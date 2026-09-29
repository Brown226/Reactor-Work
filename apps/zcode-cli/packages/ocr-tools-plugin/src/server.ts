/**
 * ocr-tools MCP server：扫描件/图片识字（office-engines Python 推理）。
 * 从 file-tools 拆出（见 docs/未完成-file-tools拆三插件方案.md）；工具名仍为 ocr_scan。
 */
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { OCR_SCAN_DESCRIPTION, ocrScan, ocrScanInputSchema } from "./tools/ocr-scan.js";

const SERVER_NAME = "ocr-tools";
const SERVER_VERSION = "0.1.0";

export const OCR_TOOLS_MCP_PROCESS_TITLE = "zcode-ocr-tools-mcp";

const INVALID_PARAMS = -32602;

const tools: Tool[] = [
  {
    name: "ocr_scan",
    description: OCR_SCAN_DESCRIPTION,
    inputSchema: z.toJSONSchema(ocrScanInputSchema) as Tool["inputSchema"],
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

export function createOcrToolsMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Offline image/scanned-PDF text recognition (PP-OCR via bundled office-engines Python). Use ocr_scan when Read on a PDF yields no text layer, or the user attaches a scan/photo. For electronic Office/PDF body text use parse_document (file-tools); for DWG use dwg-tools.",
    },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));

  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    try {
      if (name === "ocr_scan") {
        const parsed = ocrScanInputSchema.safeParse(request.params.arguments ?? {});
        if (!parsed.success) {
          invalidParams(`ocr_scan: ${parsed.error.issues[0]?.message ?? "invalid arguments"}`);
        }
        return textResult(await ocrScan(parsed.data));
      }
      return textResult({ error: `Unknown tool: ${name}` }, true);
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  });

  return server;
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1]?.replace(/\\/g, "/");
    return Boolean(argv1 && import.meta.url.endsWith(argv1.split("/").pop() ?? ""));
  } catch {
    return false;
  }
})();

if (isMain || process.env.ZCODE_OCR_TOOLS_MCP_STDLIO === "1") {
  // stdio MCP：stdout 是 JSON-RPC，诊断一律走 stderr
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
  void serveStdio(() => createOcrToolsMcpServer());
  void originalLog;
}
