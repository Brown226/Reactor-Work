import { mkdir, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { formatLogPrefix, type ServerRemoteInfo } from "@zcode/shared";
import { IReactorServerService, type ServiceCollection } from "@zcode/services";

/**
 * Web 端「每用户工作区 + 应用层配额」（B 方案：单容器多目录）。
 *
 * 规格见 docs/未完成-WEB端每用户工作区与配额-spec-v1.md。要点：
 * - 每个企业账号一个目录 `<REACTOR_WEB_WORKSPACE_ROOT>/<uid>`（默认 /data/users/<uid>）；
 * - 配额是**软限制**：agent 与文件工具直接写盘、完全绕过本模块，usedBytes/overQuota
 *   只用于展示与提示，不做硬阻断；
 * - 阶段一身份口径是「uid 即身份」：/ws 尚无鉴权（docs/未完成-WEB端功能增强与验证计划-v1.md
 *   §4 P2 独立 P0）。优先使用服务端登录成功后记录的 uid；请求显式携带 uid 属于可伪造后门，
 *   与 /ws 无鉴权同级 P0，仅保留用于联调。
 */

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:user-workspace", process.pid), ...args);

/** 默认根：容器内挂载卷 /data 下的每用户目录。 */
const DEFAULT_WORKSPACE_ROOT = "/data/users";
/** 默认每用户配额 1GB。 */
const DEFAULT_USER_QUOTA_BYTES = 1073741824;
/** 默认总容量 20GB：只做记录与告警口径，本模块不做全盘强控。 */
const DEFAULT_TOTAL_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
/**
 * 用量短 TTL 缓存：软限制的展示口径，30s 内的毫秒级误差可接受，
 * 换来避免每次请求都全量递归扫描目录。
 */
const USAGE_CACHE_TTL_MS = 30_000;
/** uid 白名单：首字符字母数字，其余限字母数字与 . _ -。天然排除路径分隔符与 `..`。 */
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const warnedEnvNames = new Set<string>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    // 只 warn 一次：env 在进程生命周期内不变，避免每次请求刷屏。
    if (!warnedEnvNames.has(name)) {
      warnedEnvNames.add(name);
      log(`env ${name}="${raw}" 不是正整数，回退默认值 ${fallback}`);
    }
    return fallback;
  }
  return parsed;
}

export interface UserWorkspaceConfig {
  readonly root: string;
  readonly userQuotaBytes: number;
  readonly totalQuotaBytes: number;
}

/** 每次调用都从 env 现读（纯内存，无 IO），保证 server-info 与路由口径一致。 */
export function resolveUserWorkspaceConfig(): UserWorkspaceConfig {
  return {
    root: process.env.REACTOR_WEB_WORKSPACE_ROOT?.trim() || DEFAULT_WORKSPACE_ROOT,
    userQuotaBytes: readPositiveIntEnv("REACTOR_WEB_USER_QUOTA_BYTES", DEFAULT_USER_QUOTA_BYTES),
    totalQuotaBytes: readPositiveIntEnv(
      "REACTOR_WEB_TOTAL_QUOTA_BYTES",
      DEFAULT_TOTAL_QUOTA_BYTES,
    ),
  };
}

/** server-info 能力发现字段用：告知前端每用户工作区根目录。 */
export function resolveUserWorkspaceRoot(): string {
  return resolveUserWorkspaceConfig().root;
}

export function isValidUid(uid: string): boolean {
  return UID_PATTERN.test(uid);
}

/** 与 http.ts 的 isInsideDirectory 同逻辑；那边未导出，6 行小函数不值得为此拉公共文件。 */
function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

/**
 * 解析用户目录绝对路径。uid 正则已排除分隔符与 `..`，这里再做一次 resolve 后的
 * 包含校验双保险：即使未来 root/uid 处理被改动，目录也永远落在 root 内。
 */
function resolveUserDir(root: string, uid: string): string | null {
  const dir = resolve(root, uid);
  return isInsideDirectory(resolve(root), dir) ? dir : null;
}

