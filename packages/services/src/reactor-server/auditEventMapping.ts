/**
 * 用量事件映射（纯函数）：`task_token_usage_delta` → `model_call` 审计事件。
 *
 * 纯函数、不碰 IO、不读时钟以外的一切：单测直接把输入喂进来断言输出，
 * 接线的部分（订阅流、flush、落盘）在 `auditOutbox.ts` / `auditReporter.ts`。
 *
 * 语言见 docs/服务端接线-P4-用量上报与策略.md §4.1；红线见 `auditContract.ts` 注释。
 */
import {
  truncateAuditSummary,
  type AuditEventInput,
  type AuditOutcome,
  type AuditUsage,
} from "./auditContract.js";

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
    // summary 只放模型 id 短标签：它同时是排障线索，也是"不塞正文"的边界示范。
    summary: truncateAuditSummary(delta.modelId),
    usage: buildAuditUsage(delta),
  };
}
