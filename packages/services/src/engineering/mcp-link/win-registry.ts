/**
 * Windows 注册表候选安装根读取。
 *
 * 逆向自 PKPM Agent 的四路安装发现。三路来自注册表：
 *   1. 卸载表 InstallLocation / InstallDir（HKCU + HKLM + WOW6432Node）
 *   2. 产品自有配置键
 *   3. 文件关联 shell\open\command
 *
 * 非 Windows 平台或缺少注册表能力时返回空数组，由调用方用环境变量兜底。
 * 读注册表失败一律静默跳过：发现环节不该因为某个键读不到就整体失败。
 */

import type { CandidateRoot } from "./discovery.js";

/** 卸载表根，按 HKCU → HKLM → WOW6432Node 顺序。 */
const UNINSTALL_ROOTS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/** 产品显示名里出现这些片段即认为是目标产品。 */
const DISPLAY_NAME_MARKERS = ["BIMBase", "PlantS", "三维工厂结构设计系统"];

/** 从「命令字符串」里取出 exe 路径，支持带引号与不带引号两种写法。 */
export function extractExePath(command: string): string | undefined {
  const quoted = command.match(/^"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = command.match(/^([a-z]:\\[^\s"]*?\.exe)/i);
  return bare?.[1];
}

/** 从一个 exe 路径推回安装根（去掉是否在 bin 层，这里只取父目录）。 */
function rootOf(exePath: string): string {
  const index = exePath.lastIndexOf("\\");
  return index > 0 ? exePath.slice(0, index) : exePath;
}

interface RegistryApi {
  enumerableKeys(root: string): Promise<string[]>;
  readValue(root: string, name: string): Promise<string | undefined>;
}

/** 载入平台注册表能力；不可用时返回 undefined。 */
async function loadRegistryApi(): Promise<RegistryApi | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    // 动态导入，避免非 Windows 环境打不进包或构建期报缺失。
    const { execFile } = await import("node:child_process");
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve) => {
        execFile(
          "reg",
          args,
          { windowsHide: true },
          (error: Error | null, stdout: string) => {
            resolve(error ? "" : stdout);
          },
        );
      });

    return {
      async enumerableKeys(root: string): Promise<string[]> {
        const output = await run(["query", root]);
        return output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith(root + "\\"))
          .map((line) => line.slice(root.length + 1))
          .filter((name) => name && !name.includes("\\"));
      },
      async readValue(root: string, name: string): Promise<string | undefined> {
        const output = await run(["query", root, "/v", name]);
        const match = output.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i"));
        return match?.[1]?.trim();
      },
    };
  } catch {
    return undefined;
  }
}

/** 收集全部注册表候选安装根。失败时返回空数组。 */
export async function readRegistryRoots(): Promise<CandidateRoot[]> {
  const api = await loadRegistryApi();
  if (!api) return [];

  const roots: CandidateRoot[] = [];

  // 路 1：卸载表
  for (const table of UNINSTALL_ROOTS) {
    const entries = await api.enumerableKeys(table);
    for (const entry of entries) {
      const keyPath = `${table}\\${entry}`;
      const displayName = await api.readValue(keyPath, "DisplayName");
      if (!displayName) continue;
      if (!DISPLAY_NAME_MARKERS.some((marker) => displayName.includes(marker))) continue;

      const installLocation = await api.readValue(keyPath, "InstallLocation");
      if (installLocation && installLocation.trim()) {
        roots.push({ path: installLocation.trim(), source: "uninstall-registry" });
        continue;
      }
      const uninstallString = await api.readValue(keyPath, "UninstallString");
      const fromCommand = uninstallString ? extractExePath(uninstallString) : undefined;
      if (fromCommand) {
        roots.push({ path: rootOf(fromCommand), source: "uninstall-registry" });
      }
    }
  }

  // 路 2：产品自有配置键（记录上次成功启动的路径）
  const productKeys = ["HKCU\\SOFTWARE\\PKPMAgent2\\22", "HKCU\\SOFTWARE\\BIMBase"];
  for (const key of productKeys) {
    for (const valueName of ["InstallPath", "InstallDir", "Path", "ExePath"]) {
      const value = await api.readValue(key, valueName);
      if (!value || !value.trim()) continue;
      roots.push({
        path: value.trim().toLowerCase().endsWith(".exe") ? rootOf(value.trim()) : value.trim(),
        source: "product-registry",
      });
    }
  }

  // 路 3：文件关联（.p3d → shell\open\command）
  for (const extension of [".p3d", ".db1"]) {
    for (const base of ["HKCU\\SOFTWARE\\Classes", "HKLM\\SOFTWARE\\Classes"]) {
      const command = await api.readValue(`${base}\\${extension}\\shell\\open\\command`, "");
      if (!command) continue;
      const exe = extractExePath(command);
      if (exe) roots.push({ path: rootOf(exe), source: "file-association" });
    }
  }

  return roots;
}
