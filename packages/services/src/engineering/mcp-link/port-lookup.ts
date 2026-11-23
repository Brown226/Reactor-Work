/**
 * PID → 监听端口反查。
 *
 * 逆向自 PKPM Agent 的 `common_tools.pid_to_mcp_port(pid)`：
 * 原厂做法不是「读厂商写的配置文件」，而是**向运行实例要端口**——
 * `configure_endpoint(pid, exe_path, host)` 设端点、`get_plants_mcp_port(pid)` 取端口，
 * 两者都以 PID 为键。配置文件格式随厂商版本变化，PID 是稳定键。
 *
 * 因此这里实现的是「给定进程 PID，列出它正在监听的 TCP 端口」，再做候选排序与连通性确认。
 * 判定顺序：
 *   1. 优先回环地址（MCP 服务只监听 127.0.0.1）；
 *   2. 优先非特权端口（1024 以上，MCP 服务不会占用系统端口）；
 *   3. 端口号升序，保证同一进程多端口时结果稳定可复现。
 * 排序后逐个做 TCP 连接确认，第一个连通的即候选端口。
 *
 * 平台差异：
 *   - Windows：`Get-NetTCPConnection -State Listen -OwningProcess`（结构化 JSON，首选），
 *     失败时回退 `netstat -ano -p TCP` 解析 LISTENING 行。
 *   - Linux：`ss -lptnH`，从 `users:(("python",pid=1234,fd=7))` 里按 PID 过滤。
 *   - macOS/其他 POSIX：`lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`。
 * 任一命令失败都降级为空列表，不抛异常——反查不到就当作「拿不到端口」，
 * 由调用方给出明确提示，而不是猜测。
 */

import { execFile } from "node:child_process";

import { isPortOpen } from "./common.js";

/** 默认命令超时：进程/端口枚举本身应很快，卡住说明系统异常。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
/** 端口等待的默认上限，与 `BaseMCPLink` 的等端口上限保持一致。 */
const DEFAULT_PORT_WAIT_TIMEOUT_MS = 100_000;
/** 端口等待的默认轮询间隔。 */
const DEFAULT_PORT_POLL_INTERVAL_MS = 1_000;
/** 低于此值的端口视为系统特权端口，MCP 服务不会使用。 */
const PRIVILEGED_PORT_BOUNDARY = 1024;

/** 一个监听中的端口及其绑定地址。 */
export interface ListeningPort {
  port: number;
  /** 绑定地址；解析不到时为 undefined。 */
  address?: string;
}

/** 外部命令执行器；测试可注入替身，避免真的调用系统命令。 */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>;

export interface PortLookupOptions {
  /** 单条系统命令的超时。 */
  timeoutMs?: number;
  /** 覆盖平台判断，供测试使用。 */
  platform?: NodeJS.Platform;
  /** 覆盖命令执行器，供测试使用。 */
  run?: CommandRunner;
}

export interface McpPortLookupOptions extends PortLookupOptions {
  /** MCP 服务监听地址，默认本机回环。 */
  host?: string;
  /** 单个端口的连接确认超时。 */
  probeTimeoutMs?: number;
  /** 覆盖连通性探测，供测试使用。 */
  probe?: (port: number, host: string) => Promise<boolean>;
}

export interface McpPortWaitOptions extends McpPortLookupOptions {
  /** 等待端口出现的总上限。 */
  waitTimeoutMs?: number;
  /** 轮询间隔。 */
  pollIntervalMs?: number;
}

/** 默认命令执行器：失败返回空串，让上层降级而不是抛错。 */
const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });

/** 判断地址是否是回环。空地址视为未知，不当作回环也不排除。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.")
  );
}

/**
 * 候选端口排序。
 *
 * 不丢弃任何候选——排序只影响「先试哪个」，避免因判断过严把真端口排除掉。
 * 排序键依次为：回环优先、非特权端口优先、端口号升序。同端口只保留一条。
 */
