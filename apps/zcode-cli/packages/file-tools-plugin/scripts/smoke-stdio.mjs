/** MCP stdio 端到端：spawn dist/mcp/server.js，initialize → tools/list → tools/call 四工具。 */
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["dist/mcp/server.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;

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

const workspace = "E:/工作/Reactor-Work/docs/审查板块原始数据/标准库测试文档";
const [, , docArg, dwgArg] = process.argv;

const init = await request("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.0" },
});
console.log("initialize ok, server:", init.message.result.serverInfo);

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const list = await request("tools/list");
const toolNames = list.message.result.tools.map((t) => t.name);
console.log("tools:", toolNames.join(", "));
for (const expected of ["parse_document", "ocr_scan", "dwg_modify", "dwg_graph"]) {
  if (!toolNames.includes(expected)) {
    console.error(`SMOKE-FAIL: tools/list 缺少 ${expected}`);
    child.kill();
    process.exit(1);
  }
}

const parseResult = await request("tools/call", {
  name: "parse_document",
  arguments: { file_path: docArg },
});
const parseContent = JSON.parse(parseResult.message.result.content[0].text);
console.log("parse_document:", JSON.stringify({
  ok: true,
  parser: parseContent.parser,
  charCount: parseContent.charCount,
  head: parseContent.markdown.slice(11, 200),
}));

const dwgResult = await request("tools/call", {
  name: "dwg_modify",
  arguments: { file_path: dwgArg },
});
const dwgContent = JSON.parse(dwgResult.message.result.content[0].text);
console.log("dwg_modify(read):", JSON.stringify({
  status: dwgContent.status,
  version: dwgContent.metadata.version,
  layers: dwgContent.metadata.layerCount,
  texts: dwgContent.metadata.textCount,
  entityCount: dwgContent.metadata.entityCount,
  standardRefs: dwgContent.standardRefs.length,
  refSample: dwgContent.standardRefs.slice(0, 2),
  note: dwgContent.note,
}));

const graphResult = await request("tools/call", {
  name: "dwg_graph",
  arguments: { file_path: dwgArg },
});
const graphContent = JSON.parse(graphResult.message.result.content[0].text);
console.log("dwg_graph:", JSON.stringify({
  status: graphContent.status,
  nodes: graphContent.stats.nodeCount,
  edges: graphContent.stats.edgeCount,
  tagged: graphContent.stats.taggedNodeCount,
  isolated: graphContent.stats.isolatedNodeCount,
  truncated: graphContent.truncated,
  note: graphContent.note,
}));

const missing = await request("tools/call", {
  name: "parse_document",
  arguments: { file_path: "Z:/does-not-exist.docx" },
});
const missingContent = JSON.parse(missing.message.result.content[0].text);
console.log("missing-file handling:", JSON.stringify({ isError: missing.message.result.isError, content: missingContent }));

const notFound = await request("tools/call", { name: "no_such_tool", arguments: {} });
console.log("unknown tool:", JSON.stringify({ error: notFound.message.error?.message }));

child.kill();
console.log("E2E-OK");
