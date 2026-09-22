// Reactor 管理台 · 审计与用量服务（G0 数据面）
// 契约真源：packages/shared/src/audit.ts。本包不依赖 @reactor/shared（保持独立构建），
// 故此处只镜像本页用到的那部分字段——改契约时两处一起改。
// 服务端实现见 packages/server/src/audit/routes.ts。

import { http } from "../http/client";
import { refreshAccess } from "./identity";
import { localStorageTokenStore } from "../http/client";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export type AuditActionKind = "model_call" | "tool_call" | "approval" | "policy_block" | "admin_action" | "session" | "auth";
export type UsageGroupBy = "dept" | "model" | "user" | "day";
export type PolicyMode = "plan" | "build" | "edit" | "yolo";

export interface AuditUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
  model?: string;
  provider?: string;
}

export interface AuditEventRow {
  id: number;
  eventId: string;
  ts: string;
  uid: string;
  deptId: number | null;
  deptPath: string | null;
  sessionId?: string;
  sessionType?: string;
  action: AuditActionKind;
  toolName?: string;
  /** 操作对象（admin_action 用），如 secrets:3 */
  target?: string;
  outcome?: string;
  approvalDecision?: string;
  policyMode?: string;
  durationMs?: number;
  errorCode?: string;
  summary?: string;
  filesTouched?: number;
  usage?: AuditUsage;
  /** 服务端核算的费用（= usage.cost） */
  cost?: number;
  /** 端侧上报的费用（对照） */
  costReported?: number;
  /** server=服务端按四段价核算；client=无量价配置回落端侧值 */
  costSource?: "server" | "client" | null;
  receivedAt: string;
}

export interface AuditStats {
  byAction: Array<{ key: string; count: number }>;
  byOutcome: Array<{ key: string; count: number }>;
  byUid: Array<{ key: string; count: number }>;
}

export interface AuditQueryParams {
  from?: string;
  to?: string;
  uid?: string;
  deptId?: number;
  action?: string;
  toolName?: string;
  sessionId?: string;
  outcome?: string;
  limit?: number;
  offset?: number;
  stats?: boolean;
}

export interface AuditQueryResult {
  events: AuditEventRow[];
  total: number;
  limit: number;
  offset: number;
  scope: "platform_admin" | "dept_head" | "user";
  stats?: AuditStats;
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const auditApi = {
  query: (params: AuditQueryParams) => http.get<AuditQueryResult>(`/desktop/audit${qs(params)}`, AUTH),
  /** CSV 导出（明细，最多 1000 行/次） */
  downloadCsv: (params: AuditQueryParams) => http.download(`/desktop/audit${qs({ ...params, format: "csv", limit: 1000 })}`),
};

export interface UsageSummaryRow {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface UsageSummaryResult {
  groupBy: UsageGroupBy;
  from: string;
  to: string;
  rows: UsageSummaryRow[];
  totals: UsageSummaryRow;
  scope: string;
}

export const usageApi = {
  summary: (params: { groupBy: UsageGroupBy; from?: string; to?: string; uid?: string; limit?: number }) =>
    http.get<UsageSummaryResult>(`/desktop/usage/summary${qs({ ...params, limit: 500 })}`, AUTH),
};

export interface DesktopPolicy {
  defaultApprovalMode: PolicyMode;
  commandBlacklist: string[];
  egressAllowlist: string[];
  quota: { monthlyTokenLimit: number | null; alertThresholds: number[] };
  updatedAt?: string;
  updatedBy?: string;
}

export const policyApi = {
  get: () => http.get<{ policy: DesktopPolicy }>("/desktop/policy", AUTH),
  put: (policy: Omit<DesktopPolicy, "updatedAt" | "updatedBy">) =>
    http.put<{ policy: DesktopPolicy }>("/desktop/policy", policy, AUTH),
};

export interface QuotaAlert {
  id: number;
  period: string;
  threshold: number;
  level: "warn" | "critical";
  monthTokens: number;
  limitTokens: number;
  percent: number;
  createdAt: string;
  notified: boolean;
  notifyError: string | null;
}

export interface QuotaAlertsResult {
  period: string;
  monthTokens: number;
  limitTokens: number | null;
  percent: number | null;
  alerts: QuotaAlert[];
  /** 是否配了告警外发（REACTOR_QUOTA_WEBHOOK_URL） */
  webhookConfigured: boolean;
}

/** 额度告警（M9）：谁在何时被阈值告警过；同一周期同一阈值只告警一次 */
export const quotaAlertsApi = {
  list: (period?: string) => http.get<QuotaAlertsResult>(`/admin/quota-alerts${period ? `?period=${period}` : ""}`, AUTH),
};
