#!/usr/bin/env node
/**
 * 实机端口探测：帮助确定 MCP 系工程软件（BIMBase / PKPM）的 MCP 服务端口。
 *
 * 为什么需要它：端口来源随厂商版本变化，仓库在无实机时无法确定
 * （mcp-link/links/bimbase.ts 的 readMcpPortForPid 因此返回 undefined）。
 * 在装有目标软件的机器上运行本脚本，可得到「进程 → 监听端口」的实际对应，
 * 据此实现 EngineeringPortResolver 并注入：
 *
 *   executor.setPortResolver((server, pid) => ({ bimbase: 12345 })[server]);
 *
 * 用法：
 *   node packages/services/scripts/probe-engineering-port.mjs [进程名关键词]
 * 例：
 *   node packages/services/scripts/probe-engineering-port.mjs BIMBase
 *
 * 只读：不启动软件、不改配置、不写盘。
 */

import { execFileSync } from "node:child_process";
import net from "node:net";

const keyword = (process.argv[2] || "").trim().toLowerCase();

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function listProcesses() {
  // 只依赖 ASCII 字段（PID、内存），中文进程名乱码不影响解析。
  const out = run("tasklist", ["/FO", "CSV", "/NH"]);
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
    if (cells.length < 2) continue;
    const pid = Number(cells[1]);
    if (!Number.isInteger(pid)) continue;
    rows.push({ name: cells[0], pid });
  }
  return rows;
}

function listListeningPorts() {
  // netstat 输出为纯 ASCII：TCP <local> <remote> LISTENING <pid>
  const out = run("netstat", ["-ano", "-p", "TCP"]);
  const byPid = new Map();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== "TCP") continue;
    if (parts[3].toUpperCase() !== "LISTENING") continue;
    const local = parts[1];
    const pid = Number(parts[4]);
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(pid) || !Number.isInteger(port)) continue;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push({ port, address: local.slice(0, local.lastIndexOf(":")) });
  }
  return byPid;
}

function probe(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const processes = listProcesses().filter(
  (p) => !keyword || p.name.toLowerCase().includes(keyword),
);
const portsByPid = listListeningPorts();

if (processes.length === 0) {
  console.log(
    keyword
      ? `未找到名称包含「${keyword}」的进程。请先启动目标软件，或换一个关键词。`
      : "未找到任何进程（tasklist 无输出）。",
  );
  process.exit(0);
}

for (const proc of processes) {
  const ports = portsByPid.get(proc.pid) ?? [];
  console.log(`\n进程 ${proc.name} (PID ${proc.pid})`);
  if (ports.length === 0) {
    console.log("  无 TCP 监听端口。若该软件的 MCP 服务尚未加载，启动后等待片刻再试。");
    continue;
  }
  for (const { port, address } of ports) {
    const ok = await probe(port);
    console.log(`  端口 ${String(port).padEnd(6)} 监听 ${address.padEnd(16)} 可连接=${ok}`);
  }
}

console.log(
  "\n把上面「可连接=true」的端口填进解析器，例如：\n" +
    "  executor.setPortResolver((server) => (server === \"bimbase\" ? <端口> : undefined));",
);
