/* path 规则集中维护：旧 task 快照与 provider 配置路径仍在这里收口。 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, win32 } from "node:path";
import { homedir } from "node:os";
import {
  DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
  USER_DATA_DIR_NAME,
  ZCODE_DATA_SCOPE_ENV_KEY,
  ZCODE_DATA_SCOPE_MARKER_FILE_NAME,
  ZCODE_LOCAL_DATA_SCOPE,
  ZCODE_USER_SCOPED_DATA_DIR_NAME,
  parseZCodeDataScopeMarkerFile,
  sanitizeZCodeDataScope,
} from "@zcode/shared";

let _dataBaseDir: string | null = null;
export const ZCODE_WINDOWS_APP_INSTALL_DIR_ENV = "ZCODE_WINDOWS_APP_INSTALL_DIR";
const envDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || null;
const defaultDataBaseDir = process.env.HOME?.trim() || homedir();

interface DataBaseDirTargetValidationOptions {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  appInstallDir?: string | null;
}

type DataBaseDirTargetValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE;
      forbiddenDir: string;
    };

/** Set the base directory for app data (replaces homedir() prefix). */
export function setDataBaseDir(dir: string | null): void {
  _dataBaseDir = dir?.trim() || null;
}

/** Get the current base directory. Priority: setDataBaseDir() > env ZCODE_DATA_BASE_DIR > homedir(). */
export function getDataBaseDir(): string {
  if (_dataBaseDir) return _dataBaseDir;
  if (envDataBaseDir) return envDataBaseDir;
  // 服务实例会启动后台刷新任务；若每次调用都动态读取 HOME，
  // 测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
  return defaultDataBaseDir;
}

/** {dataBaseDir}/{USER_DATA_DIR_NAME} —— 用户级数据根，目录名见 shared/user-data-dir。 */
export function getZCodeDataRootDir(): string {
  return join(getDataBaseDir(), USER_DATA_DIR_NAME);
}

/**
 * 数据命名空间 marker 路径：`{用户数据根}/data-scope.json`。
 *
 * 刻意放在任何 `users/{scope}` 目录**之外**——本地态与各企业用户必须读到同一份事实源，
 * 否则切到某个 scope 之后就再也读不回 marker 了。
 */
export function getZCodeDataScopeMarkerFilePath(): string {
  return join(getZCodeDataRootDir(), ZCODE_DATA_SCOPE_MARKER_FILE_NAME);
}

let cachedDataScope: string | null = null;

/**
 * 当前数据命名空间：显式 env 覆盖 > marker > `local`。
 *
 * env 由 Main 在 fork Host 时按 marker 注入（CLI/agent 再继承它）；这里读 marker 只兜底
 * 「Host 被手工启动、没有 env」的情况。进程内只解析一次：scope 变化必须重启进程才生效
 * （已打开的 SQLite 句柄与缓存目录不会跟着搬，见方案文档 §3 时序）。
 */
export function getZCodeDataScope(): string {
  if (cachedDataScope !== null) {
    return cachedDataScope;
  }
  const override = sanitizeZCodeDataScope(process.env[ZCODE_DATA_SCOPE_ENV_KEY]);
  if (override !== ZCODE_LOCAL_DATA_SCOPE) {
    cachedDataScope = override;
    return cachedDataScope;
  }
  const markerPath = getZCodeDataScopeMarkerFilePath();
  cachedDataScope = existsSync(markerPath)
    ? (() => {
        try {
          return parseZCodeDataScopeMarkerFile(readFileSync(markerPath, "utf8")).scope;
        } catch {
          // marker 损坏 = 无法判断归属，回落本地态；不为猜一个用户而冒数据串读的风险。
          return ZCODE_LOCAL_DATA_SCOPE;
        }
      })()
    : ZCODE_LOCAL_DATA_SCOPE;
  return cachedDataScope;
}

/** 撤销 `getZCodeDataScope()` 的进程内缓存（仅测试用；Host 侧 scope 变化靠重启）。 */
export function resetZCodeDataScopeCache(): void {
  cachedDataScope = null;
}

/**
 * 当前命名空间的数据根；`local` 返回 null，表示沿用历史路径、不做任何迁移
 * （`docs/已完成/已完成-data-directory-contract.md` §5：本产品不做数据迁移）。
 */
export function getZCodeUserScopedDataRootDir(): string | null {
  const scope = getZCodeDataScope();
  if (scope === ZCODE_LOCAL_DATA_SCOPE) {
    return null;
  }
  return join(getZCodeDataRootDir(), ZCODE_USER_SCOPED_DATA_DIR_NAME, scope);
}

/**
 * `v2` 配置目录的当前命名空间形态。
 *
 * 全局配置（凭据、provider、设置、策略缓存）继续用 {@link getAppConfigDir}；
 * 只有会话/任务派生的数据（tasks-index、legacy 快照、检查点、memory、审计 outbox）
 * 走这里——凭据若跟着 scope 搬走，重启后就读不到令牌，登录会被自己打成死循环。
 */
export function getUserScopedAppConfigDir(): string {
  const scoped = getZCodeUserScopedDataRootDir();
  return scoped ? join(scoped, "v2") : getAppConfigDir();
}

/** 非项目对话共享的真实工作目录；默认 {用户数据根}/workspace/default。 */
export function getConversationWorkspaceDir(): string {
  const scoped = getZCodeUserScopedDataRootDir();
  return scoped
    ? join(scoped, "workspace", "default")
    : join(getZCodeDataRootDir(), "workspace", "default");
}

