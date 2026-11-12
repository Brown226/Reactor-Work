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
  /** 产品文档入口地址；null = 未配置（端侧弹提示不跳转）。维护方式见 docs/已完成/已完成-产品文档入口.md */
  productDocsUrl?: string | null;
  updatedAt?: string;
  updatedBy?: string;
}

export const policyApi = {
  get: () => http.get<{ policy: DesktopPolicy }>("/desktop/policy", AUTH),
  put: (policy: Omit<DesktopPolicy, "updatedAt" | "updatedBy">) =>
    http.put<{ policy: DesktopPolicy }>("/desktop/policy", policy, AUTH),
};

/**
 * 额度告警（P2 起带 scope）。
 *
 * 字段名对应新口径：旧的顶层 `monthTokens/limitTokens/percent` 已移除 —— 那是
 * "全组织单值"时代的产物。现在每条告警自带 scope 与用量，页面按 scope 渲染，
 * 不再存在"全局百分比"这一个数。
 */
export interface QuotaAlert {
  id: number;
  period: string;
  scopeType: "org" | "dept" | "user";
  scopeId: string | null;
  threshold: number;
  level: "warn" | "critical";
  /** 该 scope 范围内的当期用量 */
  usedTokens: number;
  /** 该 scope 的 token 上限（未设则 null） */
  limitTokens: number | null;
  usedCost: number;
  limitCost: number | null;
  percent: number;
  createdAt: string;
  notified: boolean;
  notifyError: string | null;
}

export interface QuotaAlertsResult {
  period: string;
  alerts: QuotaAlert[];
  /** 是否配了告警外发（REACTOR_QUOTA_WEBHOOK_URL） */
  webhookConfigured: boolean;
}

/** 额度告警：同一周期同一 scope 同一阈值只告警一次 */
export const quotaAlertsApi = {
  list: (period?: string) => http.get<QuotaAlertsResult>(`/admin/quota-alerts${period ? `?period=${period}` : ""}`, AUTH),
};

/** 额度规则（P2）：org/dept/user 三类维度，可按 tokens 或费用设上限。 */
/** 规则的当期用量（服务端算，与告警/阻断同源 —— 前端不得自行推算）。 */
export interface QuotaRuleUsage {
  usedTokens: number;
  usedCost: number;
  /** tokens 使用率 0-100；未设 limit_tokens 时为 null */
  tokenPercent: number | null;
  costPercent: number | null;
  exceeded: boolean;
}

export interface QuotaRule {
  id: number;
  scopeType: "org" | "dept" | "user";
  scopeId: string | null;
  period: "month";
  limitTokens: number | null;
  limitCost: number | null;
  alertThresholds: number[];
  action: "warn" | "block";
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
  /** 当期用量；null = 服务端汇总失败（页面显示「—」，不猜） */
  usage?: QuotaRuleUsage | null;
  /** 旧配置（desktop_policy.quota）合成项：只读，保存即迁移到 quota_rule（id=-1） */
  synthesized?: true;
}

export const quotaRulesApi = {
  list: () => http.get<{ rules: QuotaRule[] }>("/admin/quota-rules", AUTH),
  put: (rule: {
    scopeType: "org" | "dept" | "user";
    scopeId?: string | null;
    /** 可带单位后缀：`5M` / `500K` / `500万` / `5000000`（服务端换算后回显） */
    limitTokens?: number | string | null;
    limitCost?: number | null;
    alertThresholds?: number[];
    action?: "warn" | "block";
    enabled?: boolean;
  }) => http.put<{ rule: QuotaRule; quotaAlerts?: QuotaAlert[] }>("/admin/quota-rules", rule, AUTH),
  del: (id: number) => http.delete<{ ok: boolean }>(`/admin/quota-rules/${id}`, AUTH),
  /**
   * 批量下发（§11.7）：一次给多个目标同值写规则。
   *
   * `dryRun: true` 只解析不写库（预览）；预览与写入走同一端点，
   * 服务端保证"预览看到什么就写什么"。
   */
  batch: (body: QuotaBatchRequest) =>
    http.post<QuotaBatchResult>("/admin/quota-rules/batch", body, AUTH),
};

/** 批量下发的一个目标组（服务端 `POST /admin/quota-rules/batch` 的 targets[]）。 */
export interface QuotaBatchTarget {
  scopeType: "org" | "dept" | "user";
  /** dept 传部门 id、user 传 uid；org 不需要 */
  scopeIds?: string[];
  /** dept 专用：把该部门子树下每个在用用户展开为各自的 user 规则 */
  expandUsers?: boolean;
}

export interface QuotaBatchRequest {
  targets: QuotaBatchTarget[];
  /** 可带单位后缀（服务端权威换算） */
  limitTokens?: number | string | null;
  limitCost?: number | null;
  alertThresholds?: number[];
  action?: "warn" | "block";
  enabled?: boolean;
  /** true = 只预览不写库 */
  dryRun?: boolean;
}

export interface QuotaBatchResolvedRule {
  scopeType: "org" | "dept" | "user";
  scopeId: string | null;
  /** true = 该 scope 已有规则，本次是覆盖（预览里必须可见） */
  existed: boolean;
}

export interface QuotaBatchSkipped {
  scopeType: "org" | "dept" | "user";
  scopeId: string | null;
  reason: string;
}

export interface QuotaBatchResult {
  dryRun: boolean;
  resolved: { org: number; dept: number; user: number };
  rules: QuotaBatchResolvedRule[];
  skipped: QuotaBatchSkipped[];
  /** 实际写入条数（dryRun 恒 0） */
  applied: number;
  /** 写入后当场触发的告警数 */
  triggeredAlerts?: number;
}

/** 计量对账（P1c）：账本（网关权威）vs 端侧上报的漂移，按 model。 */
export interface ReconciliationRow {
  model: string;
  ledgerCalls: number;
  reportedCalls: number;
  ledgerTokens: number;
  reportedTokens: number;
  deltaTokens: number;
  /** 其中属于 system 调用（KB 向量化等）：端侧按 P4-D1 本就不报，属可解释差额 */
  ledgerSystemTokens: number;
}

export interface ReconciliationResult {
  from: string;
  to: string;
  rows: ReconciliationRow[];
  totals: {
    ledgerCalls: number;
    reportedCalls: number;
    ledgerTokens: number;
    reportedTokens: number;
    deltaTokens: number;
    ledgerSystemTokens: number;
  };
  expectedDeltaFromSystem: number;
}

export const reconciliationApi = {
  get: (params: { from?: string; to?: string } = {}) =>
    http.get<ReconciliationResult>(`/admin/usage/reconciliation${qs(params)}`, AUTH),
};
