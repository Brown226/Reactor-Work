/**
 * dwg-tools MCP server：DWG 图纸读写（ACadSharp sidecar）。
 * 从 file-tools 拆出（docs/未完成-file-tools拆三插件方案.md）；工具名不变。
 */
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { DWG_GRAPH_DESCRIPTION, dwgGraph, dwgGraphInputSchema } from "./tools/dwg-graph.js";
import { DWG_MODIFY_DESCRIPTION, dwgModify, dwgModifyInputSchema } from "./tools/dwg-modify.js";

const SERVER_NAME = "dwg-tools";
const SERVER_VERSION = "0.1.0";

export const DWG_TOOLS_MCP_PROCESS_TITLE = "zcode-dwg-tools-mcp";

const INVALID_PARAMS = -32602;
const OUTPUT_CLOSED_ERROR_CODES = new Set(["EPIPE", "EIO", "ENXIO", "EBADF", "ERR_STREAM_DESTROYED"]);

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

/**
 * 插件宿主入口：agent 子进程用 `__zcode-plugin-host <server.js>` import 本模块后调 main()。
 * 缺这个导出时宿主直接报 "Plugin server does not export main()." 退出，
 * MCP 设置页显示「MCP 进程启动失败」（与 file-tools 对齐，见
 * docs/已完成/已完成-dwg-ocr-tools插件宿主启动失败修复.md）。
 */
export async function main(): Promise<void> {
  process.title = DWG_TOOLS_MCP_PROCESS_TITLE;

  // stdio MCP：stdout 是 JSON-RPC 通道，sidecar/pydwg 诊断一律走 stderr
  const stderrProxy = (...args: unknown[]) => console.error(...args);
  console.log = stderrProxy;
  console.info = stderrProxy;
  console.debug = stderrProxy;

  // 异步错误降级为 stderr 日志：sidecar 推理里未 await 的 reject 不击穿整个 server；
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
      process.stderr.write(`dwg-tools ${kind} (process kept alive): ${describe}\n`);
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

  const handle = serveStdio(() => createDwgToolsMcpServer());
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

async function isDirectMcpEntrypoint(importMetaUrl: string, argvPath: string | undefined): Promise<boolean> {
  if (!argvPath) return false;
  try {
    // macOS /tmp、/var 等会解析到 /private/…；realpath 异步比较同时兼容 symlink 安装目录。
    // 不能用文件名尾部匹配：插件宿主会把 process.argv[1] 置为 server.js 路径，
    // 尾部匹配会把宿主 import 误判成直接运行，导致模块加载即启动、双重 serveStdio。
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

if (
  (await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) ||
  process.env.ZCODE_DWG_TOOLS_MCP_STDLIO === "1"
) {
  void main().catch((error) => {
    console.error(`dwg-tools MCP server failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
