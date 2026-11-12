/**
 * 数据命名空间（企业用户隔离）的 Main 侧入口。
 *
 * Main 不持有登录态，只做一件裁决：fork Host / scheduler 之前读 marker，决定注入哪个
 * `ZCODE_DATA_SCOPE`。marker 由 Host 在登录/登出时同步写（`packages/services/src/userDataScope.ts`），
 * Main 只是它的读者——两边各写一份就会出现"日志说 A、磁盘是 B"。
 *
 * 显式 env 覆盖优先于 marker：dev / 测试 / 手工排障可以强制指定命名空间而不动登录态。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ZCODE_DATA_SCOPE_ENV_KEY,
  ZCODE_DATA_SCOPE_MARKER_FILE_NAME,
  ZCODE_LOCAL_DATA_SCOPE,
  parseZCodeDataScopeMarkerFile,
  sanitizeZCodeDataScope,
} from "@zcode/shared";
import { getZCodeDataRootDir } from "@zcode/services/node";

let cachedDataScope: string | null = null;

export function getDesktopDataScopeMarkerFilePath(): string {
  return join(getZCodeDataRootDir(), ZCODE_DATA_SCOPE_MARKER_FILE_NAME);
}

/**
 * 当前应注入子进程的数据命名空间。
 *
 * 进程内只解析一次：scope 变化必须重启应用才生效（已打开的 tasks-index / db.sqlite 句柄
 * 与缓存目录不会跟着搬），所以"读一次"不会比"每次读"更旧。
 */
export function resolveDesktopDataScope(env: Record<string, string | undefined> = process.env): string {
  if (cachedDataScope !== null) {
    return cachedDataScope;
  }
  const override = sanitizeZCodeDataScope(env[ZCODE_DATA_SCOPE_ENV_KEY]);
  cachedDataScope = override !== ZCODE_LOCAL_DATA_SCOPE ? override : readDataScopeMarker();
  return cachedDataScope;
}

function readDataScopeMarker(): string {
  const markerPath = getDesktopDataScopeMarkerFilePath();
  if (!existsSync(markerPath)) {
    return ZCODE_LOCAL_DATA_SCOPE;
  }
  try {
    return parseZCodeDataScopeMarkerFile(readFileSync(markerPath, "utf8")).scope;
  } catch {
    // marker 读不动 = 无法判断归属；回落本地态，不猜一个用户。
    return ZCODE_LOCAL_DATA_SCOPE;
  }
}

/** fork 子进程 env 补丁：把命名空间带进 Host / scheduler（agent 再从 Host 继承）。 */
export function buildDataScopeEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return { [ZCODE_DATA_SCOPE_ENV_KEY]: resolveDesktopDataScope(env) };
}

/** 仅供测试：清掉进程内缓存（scope 只在重启时变化，正常流程不需要）。 */
export function resetDesktopDataScopeCache(): void {
  cachedDataScope = null;
}
