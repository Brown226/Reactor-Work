/**
 * 端侧审计/用量契约（服务端 `server/packages/shared/src/audit.ts` 的镜像）。
 *
 * 为什么是镜像而不是复用：`server/` 是独立的 pnpm workspace，主仓库 import 不到它的包。
 * 因此这里只镜像**上行需要的字段**，并补齐调用方要用到的常量；字段增删必须两边一起改，
 * 服务端 `repo.ts` 有对应校验（`summary` ≤200 字、`uid`/`deptId` 由服务端按令牌写入、
 * 请求体带了直接 400）。
 *
 * 红线（NFR-P-01：正文不落服务端）：只承载结构化元数据 + 用量计数，
 * **不含提示词/回复/工具输出正文**；`summary` 只放短标签。
 */
import { join } from "node:path";
import { getZCodeDataRootDir } from "../paths.js";

/** 事件动作类别（v1 只用 `model_call`，其余留给 P4.3）。 */
export type AuditActionKind =
  | "model_call"
  | "tool_call"
  | "approval"
  | "policy_block"
  | "session"
  | "admin_action"
  | "auth";

/** 事件结果。 */
export type AuditOutcome = "ok" | "error" | "denied" | "cancelled";

/** 用量分项（缺省字段服务端视为 0）。 */
export interface AuditUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  /** 端侧上报只作无价目时的兜底；服务端按四段价核算为准。 */
  cost?: number;
  currency?: string;
  model?: string;
  provider?: string;
}

/** 端侧上报的单条事件。**不含 uid/deptId**：归属由服务端按令牌写入。 */
export interface AuditEventInput {
  /** 端侧幂等键（离线重传不会重复入库）。 */
  eventId: string;
  /** 事件发生时间（ISO8601）。 */
  ts: string;
  sessionId?: string;
  action: AuditActionKind;
  outcome?: AuditOutcome;
  durationMs?: number;
  errorCode?: string;
  /** 短摘要（≤200 字，不得含正文）。 */
  summary?: string;
  filesTouched?: number;
  usage?: AuditUsage;
}

export interface AuditBatchRequest {
  batchId?: string;
  events: AuditEventInput[];
}

export interface AuditBatchResponse {
  accepted: number;
  duplicates: number;
  rejected: Array<{ eventId: string; reason: string }>;
}

/** 与服务端 `shared/src/audit.ts` 保持一致；两边一起改。 */
export const MAX_AUDIT_BATCH = 500;
export const MAX_AUDIT_SUMMARY_CHARS = 200;

/** outbox 上限：超出丢最旧（磁盘有界优先于"永不丢"，见 docs/服务端接线-P4-用量上报与策略.md §7）。 */
export const AUDIT_OUTBOX_MAX_EVENTS = 5000;

/** 待上报事件的落盘文件：`{用户数据根}/audit-outbox.jsonl`。 */
export function resolveAuditOutboxPath(): string {
  return join(getZCodeDataRootDir(), "audit-outbox.jsonl");
}

/** 短摘要裁剪：按字符截断并补省略号，保证不超服务端上限。 */
export function truncateAuditSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_AUDIT_SUMMARY_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_AUDIT_SUMMARY_CHARS - 1)}…`;
}
