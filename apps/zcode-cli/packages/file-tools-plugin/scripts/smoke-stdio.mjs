/**
 * MCP stdio 端到端（file-tools）：spawn dist/mcp/server.js，
 * initialize → tools/list → tools/call（parse_document / pdf_structure + 错误路径）。
 *
 * tools/list 只允许 file-tools 归属的工具；ocr_scan / dwg_* 已拆到 ocr-tools / dwg-tools，
 * 本 server 再暴露它们即失败（拆分方案 docs/未完成-file-tools拆三插件方案.md）。
 *
 * 用法（须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）：
 *   node scripts/smoke-stdio.mjs [office 文档] [pdf]
 * 省略参数时用仓库内 fixture（docs/审查板块原始数据/标准库测试文档）；fixture 不存在时
 * 该次调用按 SMOKE-SKIP 显式跳过并打印原因，不会静默通过。
 * 退出码：0 通过；1 失败；2 有跳过的调用（未完整验证）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FILE_TOOLS = [
  "parse_document",
  "docx_patch",
  "pdf_structure",
  "pdf_citations",
  "pdf_page_text",
  "pdf_region_text",
  "pdf_formula_candidates",
];
/** 拆分后归属 ocr-tools / dwg-tools 的工具名；出现在本 server 的 tools/list 即回归。 */
const MOVED_AWAY_TOOLS = ["ocr_scan", "dwg_modify", "dwg_graph"];

// 仓库根：scripts → file-tools-plugin → packages → zcode-cli → apps → repoRoot
const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const fixtureRoot = resolve(repoRoot, "docs", "审查板块原始数据", "标准库测试文档");
const [, , docArg, pdfArg] = process.argv;
const docPath = docArg ?? resolve(fixtureRoot, "智能辅助设计平台-软件说明书.docx");
const pdfPath = pdfArg ?? resolve(fixtureRoot, "2.pdf");

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
// 归属工具必须齐全；多出来的工具（尤其迁走的 ocr/dwg）一律判失败。
const extraTools = toolNames.filter((name) => !FILE_TOOLS.includes(name));
const missingTools = FILE_TOOLS.filter((name) => !toolNames.includes(name));
if (missingTools.length > 0) fail(`tools/list 缺少 ${missingTools.join(", ")}`);
if (extraTools.length > 0) {
  const moved = extraTools.filter((name) => MOVED_AWAY_TOOLS.includes(name));
  fail(
    `tools/list 出现非 file-tools 工具：${extraTools.join(", ")}` +
      (moved.length > 0 ? `（${moved.join(", ")} 已迁至 ocr-tools / dwg-tools）` : ""),
  );
}

if (!existsSync(docPath)) {
  skip(`未找到 Office 文档 fixture（${docPath}），跳过 parse_document 调用`);
} else {
  const parseResult = await request("tools/call", {
    name: "parse_document",
    arguments: { file_path: docPath },
  });
  const parseError = toolErrorText(parseResult);
  if (parseError) fail(`parse_document 返回错误：${parseError}`);
  const parseContent = toolPayload(parseResult);
  console.log(
    "parse_document:",
    JSON.stringify({
      ok: true,
      parser: parseContent.parser,
      charCount: parseContent.charCount,
      head: parseContent.markdown.slice(11, 200),
    }),
  );
}

if (!existsSync(pdfPath)) {
  skip(`未找到 PDF fixture（${pdfPath}），跳过 pdf_structure 调用`);
} else {
  const structureResult = await request("tools/call", {
    name: "pdf_structure",
    arguments: { file_path: pdfPath },
  });
  const structureError = toolErrorText(structureResult);
  if (structureError) fail(`pdf_structure 返回错误：${structureError}`);
  const structure = toolPayload(structureResult);
  console.log(
    "pdf_structure:",
    JSON.stringify({
      ok: true,
      pages: structure.page_count,
      title: structure.title,
      outline: structure.outline.length,
      sections: structure.sections.length,
      figures: structure.figures.length,
    }),
  );
}

// 错误路径：不存在的文件必须返回结构化错误（isError 或 JSON-RPC error），不能崩 server。
const missing = await request("tools/call", {
  name: "parse_document",
  arguments: { file_path: "Z:/does-not-exist.docx" },
});
const missingError = toolErrorText(missing);
if (!missingError) fail("parse_document 对不存在的文件没有返回错误");
console.log("missing-file handling:", JSON.stringify({ isError: true, content: missingError }));

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
