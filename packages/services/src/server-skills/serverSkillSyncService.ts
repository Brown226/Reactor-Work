import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isServerSkillNameFileSafe } from "@zcode/shared";
import type { ApiClient, ServerSkillCatalogItem } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  REACTOR_SERVER_CREDENTIAL_KEYS,
  type IReactorServerService,
} from "../reactor-server/reactorServer.js";
import {
  createReactorServerClient,
  ReactorServerHttpError,
  type ReactorServerSkillPayload,
} from "../reactor-server/reactorServerClient.js";
import {
  IServerSkillSyncService,
  type ServerSkillCatalogSyncResult,
  type ServerSkillSyncResult,
} from "./serverSkillSync.js";
import { resolveServerSkillRoot } from "./serverSkillsRoot.js";

/**
 * 同步器实现。同步时序、失败语义与验收场景见 docs/server-skill-sync.md。
 *
 * 三条硬约束（来自旧项目踩坑）：
 *  1. 二进制附件哈希一律按**解码后字节**——服务端清单 sha 同口径，对不上就跳过不写；
 *  2. 任何网络失败/未登录一律零删除零写盘，只有拿到落盘集才允许清理本地；
 *  3. 删除只认「合法技能名 + 落盘集之外」的目录，绝不碰 skills/ 与其它内容。
 */

const logger = createServiceLogger("serverSkillSync");

/** 技能名先过 pattern 再当目录名（与管理端同口径）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 与 server/packages/shared/src/skills.ts 的 SKILL_FILE_LIMITS 同值；客户端落盘前再验一次。 */
const SKILL_FILE_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxPathChars: 240,
} as const;

/** 与服务端 normalizeSkillFilePath 同语义：拒绝绝对路径、盘符、控制符、`..` 段与裸 SKILL.md。 */
function normalizeSkillFilePath(raw: string): string | null {
  const p = raw.trim().replace(/\\/g, "/");
  if (!p || p.length > SKILL_FILE_LIMITS.maxPathChars) return null;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  // 控制符逐字符判断（与服务端同语义：U+0000–U+001F 拒绝），不用字符类正则以免 no-control-regex。
  for (const character of p) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f) return null;
  }
  const segs = p.split("/").filter((x) => x.length > 0);
  if (segs.length === 0) return null;
  if (segs.some((seg) => seg === "." || seg === "..")) return null;
  if (segs.length === 1 && segs[0] === "SKILL.md") return null;
  return segs.join("/");
}

function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skippedNotLoggedIn(): ServerSkillSyncResult {
  return {
    changed: [],
    removed: [],
    names: [],
    disabledNames: [],
    errors: [],
    offline: false,
    authExpired: false,
    skippedNotLoggedIn: true,
  };
}

function failedResult(error: unknown, context: string): ServerSkillSyncResult {
  const unauthorized =
    error instanceof ReactorServerHttpError &&
    (error.status === 401 || error.status === 403 || error.isUnauthorized);
  // 401/403 与「服务端挂了」必须区分：前者要提示重新登录，后者保持离线副本可用。
  return {
    changed: [],
    removed: [],
    names: [],
    disabledNames: [],
    errors: [`${context}: ${errorMessage(error)}`],
    offline: !unauthorized,
    authExpired: unauthorized,
    skippedNotLoggedIn: false,
  };
}

/** 目录投影的空结果：catalog/featured 带回上一次成功值（UI 不因离线丢市场页）。 */
function catalogResult(
  catalog: readonly ServerSkillCatalogItem[],
  featured: readonly ServerSkillCatalogItem[],
  overrides: Partial<Omit<ServerSkillCatalogSyncResult, "catalog" | "featured">> = {},
): ServerSkillCatalogSyncResult {
  return {
    catalog,
    featured,
    errors: [],
    offline: false,
    authExpired: false,
    skippedNotLoggedIn: false,
    ...overrides,
  };
}

interface ServerSession {
  readonly serverUrl: string;
  readonly accessToken: string;
}

