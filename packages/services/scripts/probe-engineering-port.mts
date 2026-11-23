#!/usr/bin/env node
/**
 * 实机端口探测：帮助确认 MCP 系工程软件（BIMBase / PKPM）的 MCP 服务端口。
 *
 * 为什么要它：端口来源随厂商版本变化，仓库在无实机时无法确定具体格式，
 * 因此在装了目标软件的机器上跑一次，看「进程 → 监听端口 → 是否可连接」。
 *
 * 关键点：本脚本直接复用连接层同一套实现（port-lookup.ts 的解析、排序与
 * 连通确认），所以这里打印的「生产反查结果」就是 BimBaseLink 实际会用的
 * 端口，不会出现探测脚本通过、生产环境拿到另一个端口的情况。
 *
 * 用法：
 *   npx tsx packages/services/scripts/probe-engineering-port.mts [进程名关键词]
 * 例：
 *   npx tsx packages/services/scripts/probe-engineering-port.mts BIMBase
 *
 * 只读：不启动软件、不改配置、不写盘。
 */

import { execFileSync } from "node:child_process";

import { isPortOpen } from "../src/engineering/mcp-link/common.js";
import {
  findListeningPortsByPid,
  findMcpPortByPid,
  rankCandidatePorts,
} from "../src/engineering/mcp-link/port-lookup.js";

const keyword = (process.argv[2] || "").trim().toLowerCase();

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

interface ProcessRow {
  name: string;
  pid: number;
}

function listProcesses(): ProcessRow[] {
  // 只依赖 ASCII 字段（PID、内存），中文进程名乱码不影响解析。
  const out = run("tasklist", ["/FO", "CSV", "/NH"]);
  const rows: ProcessRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
    if (cells.length < 2) continue;
    const pid = Number(cells[1]);
    if (!Number.isInteger(pid)) continue;
    rows.push({ name: cells[0] ?? "", pid });
  }
  return rows;
}

const processes = listProcesses().filter((p) => !keyword || p.name.toLowerCase().includes(keyword));

if (processes.length === 0) {
  console.log(
    keyword
      ? `未找到名称包含「${keyword}」的进程。请先启动目标软件，或换一个关键词。`
      : "未找到任何进程（tasklist 无输出）。",
  );
  process.exit(0);
}

for (const proc of processes) {
  const ports = rankCandidatePorts(await findListeningPortsByPid(proc.pid));
  console.log(`\n进程 ${proc.name} (PID ${proc.pid})`);
  if (ports.length === 0) {
    console.log("  无 TCP 监听端口。若该软件的 MCP 服务尚未加载，启动后等待片刻再试。");
    continue;
  }
  for (const { port, address } of ports) {
    const ok = await isPortOpen(port);
    console.log(`  端口 ${String(port).padEnd(6)} 监听 ${(address ?? "").padEnd(16)} 可连接=${ok}`);
  }
  const resolved = await findMcpPortByPid(proc.pid);
  console.log(
    resolved === undefined
      ? "  生产反查结果：未找到可连接的监听端口（连接层会返回「未能取得 MCP 服务端口」）"
      : `  生产反查结果：${resolved}（BimBaseLink 会直接用这个端口握手）`,
  );
}
