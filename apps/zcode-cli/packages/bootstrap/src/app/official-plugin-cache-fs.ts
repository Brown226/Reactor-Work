import { access, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, sep } from "node:path";

const DEFAULT_RETRY_DURATION_MS = 1_500;
const RETRY_DELAYS_MS = [25, 50, 100] as const;
const RETRY_ATTEMPTS_FIELD = "zcodeOfficialPluginCacheAttempts";
const TRANSIENT_ERROR_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);

export interface OfficialPluginCacheRetryBudget {
  signal?: AbortSignal;
  deadlineAt: number;
  now: () => number;
  sleep: (delayMs: number) => void | Promise<void>;
}

export function createOfficialPluginCacheRetryBudget(input?: {
  signal?: AbortSignal;
  durationMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => void | Promise<void>;
}): OfficialPluginCacheRetryBudget {
  const now = input?.now ?? Date.now;
  return {
    signal: input?.signal,
    deadlineAt: now() + (input?.durationMs ?? DEFAULT_RETRY_DURATION_MS),
    now,
    sleep: input?.sleep ?? ((ms) => delay(ms, undefined, { signal: input?.signal })),
  };
}

export function isTransientOfficialPluginCacheFsError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    TRANSIENT_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code))
  );
}

export function getOfficialPluginCacheRetryAttempts(error: unknown): number {
  if (typeof error !== "object" || error === null) return 1;
  const attempts = (error as Record<string, unknown>)[RETRY_ATTEMPTS_FIELD];
  return typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 1;
}

export async function retryOfficialPluginCacheFs<T>(
  operation: () => T | Promise<T>,
  options?: {
    budget?: OfficialPluginCacheRetryBudget;
  },
): Promise<T> {
  const budget = options?.budget ?? createOfficialPluginCacheRetryBudget();
  let attempts = 0;
  while (true) {
    budget.signal?.throwIfAborted();
    attempts += 1;
    try {
      return await operation();
    } catch (error) {
      setRetryAttempts(error, attempts);
      const delayMs = RETRY_DELAYS_MS[attempts - 1];
      if (
        !isTransientOfficialPluginCacheFsError(error) ||
        delayMs === undefined ||
        budget.now() + delayMs > budget.deadlineAt
      ) {
        throw error;
      }
      await budget.sleep(delayMs);
    }
  }
}

export async function removeOfficialPluginCacheDirectory(
  path: string,
  budget = createOfficialPluginCacheRetryBudget(),
): Promise<void> {
  await retryOfficialPluginCacheFs(
    async () => {
      await rm(path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 25,
      });
    },
    { budget },
  );
}

export async function renameOfficialPluginCachePath(
  fromPath: string,
  toPath: string,
  budget: OfficialPluginCacheRetryBudget,
): Promise<void> {
  await retryOfficialPluginCacheFs(async () => await rename(fromPath, toPath), { budget });
}

export async function writeTextFileAtomicallyWithRetry(
  filePath: string,
  contents: string,
  budget: OfficialPluginCacheRetryBudget,
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    await retryOfficialPluginCacheFs(async () => await writeFile(temporaryPath, contents), {
      budget,
    });
    await renameOfficialPluginCachePath(temporaryPath, filePath, budget);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // 清理临时文件失败不能覆盖真正的写入错误；下次启动会使用新的唯一临时文件。
    }
    throw error;
  }
}

function setRetryAttempts(error: unknown, attempts: number): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Object.defineProperty(error, RETRY_ATTEMPTS_FIELD, {
      configurable: true,
      value: attempts,
      writable: true,
    });
  } catch {
    // 某些第三方错误对象可能被冻结；此时日志退回 attempts=1，不改变原始异常。
  }
}

