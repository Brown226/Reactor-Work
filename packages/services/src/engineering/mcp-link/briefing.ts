/**
 * 连接简报：告诉 Agent「你刚连上的软件能做什么」。
 *
 * 逆向自 PKPM Agent 的 briefing 机制。连接成功后一次性列出可用函数类别
 * 与数据结构，省掉模型靠试错摸索能力边界的一轮往返。
 */

import type { McpCapabilitySnapshot } from "./types.js";

/** 简报正文的长度上限，避免一次性吃掉过多上下文。 */
const MAX_CATEGORY_LINES = 40;
const MAX_FUNCTION_SAMPLES = 6;

/**
 * 生成连接简报。内容稳定可复现：同一快照总是生成同一文本，
 * 便于上层做缓存与去重。
 */
export function buildBriefing(snapshot: McpCapabilitySnapshot): string {
  const lines: string[] = [`已连接 ${snapshot.serverName}。`, ""];

  if (snapshot.categories.length > 0) {
    lines.push("可用函数类别（用 function_search(GetName, <类别>) 取该类别全部函数）：");
    for (const category of snapshot.categories.slice(0, MAX_CATEGORY_LINES)) {
      const names = snapshot.functionsByCategory[category] ?? [];
      const sample = names.slice(0, MAX_FUNCTION_SAMPLES).join("、");
      lines.push(`- ${category}${sample ? `：${sample}${names.length > MAX_FUNCTION_SAMPLES ? " 等" : ""}` : ""}`);
    }
    if (snapshot.categories.length > MAX_CATEGORY_LINES) {
      lines.push(`（还有 ${snapshot.categories.length - MAX_CATEGORY_LINES} 个类别未列出）`);
    }
    lines.push("");
  }

  if (snapshot.dataStructures.length > 0) {
    lines.push("可用数据结构（已注入执行环境，可直接构造）：");
    lines.push(`- ${snapshot.dataStructures.join("、")}`);
    lines.push("");
  }

  lines.push(
    "注入的函数已存在于执行环境，脚本里直接调用即可，不要 import。",
    "只有 print() 的输出会返回给用户。",
  );

  return lines.join("\n");
}
