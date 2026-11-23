/**
 * 连接层公共工具：端口探测、等待就绪。
 *
 * 逆向自 PKPM Agent 的 mcp_link/common_tools：
 *   is_local_port_opened(port) / pid_to_mcp_port(pid) / wait_local_mcp_ready(port, timeout)
 * 其中 is_local_port_opened 与 wait_local_mcp_ready 在本文件；
 * pid_to_mcp_port 需要平台进程/端口命令，见同目录 port-lookup.ts。
 */

import { createConnection } from "node:net";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_CONNECT_TIMEOUT_MS = 1000;

/** 探测本机端口是否可建立 TCP 连接。 */
export function isPortOpen(
  port: number,
  host = "127.0.0.1",
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ port, host });

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** 轮询等待端口可用；超时抛错，错误文案带等待时长与端口号。 */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  host = "127.0.0.1",
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return;
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `MCP 服务未在端口 ${port} 就绪（已等待 ${Math.round(timeoutMs / 1000)} 秒）`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
