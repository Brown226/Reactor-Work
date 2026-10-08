/**
 * 用户数据命名空间（企业用户隔离）的**纯语义**。
 *
 * 本产品按「机器 + 工作区」落盘会话与任务历史，企业登录身份（uid）不参与存储键，
 * 于是同一台机器上换企业账号登录，任务列表与会话消息原样共享（见
 * `docs/已完成/已完成-用户数据隔离-命名空间与切换.md`）。这里把「当前数据属于哪个用户」
 * 收口成一处纯契约，路径拼接与落盘留给 Node 消费方（`packages/services/src/userDataScope.ts`）。
 *
 * 约束（与 `desktopPolicy.ts` 同源）：本文件经 barrel 被渲染层与 sandboxed preload
 * 求值，**不得引入 `node:path` / `process.env`**；这里只放常量、判定与序列化。
 */
/** 数据命名空间环境变量：Host fork / agent spawn 时注入，子进程据此解析自己的数据根。 */
export const ZCODE_DATA_SCOPE_ENV_KEY = "ZCODE_DATA_SCOPE";

/** Main 侧 marker 文件名：下一次 fork Host 前读取，决定注入哪个 scope。 */
export const ZCODE_DATA_SCOPE_MARKER_FILE_NAME = "data-scope.json";

/** 未登录/本地态 scope：解析结果就是历史数据路径本身，不做任何迁移。 */
export const ZCODE_LOCAL_DATA_SCOPE = "local";

/** 用户命名空间目录名：`{用户数据根}/users/{scope}`。 */
export const ZCODE_USER_SCOPED_DATA_DIR_NAME = "users";

/** 允许原样保留的 scope 字符（uid 通常形如 `tiankd` / `u_12345`）。 */
const ZCODE_DATA_SCOPE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 折叠后 scope 段的最大长度（含追加的 `-摘要`）。 */
const ZCODE_DATA_SCOPE_MAX_CHARS = 64;

/** marker 文件内容：scope 之外保留 uid，供诊断与日志定位（不是凭据）。 */
export interface ZCodeDataScopeMarker {
  scope: string;
  uid?: string;
  updatedAt?: string;
}

export function isZCodeLocalDataScope(scope: string): boolean {
  return scope === ZCODE_LOCAL_DATA_SCOPE;
}

/**
 * 归一化 scope：空值回落 `local`；无法原样保留时折叠字符并追加短摘要。
 *
 * 不回落 `local` 是刻意的——那会让两个不同用户静默共享一份数据。
 * 折叠也不能只替换字符：中文 uid（`田科` / `王五`）折叠后同样长度、同样字符，
 * 两个账号会被折进同一个目录名，因此追加一份纯 JS 摘要保证互不相同
 * （shared 不能用 `node:crypto`，这里用 FNV-1a，只要稳定不需要密码学强度）。
 */
export function sanitizeZCodeDataScope(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return ZCODE_LOCAL_DATA_SCOPE;
  if (ZCODE_DATA_SCOPE_SEGMENT_PATTERN.test(trimmed)) return trimmed;
  const folded = trimmed.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, ZCODE_DATA_SCOPE_MAX_CHARS - 9);
  return `${folded}-${fnv1aHex(trimmed)}`;
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 32 位 FNV prime，用 Math.imul 避免溢出成浮点。
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 从环境变量读 scope（未注入 = 本地态）。 */
export function readZCodeDataScopeFromEnv(
  env: Record<string, string | undefined>,
): string {
  return sanitizeZCodeDataScope(env[ZCODE_DATA_SCOPE_ENV_KEY]);
}

/** 解析 marker 文件：JSON 损坏或形状非法都回落到本地态，不抛。 */
export function parseZCodeDataScopeMarkerFile(text: string): ZCodeDataScopeMarker {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return { scope: ZCODE_LOCAL_DATA_SCOPE };
    const record = parsed as Record<string, unknown>;
    return {
      scope: sanitizeZCodeDataScope(typeof record.scope === "string" ? record.scope : undefined),
      ...(typeof record.uid === "string" ? { uid: record.uid } : {}),
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
    };
  } catch {
    return { scope: ZCODE_LOCAL_DATA_SCOPE };
  }
}

/** marker 文件内容：登录/登出时由 Host 同步写盘，Main 下一次 fork 前读取。 */
export function stringifyZCodeDataScopeMarkerFile(marker: ZCodeDataScopeMarker): string {
  return JSON.stringify(marker);
}