/** 元数据用于成功准备的再验证；缺失或不可读时必须重新准备，不能复用历史成功。 */
export async function readOfficialPluginFileFacts(
  paths: readonly string[],
): Promise<string | undefined> {
  try {
    const facts = [];
    for (const path of paths) {
      const info = await stat(path, { bigint: true });
      facts.push([
        path,
        String(info.dev),
        String(info.ino),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
        String(info.mode),
      ]);
    }
    return JSON.stringify(facts);
  } catch {
    return undefined;
  }
}

export async function collectOfficialPluginSourceFiles(
  rootPath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Array<{ mode: number; path: string; sourcePath: string }>> {
  const files = [];
  for await (const sourcePath of walkFiles(rootPath, allowedTopLevelPaths, 0, signal)) {
    const relativePath = sourcePath
      .slice(rootPath.length + 1)
      .split(sep)
      .join("/");
    if (!shouldIncludePluginFile(relativePath, allowedTopLevelPaths)) continue;
    signal?.throwIfAborted();
    const { mode } = await stat(sourcePath);
    signal?.throwIfAborted();
    files.push({ mode, path: relativePath, sourcePath });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function* walkFiles(
  directory: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  depth = 0,
  signal?: AbortSignal,
  topLevelSegment?: string,
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    signal?.throwIfAborted();
    if (shouldSkipDirectory(entry.name, depth, allowedTopLevelPaths, topLevelSegment)) continue;
    const fullPath = join(directory, entry.name);
    // 修复原因：Dirent 的 d_type 在部分文件系统（FUSE / proot bind mount）上不可靠 ——
    // 硬链接文件会被报成 symlink，isFile() 与 isDirectory() 同时为 false。
    // 2026-11-13 在 Android proot 环境实测：pnpm store 硬链接进 node_modules 的资产包
    // 因此被整棵跳过，filesystem seed 只会收到 manifest，插件在缓存里是空壳。
    // 用 stat 复核真实类型，避免依赖树被静默剪空。
    const entryStats = await stat(fullPath);
    signal?.throwIfAborted();
    if (entryStats.isDirectory()) {
      yield* walkFiles(
        fullPath,
        allowedTopLevelPaths,
        depth + 1,
        signal,
        topLevelSegment ?? (depth === 0 ? entry.name : undefined),
      );
      continue;
    }
    if (entryStats.isFile()) yield fullPath;
  }
}

function shouldSkipDirectory(
  name: string,
  depth: number,
  allowedTopLevelPaths: ReadonlySet<string>,
  topLevelSegment?: string,
): boolean {
  if (name === ".turbo" || name === "coverage" || name === ".venv" || name === "__pycache__") {
    return true;
  }
  if (name !== "node_modules") return false;
  // 顶层 node_modules 只有在被显式允许时才拷（原行为）。
  if (depth === 0) return !allowedTopLevelPaths.has(name);
  // 嵌套的 node_modules 默认剪掉（源码树的依赖不该进缓存），**但**在
  // `runtimeTopLevelPaths` 显式声明的资产树里必须保留：原生绑定（anydoc / onnxruntime-node /
  // canvas）本身就是以 node_modules 包的形式分发的，剪掉它们等于交付一个"资产不完整"的插件
  // ——2026-09-23 实测：file-tools 的 anydoc/canvas/onnxruntime 被整棵剪掉，工具在应用里直接报错，
  // 而源码态跑得好好的（源码走 require，不经过 seed）。
  if (topLevelSegment !== undefined && allowedTopLevelPaths.has(topLevelSegment)) return false;
  return true;
}

function shouldIncludePluginFile(
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split("/");
  return topLevel !== undefined && allowedTopLevelPaths.has(topLevel);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 读取 definition 声明的构建身份文件；旧构建没有该文件时按“无构建身份”比较，不阻断 seed。 */
export async function readOfficialPluginBuildIdentity(
  rootPath: string,
  definition: { buildIdentityPath?: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  const relativePath = definition.buildIdentityPath;
  if (!relativePath) return undefined;
  try {
    return await readFile(join(rootPath, ...relativePath.split("/")), { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
