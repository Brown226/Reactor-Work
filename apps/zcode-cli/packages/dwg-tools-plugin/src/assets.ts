/**
 * dwg-tools 资产定位：只关心 dwg-sidecar 子树。
 * 候选链与 file-tools 时代一致：显式 env → resourcesPath → 包内 assets/<platform>。
 * 候选求值收口到 @zcode/shared/node 的 firstExistingDir（原先手写循环，8 处同构之一）。
 */
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { firstExistingDir, firstExistingPath } from "@zcode/shared/node";

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function resolveDwgAssetsRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const explicit = env.ZCODE_DWG_TOOLS_ASSETS_ROOT?.trim();
  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : null;
  return firstExistingDir([
    explicit ? resolvePath(explicit) : null,
    resourcesPath ? join(resourcesPath, "tools", "dwg-tools") : null,
    join(cwd, "assets", platformKey()),
    resolvePath(fileURLToPath(import.meta.url), "..", "..", "assets", platformKey()),
    resolvePath(fileURLToPath(import.meta.url), "..", "..", "..", "assets", platformKey()),
  ]);
}

export function resolveSidecarDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = resolveDwgAssetsRoot(env);
  if (!root) return null;
  return firstExistingDir([join(root, "dwg-sidecar")]);
}
