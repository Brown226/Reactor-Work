/**
 * file-tools MCP server（官方内置插件的 stdio 形态，与 node_repl host 同链路）：
 * parse_document / docx_patch / pdf_* 研读工具。
 * OCR 在 ocr-tools，DWG 在 dwg-tools（见 docs/未完成-file-tools拆三插件方案.md）。
 *
 * 关键约束：stdio MCP 的 stdout 就是 JSON-RPC 通道。pdfjs（"Warning: TT"）等
 * 第三方会把诊断打到 console.log，必须整体改道 stderr，否则协议流被污染。
 */
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { PARSE_DOCUMENT_DESCRIPTION, parseDocument, parseDocumentInputSchema } from "./tools/parse-document.js";
import { DOCX_PATCH_DESCRIPTION, docxPatch, docxPatchInputSchema } from "./tools/docx-patch.js";
import {
  PDF_CITATIONS_DESCRIPTION,
  PDF_FORMULA_CANDIDATES_DESCRIPTION,
  PDF_PAGE_TEXT_DESCRIPTION,
  PDF_REGION_TEXT_DESCRIPTION,
  PDF_STRUCTURE_DESCRIPTION,
  pdfCitations,
  pdfCitationsInputSchema,
  pdfFormulaCandidates,
  pdfFormulaCandidatesInputSchema,
  pdfPageText,
  pdfPageTextInputSchema,
  pdfRegionText,
  pdfRegionTextInputSchema,
  pdfStructure,
  pdfStructureInputSchema,
} from "./tools/pdf-research.js";

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
    name: "docx_patch",
    description: DOCX_PATCH_DESCRIPTION,
    inputSchema: z.toJSONSchema(docxPatchInputSchema) as Tool["inputSchema"],
  },
  {
    name: "pdf_structure",
    description: PDF_STRUCTURE_DESCRIPTION,
    inputSchema: z.toJSONSchema(pdfStructureInputSchema) as Tool["inputSchema"],
  },
  {
    name: "pdf_citations",
    description: PDF_CITATIONS_DESCRIPTION,
    inputSchema: z.toJSONSchema(pdfCitationsInputSchema) as Tool["inputSchema"],
  },
  {
    name: "pdf_page_text",
    description: PDF_PAGE_TEXT_DESCRIPTION,
    inputSchema: z.toJSONSchema(pdfPageTextInputSchema) as Tool["inputSchema"],
  },
  {
    name: "pdf_region_text",
    description: PDF_REGION_TEXT_DESCRIPTION,
    inputSchema: z.toJSONSchema(pdfRegionTextInputSchema) as Tool["inputSchema"],
  },
  {
    name: "pdf_formula_candidates",
    description: PDF_FORMULA_CANDIDATES_DESCRIPTION,
    inputSchema: z.toJSONSchema(pdfFormulaCandidatesInputSchema) as Tool["inputSchema"],
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
        "Local document tools (anydoc parse + docx surgical patch + PDF research). Use parse_document for Office/PDF body text, docx_patch to apply review fixes inside an existing .docx without touching its formatting (matched text only, copies by default). For paper/standard reading use pdf_structure / pdf_citations / pdf_page_text / pdf_region_text / pdf_formula_candidates. Scans/images and DWG drawings are other plugins' MCP servers, not tools of this one: ocr-tools provides ocr_scan, dwg-tools provides dwg_modify / dwg_graph. All engines run offline inside the installer.",
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
      if (name === "docx_patch") {
        const parsed = docxPatchInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`docx_patch: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await docxPatch(parsed.data));
      }
      if (name === "pdf_structure") {
        const parsed = pdfStructureInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`pdf_structure: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await pdfStructure(parsed.data.file_path));
      }
      if (name === "pdf_citations") {
        const parsed = pdfCitationsInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`pdf_citations: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(
          await pdfCitations(parsed.data.file_path, parsed.data.max_items),
        );
      }
      if (name === "pdf_page_text") {
        const parsed = pdfPageTextInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`pdf_page_text: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(
          await pdfPageText(parsed.data.file_path, parsed.data.start_page, parsed.data.end_page),
        );
      }
      if (name === "pdf_region_text") {
        const parsed = pdfRegionTextInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`pdf_region_text: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(
          await pdfRegionText(parsed.data.file_path, parsed.data.page, parsed.data.bbox),
        );
      }
      if (name === "pdf_formula_candidates") {
        const parsed = pdfFormulaCandidatesInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(
            `pdf_formula_candidates: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`,
          );
        }
        return textResult(
          await pdfFormulaCandidates(parsed.data.file_path, parsed.data.max_items),
        );
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