export function rankCandidatePorts(ports: ListeningPort[]): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const item of ports) {
    if (!Number.isInteger(item.port) || item.port <= 0 || item.port > 65535) continue;
    const existing = byPort.get(item.port);
    // 同一端口出现多条时，优先保留带地址的那条（便于判断回环）。
    if (!existing || (!existing.address && item.address)) {
      byPort.set(item.port, item);
    }
  }

  return [...byPort.values()].sort((a, b) => {
    const loopbackDelta =
      Number(isLoopbackAddress(b.address)) - Number(isLoopbackAddress(a.address));
    if (loopbackDelta !== 0) return loopbackDelta;

    const privilegedDelta =
      Number(a.port < PRIVILEGED_PORT_BOUNDARY) - Number(b.port < PRIVILEGED_PORT_BOUNDARY);
    if (privilegedDelta !== 0) return privilegedDelta;

    return a.port - b.port;
  });
}

/**
 * 解析 Windows `Get-NetTCPConnection` 的 JSON 输出。
 *
 * 单条结果时 PowerShell 返回对象而不是数组，因此两种形态都要接受。
 */
export function parseNetTcpConnection(output: string): ListeningPort[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const ports: ListeningPort[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const port = typeof record.LocalPort === "number" ? record.LocalPort : undefined;
    if (!port) continue;
    const address =
      typeof record.LocalAddress === "string" ? record.LocalAddress : undefined;
    ports.push({ port, address });
  }
  return ports;
}

/**
 * 解析 `netstat -ano -p TCP` 的输出，按 PID 过滤 LISTENING 行。
 *
 * 行格式：`  TCP    127.0.0.1:8000    0.0.0.0:0    LISTENING    1234`
 * 本地地址列可能是 `[::1]:8000` 形式，因此按最后一个冒号切分端口。
 */
export function parseWindowsNetstat(output: string, pid: number): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 5) continue;
    const [protocol, local, , state, owner] = cells;
    if (protocol?.toUpperCase() !== "TCP") continue;
    if (state?.toUpperCase() !== "LISTENING") continue;
    if (Number(owner) !== pid) continue;
    if (!local) continue;

    const separator = local.lastIndexOf(":");
    if (separator <= 0) continue;
    const port = Number(local.slice(separator + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    ports.push({ port, address: local.slice(0, separator) });
  }
  return ports;
}

/**
 * 解析 Linux `ss -lptnH` 的输出，按 PID 过滤。
 *
 * 行格式：`LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:(("python",pid=1234,fd=7))`
 * `-H` 去掉表头，因此每行都是数据行。
 */
