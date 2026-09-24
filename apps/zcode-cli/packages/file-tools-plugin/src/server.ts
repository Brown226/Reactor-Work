/**
 * file-tools MCP server（官方内置插件的 stdio 形态，与 node_repl host 同链路）：
 * parse_document / ocr_scan / dwg_modify / dwg_graph 四个本地工具（dwg_modify 可读写，其余只读）。
 *
 * 关键约束：stdio MCP 的 stdout 就是 JSON-RPC 通道。pdfjs（"Warning: TT"）、
 * sidecar（"Open dwg file with error code"）等第三方会把诊断打到 console.log，
 * 必须整体改道 stderr，否则协议流被污染。
 */
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { PARSE_DOCUMENT_DESCRIPTION, parseDocument, parseDocumentInputSchema } from "./tools/parse-document.js";
import { OCR_SCAN_DESCRIPTION, ocrScan, ocrScanInputSchema } from "./tools/ocr-scan.js";
import { DWG_MODIFY_DESCRIPTION, dwgModify, dwgModifyInputSchema } from "./tools/dwg-modify.js";
import { DWG_GRAPH_DESCRIPTION, dwgGraph, dwgGraphInputSchema } from "./tools/dwg-graph.js";

const SERVER_NAME = "file-tools";
const SERVER_VERSION = "0.1.0";

export const FILE_TOOLS_MCP_PROCESS_TITLE = "zcode-file-tools-mcp";

const INVALID_PARAMS = -32602;
const OUTPUT_CLOSED_ERROR_CODES = new Set(["EPIPE", "EIO", "ENXIO", "EBADF", "ERR_STREAM_DESTROYED"]);

/** JSON Schema 由 zod 数组描述生成；工具名/描述即模型可见契约。 */
const tools: Tool[] = [
  {
    name: "parse_document",
    description: PARSE_DOCUMENT_DESCRIPTION,
    inputSchema: z.toJSONSchema(parseDocumentInputSchema) as Tool["inputSchema"],
  },
  {
    name: "ocr_scan",
    description: OCR_SCAN_DESCRIPTION,
    inputSchema: z.toJSONSchema(ocrScanInputSchema) as Tool["inputSchema"],
  },
  {
    name: "dwg_modify",
    description: DWG_MODIFY_DESCRIPTION,
    inputSchema: z.toJSONSchema(dwgModifyInputSchema) as Tool["inputSchema"],
  },
  {
    name: "dwg_graph",
    description: DWG_GRAPH_DESCRIPTION,
    inputSchema: z.toJSONSchema(dwgGraphInputSchema) as Tool["inputSchema"],
  },
];

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function textResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createFileToolsMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Local document/OCR/DWG tools. Use parse_document for Office/PDF, ocr_scan for scans and images, dwg_modify to read drawings (layers, texts, dimensions, standard references) and to modify them with structured ops, dwg_graph for symbol/connection topology (which equipment a symbol connects to). All engines run offline inside the installer.",
    },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));

  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    try {
      if (name === "parse_document") {
        const parsed = parseDocumentInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`parse_document: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await parseDocument(parsed.data));
      }
      if (name === "ocr_scan") {
        const parsed = ocrScanInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`ocr_scan: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await ocrScan(parsed.data));
      }
      if (name === "dwg_modify") {
        const parsed = dwgModifyInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`dwg_modify: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await dwgModify(parsed.data));
      }
      if (name === "dwg_graph") {
        const parsed = dwgGraphInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`dwg_graph: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await dwgGraph(parsed.data));
      }
      invalidParams(`Tool ${name} not found`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult({ status: "failed", error: message }, true);
    }
  });

  return server;
}

/** stdio 专属改道：stdout 是 JSON-RPC 通道，任何库的 console.log 都必须去 stderr。 */
function redirectStdoutNoiseToStderr(): void {
  const stderrProxy = (...args: unknown[]) => console.error(...args);
  console.log = stderrProxy;
  console.info = stderrProxy;
  console.debug = stderrProxy;
}

async function isDirectMcpEntrypoint(importMetaUrl: string, argvPath: string | undefined): Promise<boolean> {
  if (!argvPath) return false;
  try {
    // macOS /tmp、/var 等会解析到 /private/…；realpath 异步比较同时兼容 symlink 安装目录。
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(importMetaUrl)),
      realpath(argvPath),
    ]);
    return modulePath === executablePath;
  } catch {
    return false;
  }
}

function isOutputClosedError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && OUTPUT_CLOSED_ERROR_CODES.has(code);
}

export async function main(): Promise<void> {
  process.title = FILE_TOOLS_MCP_PROCESS_TITLE;

  // 异步错误降级为 stderr 日志：native 推理里未 await 的 reject 不击穿整个 server；
  // 输出管道关闭（父进程退出）时直接 shutdown，不写诊断避免 EPIPE 循环。
  let outputClosed = false;
  const report = (kind: string, reason: unknown): void => {
    if (outputClosed) return;
    if (isOutputClosedError(reason)) {
      outputClosed = true;
      shutdown();
      return;
    }
    const describe = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    try {
      process.stderr.write(`file-tools ${kind} (process kept alive): ${describe}\n`);
    } catch {
      outputClosed = true;
      shutdown();
    }
  };
  process.on("unhandledRejection", (reason) => report("unhandledRejection", reason));
  process.on("uncaughtException", (error) => report("uncaughtException", error));

  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    process.exit(0);
  };

  const handle = serveStdio(() => createFileToolsMcpServer());
  // MCP SDK 的 stdio transport 不监听 stdin end/close；父进程退出时收不到终点会沦为孤儿。
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.on("error", (error) => {
    if (isOutputClosedError(error)) shutdown();
  });
  void handle;
}

if (await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) {
  redirectStdoutNoiseToStderr();
  void main().catch((error) => {
    console.error(`file-tools MCP server failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
