/**
 * 把工程能力暴露为 MCP 服务，供 Agent 通过标准 MCP 通道调用。
 *
 * 为什么走 MCP 而不是直接注册工具：
 * Reactor 的 Agent 跑在独立 CLI 进程里，通过 stdio 通信；主进程提供能力
 * 的标准方式是 MCP 服务。走这条路，工程能力对 Agent 就是一组普通工具，
 * 不需要改动 Agent 运行时的工具注册逻辑。
 *
 * 设计边界：本模块只产出「MCP 工具定义 + 调用转发」，不启动 HTTP 服务，
 * 也不决定进程模型。传输层由外层选择（stdio 或 HTTP）。
 */

import type { EngineeringExecutor } from "./executor/engineering-executor.js";
import { ENGINEERING_TOOLS, invokeEngineeringTool } from "./agent-tools.js";
import type { PermissionMode } from "./permission/permission.js";

/** MCP 工具定义，字段名对齐 MCP 规范。 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** MCP 工具调用结果，字段名对齐 MCP 规范。 */
export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** 工程 MCP 服务的选项。 */
export interface EngineeringMcpOptions {
  executor: EngineeringExecutor;
  mode: PermissionMode;
  alwaysAllow?: ReadonlySet<string>;
}

/**
 * 生成 MCP 工具定义清单。
 *
 * 与 ENGINEERING_TOOLS 一一对应，只是把内部结构翻译成 MCP 规范形状。
 * 不在这里增删工具——单一来源在 agent-tools.ts。
 */
export function listMcpTools(): McpToolDefinition[] {
  return ENGINEERING_TOOLS.map((tool) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, param] of Object.entries(tool.parameters)) {
      properties[name] = {
        type: param.type === "array" ? "array" : param.type === "number" ? "number" : param.type === "object" ? "object" : "string",
        description: param.description,
        ...(param.type === "array" ? { items: { type: "string" } } : {}),
      };
      if (param.required) required.push(name);
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", properties, required },
    };
  });
}

/**
 * 调用一个 MCP 工具。
 *
 * 结果统一转成 MCP 的 content 数组；失败时置 isError，不抛异常——
 * MCP 协议里工具失败也是正常响应，让模型能看到原因。
 */
export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  options: EngineeringMcpOptions,
): Promise<McpToolResult> {
  const result = await invokeEngineeringTool(
    { name, args },
    {
      executor: options.executor,
      mode: options.mode,
      alwaysAllow: options.alwaysAllow,
    },
  );

  return {
    content: [{ type: "text", text: result.content }],
    ...(result.ok ? {} : { isError: true }),
  };
}