/** {dataBaseDir}/{USER_DATA_DIR_NAME}/v2 */
export function getAppConfigDir(): string {
  return join(getZCodeDataRootDir(), "v2");
}

function readEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]?.trim();
  if (direct) {
    return direct;
  }

  const lowerKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() !== lowerKey) {
      continue;
    }
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeWindowsComparablePath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = win32.normalize(trimmed).replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return win32
    .resolve(normalized)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsPathEqualOrInside(pathValue: string, rootValue: string): boolean {
  const normalizedPath = normalizeWindowsComparablePath(pathValue);
  const normalizedRoot = normalizeWindowsComparablePath(rootValue);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function collectWindowsForbiddenAppInstallDirs(
  options: Required<Pick<DataBaseDirTargetValidationOptions, "env">> &
    Pick<DataBaseDirTargetValidationOptions, "appInstallDir">,
): string[] {
  const env = options.env;
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const programW6432 = readEnvValue(env, "ProgramW6432");
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  const candidates = [
    options.appInstallDir,
    readEnvValue(env, ZCODE_WINDOWS_APP_INSTALL_DIR_ENV),
    programFiles ? win32.join(programFiles, "ZCode") : null,
    programFilesX86 ? win32.join(programFilesX86, "ZCode") : null,
    programW6432 ? win32.join(programW6432, "ZCode") : null,
    localAppData ? win32.join(localAppData, "Programs", "ZCode") : null,
  ];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? normalizeWindowsComparablePath(candidate) : null;
    if (!candidate || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(candidate);
  }

  return result;
}

export function validateDataBaseDirTarget(
  targetBaseDir: string,
  options: DataBaseDirTargetValidationOptions = {},
): DataBaseDirTargetValidationResult {
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true };
  }

  for (const forbiddenDir of collectWindowsForbiddenAppInstallDirs({
    env: options.env ?? process.env,
    appInstallDir: options.appInstallDir ?? null,
  })) {
    if (isWindowsPathEqualOrInside(targetBaseDir, forbiddenDir)) {
      return {
        ok: false,
        code: DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
        forbiddenDir,
      };
    }
  }

  return { ok: true };
}

export function getExportLogStageDir(): string {
  return join(getZCodeDataRootDir(), "export-log-stage");
}

export function getExportLogDir(): string {
  return join(getZCodeDataRootDir(), "export-log");
}

export function getFeedbackRootDir(): string {
  return join(getZCodeDataRootDir(), "feedback");
}

export function getFeedbackAttachmentDir(): string {
  return join(getFeedbackRootDir(), "attachments");
}

export function getFeedbackLogArchiveDir(): string {
  return join(getFeedbackRootDir(), "logs");
}

export function getGitCheckpointIndexRootDir(): string {
  const scoped = getZCodeUserScopedDataRootDir();
  return join(scoped ?? getZCodeDataRootDir(), "git-checkpoint-index");
}

/** ~/.zcode/v2/tasks-index.sqlite（本地态）或 ~/.zcode/users/{scope}/v2/tasks-index.sqlite */
export function getTasksIndexDatabasePath(): string {
  return join(getUserScopedAppConfigDir(), "tasks-index.sqlite");
}

/** workspace 级身份键：远程优先使用 workspaceIdentity，本地回退 workspacePath。 */
function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 与 ZCode session 持久化一致：使用 workspaceKey 的 SHA-256 前 12 位 */
export function getWorkspaceHash(workspacePath: string, workspaceIdentity?: string): string {
  return createHash("sha256")
    .update(getWorkspaceKey(workspacePath, workspaceIdentity))
    .digest("hex")
    .slice(0, 12);
}

/** ~/.zcode/v2/sessions/{workspaceHash}（本地态）或 users/{scope}/v2/sessions/{workspaceHash} */
function getTaskSessionDir(workspacePath: string, workspaceIdentity?: string): string {
  return join(
    getUserScopedAppConfigDir(),
    "sessions",
    getWorkspaceHash(workspacePath, workspaceIdentity),
  );
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json */
export function getLegacyTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.json`);
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.deleted.json */
export function getLegacyDeletedTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.deleted.json`);
}

/**
 * Copy the user data directory from one base dir to another.
 * Excludes setting.json and its transient atomic-write siblings — bootstrap
 * state must only live at the default homedir location.
 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  const oldDir = join(oldBaseDir, USER_DATA_DIR_NAME, "v2");
  const newDir = join(newBaseDir, USER_DATA_DIR_NAME, "v2");
  await cp(oldDir, newDir, {
    recursive: true,
    force: false,
    filter: (source) => {
      const sourceName = basename(source);
      if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
        // setting.json.lock 和 setting.json.*.tmp 由原子写入短暂创建/删除，
        // 复制过程中扫描到已消失的 lock 会触发 ENOENT，并让数据目录迁移失败。
        // 这些文件都属于 bootstrap 写入中间态，不能迁移到新数据根。
        return false;
      }
      // Windows 非提权环境下 fs.cp 无法复制符号链接（EPERM）。
      // 跳过符号链接可避免 Windows 非提权环境下 fs.cp 报 EPERM。
      try {
        if (lstatSync(source).isSymbolicLink()) return false;
      } catch {
        // lstat 失败时放行，让 cp 自行处理
      }
      return true;
    },
  });
}