/**
 * 递归统计目录字节数（node:fs/promises 异步 IO）。
 * - 符号链接不跟随也不计入：防止把用户目录外的文件算进配额，也防成环；
 * - 单个条目失败按 0 跳过：软限制的展示口径，个别文件读不动不应让整个请求 500。
 */
async function scanDirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 目录不存在（GET 是只读语义，不代创建）或暂不可读：按 0 计。
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      total += await scanDirSize(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      total += (await stat(entryPath)).size;
    } catch {
      // 并发删除/权限变化：跳过该条目。
    }
  }
  return total;
}

interface UsageCacheEntry {
  readonly bytes: number;
  readonly expiresAt: number;
}

/** key 为解析后的绝对目录：root 配置不同则天然隔离，value 过期时间 30s。 */
const usageCache = new Map<string, UsageCacheEntry>();
/** 同目录并发请求合并为一次扫描，避免 TTL 到期瞬间的惊群重复扫描。 */
const inFlightScans = new Map<string, Promise<number>>();

async function readUsedBytes(dir: string): Promise<number> {
  const cached = usageCache.get(dir);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.bytes;
  }
  const inFlight = inFlightScans.get(dir);
  if (inFlight) {
    return inFlight;
  }
  const scan = scanDirSize(dir)
    .then((bytes) => {
      usageCache.set(dir, { bytes, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
      return bytes;
    })
    .finally(() => {
      inFlightScans.delete(dir);
    });
  inFlightScans.set(dir, scan);
  return scan;
}

export interface UserWorkspaceUsagePayload {
  /** 用户工作区绝对路径（服务器/容器内视角）。 */
  path: string;
  quotaBytes: number;
  usedBytes: number;
  /** 总容量：只做记录与告警口径（REACTOR_WEB_TOTAL_QUOTA_BYTES），不是硬上限。 */
  totalBytes: number;
  /** usedBytes 超过每用户配额：软限制提示位，服务端不阻断写入。 */
  overQuota: boolean;
}

/**
 * server-info 追加字段后的响应形状。shared 的 ServerRemoteInfo 未含 userWorkspaceRoot
 * （本任务约束不碰 packages/shared），在此局部扩展类型；JSON 多出的字段对旧客户端向后兼容。
 */
export interface ServerInfoWithUserWorkspace extends ServerRemoteInfo {
  userWorkspaceRoot: string;
}

/**
 * 「当前登录 uid」的唯一所有者：进程内单值。
 *
 * 事件序：浏览器登录 RPC → reactorServer.login 成功（@zcode/services 里 client.login 的
 * 唯一调用点 reactorServerService.ts:959）→ 本模块覆盖写入 uid → 后续 user-workspace
 * 请求按该 uid 路由；logout 清空。记录幂等（覆盖语义）。
 *
 * 阶段一已知限制：进程级单值意味着多浏览器并发登录时「后登录者覆盖」；这与 /ws 无鉴权、
 * 显式 uid 可伪造同属阶段一安全口径（独立 P0，见 docs/未完成-WEB端功能增强与验证计划-v1.md §4）。
 */
let currentLoginUid: string | null = null;

export function recordLoginUid(uid: string): void {
  currentLoginUid = uid;
  log("记录当前登录用户 uid:", uid);
}

export function clearLoginUid(): void {
  currentLoginUid = null;
}

export function getCurrentLoginUid(): string | null {
  return currentLoginUid;
}

const recorderInstalled = new WeakSet<object>();

/**
 * 在服务端登录成功路径上挂 uid 记录（观察者包装，不改变原方法行为）。
 *
 * 挂载点选择：packages/services 中 `client.login` 的唯一调用点是 `reactorServerService.login`
 * （packages/services/src/reactor-server/reactorServerService.ts:959），浏览器经 /ws 调的
 * 登录 RPC 最终都汇聚到这里，desktop 与 web/server 形态共用同一实现。受「只改
 * packages/server/src」约束，不在 services 包内加钩子，而是在本包对该 ServiceCollection
 * 里的实例做外层包装；Desktop 走 stdio 不经过 createHttpServer，不受影响。
 */
export function installLoginUidRecorder(services: ServiceCollection): void {
  const reactorServer = services.getOptional(IReactorServerService);
  if (!reactorServer || recorderInstalled.has(reactorServer)) {
    return;
  }
  recorderInstalled.add(reactorServer);
  const originalLogin = reactorServer.login.bind(reactorServer);
  reactorServer.login = async (input) => {
    const status = await originalLogin(input);
    // 登录成功（含 mustChangePassword 的首次登录）：user.uid 是身份服务下发的稳定标识。
    if (status.user?.uid) {
      recordLoginUid(status.user.uid);
    }
    return status;
  };
  const originalLogout = reactorServer.logout.bind(reactorServer);
  reactorServer.logout = async () => {
    await originalLogout();
    // 登出必须清掉记录：否则下一个匿名 GET 会静默拿到上一个用户的用量。
    clearLoginUid();
  };
}

type UidResolution = { ok: true; uid: string } | { ok: false; status: 400 | 401; message: string };

/**
 * 解析本次请求的身份：显式 uid（POST body / GET query）优先，其次登录成功记录的 uid。
 *
 * **假设标注**：显式 uid 是阶段一的可伪造后门 —— /ws 无鉴权（计划 §4 P2 独立 P0），
 * 任何客户端都能报任意 uid 拿到别人目录的用量。保留它只为联调与前端显式传参兜底；
 * 接入登录身份后应移除或收紧为「uid 必须来自已认证会话」。
 */
function resolveRequestUid(explicitUid: string | undefined): UidResolution {
  const uid = explicitUid?.trim() || getCurrentLoginUid();
  if (!uid) {
    return {
      ok: false,
      status: 401,
      message: "无法确定用户身份：请求未携带 uid，且服务端尚无登录成功的用户记录",
    };
  }
  if (!isValidUid(uid)) {
    return {
      ok: false,
      status: 400,
      message: `uid 不合法：需匹配 ${UID_PATTERN.source}`,
    };
  }
  return { ok: true, uid };
}

function toPayload(config: UserWorkspaceConfig, dir: string, usedBytes: number) {
  return {
    path: dir,
    quotaBytes: config.userQuotaBytes,
    usedBytes,
    totalBytes: config.totalQuotaBytes,
    overQuota: usedBytes > config.userQuotaBytes,
  };
}

/**
 * 挂载每用户工作区路由（在 createHttpServer 里调用一次）。
 * /api/* 已被现有 token 中间件覆盖：配置了 authToken 时这两个路由同样需要令牌。
 */
export function registerUserWorkspaceRoutes(app: Hono): void {
  // 建目录（ensure）+ 返回用量。显式 body.uid 优先，其次登录记录 uid（伪造风险见 resolveRequestUid）。
  app.post("/api/user-workspace", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "请求体必须是 JSON" }, 400);
    }
    const bodyUid =
      typeof rawBody === "object" && rawBody !== null && typeof (rawBody as { uid?: unknown }).uid === "string"
        ? (rawBody as { uid: string }).uid
        : undefined;
    const resolved = resolveRequestUid(bodyUid);
    if (!resolved.ok) {
      return c.json({ error: resolved.message }, resolved.status);
    }
    const config = resolveUserWorkspaceConfig();
    const dir = resolveUserDir(config.root, resolved.uid);
    if (!dir) {
      return c.json({ error: "uid 解析后的目录越界" }, 400);
    }
    try {
      // 递归创建，幂等；注意这只保证目录存在，**不会**限制 agent 在目录里写多少 —— 软限制。
      await mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `创建用户工作区失败: ${message}` }, 500);
    }
    return c.json(toPayload(config, dir, await readUsedBytes(dir)));
  });

  // 只读用量：不创建目录；uid 缺省回落登录记录（无需 body，便于 UI 轮询展示）。
  app.get("/api/user-workspace/usage", async (c) => {
    const resolved = resolveRequestUid(c.req.query("uid"));
    if (!resolved.ok) {
      return c.json({ error: resolved.message }, resolved.status);
    }
    const config = resolveUserWorkspaceConfig();
    const dir = resolveUserDir(config.root, resolved.uid);
    if (!dir) {
      return c.json({ error: "uid 解析后的目录越界" }, 400);
    }
    return c.json(toPayload(config, dir, await readUsedBytes(dir)));
  });
}
