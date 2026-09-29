/**
 * dwg-tools MCP server：DWG 图纸读写（ACadSharp sidecar）。
 * 从 file-tools 拆出（docs/未完成-file-tools拆三插件方案.md）；工具名不变。
 */
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { DWG_GRAPH_DESCRIPTION, dwgGraph, dwgGraphInputSchema } from "./tools/dwg-graph.js";
import { DWG_MODIFY_DESCRIPTION, dwgModify, dwgModifyInputSchema } from "./tools/dwg-modify.js";

const SERVER_NAME = "dwg-tools";
const SERVER_VERSION = "0.1.0";

export const DWG_TOOLS_MCP_PROCESS_TITLE = "zcode-dwg-tools-mcp";

const INVALID_PARAMS = -32602;

const tools: Tool[] = [
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

export function createDwgToolsMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Local DWG drawing tools (ACadSharp sidecar, offline). Use dwg_modify read mode to extract layers/texts/dimensions/standard references, or to apply structured edits; use dwg_graph for symbol/connection topology. For Office/PDF body text use parse_document (file-tools); for scans use ocr_scan (ocr-tools).",
    },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));

  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    try {
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

if (isMain || process.env.ZCODE_DWG_TOOLS_MCP_STDLIO === "1") {
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
  void serveStdio(() => createDwgToolsMcpServer());
}
