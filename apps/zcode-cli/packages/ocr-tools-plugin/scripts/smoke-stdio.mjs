/**
 * MCP stdio 端到端（ocr-tools）：spawn dist/mcp/server.js，
 * initialize → tools/list → tools/call（ocr_scan）。
 *
 * tools/list 只允许 ocr_scan；file-tools / dwg-tools 的工具出现即失败
 * （拆分方案 docs/未完成-file-tools拆三插件方案.md）。
 *
 * 用法（须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）：
 *   node scripts/smoke-stdio.mjs [图片或 PDF]
 * 省略参数时用仓库内 fixture（docs/审查板块原始数据/标准库测试文档/2.pdf）。
 * 开发态未显式设置 ZCODE_SKILL_ENGINE_ROOT 时，脚本按 officeEnginesEnv 的 dev 候选
 * （packages/desktop/bundled-tools/<platformKey>/office-engines）注入，便于本机冒烟；
 * 引擎缺失或 fixture 缺失时按 SMOKE-SKIP 显式跳过并打印原因，不静默通过。
 * 退出码：0 通过；1 失败；2 有跳过的调用（未完整验证）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const OCR_TOOLS = ["ocr_scan"];
/** 拆分后归属 file-tools / dwg-tools 的工具名；出现在本 server 的 tools/list 即回归。 */
const FOREIGN_TOOLS = [
  "parse_document",
  "docx_patch",
  "pdf_structure",
  "pdf_citations",
  "pdf_page_text",
  "pdf_region_text",
  "pdf_formula_candidates",
  "dwg_modify",
  "dwg_graph",
];
/** 引擎缺失时 ocr_scan 返回的 failed note 特征（src/ocr-python.ts 的 EngineUnavailableError 文案）。 */
const ENGINE_MISSING_PATTERN = /ENGINE_UNAVAILABLE|office-engines|office_skill_lib|Python/;

// 仓库根：scripts → ocr-tools-plugin → packages → zcode-cli → apps → repoRoot
const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const fixtureRoot = resolve(repoRoot, "docs", "审查板块原始数据", "标准库测试文档");
const [, , fileArg] = process.argv;
const targetPath = fileArg ?? resolve(fixtureRoot, "2.pdf");

// 开发态引擎根（与 packages/services/src/runtime-tools/officeEnginesEnv.ts 的 dev 候选一致）：
// 仅在本机未配置时兜底，绝不覆盖显式 env。
const devEngineRoot = resolve(
  repoRoot,
  "packages",
  "desktop",
  "bundled-tools",
  `${process.platform}-${process.arch}`,
  "office-engines",
);
const childEnv = { ...process.env };
if (!childEnv.ZCODE_SKILL_ENGINE_ROOT?.trim() && existsSync(devEngineRoot)) {
  childEnv.ZCODE_SKILL_ENGINE_ROOT = devEngineRoot;
  console.log(`using dev office-engines root: ${devEngineRoot}`);
}

const child = spawn(process.execPath, ["dist/mcp/server.js"], {
  cwd: process.cwd(),
  env: childEnv,
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

/** 区分「本机缺引擎」与真回归：前者跳过并写清原因，后者失败退出。 */
function engineMissingReason(payload) {
  const message = `${payload.error ?? ""}${payload.note ?? ""}`;
  return ENGINE_MISSING_PATTERN.test(message) ? message : null;
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
const extraTools = toolNames.filter((name) => !OCR_TOOLS.includes(name));
const missingTools = OCR_TOOLS.filter((name) => !toolNames.includes(name));
if (missingTools.length > 0) fail(`tools/list 缺少 ${missingTools.join(", ")}`);
if (extraTools.length > 0) {
  const foreign = extraTools.filter((name) => FOREIGN_TOOLS.includes(name));
  fail(
    `tools/list 出现非 ocr-tools 工具：${extraTools.join(", ")}` +
      (foreign.length > 0 ? `（${foreign.join(", ")} 归属其它插件）` : ""),
  );
}

if (!existsSync(targetPath)) {
  skip(`未找到图片/PDF fixture（${targetPath}），跳过 ocr_scan 调用`);
} else {
  const ocrResult = await request("tools/call", {
    name: "ocr_scan",
    arguments: { file_path: targetPath },
  });
  const ocrError = toolErrorText(ocrResult);
  if (ocrError) {
    fail(`ocr_scan 返回错误：${ocrError}`);
  } else {
    const ocr = toolPayload(ocrResult);
    if (ocr.status === "failed") {
      const reason = engineMissingReason(ocr);
      if (reason) skip(`OCR 引擎不可用，跳过 ocr_scan：${reason}`);
      else fail(`ocr_scan status=failed：${ocr.note ?? ""}`);
    } else {
      console.log(
        "ocr_scan:",
        JSON.stringify({
          ok: true,
          pages: ocr.pages,
          confidence: ocr.confidence,
          charCount: ocr.text.length,
          head: ocr.text.slice(0, 200),
          note: ocr.note,
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
