/**
 * MCP stdio 端到端（dwg-tools）：spawn dist/mcp/server.js，
 * initialize → tools/list → tools/call（dwg_modify 读模式 + dwg_graph）。
 *
 * tools/list 只允许 dwg_modify / dwg_graph；file-tools / ocr-tools 的工具出现即失败
 * （拆分方案 docs/未完成-file-tools拆三插件方案.md）。
 *
 * 用法（须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）：
 *   node scripts/smoke-stdio.mjs [drawing.dwg]
 * 省略参数时用仓库内 fixture（docs/审查板块原始数据/标准库测试文档）；
 * sidecar 未发布（未跑 dotnet publish / scripts/prepare-file-tools-assets.mjs）或 fixture
 * 缺失时，该次调用按 SMOKE-SKIP 显式跳过并打印所缺项，不静默通过。
 * 退出码：0 通过；1 失败；2 有跳过的调用（未完整验证）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DWG_TOOLS = ["dwg_modify", "dwg_graph"];
/** 拆分后归属 file-tools / ocr-tools 的工具名；出现在本 server 的 tools/list 即回归。 */
const FOREIGN_TOOLS = [
  "parse_document",
  "docx_patch",
  "pdf_structure",
  "pdf_citations",
  "pdf_page_text",
  "pdf_region_text",
  "pdf_formula_candidates",
  "ocr_scan",
];
/** sidecar 缺失时工具返回的错误特征（src/dwg-sidecar.ts 的资产解析失败文案）。 */
const SIDECAR_MISSING_PATTERN = /DWG sidecar|sidecar 可执行文件|dwg-tools 资产不完整/;

// 仓库根：scripts → dwg-tools-plugin → packages → zcode-cli → apps → repoRoot
const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const fixtureRoot = resolve(repoRoot, "docs", "审查板块原始数据", "标准库测试文档");
const [, , dwgArg] = process.argv;
const dwgPath = dwgArg ?? resolve(fixtureRoot, "FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg");

const child = spawn(process.execPath, ["dist/mcp/server.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let skipped = 0;

child.stdout.on("data", (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
  for (;;) {
    const index = stdoutBuf.indexOf("\n");
    if (index === -1) break;
    const line = stdoutBuf.subarray(0, index).toString("utf8").trim();
    stdoutBuf = stdoutBuf.subarray(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)({ message, line });
    }
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[child-stderr] ${chunk.toString()}`);
});

async function request(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, resolveRequest);
    child.stdin.write(`${payload}\n`);
    setTimeout(() => rejectRequest(new Error(`timeout on ${method}`)), 300000);
  });
}

function fail(reason) {
  console.error(`SMOKE-FAIL: ${reason}`);
  child.kill();
  process.exit(1);
}

function skip(reason) {
  skipped += 1;
  console.log(`SMOKE-SKIP: ${reason}`);
}

function toolPayload(response) {
  return JSON.parse(response.message.result.content[0].text);
}

/** 工具调用失败的统一文案；成功返回 null。JSON-RPC error 与 isError 结果都算失败。 */
function toolErrorText(response) {
  if (response.message.error) return `JSON-RPC error: ${response.message.error.message}`;
  const result = response.message.result;
  if (!result) return "响应既无 result 也无 error";
  return result.isError ? (result.content?.[0]?.text ?? "(isError 无内容)") : null;
}

/**
 * 判定失败是「环境缺 sidecar」还是真回归：前者跳过（原因写清），后者失败退出。
 */
function sidecarMissingReason(errorText) {
  return SIDECAR_MISSING_PATTERN.test(errorText) ? errorText : null;
}

const init = await request("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.0" },
});
console.log("initialize ok, server:", init.message.result.serverInfo);

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const list = await request("tools/list");
const toolNames = list.message.result.tools.map((t) => t.name).sort();
console.log("tools:", toolNames.join(", "));
const extraTools = toolNames.filter((name) => !DWG_TOOLS.includes(name));
const missingTools = DWG_TOOLS.filter((name) => !toolNames.includes(name));
if (missingTools.length > 0) fail(`tools/list 缺少 ${missingTools.join(", ")}`);
if (extraTools.length > 0) {
  const foreign = extraTools.filter((name) => FOREIGN_TOOLS.includes(name));
  fail(
    `tools/list 出现非 dwg-tools 工具：${extraTools.join(", ")}` +
      (foreign.length > 0 ? `（${foreign.join(", ")} 归属其它插件）` : ""),
  );
}

if (!existsSync(dwgPath)) {
  skip(`未找到 DWG fixture（${dwgPath}），跳过 dwg_modify / dwg_graph 调用`);
} else {
  const readResult = await request("tools/call", {
    name: "dwg_modify",
    arguments: { file_path: dwgPath },
  });
  const readError = toolErrorText(readResult);
  if (readError) {
    const reason = sidecarMissingReason(readError);
    if (reason) {
      skip(`DWG sidecar 不可用，跳过 dwg_modify：${reason}`);
      skip(`DWG sidecar 不可用，跳过 dwg_graph：${reason}`);
    } else {
      fail(`dwg_modify 返回错误：${readError}`);
    }
  } else {
    const read = toolPayload(readResult);
    if (read.status !== "success") fail(`dwg_modify 读模式 status=${read.status}：${read.note ?? ""}`);
    console.log(
      "dwg_modify(read):",
      JSON.stringify({
        ok: true,
        version: read.metadata.version,
        layers: read.metadata.layerCount,
        texts: read.metadata.textCount,
        dimensions: read.metadata.dimensionCount,
        entityCount: read.metadata.entityCount,
        standardRefs: read.standardRefs.length,
        refSample: read.standardRefs.slice(0, 2),
        note: read.note,
      }),
    );

    const graphResult = await request("tools/call", {
      name: "dwg_graph",
      arguments: { file_path: dwgPath },
    });
    const graphError = toolErrorText(graphResult);
    if (graphError) {
      const reason = sidecarMissingReason(graphError);
      if (reason) skip(`DWG sidecar 不可用，跳过 dwg_graph：${reason}`);
      else fail(`dwg_graph 返回错误：${graphError}`);
    } else {
      const graph = toolPayload(graphResult);
      if (graph.status !== "success") fail(`dwg_graph status=${graph.status}：${graph.note ?? ""}`);
      console.log(
        "dwg_graph:",
        JSON.stringify({
          ok: true,
          nodes: graph.stats.nodeCount,
          edges: graph.stats.edgeCount,
          tagged: graph.stats.taggedNodeCount,
          isolated: graph.stats.isolatedNodeCount,
          truncated: graph.truncated,
          note: graph.note,
        }),
      );
    }
  }
}

const notFound = await request("tools/call", { name: "no_such_tool", arguments: {} });
// MCP 层两种合法形态：JSON-RPC error（无效 tool 名）或 isError 结果（服务端自行兜底）。
const unknownToolError =
  notFound.message.error?.message ?? notFound.message.result?.content?.[0]?.text;
if (!unknownToolError) fail("未知工具调用既没有 JSON-RPC error 也没有 isError 结果");
console.log("unknown tool:", JSON.stringify({ error: unknownToolError }));

child.kill();
if (skipped > 0) {
  console.log(`SMOKE-INCOMPLETE: ${skipped} 项调用被跳过（见上方 SMOKE-SKIP）`);
  process.exit(2);
}
console.log("E2E-OK");
