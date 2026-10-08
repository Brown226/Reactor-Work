/**
 * 用量事件映射（纯函数）：`task_token_usage_delta` → `model_call` 审计事件。
 * 洞②（审计补全）追加行为事实映射：`tool.lifecycle` / `permission.lifecycle` →
 * `tool_call` / `approval` / `policy_block`，规则见 docs/未完成-审计补全-方案-v1.md §2.3。
 *
 * 纯函数、不碰 IO、不读时钟以外的一切：单测直接把输入喂进来断言输出，
 * 接线的部分（订阅流、flush、落盘）在 `auditOutbox.ts` / `auditReporter.ts`。
 *
 * 语言见 docs/未完成-服务端接线-P4-用量上报与策略.md §4.1；红线见 `auditContract.ts` 注释。
 */
import { createHash } from "node:crypto";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import {
  truncateAuditSummary,
  type AuditApprovalDecision,
  type AuditEventInput,
  type AuditOutcome,
  type AuditUsage,
} from "./auditContract.js";

/** 行为审计事实：telemetry 事实里工具生命周期与审批生命周期两支。 */
export type BehaviorAuditFact = Extract<
  ConversationTelemetryFact,
  { kind: "tool.lifecycle" | "permission.lifecycle" }
>;

/** 映射输入：与 Host 流事件 `task_token_usage_delta` 的字段一一对应。 */
export interface ModelCallUsageDelta {
  /** 幂等键：协议 `eventId`（缺省时由调用方用 `eventKey` 兜底）。 */
  eventId?: string;
  eventKey?: string;
  /** 事件时间（ISO8601）；缺省由调用方补。 */
  ts?: string;
  sessionId?: string;
  providerId: string;
  modelId: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cachedWriteInputTokens?: number;
    reasoningTokens?: number;
  };
  durationMs?: number;
  outcome?: AuditOutcome;
  errorCode?: string;
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 是否有任何有效用量分项：全 0 的调用不计账（服务端也会当脏数据拒掉）。 */
export function hasBillableUsage(delta: ModelCallUsageDelta): boolean {
  const usage = delta.usage;
  return (
    positiveOrUndefined(usage.totalTokens) !== undefined ||
    positiveOrUndefined(usage.inputTokens) !== undefined ||
    positiveOrUndefined(usage.outputTokens) !== undefined ||
    positiveOrUndefined(usage.cachedInputTokens) !== undefined ||
    positiveOrUndefined(usage.cachedWriteInputTokens) !== undefined
  );
}

/**
 * 组装审计用量分项。
 *
 * `reasoningTokens` **不进 `AuditUsage`**：服务端的四段价只认 input/output/cacheRead/cacheWrite
 * （它已包含在 output 里），单独上行会被当成额外计费项。
 */
export function buildAuditUsage(delta: ModelCallUsageDelta): AuditUsage {
  return {
    inputTokens: positiveOrUndefined(delta.usage.inputTokens),
    outputTokens: positiveOrUndefined(delta.usage.outputTokens),
    cacheReadTokens: positiveOrUndefined(delta.usage.cachedInputTokens),
    cacheWriteTokens: positiveOrUndefined(delta.usage.cachedWriteInputTokens),
    totalTokens: positiveOrUndefined(delta.usage.totalTokens),
    model: delta.modelId,
    provider: delta.providerId,
  };
}

/** 幂等键：优先协议 `eventId`，退到 `eventKey`；两者都没有则返回 null（调用方不得上报）。 */
export function resolveAuditEventId(delta: ModelCallUsageDelta): string | null {
  const eventId = delta.eventId?.trim();
  if (eventId) return eventId;
  const eventKey = delta.eventKey?.trim();
  return eventKey ? eventKey : null;
}

/**
 * 映射成一条 `model_call` 事件。
 *
 * 返回 `null` = 这条增量不该上报（没有幂等键）。过滤"是否企业 provider""是否已登录"由
 * 调用方（Reporter）负责——映射只管形状，不猜上下文。
 */
export function buildModelCallAuditEvent(
  delta: ModelCallUsageDelta,
  options: { ts: string },
): AuditEventInput | null {
  const eventId = resolveAuditEventId(delta);
  if (!eventId) return null;

  return {
    eventId,
    ts: delta.ts ?? options.ts,
    sessionId: delta.sessionId,
    action: "model_call",
    outcome: delta.outcome,
    durationMs: positiveOrUndefined(delta.durationMs),
    errorCode: delta.errorCode,
    summary: truncateAuditSummary(delta.modelId),
    usage: buildAuditUsage(delta),
  };
}

/* ── 行为事实 → 审计事件（洞②，规则见 docs/未完成-审计补全-方案-v1.md §2.3） ── */

/** 权限层拒绝的稳定错误码（CLI `CoreErrorType.PermissionDenied`）。 */
const PERMISSION_DENIED_CODE = "permission_denied";
/** 出网白名单拦截的稳定错误码族（`egress_blocked` / `webfetch_egress_blocked` 均含此子串）。 */
const EGRESS_BLOCKED_CODE = "egress_blocked";
/** 服务端 eventId 上限 128。 */
const MAX_EVENT_ID_CHARS = 128;