export function createServerSkillSyncService(options: {
  apiClient: ApiClient;
  credentials: ICredentialService;
  reactorServer: IReactorServerService;
}): IServerSkillSyncService {
  const client = createReactorServerClient(options.apiClient);
  // 串行队列：sync/uninstall/refresh/install/favorite 同一时刻只跑一个，后来的等待，
  // 避免「全量对齐删目录」与「单技能卸载删目录」交叉执行把状态写撕裂。
  let queue: Promise<unknown> = Promise.resolve();
  /** 最近一次成功 syncCatalog 的目录/精选投影（进程内存；不落盘，失败时作为兜底）。 */
  let lastCatalog: readonly ServerSkillCatalogItem[] = [];
  let lastFeatured: readonly ServerSkillCatalogItem[] = [];

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function resolveSession(): Promise<ServerSession | null> {
    let status;
    try {
      status = await options.reactorServer.getStatus();
    } catch {
      return null;
    }
    if (!status.loggedIn || !status.serverUrl) return null;
    const accessToken = await options.credentials
      .load(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken)
      .catch(() => null);
    if (!accessToken) return null;
    return { serverUrl: status.serverUrl, accessToken };
  }

  async function fetchSkillFile(
    session: ServerSession,
    name: string,
    relativePath: string,
    expectedSha256: string,
  ): Promise<Buffer | null> {
    try {
      const file = await client.skillFile(
        session.serverUrl,
        session.accessToken,
        name,
        relativePath,
      );
      const bytes =
        typeof file.contentB64 === "string"
          ? Buffer.from(file.contentB64, "base64")
          : Buffer.from(file.content ?? "", "utf8");
      // 哈希口径 = 解码后字节；对不上宁可不写，也不写半套损坏文件。
      if (sha256hex(bytes) !== expectedSha256) return null;
      return bytes;
    } catch (error) {
      if (error instanceof ReactorServerHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /** 删除服务端清单里已不存在的附件（保持目录与清单一致；只删文件，不动目录外的任何东西）。 */
  async function removeFilesNotInManifest(
    skillDir: string,
    manifestPaths: ReadonlySet<string>,
  ): Promise<void> {
    const walk = async (relativeDir: string): Promise<boolean> => {
      const absoluteDir = relativeDir === "" ? skillDir : join(skillDir, relativeDir);
      let entries;
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(relativePath);
          continue;
        }
        // SKILL.md 由 content 列单独下发，服务端清单永远不会列它——必须显式保护，
        // 否则无附件技能每次同步都会把刚写入的 SKILL.md 当「清单外文件」删掉。
        if (relativePath === "SKILL.md") continue;
        // 文件与（异常出现的）链接：清单外的才删；链接只删链接本身。
        if (!manifestPaths.has(relativePath)) {
          await rm(join(absoluteDir, entry.name), { recursive: true, force: true });
        }
      }
      // 子目录空了就收掉，避免服务端删了附件后本地留下空目录骨架。
      if (relativeDir !== "" && entries.length === 0) {
        await rm(absoluteDir, { recursive: true, force: true }).catch(() => {});
      }
      return entries.length === 0;
    };
    await walk("");
  }

  async function writeSkillToDisk(
    session: ServerSession,
    skill: ReactorServerSkillPayload,
    errors: string[],
  ): Promise<boolean> {
    const skillDir = join(resolveServerSkillRoot(), skill.name);
    let wrote = false;

    const skillMdPath = join(skillDir, "SKILL.md");
    const existing = await readFile(skillMdPath, "utf-8").catch(() => null);
    // 内容不等才写：重复 sync 不碰 mtime，幂等。
    if (existing !== skill.content) {
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillMdPath, skill.content, "utf-8");
      wrote = true;
    }

    const files = skill.files.slice(0, SKILL_FILE_LIMITS.maxFiles);
    if (skill.files.length > files.length) {
      errors.push(
        `技能 ${skill.name} 附件数超限（${skill.files.length}），仅同步前 ${files.length} 个`,
      );
    }
    const manifestPaths = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      const relativePath = normalizeSkillFilePath(file.path);
      if (!relativePath) {
        errors.push(`技能 ${skill.name} 附件路径非法: ${JSON.stringify(file.path)}`);
        continue;
      }
      if (file.size > SKILL_FILE_LIMITS.maxFileBytes) {
        errors.push(`附件超限（${file.size}B）已跳过: ${skill.name}/${relativePath}`);
        continue;
      }
      totalBytes += file.size;
      if (totalBytes > SKILL_FILE_LIMITS.maxTotalBytes) {
        errors.push(`技能 ${skill.name} 附件总量超限，后续附件跳过`);
        break;
      }
      manifestPaths.add(relativePath);
      const targetPath = join(skillDir, ...relativePath.split("/"));
      // 增量短路：本地字节哈希与清单一致就不发 /file 请求。
      const localBytes = await readFile(targetPath).catch(() => null);
      if (localBytes && sha256hex(localBytes) === file.sha256) continue;
      const bytes = await fetchSkillFile(session, skill.name, relativePath, file.sha256);
      if (bytes === null) {
        errors.push(`附件拉取失败或哈希不符，已跳过: ${skill.name}/${relativePath}`);
        continue;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, bytes);
      if (file.executable) {
        await chmod(targetPath, 0o755).catch(() => {});
      }
      wrote = true;
    }

    await removeFilesNotInManifest(skillDir, manifestPaths);
    return wrote;
  }

  /** 删除落盘集之外的合法名子目录（硬收回）。只认 pattern 名目录，其它内容一律不碰。 */
  async function removeObsoleteSkills(keepNames: ReadonlySet<string>): Promise<string[]> {
    const serverRoot = resolveServerSkillRoot();
    let entries;
    try {
      entries = await readdir(serverRoot, { withFileTypes: true });
    } catch {
      // ENOENT = 还没有同步过，合理空状态。
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SKILL_NAME_PATTERN.test(entry.name)) continue;
      if (keepNames.has(entry.name)) continue;
      await rm(join(serverRoot, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
    return removed.sort((left, right) => left.localeCompare(right));
  }

  async function readDisabledNames(
    session: ServerSession,
    deliverableNames: ReadonlySet<string>,
  ): Promise<string[]> {
    try {
      const states = await client.skillStates(session.serverUrl, session.accessToken);
      const activeNames = new Set(states.map((state) => state.name));
      return [...deliverableNames].filter((name) => !activeNames.has(name)).sort();
    } catch (error) {
      // 「已下架」徽标是投影，拉不到不影响同步本体。
      logger.debug(undefined, "skill state projection failed", errorMessage(error));
      return [];
    }
  }

  async function runSync(): Promise<ServerSkillSyncResult> {
    const session = await resolveSession();
    if (!session) return skippedNotLoggedIn();

    let payload;
    try {
      payload = await client.deliverableSkills(session.serverUrl, session.accessToken);
    } catch (error) {
      return failedResult(error, "读取技能落盘集失败");
    }

    const errors: string[] = [];
    const changed: string[] = [];
    const deliverableNames = new Set<string>();
    for (const skill of payload.skills) {
      if (!SKILL_NAME_PATTERN.test(skill.name)) {
        errors.push(`跳过非法技能名: ${JSON.stringify(skill.name)}`);
        continue;
      }
      deliverableNames.add(skill.name);
      try {
        const wrote = await writeSkillToDisk(session, skill, errors);
        if (wrote) changed.push(skill.name);
      } catch (error) {
        errors.push(`技能 ${skill.name} 同步失败: ${errorMessage(error)}`);
      }
    }
    changed.sort((left, right) => left.localeCompare(right));

    let removed: string[] = [];
    try {
      removed = await removeObsoleteSkills(deliverableNames);
    } catch (error) {
      errors.push(`清理过期技能目录失败: ${errorMessage(error)}`);
    }

    const disabledNames = await readDisabledNames(session, deliverableNames);
    if (changed.length > 0 || removed.length > 0) {
      logger.debug(
        undefined,
        `server skills synced changed=${changed.length} removed=${removed.length} total=${deliverableNames.size}`,
      );
    }
    return {
      changed,
      removed,
      names: [...deliverableNames].sort((left, right) => left.localeCompare(right)),
      disabledNames,
      errors,
      offline: false,
      authExpired: false,
      skippedNotLoggedIn: false,
    };
  }

  async function runUninstall(name: string): Promise<void> {
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new Error(`非法技能名: ${name}`);
    }
    const session = await resolveSession();
    if (!session) {
      throw new Error("未登录企业服务端，无法卸载（本地只删会被下次同步写回）");
    }
    try {
      await client.uninstallSkill(session.serverUrl, session.accessToken, name);
    } catch (error) {
      if (error instanceof ReactorServerHttpError && error.status === 404) {
        // 服务端已无安装记录：按已卸载处理，只清理本地残留。
      } else {
        throw new Error(`卸载失败（服务端未确认）: ${errorMessage(error)}`);
      }
    }
    await rm(join(resolveServerSkillRoot(), name), { recursive: true, force: true });
  }

  async function runRefreshFromServer(name: string): Promise<ServerSkillSyncResult> {
    // 复用 sync 的全量对齐：落盘口径与 §4.1 完全一致（含硬收回清理），
    // 避免「单技能刷新」与「全量同步」两套写入逻辑分叉。
    const result = await runSync();
    if (!result.names.includes(name)) return result;
    const session = await resolveSession();
    if (!session) return result;
    try {
      await client.refreshSkill(session.serverUrl, session.accessToken, name);
      return result;
    } catch (error) {
      // refresh 只归位 hasUpdate；失败不改变磁盘已对齐的事实，记入 errors 即可。
      return { ...result, errors: [...result.errors, `更新归位失败: ${errorMessage(error)}`] };
    }
  }

  /**
   * 拉 catalog + featured 刷新进程内投影：**纯内存，零磁盘写**——
   * 失败（含未登录/离线/401）一律带回上一次成功值，本地 `server-skills/` 分毫不动。
   */
  async function runSyncCatalog(): Promise<ServerSkillCatalogSyncResult> {
    const session = await resolveSession();
    if (!session) {
      return catalogResult(lastCatalog, lastFeatured, { skippedNotLoggedIn: true });
    }
    try {
      const [page, featured] = await Promise.all([
        client.skillCatalog(session.serverUrl, session.accessToken),
        client.skillFeatured(session.serverUrl, session.accessToken),
      ]);
      lastCatalog = page.items;
      lastFeatured = featured;
      return catalogResult(lastCatalog, lastFeatured);
    } catch (error) {
      const unauthorized =
        error instanceof ReactorServerHttpError &&
        (error.status === 401 || error.status === 403 || error.isUnauthorized);
      return catalogResult(lastCatalog, lastFeatured, {
        errors: [`读取技能市场目录失败: ${errorMessage(error)}`],
        offline: !unauthorized,
        authExpired: unauthorized,
      });
    }
  }

  async function runInstall(name: string): Promise<ServerSkillSyncResult> {
    if (!isServerSkillNameFileSafe(name)) throw new Error(`非法技能名: ${name}`);
    const session = await resolveSession();
    if (!session) throw new Error("未登录企业服务端，无法安装技能");
    await client.installSkill(session.serverUrl, session.accessToken, name);
    // 写后 re-GET + 落盘 reconcile：安装关系与聚合字段以服务端为准，本地不推算（D3 同款）。
    return runSync();
  }

  async function runSetFavorite(
    name: string,
    favorited: boolean,
  ): Promise<ServerSkillCatalogSyncResult> {
    if (!isServerSkillNameFileSafe(name)) throw new Error(`非法技能名: ${name}`);
    const session = await resolveSession();
    if (!session) throw new Error("未登录企业服务端，无法收藏技能");
    await client.setSkillFavorite(session.serverUrl, session.accessToken, name, favorited);
    // 收藏不改下发集（不影响磁盘）；写成功后 re-GET 只刷新目录投影。
    const refreshed = await runSyncCatalog();
    // 写已生效、只是 re-GET 失败：标注清楚，避免 UI 把「收藏成功」误报成整体失败。
    const errors = refreshed.errors.map((entry) => `收藏已生效，但${entry}`);
    return errors.length > 0 ? { ...refreshed, errors } : refreshed;
  }

  return {
    sync: () => enqueue(runSync),
    syncCatalog: () => enqueue(runSyncCatalog),
    install: (name: string) => enqueue(() => runInstall(name)),
    uninstall: (name: string) => enqueue(() => runUninstall(name)),
    refreshFromServer: (name: string) => enqueue(() => runRefreshFromServer(name)),
    setFavorite: (name: string, favorited: boolean) =>
      enqueue(() => runSetFavorite(name, favorited)),
    getCatalog: async () => lastCatalog,
  };
}
