/**
 * 记忆 formation 策略（W4-②）—— **确定性打分，零 LLM**。
 *
 * 设计来源：LeAgent `memory/formation.py`（Apache-2.0）。权重与阈值逐项照抄，
 * 因为它们是「记什么 / 记哪库 / 多重要」的产品语义，不是实现细节。
 *
 * 为什么刻意不用 LLM 判「值不值得记」：
 *  ① 每轮都要跑 —— LLM 判定会让每轮多一次调用（成本 + 延迟）；
 *  ② 不可测 —— 打分权重是**可回归**的，LLM 判定不是；
 *  ③ 噪声不可控 —— 「每轮全记」会把记忆库变成垃圾场，而确定性阈值天然抑制噪声。
 */

import { clamp01, successRate, type MemoryKind } from "./types.js";

// ---------------------------------------------------------------------------
// 触发器分类
// ---------------------------------------------------------------------------

/** 为什么考虑写一条记忆 */
export type TriggerKind =
  | "turn_complete"
  | "user_like"
  | "user_dislike"
  | "explicit_remember"
  | "tool_success"
  | "tool_failure"
  | "multi_step_success"
  | "correction"
  | "preference_detected"
  | "fact_stated";

/** 一次写入决策可能落到哪些库 */
export type FormationTarget = MemoryKind;

/** 一轮（或一次反馈）的观测快照 —— formation 的全部输入 */
export interface TurnObservation {
  readonly sessionId: string;
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly userText?: string;
  readonly assistantText?: string;
  readonly toolNames?: readonly string[];
  readonly toolSuccessCount?: number;
  readonly toolFailureCount?: number;
  readonly totalSteps?: number;
  readonly trigger?: TriggerKind;
  readonly tags?: readonly string[];
  readonly durationMs?: number;
  readonly error?: string;
  /**
   * 幂等键（**必须由调用方提供**）。
   *
   * ⚠️ LeAgent 的坑：`TurnObservation` 未声明 `turn_id`，代码用 `getattr(obs,'turn_id','')`
   * → 键退化成 `"<session>:"`，导致**同 session 第二次 observe_turn 被静默 suppress**。
   * 我们把它变成契约里的必填字段，消灭这个 bug 的存在空间。
   */
  readonly turnId: string;
}

/** formation 结论 */
export interface FormationDecision {
  readonly targets: readonly FormationTarget[];
  readonly importance: number;
  readonly confidence: number;
  /** 命中的触发器（逗号分隔），用于审计/排障 */
  readonly provenance: string;
  readonly suppress: boolean;
  readonly reasoning: string;
}

// ---------------------------------------------------------------------------
// 阈值与权重（照 LeAgent 原值）
// ---------------------------------------------------------------------------

export const EPISODIC_THRESHOLD = 0.1;
export const PROCEDURAL_THRESHOLD = 0.35;
export const SEMANTIC_THRESHOLD = 0.25;

export const TRIGGER_WEIGHTS: Readonly<Record<TriggerKind, number>> = {
  turn_complete: 0.15,
  user_like: 0.4,
  user_dislike: -0.1,
  explicit_remember: 0.55,
  tool_success: 0.2,
  tool_failure: 0.05,
  multi_step_success: 0.35,
  correction: 0.3,
  preference_detected: 0.4,
  fact_stated: 0.35,
};

// ---------------------------------------------------------------------------
// 显式意图检出（正则照 LeAgent 逐条移植，含中英双语）
// ---------------------------------------------------------------------------

