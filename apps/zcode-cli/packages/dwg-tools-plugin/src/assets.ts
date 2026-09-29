/**
 * dwg-tools 资产定位：只关心 dwg-sidecar 子树。
 * 候选链与 file-tools 时代一致：显式 env → resourcesPath → 包内 assets/<platform>。
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function dirIfExists(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

export function resolveDwgAssetsRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const explicit = env.ZCODE_DWG_TOOLS_ASSETS_ROOT?.trim();
  if (explicit && existsSync(explicit)) return resolvePath(explicit);

  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : null;
  const candidates = [
    resourcesPath ? join(resourcesPath, "tools", "dwg-tools") : null,
    join(cwd, "assets", platformKey()),
    resolvePath(fileURLToPath(import.meta.url), "..", "..", "assets", platformKey()),
    resolvePath(fileURLToPath(import.meta.url), "..", "..", "..", "assets", platformKey()),
  ];
  for (const candidate of candidates) {
    if (candidate && dirIfExists(candidate)) return candidate;
  }
  return null;
}

export function resolveSidecarDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = resolveDwgAssetsRoot(env);
  if (!root) return null;
  return dirIfExists(join(root, "dwg-sidecar"));
}
