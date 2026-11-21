/**
 * MCP 客户端会话：完成握手、拉取工具清单、执行调用。
 *
 * 逆向自 PKPM Agent 的 mcp_link 连接流程：
 *   连上端口后用 streamable HTTP + JSON-RPC 握手，再 tools/list 拿能力。
 *
 * 本模块不决定连哪台软件，也不管安装发现——那是 BaseMCPLink 子类的职责。
 * 它只负责「给定端点，完成一次 MCP 会话」。
 *
 * 注意：@modelcontextprotocol/client 是可选依赖，缺失时本模块降级为明确
 * 报错而不是让整个包无法加载。
 */

import type { McpToolDescriptor } from "../mcp-link/injection.js";

/** 一次 MCP 会话的最小接口，便于测试时替换。 */
export interface McpSession {
  /** 拉取工具清单。 */
  listTools(): Promise<McpToolDescriptor[]>;
  /** 调用一个工具。 */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 关闭会话。 */
  close(): Promise<void>;
}

export interface McpSessionOptions {
  host: string;
  port: number;
  /** 握手超时（毫秒）。 */
  timeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * 建立 MCP 会话。
 *
 * 失败返回 `string` 错误描述而不是抛异常：连接层所有失败都以文案形式
 * 交给用户，不制造未捕获异常。
 */
export async function openMcpSession(
  options: McpSessionOptions,
): Promise<McpSession | string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const endpoint = new URL(`http://${options.host}:${options.port}/mcp`);

  let clientModule: typeof import("@modelcontextprotocol/client");
  try {
    clientModule = await import("@modelcontextprotocol/client");
  } catch {
    return (
      "缺少 @modelcontextprotocol/client 依赖，无法建立 MCP 会话。" +
      "请在安装依赖后重试。"
    );
  }

  const { Client, StreamableHTTPClientTransport } = clientModule;
  const transport = new StreamableHTTPClientTransport(endpoint);
  const client = new Client(
    { name: "zcode-engineering", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await withTimeout(client.connect(transport), timeoutMs, "MCP 握手");
  } catch (error) {
    await safeClose(transport);
    return `连接 ${endpoint.toString()} 失败：${messageOf(error)}`;
  }

  return {
    async listTools(): Promise<McpToolDescriptor[]> {
      const result = await client.listTools();
      return (result.tools ?? []).map(toDescriptor);
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      return client.callTool({ name, arguments: args });
    },
    async close(): Promise<void> {
      await safeClose(transport);
    },
  };
}

/** 把 MCP SDK 的 Tool 映射成本模块的描述结构。 */
function toDescriptor(tool: {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}): McpToolDescriptor {
  const descriptor: McpToolDescriptor = { name: tool.name };
  if (tool.description) descriptor.description = tool.description;
  if (tool.inputSchema && typeof tool.inputSchema === "object") {
    descriptor.inputSchema = tool.inputSchema as Record<string, unknown>;
  }
  if (tool.outputSchema && typeof tool.outputSchema === "object") {
    descriptor.outputSchema = tool.outputSchema as Record<string, unknown>;
  }
  return descriptor;
}

async function safeClose(transport: { close?: () => Promise<void> }): Promise<void> {
  try {
    await transport.close?.();
  } catch {
    // 关闭失败不影响调用方：连接已不可用，忽略。
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
