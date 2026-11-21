/**
 * MCP 工具清单 → 可注入执行环境的函数签名。
 *
 * 逆向自 PKPM Agent 的 mcp_ptc：
 *   - 连接成功后把 tools/list 的结果转成目标语言的函数定义
 *   - 同时把 JSON Schema 转成数据结构定义
 *   - 一次性注入，会话中途不变
 *
 * 本模块只做「转换」，不碰传输层，也不决定注入到哪个运行时。
 * 这样 Python / JS 执行器都能复用同一份结果。
 */

import type { InjectionResult, McpCapabilitySnapshot } from "./types.js";

/** MCP 工具的最小描述，与 @modelcontextprotocol 的 Tool 结构兼容。 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema（draft-07 / 2020-12 均可）。 */
  inputSchema?: Record<string, unknown>;
  /** 可选的输出 Schema。 */
  outputSchema?: Record<string, unknown>;
  /** 工具分组（服务端有约定时可用，缺省归入「未分组」）。 */
  group?: string;
}

/** 转换后的函数签名，可供任意运行时生成调用桩。 */
export interface GeneratedFunction {
  name: string;
  /** 一句话用途，来自工具 description 的首句。 */
  summary: string;
  /** 参数名 → 类型表达式。 */
  parameters: { name: string; type: string; required: boolean; description?: string }[];
  /** 返回类型表达式。 */
  returns: string;
  /** JSON Schema 里的定义名，用于生成数据结构。 */
  definitions: Record<string, Record<string, unknown>>;
  group: string;
}

/** 一次转换的完整结果。 */
export interface ConversionResult {
  functions: GeneratedFunction[];
  /** 数据结构名 → JSON Schema。 */
  dataStructures: Record<string, Record<string, unknown>>;
  /** 转换中被跳过的工具及原因，用于诊断。 */
  skipped: { name: string; reason: string }[];
}

const UNGROUPED = "未分组";
/** 简报里每类函数最多展示几个样例。 */
const SUMMARY_MAX_CHARS = 120;

/** JSON Schema 类型 → 目标类型表达式。未知类型落到 `any`，不猜。 */
function schemaTypeToExpression(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "any";
  const node = schema as Record<string, unknown>;

  // $ref 直接保留引用名，由数据结构定义承载
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop() ?? "";
    return name || "any";
  }

  if (typeof node.type === "string") {
    switch (node.type) {
      case "string":
        return "str";
      case "integer":
        return "int";
      case "number":
        return "float";
      case "boolean":
        return "bool";
      case "null":
        return "None";
      case "array": {
        const item = schemaTypeToExpression(node.items);
        return `list[${item}]`;
      }
      case "object": {
        // 有 properties 时按内联对象描述，否则视为任意字典
        const props = node.properties;
        if (props && typeof props === "object" && Object.keys(props).length > 0) {
          return "dict";
        }
        return "dict";
      }
      default:
        return "any";
    }
  }

  // anyOf / oneOf：取联合类型，去掉重复
  for (const key of ["anyOf", "oneOf"] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      const types = [...new Set(branch.map((item) => schemaTypeToExpression(item)))];
      const [first, ...rest] = types;
      if (rest.length === 0) return first ?? "any";
      return types.join(" | ");
    }
  }

  // enum 无 type 时按字符串处理
  if (Array.isArray(node.enum)) return "str";

  return "any";
}

/** 取 description 的首句，避免把整段文档塞进签名。 */
function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const trimmed = text.trim().replace(/\s+/g, " ");
  const stop = trimmed.search(/[。.!?\n]/);
  const sentence = stop >= 0 ? trimmed.slice(0, stop) : trimmed;
  return sentence.length > SUMMARY_MAX_CHARS ? `${sentence.slice(0, SUMMARY_MAX_CHARS)}…` : sentence;
}

/**
 * 把一批工具描述转换成函数签名。
 *
 * 不抛异常：单个工具 Schema 畸形时记入 skipped 继续处理其余，
 * 避免一个坏工具让整次注入失败。
 */
