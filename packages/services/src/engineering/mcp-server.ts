/**
 * 工程能力 MCP 服务（stdio 传输）。
 *
 * 形态：由 Agent 按 MCP 配置启动的独立子进程。连接状态与 Python worker 池
 * 都在本进程内，因此每个 Agent 会话天然隔离，不与其他会话共享。
 *
 * 为什么是 stdio 而不是 HTTP：Agent 通过 spwan 子进程 + stdin/stdout 通信，
 * 不需要端口分配、不需要处理端口冲突与会话路由。mcp-adapter.ts 只负责
 * 「工具定义 + 调用转发」，传输层由这里承担。
 *
 * 协议：JSON-RPC 2.0，每行一个消息（MCP stdio 传输约定）。
 */

import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "@zcode/shared";

import { listMcpTools, callMcpTool } from "./mcp-adapter.js";
import { EngineeringExecutor } from "./executor/engineering-executor.js";
import { disconnectAll } from "./mcp-link/registry.js";
import type { PermissionMode } from "./permission/permission.js";

/** 与 mcp-adapter 的 McpToolDefinition 对应，不重复声明协议常量以外的形状。 */
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "engineering";
const SERVER_VERSION = "0.1.0";

/** JSON-RPC 错误码。 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

interface JsonRpcId {
  jsonrpc: "2.0";
  id?: number | string | null;
}

interface JsonRpcRequest extends JsonRpcId {
  method: string;
  params?: Record<string, unknown>;
}

export interface EngineeringMcpServerOptions {
  /** 权限模式，缺省 auto：只拦截改模型/计算类脚本。 */
  mode?: PermissionMode;
  /** 指定 Python 解释器；缺省按 python/py/python3 顺序探测。 */
  interpreter?: string;
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcRequest["id"], result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id: id ?? null, result });
}

function replyError(id: JsonRpcRequest["id"], code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** 从环境变量读权限模式，非法值回落到 auto。 */
function resolveMode(): PermissionMode {
  const raw = process.env.ZCODE_ENGINEERING_PERMISSION_MODE;
  return raw === "ask" || raw === "full" || raw === "auto" ? raw : "auto";
}

/**
 * 启动服务。返回一个停止函数，便于宿主在退出时清理子进程与 worker。
 *
 * 注意：不在这里监听 SIGTERM 并自动退出——宿主负责进程生命周期，
 * 本函数只清理自己的资源。
 */
export function startEngineeringMcpServer(
  options: EngineeringMcpServerOptions = {},
): () => void {
  const executor = options.interpreter
    ? new EngineeringExecutor({ interpreter: options.interpreter })
    : new EngineeringExecutor();
  const mode = options.mode ?? resolveMode();

  const handle = async (request: JsonRpcRequest): Promise<void> => {
    const { id, method, params } = request;

    // 通知（无 id）不回复；MCP 的 initialized 就属于这类。
    if (method === "notifications/initialized" || method === "initialized") return;

    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;

      case "tools/list":
        reply(id, { tools: listMcpTools() });
        return;

      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        const args =
          params?.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        if (!name) {
          replyError(id, INVALID_REQUEST, "tools/call 缺少 name");
          return;
        }
        const result = await callMcpTool(name, args, { executor, mode });
        reply(id, result);
        return;
      }

      case "ping":
        reply(id, {});
        return;

      default:
        replyError(id, METHOD_NOT_FOUND, `不支持的方法：${method}`);
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      replyError(null, PARSE_ERROR, "消息不是合法 JSON");
      return;
    }

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      replyError(request.id, INVALID_REQUEST, "需要 JSON-RPC 2.0 请求");
      return;
    }

    void handle(request).catch((error: unknown) => {
      replyError(
        request.id,
        INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    });
  });

  return () => {
    rl.close();
    disconnectAll();
  };
}

/**
 * 生成供宿主注入到 Agent MCP 配置的 server 条目。
 *
 * 用 process.execPath + ELECTRON_RUN_AS_NODE：桌面打包态 execPath 是 ZCode Helper，
 * 缺 Node 模式会误进 Electron main（与 official-plugin-runtime 的处理一致）。
 *
 * 限制：SEA 二进制里 execPath 不是 Node，无法用本函数指向外部脚本；
 * SEA 形态需要把 server 作为内嵌资产并改走统一 host 入口。
 */
export function engineeringMcpServerConfig(
  options: EngineeringMcpServerOptions & { timeoutMs?: number } = {},
): McpServerConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  if (options.mode) env.ZCODE_ENGINEERING_PERMISSION_MODE = options.mode;
  if (options.interpreter) env.ZCODE_ENGINEERING_PYTHON = options.interpreter;

  return {
    type: "stdio",
    command: process.execPath,
    args: [join(here, "mcp-server-main.js")],
    env,
    timeoutMs: options.timeoutMs ?? 600_000,
  };
}
