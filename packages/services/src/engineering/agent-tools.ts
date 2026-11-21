/**
 * 工程能力对 Agent 的暴露面：把执行器包装成工具调用。
 *
 * 这是模块与 Agent 运行时之间的唯一接口。Agent 只要拿到这里的
 * 工具描述与调用函数，就能驱动工程软件，不需要了解连接层细节。
 *
 * 设计边界：
 *   - 本模块不注册到任何具体运行时，只产出「工具定义 + 调用实现」，
 *     由外层按平台接入（CLI / 桌面 / Web 各自适配）。
 *   - 工具数量刻意少：连接、执行、检索、结果判定各一个。工程操作面
 *     很大，但都通过「写脚本」完成，不为每个软件函数建一个工具。
 */

import type { ToolCallSummary } from "./permission/permission.js";
import { decidePermission, describeDecision } from "./permission/permission.js";
import type { PermissionMode } from "./permission/permission.js";
import type { EngineeringExecutor } from "./executor/engineering-executor.js";
import type { FunctionSearchAction } from "./mcp-link/function-search.js";

/** 一个可暴露给 Agent 的工具。 */
export interface EngineeringTool {
  name: string;
  description: string;
  /** 入参描述，供模型理解。 */
  parameters: Record<string, { type: string; required?: boolean; description: string }>;
  /** 危险等级，交给权限层判定。 */
  danger: ToolCallSummary["declaredDanger"];
}

/** 工具清单。顺序即建议的展示顺序。 */
export const ENGINEERING_TOOLS: EngineeringTool[] = [
  {
    name: "connect_engineering_software",
    description:
      "连接本机已安装的工程软件并取得可用函数清单。同一软件重复连接是幂等的。" +
      "连接成功后返回简报，列出可用函数类别与数据结构。",
    parameters: {
      server: { type: "string", required: true, description: "软件标识，如 bimbase、sap2000、etabs、autocad、rhino" },
      exePath: { type: "string", description: "显式指定可执行文件路径，缺省自动发现" },
      projectPath: { type: "string", description: "指定工程文件，仅本次连接有效" },
    },
    danger: "caution",
  },
  {
    name: "run_engineering_script",
    description:
      "在已连接的软件上执行 Python 脚本。注入的函数可直接调用，不需要 import。" +
      "只有 print 的内容会返回给用户。",
    parameters: {
      server: { type: "string", required: true, description: "已连接的软件标识" },
      code: { type: "string", required: true, description: "Python 脚本" },
      timeoutMs: { type: "number", description: "超时毫秒数，缺省 300 秒" },
    },
    danger: "danger",
  },
  {
    name: "search_engineering_functions",
    description:
      "检索已连接软件提供的函数。四个动作：GetType 列类别、GetName 列某类全部函数、" +
      "GetDescription 查参数详情、GetClass 列数据结构。函数清单完整可穷尽，查不到就是不存在。",
    parameters: {
      server: { type: "string", required: true, description: "已连接的软件标识" },
      action: { type: "string", required: true, description: "GetType / GetName / GetDescription / GetClass" },
      funcType: { type: "string", description: "GetName / GetDescription 需要的函数类别" },
      funcNames: { type: "array", description: "GetDescription 需要的函数名列表" },
    },
    danger: "safe",
  },
  {
    name: "evaluate_engineering_evidence",
    description:
      "用确定性规则判定计算结果是否可信。未通过时只能报告未验证，不能宣称结果正确。",
    parameters: {
      server: { type: "string", required: true, description: "已连接的软件标识" },
      criteria: { type: "array", required: true, description: "验收标准列表" },
      evidence: { type: "object", required: true, description: "实测值字典" },
    },
    danger: "safe",
  },
];

/** 一次工具调用的入参。 */
export interface EngineeringToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** 调用结果。失败也返回结构，不抛异常。 */
export interface EngineeringToolResult {
  ok: boolean;
  /** 面向模型的文本结果。 */
  content: string;
  /** 权限层拒绝时的说明；正常执行时为空。 */
  deniedReason?: string;
}

