/**
 * 相关性门控（W4-①，照 LeAgent `context/relevance.py`）。
 *
 * 一个 ~60 行的纯函数原语，解决一个很贵的问题：**重型域手册默认不注入**。
 * 只有在「本轮确实相关」或「harness 显式开闸」时才付费。
 *
 * 三信号（照 LeAgent 判定顺序）：
 *  1. **opt-in**：`templateVars[optInKey]` 任一为真 → 开门（harness/workflow 确定性强制）；
 *  2. **workflowHint**：命中 `hints` → 开门；
 *  3. **query 子串**：小写 `query` 命中任一 `hint` → 开门。
 *
 * ⚠️ LeAgent 的坑（已规避）：`invalidation_key` 必须含「是否 relevant」，否则缓存串味。
 * 本原语把 `relevanceKey()` 一并给出，供 source 直接拼进缓存键。
 */

import type { ResolveContext } from "./types.js";

export interface RelevanceGate {
  /** 门名（用于日志/审计；同名门共享缓存语义） */
  readonly name: string;
  /** 关键词（**必须小写**；匹配用小写子串包含，不做分词） */
  readonly hints: readonly string[];
  /** 模板变量开关名（任一为真即开门） */
  readonly optInKeys: readonly string[];
}

/** 判定：harness 是否显式开闸（信号 1 + 2） */
export function optedIn(gate: RelevanceGate, ctx: ResolveContext): boolean {
  const vars = ctx.templateVars;
  if (vars) {
    for (const key of gate.optInKeys) {
      if (isTruthy(vars[key])) return true;
    }
  }
  const hint = ctx.workflowHint;
  if (hint !== undefined && hint !== "") {
    const low = hint.toLowerCase();
    if (gate.hints.some((h) => low.includes(h))) return true;
  }
  return false;
}

/**
 * 判定：本轮是否该注入该门内容。
 *
 * 顺序与 LeAgent 一致：先 `optedIn`（确定性强制），再回落 query 子串。
 * `query` 为空时**不开门**（fail-closed：宁可不注入，也不无差别灌手册）。
 */
export function gateMatches(gate: RelevanceGate, ctx: ResolveContext): boolean {
  if (optedIn(gate, ctx)) return true;
  const query = ctx.query;
  if (query === undefined || query === "") return false;
  const low = query.toLowerCase();
  return gate.hints.some((h) => low.includes(h));
}

/**
 * 缓存键片段：`<gateName>:<0|1>`。
 *
 * 照 LeAgent `gated_policy.py invalidation_key` —— **必须把「是否 relevant」拼进缓存键**，
 * 否则 `session` scope 的缓存会把「本轮跳过」的结果复用到「本轮命中」的轮次上。
 */
export function relevanceKey(gate: RelevanceGate, ctx: ResolveContext): string {
  return `${gate.name}:${gateMatches(gate, ctx) ? 1 : 0}`;
}

/** 门工厂：自动把 hints 归一为小写，避免调用方漏转（这是最容易犯的错） */
export function defineRelevanceGate(
  name: string,
  hints: readonly string[],
  optInKeys: readonly string[] = [],
): RelevanceGate {
  return {
    name,
    hints: hints.map((h) => h.toLowerCase()),
    optInKeys: [...optInKeys],
  };
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (typeof value === "string") {
    const low = value.trim().toLowerCase();
    return low !== "" && low !== "0" && low !== "false" && low !== "no" && low !== "off";
  }
  return true;
}
