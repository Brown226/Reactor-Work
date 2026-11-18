/**
 * 权限分级：Ask / Auto / Full。
 *
 * 逆向自 PKPM Agent 的 middleware/permission 与前端文案里的三级模式。
 * 在工程场景这不是体验优化而是合规要求——改错一个截面可能就是事故。
 *
 * 三级的差别只在「哪些操作需要人确认」，不改变操作本身的能力：
 *   ask   每次工具调用都要确认
 *   auto  只拦高危操作（删除、计算、覆盖文件、写模型）
 *   full  全自动，仅保留不可逆操作的硬拦截
 *
 * 「不可逆」是硬编码的，不受模式影响：任何模式下都不允许静默执行
 * 摧毁性操作——这一条不能交给模型判断。
 */

export type PermissionMode = "ask" | "auto" | "full";

/** 危险等级。 */
export type DangerLevel = "safe" | "caution" | "danger" | "destructive";

/** 一次调用的判定结果。 */
export interface PermissionDecision {
  /** 是否允许直接执行。 */
  allowed: boolean;
  /** 不允许时需要用户确认；为 false 时是硬拒绝（不可逆操作在受限场景）。 */
  needsConfirmation: boolean;
  /** 面向用户的原因；allowed 为 true 时为空串。 */
  reason: string;
  /** 判定依据的危险等级，便于日志与展示。 */
  dangerLevel: DangerLevel;
}

/** 待判定的工具调用概要。 */
export interface ToolCallSummary {
  toolName: string;
  /** 入参；只用于关键词判定，不在这里做深层解析。 */
  args?: Record<string, unknown>;
  /** 调用方标注的危险等级（工具自带声明时优先用）。 */
  declaredDanger?: DangerLevel;
}

/**
 * 危险关键词。命中即提级。
 *
 * 这里刻意用保守的匹配：宁可多拦一次，也不放行一次改模型。
 */
const DESTRUCTIVE_PATTERNS = [
  /delete/i,
  /remove/i,
  /drop\b/i,
  /clear/i,
  /purge/i,
  /reset/i,
  /rollback/i,
];

const DANGER_PATTERNS = [
  /Modify/i,
  /Update/i,
  /Set[A-Z]/, // SetBeamSection / SetLoad 这类写操作
  /write/i,
  /save/i,
  /overwrite/i,
  /run/i, // RunPKPMAnalyse 这类会关闭进程并重算的操作
  /calc/i,
  /execute/i,
];

const CAUTION_PATTERNS = [/Create/i, /Add/i, /Insert/i, /generate/i];

/** 判断工具名命中的最高危险等级。 */
export function classifyTool(toolName: string): DangerLevel {
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(toolName))) return "destructive";
  if (DANGER_PATTERNS.some((pattern) => pattern.test(toolName))) return "danger";
  if (CAUTION_PATTERNS.some((pattern) => pattern.test(toolName))) return "caution";
  return "safe";
}

/**
 * 按模式判定一次调用是否需要确认。
 *
 * 硬规则（任何模式都不变）：`destructive` 在 `ask` / `auto` 下必须确认；
 * `full` 下也要求确认——不可逆操作不接受「全自动」豁免。
 */
export function decidePermission(
  call: ToolCallSummary,
  mode: PermissionMode,
  alwaysAllow: ReadonlySet<string> = new Set(),
): PermissionDecision {
  const level = call.declaredDanger ?? classifyTool(call.toolName);

  // 用户显式放行的工具跳过确认（但仍受 destructive 硬规则约束）。
  const preApproved = alwaysAllow.has(call.toolName);

  if (level === "destructive") {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `「${call.toolName}」是不可逆操作，需要确认后才能执行。`,
      dangerLevel: level,
    };
  }

  if (mode === "full") {
    return { allowed: true, needsConfirmation: false, reason: "", dangerLevel: level };
  }

  if (preApproved) {
    return { allowed: true, needsConfirmation: false, reason: "", dangerLevel: level };
  }

  if (mode === "ask") {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `「${call.toolName}」需要确认。`,
      dangerLevel: level,
    };
  }

  // auto：只拦 danger 及以上
  if (level === "danger") {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: `「${call.toolName}」会修改模型或触发计算，需要确认。`,
      dangerLevel: level,
    };
  }

  return { allowed: true, needsConfirmation: false, reason: "", dangerLevel: level };
}

/** 生成给用户看的确认文案。把「会发生什么」说清楚，不写空话。 */
export function describeDecision(decision: PermissionDecision): string {
  if (decision.allowed) return "";
  const verb = decision.needsConfirmation ? "需要你的确认" : "被拒绝";
  return `${verb}：${decision.reason}\n危险等级：${decision.dangerLevel}`;
}

export { DESTRUCTIVE_PATTERNS, DANGER_PATTERNS, CAUTION_PATTERNS };