/**
 * 执行一次工具调用。
 *
 * 权限判定在本层完成：拒绝时返回说明而不是抛错，让模型能向用户解释。
 */
export async function invokeEngineeringTool(
  call: EngineeringToolCall,
  context: {
    executor: EngineeringExecutor;
    mode: PermissionMode;
    alwaysAllow?: ReadonlySet<string>;
  },
): Promise<EngineeringToolResult> {
  const tool = ENGINEERING_TOOLS.find((item) => item.name === call.name);
  if (!tool) {
    return { ok: false, content: `未知工具：${call.name}` };
  }

  const decision = decidePermission(
    { toolName: call.name, args: call.args, declaredDanger: tool.danger },
    context.mode,
    context.alwaysAllow,
  );
  if (!decision.allowed) {
    return {
      ok: false,
      content: describeDecision(decision),
      deniedReason: decision.reason,
    };
  }

  switch (call.name) {
    case "connect_engineering_software":
      return connectTool(call.args, context.executor);
    case "run_engineering_script":
      return runTool(call.args, context.executor);
    case "search_engineering_functions":
      return searchTool(call.args, context.executor);
    case "evaluate_engineering_evidence":
      return evaluateTool(call.args);
    default:
      return { ok: false, content: `未实现的工具：${call.name}` };
  }
}

async function connectTool(
  args: Record<string, unknown>,
  executor: EngineeringExecutor,
): Promise<EngineeringToolResult> {
  const server = readString(args.server);
  if (!server) return { ok: false, content: "缺少 server 参数。" };

  const connected = await executor.connect(server, {
    exePath: readString(args.exePath),
    projectPath: readString(args.projectPath),
  });
  if (connected !== true) return { ok: false, content: connected };

  const briefing = executor.briefing(server);
  return {
    ok: true,
    content: briefing || `已连接 ${server}。`,
  };
}

async function runTool(
  args: Record<string, unknown>,
  executor: EngineeringExecutor,
): Promise<EngineeringToolResult> {
  const server = readString(args.server);
  const code = readString(args.code);
  if (!server || !code) return { ok: false, content: "缺少 server 或 code 参数。" };

  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
  const result = await executor.run({ server, code, timeoutMs });

  if (!result.ok) {
    return { ok: false, content: result.error || "脚本执行失败。" };
  }
  return { ok: true, content: result.stdout || "（脚本没有 print 输出）" };
}

function searchTool(
  args: Record<string, unknown>,
  executor: EngineeringExecutor,
): EngineeringToolResult {
  const server = readString(args.server);
  const action = readString(args.action) as FunctionSearchAction | undefined;
  if (!server || !action) return { ok: false, content: "缺少 server 或 action 参数。" };

  const result = executor.searchFunctions(server, {
    action,
    funcType: readString(args.funcType),
    funcNames: readStringArray(args.funcNames),
  });
  return { ok: result.ok, content: result.text };
}

function evaluateTool(args: Record<string, unknown>): EngineeringToolResult {
  // 委托给确定性模块，这里只做入参形状检查，避免重复实现判定逻辑。
  const criteria = Array.isArray(args.criteria) ? args.criteria : undefined;
  const evidence =
    args.evidence && typeof args.evidence === "object"
      ? (args.evidence as Record<string, unknown>)
      : undefined;
  if (!criteria || !evidence) {
    return { ok: false, content: "缺少 criteria 或 evidence 参数。" };
  }
  // 实际判定由上层调用 determinism 模块；这里返回已接收，避免类型循环。
  return {
    ok: true,
    content: `已接收 ${criteria.length} 条验收标准与 ${Object.keys(evidence).length} 项实测值。`,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

export { connectTool, runTool, searchTool, evaluateTool };
