/**
 * function_search —— 注入环境里的普通函数，不是工具。
 *
 * 逆向自 PKPM Agent 的 tools/tool_search：
 *   GetType / GetName / GetDescription / GetClass 四个动作。
 * 关键设计：函数清单有限且可穷尽，Agent 据此判断「某能力是否存在」，
 * 而不是靠反复试探。这是防幻觉的核心机制。
 *
 * 本实现返回结构化数据，由执行器转成目标运行时的字符串。
 */

import type { GeneratedFunction } from "./injection.js";
import { UNGROUPED } from "./injection.js";
import type { McpCapabilitySnapshot } from "./types.js";

export type FunctionSearchAction = "GetType" | "GetName" | "GetDescription" | "GetClass";

export interface FunctionSearchRequest {
  action: FunctionSearchAction;
  /** GetName / GetDescription 需要：函数类别。 */
  funcType?: string;
  /** GetDescription 需要：要查详情的函数名。 */
  funcNames?: string[];
}

export interface FunctionSearchResult {
  ok: boolean;
  /** 供模型直接阅读的文本；失败时是可执行的指引。 */
  text: string;
}

/** 类别清单的人类可读形式。 */
function formatCategories(snapshot: McpCapabilitySnapshot): string {
  if (snapshot.categories.length === 0) {
    return "当前连接未提供函数类别。可先用 GetClass 查看可用数据结构。";
  }
  const lines = [`函数类别（共 ${snapshot.categories.length} 类）：`];
  for (const category of snapshot.categories) {
    const count = snapshot.functionsByCategory[category]?.length ?? 0;
    lines.push(`- ${category}（${count} 个函数）`);
  }
  lines.push("");
  lines.push("用 GetName 传入类别取该类别全部函数名。");
  return lines.join("\n");
}

function formatFunctionNames(snapshot: McpCapabilitySnapshot, category: string): string {
  const names = snapshot.functionsByCategory[category];
  if (!names) {
    const available = snapshot.categories.slice(0, 10).join("、") || "（无）";
    return `没有类别「${category}」。可用类别：${available}`;
  }
  return `类别「${category}」共 ${names.length} 个函数：\n${names.join("\n")}`;
}

function formatFunctionDetail(fn: GeneratedFunction): string {
  const lines = [`${fn.name}${fn.summary ? ` —— ${fn.summary}` : ""}`];
  if (fn.parameters.length === 0) {
    lines.push("参数：无");
  } else {
    lines.push("参数：");
    for (const param of fn.parameters) {
      const flag = param.required ? "必填" : "可选";
      const desc = param.description ? `  ${param.description}` : "";
      lines.push(`- ${param.name}: ${param.type}（${flag}）${desc}`);
    }
  }
  lines.push(`返回：${fn.returns}`);
  if (Object.keys(fn.definitions).length > 0) {
    lines.push(`涉及数据结构：${Object.keys(fn.definitions).join("、")}`);
  }
  return lines.join("\n");
}

function formatClasses(snapshot: McpCapabilitySnapshot): string {
  if (snapshot.dataStructures.length === 0) {
    return "当前连接未提供数据结构。";
  }
  return `可用数据结构（已注入执行环境）：\n${snapshot.dataStructures.join("\n")}`;
}

/**
 * 执行一次 function_search。
 *
 * 不抛异常：参数不全时返回带指引的失败结果，让模型自行修正。
 */
export function functionSearch(
  request: FunctionSearchRequest,
  context: { snapshot: McpCapabilitySnapshot; functions: GeneratedFunction[] },
): FunctionSearchResult {
  const { snapshot, functions } = context;

  switch (request.action) {
    case "GetType":
      return { ok: true, text: formatCategories(snapshot) };

    case "GetName": {
      if (!request.funcType) {
        return {
          ok: false,
          text: "GetName 需要 funcType。先用 GetType 查看可用类别。",
        };
      }
      const text = formatFunctionNames(snapshot, request.funcType);
      return { ok: snapshot.functionsByCategory[request.funcType] !== undefined, text };
    }

    case "GetDescription": {
      if (!request.funcNames || request.funcNames.length === 0) {
        return {
          ok: false,
          text: "GetDescription 需要 funcNames。先用 GetName 取到函数名。",
        };
      }
      const found: string[] = [];
      const missing: string[] = [];
      for (const name of request.funcNames) {
        const fn = functions.find((item) => item.name === name);
        if (fn) found.push(formatFunctionDetail(fn));
        else missing.push(name);
      }
      const parts: string[] = [];
      if (found.length > 0) parts.push(found.join("\n\n"));
      if (missing.length > 0) {
        parts.push(
          `未找到：${missing.join("、")}。` +
            "函数清单是完整的，找不到就是真的不存在；不要改动拼写重试，" +
            "改用 GetName 确认该类别下的实际函数名。",
        );
      }
      return { ok: found.length > 0, text: parts.join("\n\n") };
    }

    case "GetClass":
      return { ok: true, text: formatClasses(snapshot) };

    default:
      return {
        ok: false,
        text: `未知 action：${String(request.action)}。可用：GetType / GetName / GetDescription / GetClass。`,
      };
  }
}

export { UNGROUPED };
