import { existsSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { resolvePlatformScopedBundledToolRoots } from "./runtimeToolResolver.js";

/**
 * 办公四件套 skill 的本地引擎解析（LibreOffice / 便携 Python + wheels / CJK 字体）。
 *
 * 资产由 `scripts/prepare-office-engines-assets.mjs` 打进
 * `bundled-tools/<platform>/office-engines`，electron-builder 随安装包发到
 * `resources/tools/office-engines`（见 packages/desktop/electron-builder.config.js）。
 * skill 的 `env_setup/env_check.sh` 只认 env 契约：ZCODE_SKILL_ENGINE_ROOT 或
 * ZCODE_LIBREOFFICE_PATH / ZCODE_PYTHON_PATH / ZCODE_FONT_DIR；这里负责把可用的引擎
 * 翻译成那组 env，并把可执行目录追加进 PATH。解析范围包括：显式 env、安装器内置资产、
 * **用户/IT 自行安装的 LibreOffice**（Windows 标准安装位、macOS App、Linux PATH 常见位，
 * 因 LibreOffice 安装器默认不写 PATH，这是当前部署策略的主渲染来源）。
 */

const OFFICE_ENGINES_RESOURCE_DIR = "office-engines";

export interface OfficeEnginesEnvPatch {
  env: Record<string, string>;
  pathEntries: string[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstExistingFile(candidates: Array<string | null>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 引擎根候选链（与 runtimeToolResolver.findRuntimeToolBinary 同思路）：
 * 显式 env > server runtime root > Electron resourcesPath > 平台域 bundled-tools（dev）。
 */
export function resolveOfficeEnginesRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ZCODE_SKILL_ENGINE_ROOT?.trim();
  if (explicit && isDirectory(explicit)) {
    return explicit;
  }

  const resourcesPath =
    typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      : null;
  const runtimeRoot = env.ZCODE_SERVER_RUNTIME_ROOT?.trim();
  const candidate = [
    runtimeRoot ? resolvePath(runtimeRoot, "tools", OFFICE_ENGINES_RESOURCE_DIR) : null,
    resourcesPath ? resolvePath(resourcesPath, "tools", OFFICE_ENGINES_RESOURCE_DIR) : null,
    ...resolvePlatformScopedBundledToolRoots(import.meta.dirname).map((root) =>
      root ? resolvePath(root, OFFICE_ENGINES_RESOURCE_DIR) : null,
    ),
  ].find((path) => path && isDirectory(path));

  return candidate ?? null;
}

function resolveSoffice(root: string | null, env: NodeJS.ProcessEnv): string | null {
  // 0) 显式 env 优先（IT/用户指定），随后是安装器内置资产，最后是系统标准安装位置。
  //    Windows 上 LibreOffice 安装器默认不写 PATH，「装了但 command -v soffice 失败」
  //    是最常见形态，所以标准安装位置必须探测（env_check 的提示也指向这些路径）。
  const explicit = env.ZCODE_LIBREOFFICE_PATH?.trim();
  const candidates = [
    explicit && existsSync(explicit) ? explicit : null,
    root ? join(root, "libreoffice", "program", "soffice.exe") : null,
    root ? join(root, "libreoffice", "program", "soffice") : null,
    ...wellKnownSofficePaths(env),
  ];
  return firstExistingFile(candidates);
}

function wellKnownSofficePaths(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? env.PROGRAMFILES_X86 ?? "C:\\Program Files (x86)";
  if (process.platform === "win32") {
    return [
      join(programFiles, "LibreOffice", "program", "soffice.exe"),
      join(programFilesX86, "LibreOffice", "program", "soffice.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  }
  return ["/usr/bin/soffice", "/usr/local/bin/soffice", "/opt/libreoffice/program/soffice"];
}

function resolvePython(root: string): string | null {
  return firstExistingFile([
    join(root, "python", "bin", "python3.exe"),
    join(root, "python", "bin", "python3"),
    join(root, "python", "bin", "python.exe"),
    join(root, "python", "python3.exe"),
    join(root, "python", "python3"),
    join(root, "python", "python.exe"),
  ]);
}

export function buildOfficeEnginesEnvPatch(
  baseEnv: NodeJS.ProcessEnv = process.env,
): OfficeEnginesEnvPatch {
  const root = resolveOfficeEnginesRoot(baseEnv);
  // 无内置资产时不能提前返回：用户自行安装的 LibreOffice（标准位置/已注册 PATH）就是
  // 当前部署策略的主渲染引擎，探测与 PATH 前置必须照常生效。
  const env: Record<string, string> = {};
  if (root) {
    env.ZCODE_SKILL_ENGINE_ROOT = root;
  }
  const pathEntries: string[] = [];

  const soffice = resolveSoffice(root, baseEnv);
  if (soffice) {
    env.ZCODE_LIBREOFFICE_PATH = soffice;
    pathEntries.push(resolvePath(soffice, ".."));
  }

  const python = root ? resolvePython(root) : null;
  if (python) {
    env.ZCODE_PYTHON_PATH = python;
    pathEntries.push(resolvePath(python, ".."));
  }

  if (root) {
    const fontsDir = join(root, "fonts");
    if (isDirectory(fontsDir)) {
      env.ZCODE_FONT_DIR = fontsDir;
    }
  }

  return { env, pathEntries };
}