export function convertTools(tools: McpToolDescriptor[]): ConversionResult {
  const functions: GeneratedFunction[] = [];
  const dataStructures: Record<string, Record<string, unknown>> = {};
  const skipped: { name: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if (!tool?.name || typeof tool.name !== "string") {
      skipped.push({ name: String(tool?.name ?? "<空>"), reason: "工具缺少 name" });
      continue;
    }
    if (seen.has(tool.name)) {
      skipped.push({ name: tool.name, reason: "工具名重复，保留先出现的定义" });
      continue;
    }
    seen.add(tool.name);

    const input = tool.inputSchema;
    const properties =
      input && typeof input === "object" && typeof input.properties === "object" && input.properties
        ? (input.properties as Record<string, unknown>)
        : {};
    const requiredRaw =
      input && typeof input === "object" && Array.isArray(input.required) ? (input.required as unknown[]) : [];
    const required = new Set(requiredRaw.filter((item): item is string => typeof item === "string"));

    const parameters = Object.entries(properties).map(([name, schema]) => ({
      name,
      type: schemaTypeToExpression(schema),
      required: required.has(name),
      description: firstSentence(
        schema && typeof schema === "object"
          ? (schema as Record<string, unknown>).description as string | undefined
          : undefined,
      ),
    }));

    // 收集 Schema 里的 definitions / $defs，供数据结构生成
    const definitions: Record<string, Record<string, unknown>> = {};
    for (const defKey of ["definitions", "$defs"] as const) {
      const defs =
        input && typeof input === "object" ? (input as Record<string, unknown>)[defKey] : undefined;
      if (defs && typeof defs === "object") {
        for (const [name, schema] of Object.entries(defs as Record<string, unknown>)) {
          if (schema && typeof schema === "object") {
            definitions[name] = schema as Record<string, unknown>;
            dataStructures[name] = schema as Record<string, unknown>;
          }
        }
      }
    }

    const outputDefs =
      tool.outputSchema && typeof tool.outputSchema === "object"
        ? (tool.outputSchema as Record<string, unknown>)
        : undefined;
    for (const defKey of ["definitions", "$defs"] as const) {
      const defs = outputDefs?.[defKey];
      if (defs && typeof defs === "object") {
        for (const [name, schema] of Object.entries(defs as Record<string, unknown>)) {
          if (schema && typeof schema === "object") {
            definitions[name] = schema as Record<string, unknown>;
            dataStructures[name] = schema as Record<string, unknown>;
          }
        }
      }
    }

    functions.push({
      name: tool.name,
      summary: firstSentence(tool.description),
      parameters,
      returns: tool.outputSchema ? schemaTypeToExpression(tool.outputSchema) : "any",
      definitions,
      group: tool.group?.trim() || UNGROUPED,
    });
  }

  return { functions, dataStructures, skipped };
}

/** 生成能力快照，供 function_search 与简报使用。 */
export function toCapabilitySnapshot(
  serverName: string,
  conversion: ConversionResult,
): McpCapabilitySnapshot {
  const functionsByCategory: Record<string, string[]> = {};
  for (const fn of conversion.functions) {
    (functionsByCategory[fn.group] ??= []).push(fn.name);
  }
  for (const names of Object.values(functionsByCategory)) names.sort();

  return {
    serverName,
    categories: Object.keys(functionsByCategory).sort(),
    functionsByCategory,
    dataStructures: Object.keys(conversion.dataStructures).sort(),
  };
}

/** 把转换结果与简报组合成注入结果，交给执行器落地。 */
export function toInjectionResult(
  serverName: string,
  conversion: ConversionResult,
  briefing: string,
): InjectionResult {
  return {
    injectedFunctions: conversion.functions.map((fn) => fn.name),
    injectedClasses: Object.keys(conversion.dataStructures),
    briefing,
    snapshot: toCapabilitySnapshot(serverName, conversion),
  };
}

/** 按类别检索函数名；类别不存在时返回空数组，不抛异常。 */
export function findFunctionsByCategory(
  snapshot: McpCapabilitySnapshot,
  category: string,
): string[] {
  return snapshot.functionsByCategory[category] ?? [];
}

/** 在全部类别里按关键词搜函数名与摘要。 */
export function searchFunctions(
  functions: GeneratedFunction[],
  keyword: string,
  limit = 20,
): GeneratedFunction[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];
  return functions
    .filter(
      (fn) =>
        fn.name.toLowerCase().includes(needle) || fn.summary.toLowerCase().includes(needle),
    )
    .slice(0, limit);
}

export { UNGROUPED };
