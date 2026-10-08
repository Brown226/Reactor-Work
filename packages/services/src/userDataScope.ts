/**
 * 用户数据命名空间的 marker 写入入口。
 *
 * 纯语义在 `@zcode/shared` 的 `userDataScope`，路径与 scope 解析在 `paths.ts`；
 * 这里只保留「Host 在登录态变更时同步落盘」这一件事——它是 Host 侧唯一的写者，
 * 否则两边各写一份 marker 会出现"日志说 A、磁盘是 B"的分叉。
 *
 * 为什么必须同步写：Renderer 在登录/登出 RPC 返回后就触发应用重启，marker 若还没落盘，
 * 新进程会按旧 scope 拉起数据，隔离当场失效（时序见方案文档 §3）。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stringifyZCodeDataScopeMarkerFile, sanitizeZCodeDataScope } from "@zcode/shared";
import { getZCodeDataScopeMarkerFilePath, getZCodeDataRootDir } from "./paths.js";

/** 原子写 marker（tmp + rename）：进程被 kill 的瞬间也不会留下半个 JSON。 */
export function writeZCodeDataScopeMarker(scope: string, uid?: string): void {
  const markerPath = getZCodeDataScopeMarkerFilePath();
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  mkdirSync(getZCodeDataRootDir(), { recursive: true });
  try {
    writeFileSync(
      temporaryPath,
      stringifyZCodeDataScopeMarkerFile({
        scope: sanitizeZCodeDataScope(scope),
        ...(uid ? { uid } : {}),
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    renameSync(temporaryPath, markerPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