export function parsePosixSs(output: string, pid: number): ListeningPort[] {
  const ports: ListeningPort[] = [];
  const pidPattern = new RegExp(`pid=${pid}(?:,|\\))`);
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !pidPattern.test(trimmed)) continue;

    const cells = trimmed.split(/\s+/);
    // 取第 4 列（本地地址:端口）；缺列时按「含冒号的第一个单元格」兜底。
    const local = cells[3] ?? cells.find((cell) => /:\d+$/.test(cell));
    if (!local) continue;

    const separator = local.lastIndexOf(":");
    if (separator <= 0) continue;
    const port = Number(local.slice(separator + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    ports.push({ port, address: local.slice(0, separator) });
  }
  return ports;
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` 的输出。
 *
 * 行格式：`python 1234 user 7u IPv4 0x1234 0t0 TCP 127.0.0.1:8000 (LISTEN)`
 * 只有带 `(LISTEN)` 的行才是监听态；本地地址列在 `TCP`/`UDP` 之后。
 */
export function parseLsof(output: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("(LISTEN)")) continue;

    const cells = trimmed.split(/\s+/);
    const protocolIndex = cells.findIndex((cell) => cell === "TCP" || cell === "UDP");
    const local = protocolIndex >= 0 ? cells[protocolIndex + 1] : undefined;
    if (!local) continue;

    const separator = local.lastIndexOf(":");
    if (separator <= 0) continue;
    const port = Number(local.slice(separator + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    ports.push({ port, address: local.slice(0, separator) });
  }
  return ports;
}

/**
 * 列出指定进程正在监听的 TCP 端口。
 *
 * 命令失败一律返回空列表：反查是「尽力而为」的增强路径，
 * 拿不到时调用方会走启动分支或给出明确提示，不应因此抛异常。
 */
export async function findListeningPortsByPid(
  pid: number,
  options: PortLookupOptions = {},
): Promise<ListeningPort[]> {
  if (!Number.isInteger(pid) || pid <= 0) return [];

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunner;

  try {
    if (platform === "win32") {
      return await listPortsWindows(pid, timeoutMs, run);
    }
    if (platform === "linux") {
      return await listPortsLinux(pid, timeoutMs, run);
    }
    return await listPortsLsof(pid, timeoutMs, run);
  } catch {
    return [];
  }
}

async function listPortsWindows(
  pid: number,
  timeoutMs: number,
  run: CommandRunner,
): Promise<ListeningPort[]> {
  const script =
    `Get-NetTCPConnection -State Listen -OwningProcess ${pid} ` +
    `| Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress`;
  const output = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
  );
  const structured = parseNetTcpConnection(output);
  if (structured.length > 0) return structured;

  // Get-NetTCPConnection 在旧系统或受限环境下可能不可用，回退 netstat。
  const netstat = await run("netstat", ["-ano", "-p", "TCP"], timeoutMs);
  return parseWindowsNetstat(netstat, pid);
}

async function listPortsLinux(
  pid: number,
  timeoutMs: number,
  run: CommandRunner,
): Promise<ListeningPort[]> {
  const output = await run("ss", ["-lptnH"], timeoutMs);
  const parsed = parsePosixSs(output, pid);
  if (parsed.length > 0) return parsed;

  // ss 在精简镜像里可能不存在，回退 lsof。
  return listPortsLsof(pid, timeoutMs, run);
}

async function listPortsLsof(
  pid: number,
  timeoutMs: number,
  run: CommandRunner,
): Promise<ListeningPort[]> {
  const output = await run(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
    timeoutMs,
  );
  return parseLsof(output);
}

/**
 * 反查指定进程的 MCP 端口，并用 TCP 连接确认可达。
 *
 * 排序后逐个探测，第一个可连通的端口即为结果；全部不可连通时返回 undefined。
 * 探测是必要的：进程可能监听多个端口（日志、插件通信），
 * 只有真正能接受连接的才是 MCP 服务。
 */
export async function findMcpPortByPid(
  pid: number,
  options: McpPortLookupOptions = {},
): Promise<number | undefined> {
  const ports = rankCandidatePorts(await findListeningPortsByPid(pid, options));
  const host = options.host ?? "127.0.0.1";
  const probe =
    options.probe ?? ((port: number, target: string) => isPortOpen(port, target, options.probeTimeoutMs));

  for (const candidate of ports) {
    if (await probe(candidate.port, host)) {
      return candidate.port;
    }
  }
  return undefined;
}

/**
 * 轮询等待进程的 MCP 端口出现。
 *
 * 冷启动场景：软件刚被拉起，内嵌 MCP 脚本要等进入主界面后才开始监听。
 * 因此这里按固定间隔重复反查，直到超时返回 undefined——不抛异常，
 * 由调用方给出「已启动但未取得端口」的明确文案。
 */
export async function waitForMcpPortByPid(
  pid: number,
  options: McpPortWaitOptions = {},
): Promise<number | undefined> {
  const deadline = Date.now() + (options.waitTimeoutMs ?? DEFAULT_PORT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PORT_POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    const port = await findMcpPortByPid(pid, options);
    if (port !== undefined) return port;
    if (Date.now() + pollIntervalMs >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return undefined;
}