/**
 * 行为事件幂等键：`{sessionId}:{fact.eventId}`（与用量映射同构——事实 eventId 只在会话内唯一）。
 * 超长时退化为内容哈希：仍是纯函数、同输入同键，离线重传的幂等语义不破。
 */
export function resolveBehaviorEventId(fact: BehaviorAuditFact): string {
  const raw = `${fact.sessionId}:${fact.eventId}`;
  if (raw.length <= MAX_EVENT_ID_CHARS) return raw;
  return `h:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * 审批事实结论折算：事实词表（allow/deny/escalate/modify）→ 服务端 `APPROVALS`。
 * `modify` 是「改了入参再放行」，按放行记；`escalate` 是「上报更高级别裁决」，按 ask 记。
 * 缺结论返回 null —— 不猜、不报（resolved 事实必带 decision，缺失即数据缺陷）。
 */
function approvalDecisionOf(decision: string | undefined): AuditApprovalDecision | null {
  switch (decision) {
    case "allow":
    case "modify":
      return "allow";
    case "deny":
      return "deny";
    case "escalate":
      return "ask";
    default:
      return null;
  }
}

function factIsoTs(occurredAt: number, fallback: string): string {
  const t = typeof occurredAt === "number" && Number.isFinite(occurredAt) ? occurredAt : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

/**
 * 映射成一条行为审计事件（tool_call / approval / policy_block）。
 *
 * 过滤口径（与 §2.3 表逐行对应）：
 * - permission requested 不报（问了还没答）；resolved 报 approval；
 * - denied 且 ruleId 以 `policy.` 开头 → policy_block（组织策略拦截），其余 denied → approval/forbidden；
 * - tool 只记终态；`egress_blocked` 族 → policy_block（必报）；`permission_denied` → 跳过
 *   （已由同 toolCallId 的 permission 事实记账，防一案两行）；
 * - 其余终态仅当 `sideEffect === true`（副作用工具）才记 tool_call——只读与缺字段都不报。
 *
 * 红线：errorMessage / reason / 输入摘要一律不入任何字段（自由文本可能回显命令与路径内容）。
 */
export function buildBehaviorAuditEvent(
  fact: BehaviorAuditFact,
  options: { ts: string },
): AuditEventInput | null {
  const eventId = resolveBehaviorEventId(fact);
  const ts = factIsoTs(fact.occurredAt, options.ts);
  const base = (
    fields: Pick<AuditEventInput, "action"> & Partial<AuditEventInput>,
  ): AuditEventInput => ({
    eventId,
    ts,
    sessionId: fact.sessionId,
    ...fields,
  });
  const target = fact.toolCallId.slice(0, 128);
  const toolName = fact.toolName ? fact.toolName.slice(0, 128) : undefined;

  if (fact.kind === "permission.lifecycle") {
    if (fact.phase === "requested") return null;
    const ruleId = fact.ruleId;
    if (fact.phase === "denied") {
      if (ruleId?.startsWith("policy.")) {
        return base({
          action: "policy_block",
          outcome: "denied",
          target,
          ...(toolName ? { toolName } : {}),
          summary: truncateAuditSummary(ruleId),
          errorCode: ruleId,
        });
      }
      return base({
        action: "approval",
        approvalDecision: "forbidden",
        outcome: "denied",
        target,
        ...(toolName ? { toolName } : {}),
        summary: truncateAuditSummary(ruleId ?? toolName),
        ...(ruleId ? { errorCode: ruleId } : {}),
      });
    }
    // phase === "resolved"
    const decision = approvalDecisionOf(fact.decision);
    if (!decision) return null;
    return base({
      action: "approval",
      approvalDecision: decision,
      outcome: decision === "deny" ? "denied" : "ok",
      target,
      ...(toolName ? { toolName } : {}),
      summary: truncateAuditSummary(toolName),
    });
  }

  // kind === "tool.lifecycle"
  if (fact.phase !== "completed" && fact.phase !== "failed") return null;
  const errorCode = fact.errorCode;
  const durationMs = positiveOrUndefined(fact.durationMs);
  const common = {
    target,
    ...(toolName ? { toolName } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  } as const;

  // ① 出网白名单拦截：同时是工具失败，但语义上记 policy_block（必报，先于副作用判定）。
  if (errorCode && errorCode.includes(EGRESS_BLOCKED_CODE)) {
    return base({
      action: "policy_block",
      outcome: "denied",
      ...common,
      summary: truncateAuditSummary(toolName ?? errorCode),
      errorCode,
    });
  }
  // ② 权限层拒绝：同 toolCallId 的 permission 事实已记 approval/policy_block，跳过防一案两行。
  if (errorCode === PERMISSION_DENIED_CODE) return null;
  // ③ 只读工具与缺 sideEffect 的事实不报（副作用工具全报，只读不报）。
  if (fact.sideEffect !== true) return null;

  return base({
    action: "tool_call",
    outcome: fact.phase === "failed" ? "error" : "ok",
    ...common,
    summary: truncateAuditSummary(toolName),
    ...(errorCode ? { errorCode } : {}),
  });
}
