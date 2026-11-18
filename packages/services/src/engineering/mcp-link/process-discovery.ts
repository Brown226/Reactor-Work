/**
 * 进程枚举：找出目标软件的已运行实例。
 *
 * 逆向自 PKPM Agent 的 `_find_running_plants` / `_matches_target`：
 * 遍历进程表，按可执行文件路径匹配，命中即复用而不是重复启动。
 *
 * 设计要点：
 *   - 只读进程名与路径，不读命令行参数（部分系统上读取参数需要额外权限）。
 *   - 路径比较用 normcase 语义：Windows 上大小写不敏感、分隔符归一。
 *   - 任一平台失败降级为空列表，不抛异常——发现不到就当作未运行。
 */

import { execFile } from "node:child_process";

/** 一个匹配到的进程。 */
export interface MatchedProcess {
  pid: number;
  /** 可执行文件路径；拿不到时为 undefined（只按名称匹配）。 */
  exePath?: string;
}

/** 路径归一：统一分隔符与大小写（仅 Windows 大小写不敏感）。 */
export function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** 取归一化路径的最后一段。 */
function basenameOf(normalizedPath: string): string {
  const index = normalizedPath.lastIndexOf("/");
  return index >= 0 ? normalizedPath.slice(index + 1) : normalizedPath;
}

/** 判断两个路径是否指向同一文件（按归一化后比较）。 */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * 列出与目标可执行文件匹配的进程。
 *
 * Windows 用 PowerShell 的 Get-CimInstance（比 wmic 更可靠，wmic 在新版
 * 系统上已被移除）；POSIX 用 ps。
 */
export async function findProcessesByExecutable(
  exePath: string,
  options: { timeoutMs?: number } = {},
): Promise<MatchedProcess[]> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  try {
    if (process.platform === "win32") {
      return await listWindows(exePath, timeoutMs);
    }
    return await listPosix(exePath, timeoutMs);
  } catch {
    return [];
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

async function listWindows(exePath: string, timeoutMs: number): Promise<MatchedProcess[]> {
  const script =
    "Get-CimInstance Win32_Process | " +
    "Where-Object { $_.ExecutablePath } | " +
    "Select-Object ProcessId,ExecutablePath | " +
    "ConvertTo-Json -Compress";
  const output = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
  );
  if (!output.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const matches: MatchedProcess[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.ExecutablePath === "string" ? record.ExecutablePath : undefined;
    const pid = typeof record.ProcessId === "number" ? record.ProcessId : undefined;
    if (!pid || !path) continue;
    if (samePath(path, exePath)) matches.push({ pid, exePath: path });
  }
  return matches;
}

async function listPosix(exePath: string, timeoutMs: number): Promise<MatchedProcess[]> {
  const output = await run("ps", ["-eo", "pid=,comm="], timeoutMs);
  if (!output.trim()) return [];
  const target = normalizePath(exePath);
  const matches: MatchedProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const command = trimmed.slice(space + 1).trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // ps 的 comm 只有可执行文件名（无目录），所以两头都取 basename 比较。
    // 这是 posix 下的固有限制：拿不到完整路径时只能按名字匹配，
    // 因此本函数在 posix 上的结果仅供参考，调用方仍需做存在性确认。
    const commName = normalizePath(command);
    const targetName = basenameOf(target);
    if (commName === target || commName === targetName || target.endsWith(`/${commName}`)) {
      matches.push({ pid, exePath: command });
    }
  }
  return matches;
}

/** 判断进程是否还活着。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