const REMEMBER_PATTERNS = /(?:请?记住|别忘[了记]|以后.*(?:记得|注意)|remember\b|don'?t forget|keep in mind|note that|always\s)/i;
const PREFERENCE_PATTERNS = /(?:我(?:喜欢|偏好|习惯|总是)|i (?:prefer|like|always|want you to)|my (?:preference|style|convention))/i;
const CORRECTION_PATTERNS = /(?:不[是对]|错了|纠正|actually|no,?\s*(?:it'?s|that'?s)|wrong|incorrect|correction)/i;

/** 从观测文本里补出隐式触发器（显式 `trigger` 始终保留在首位） */
export function detectTriggers(obs: TurnObservation): TriggerKind[] {
  const triggers: TriggerKind[] = [obs.trigger ?? "turn_complete"];
  const text = obs.userText ?? "";

  if (REMEMBER_PATTERNS.test(text)) triggers.push("explicit_remember");
  if (PREFERENCE_PATTERNS.test(text)) triggers.push("preference_detected");
  if (CORRECTION_PATTERNS.test(text)) triggers.push("correction");

  const toolNames = obs.toolNames ?? [];
  const successCount = obs.toolSuccessCount ?? 0;
  const failureCount = obs.toolFailureCount ?? 0;
  if (toolNames.length > 0) {
    if (successCount > 0 && failureCount === 0) triggers.push("tool_success");
    else if (failureCount > 0) triggers.push("tool_failure");
    if (toolNames.length >= 3 && failureCount === 0) triggers.push("multi_step_success");
  }

  // 去重保序（照 LeAgent `dict.fromkeys`）
  return [...new Set(triggers)];
}

// ---------------------------------------------------------------------------
// 策略
// ---------------------------------------------------------------------------

export interface FormationPolicyOptions {
  readonly episodicThreshold?: number;
  readonly proceduralThreshold?: number;
  readonly semanticThreshold?: number;
  readonly weights?: Readonly<Record<TriggerKind, number>>;
}

/**
 * formation 打分器（**无状态**，可安全复用/并发）。
 *
 * 打分公式（照 LeAgent `evaluate`）：
 * ```
 *   raw = Σ weights[trigger]
 *   importance = clamp01(raw)
 *   若 toolNames.length >= 2 → importance = min(1, importance + 0.05 * min(toolCount, 6))
 *   若 totalSteps >= 4      → importance = min(1, importance + 0.05)
 * ```
 * 入库条件：
 * - episodic：`importance >= 0.10`
 * - procedural：`有工具 && 全成功 && importance >= 0.35`
 * - semantic：`有显式语义意图 && importance >= 0.25`
 */
export class FormationPolicy {
  readonly episodicThreshold: number;
  readonly proceduralThreshold: number;
  readonly semanticThreshold: number;
  private readonly weights: Readonly<Record<TriggerKind, number>>;

  constructor(options: FormationPolicyOptions = {}) {
    this.episodicThreshold = options.episodicThreshold ?? EPISODIC_THRESHOLD;
    this.proceduralThreshold = options.proceduralThreshold ?? PROCEDURAL_THRESHOLD;
    this.semanticThreshold = options.semanticThreshold ?? SEMANTIC_THRESHOLD;
    this.weights = options.weights ?? TRIGGER_WEIGHTS;
  }

  evaluate(obs: TurnObservation): FormationDecision {
    const triggers = detectTriggers(obs);
    const raw = triggers.reduce((sum, t) => sum + (this.weights[t] ?? 0), 0);
    let importance = clamp01(raw);

    const toolNames = obs.toolNames ?? [];
    const toolCount = toolNames.length;
    if (toolCount >= 2) importance = Math.min(1, importance + 0.05 * Math.min(toolCount, 6));
    if ((obs.totalSteps ?? 0) >= 4) importance = Math.min(1, importance + 0.05);

    const targets: FormationTarget[] = [];
    const reasons: string[] = [];

    if (importance >= this.episodicThreshold) {
      targets.push("episodic");
      reasons.push("episodic(达到阈值)");
    }

    const hasTools = toolNames.length > 0;
    const toolSuccess = (obs.toolSuccessCount ?? 0) > 0 && (obs.toolFailureCount ?? 0) === 0;
    if (hasTools && toolSuccess && importance >= this.proceduralThreshold) {
      targets.push("procedural");
      reasons.push("procedural(工具全成功 + 达到阈值)");
    }

    const explicitSemantic = triggers.some(
      (t) => t === "explicit_remember" || t === "preference_detected" || t === "correction" || t === "fact_stated",
    );
    if (explicitSemantic && importance >= this.semanticThreshold) {
      targets.push("semantic");
      reasons.push("semantic(检出显式语义意图)");
    }

    // 主要防「负分仍入库」：纯 dislike 且分数不回升 → 压制
    const suppress = triggers.includes("user_dislike") && importance <= 0;
    const confidence = Math.min(1, 0.3 + importance * 0.7);

    return {
      targets,
      importance,
      confidence,
      provenance: triggers.join(","),
      suppress,
      reasoning: reasons.join("; ") || "低于所有阈值",
    };
  }

  /** 反馈快捷路径（点赞/点踩端点用），照 LeAgent `score_feedback` */
  scoreFeedback(input: {
    isLike: boolean;
    hasTools: boolean;
    toolCount?: number;
    existingImportance?: number;
  }): FormationDecision {
    const trigger: TriggerKind = input.isLike ? "user_like" : "user_dislike";
    let base = (this.weights[trigger] ?? 0) + (input.existingImportance ?? 0.3);
    if (input.hasTools) {
      base += 0.1;
      base += 0.03 * Math.min(input.toolCount ?? 0, 6);
    }
    const importance = clamp01(base);
    const targets: FormationTarget[] = [];
    if (input.isLike) {
      targets.push("episodic");
      if (input.hasTools && importance >= this.proceduralThreshold) targets.push("procedural");
    } else {
      targets.push("episodic");
    }
    return {
      targets,
      importance,
      confidence: Math.min(1, 0.5 + importance * 0.5),
      provenance: trigger,
      suppress: !input.isLike && importance <= 0,
      reasoning: input.isLike ? "反馈路径：点赞" : "反馈路径：点踩",
    };
  }
}

// ---------------------------------------------------------------------------
// 保留分（维护/淘汰用）
// ---------------------------------------------------------------------------

/**
 * 计算一条已有记忆的 0–1 保留分（照 LeAgent `retention_score`）。
 *
 * `0.35*importance + 0.25*recallBoost + 0.25*recency + 0.15*confidence`，
 * 有 `successRate` 时再乘 `(0.5 + 0.5*successRate)`。
 * 注意 `recallBoost` 上限 0.3（被召回 ≠ 重要到能无限加分）。
 */
export function retentionScore(input: {
  importance: number;
  recallCount: number;
  ageDays: number;
  successRate?: number;
  confidence?: number;
  halfLifeDays?: number;
}): number {
  const base = clamp01(input.importance);
  const recallBoost = Math.min(0.3, 0.03 * input.recallCount);
  const recency = Math.exp(-input.ageDays / Math.max(1, input.halfLifeDays ?? 60));

  let score = 0.35 * base + 0.25 * recallBoost + 0.25 * recency;
  score += input.confidence === undefined ? 0.075 : 0.15 * clamp01(input.confidence);
  if (input.successRate !== undefined) score *= 0.5 + 0.5 * clamp01(input.successRate);
  return clamp01(score);
}

// ---------------------------------------------------------------------------
// 摘要与指纹
// ---------------------------------------------------------------------------

/** 拼 episode 摘要（照 LeAgent `build_episode_summary`：user≤400 / assistant≤800 / 整体≤maxLen） */
export function buildEpisodeSummary(obs: TurnObservation, maxLen = 1200): string {
  const user = (obs.userText ?? "").trim().slice(0, 400);
  const assistant = (obs.assistantText ?? "").trim().slice(0, 800);
  let summary = user && assistant ? `Q: ${user}\nA: ${assistant}` : user || assistant;
  const toolNames = obs.toolNames ?? [];
  if (toolNames.length > 0) {
    const show = toolNames.slice(0, 32);
    const tail = toolNames.length <= 32 ? "" : ` (+${toolNames.length - 32} more)`;
    summary += `\nTools: ${show.join(", ")}${tail}`;
  }
  return summary.slice(0, maxLen);
}

/**
 * 流程指纹（确定性）：`sha256(小写意图 + \0 + 排序去重工具名)`。
 *
 * 用**排序去重后的工具名**是关键：同一条流程只要工具集相同就算同一条，
 * 与调用顺序无关（顺序差异是噪声，不该产生新流程条目）。
 */
export function buildProcedureSignature(obs: TurnObservation): string {
  const intent = (obs.userText ?? "").trim().toLowerCase().slice(0, 200);
  const tools = [...new Set((obs.toolNames ?? []).map((t) => t.trim()).filter((t) => t !== ""))].sort();
  return fnv1aHex(`${intent}\u0000${tools.join(",")}`);
}

/** FNV-1a 64 位十六进制（与 `context/types.ts` 的 `shortHash` 同族，避免引入 crypto 依赖） */
function fnv1aHex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 从 procedure 计算 successRate（转发，避免调用方每次 import 两个模块） */
export const procedureSuccessRate = successRate;
