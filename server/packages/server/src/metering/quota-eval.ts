/**
 * 额度评估引擎（额度分配 P2）：按规则算当期用量 → 触发告警 → 供 P3 做阻断判定。
 *
 * ## 口径（与方案 §3 一致）
 *
 *  · **用量取账本**（`usage_ledger`），不是端侧上报 —— 这是 P1 立下的权威源。
 *  · **周期为自然月**（UTC；`REACTOR_QUOTA_PERIOD_TZ` 预留未实现，方案 §2 Q4 列为 P5）。
 *  · **部门规则只统计该部门子树**（`dept_id = ANY(子树)`）—— 与审计报表的口径一致：
 *    "研发部用了多少"应当含其下所有组，否则部门额度会被子部门绕开。
 *    实现上取规则的部门子树（`subtreeIds`），而不是祖先链 —— 两者方向相反，别混。
 *  · **org 规则统计全部**（含 system 调用，方案 §2 Q5）；user/部门规则**排除 system**
 *    （系统调用不归属到人/部门）。
 *
 * ## 幂等
 *
 * `quota_alert` 的 `(period, scope_type, scope_id, threshold)` 唯一 + `ON CONFLICT DO NOTHING`：
 * 同周期同 scope 同阈值只告警一次（老库的旧约束由 quota-schema.ts 迁移）。
 *
 * ## 失败语义
 *
 * 评估失败**不影响**上报/调用（调用方 catch）；webhook 为 best-effort。
 */

import type { IdentityDb } from "../identity/db.js";
import { aggregateUsage } from "./repo.js";
import {
  deptAncestorIds,
  deptSubtreeIds,
  listEnabledQuotaRules,
  resolveApplicableRules,
  type QuotaRule,
} from "./quota-repo.js";

/** 当前周期（UTC，YYYY-MM）。 */
export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * 旧配置合成（方案 §6 兼容）：`desktop_policy.quota` 里还有组织级单值、且库里**没有**
 * org 规则时，把它当成一条 `warn` 的 org 规则参与评估。
 *
 * 为什么必须合成而不是忽略：老部署的额度就在那个字段里，管理台没迁移前直接忽略会让
 * "设了额度却不再告警"——静默失效比报错更难发现。有 org 规则时以 `quota_rule` 为准
 * （管理台保存即完成迁移，见 quota-routes 的 synthesized 提示）。
 */
function synthesizeOrgRule(policy: {
  quota: { monthlyTokenLimit: number | null; alertThresholds: number[] };
}): QuotaRule | null {
  const limit = policy.quota.monthlyTokenLimit;
  const thresholds = policy.quota.alertThresholds.filter((n) => n > 0 && n <= 100);
  if ((limit === null || limit <= 0) && thresholds.length === 0) return null;
  return {
    id: -1, // 合成项，不落库（前端以 synthesized 标记）
    scopeType: "org",
    scopeId: null,
    period: "month",
    limitTokens: limit !== null && limit > 0 ? limit : null,
    limitCost: null,
    alertThresholds: thresholds.length > 0 ? thresholds : [80, 100],
    action: "warn", // 旧配置语义就是"只告警不阻断"（P4 D5），不因合成而变成 block
    enabled: true,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };
}

/** 周期起止（UTC）。 */
export function periodRange(period: string): { from: Date; to: Date } {
  const [y, m] = period.split("-").map(Number);
  const from = new Date(Date.UTC(y!, (m ?? 1) - 1, 1));
  const to = new Date(Date.UTC(y!, m ?? 1, 1));
  return { from, to };
}

/** 某规则在当期内的用量（令牌类型口径见文件头）。 */
export interface RuleUsage {
  rule: QuotaRule;
  /** 适用范围内的 token 合计 */
  tokens: number;
  /** 适用范围内的费用合计（¥；无价目的调用记 0） */
  cost: number;
  /** tokens / limitTokens 的百分比（未设 limit_tokens 时为 null） */
  tokenPercent: number | null;
  /** cost / limitCost 的百分比（未设 limit_cost 时为 null） */
  costPercent: number | null;
  /** 任一维度（tokens 或 cost）已超上限 */
  exceeded: boolean;
}

/** 告警记录（含 scope）。 */
export interface ScopedQuotaAlert {
  id: number;
  period: string;
  scopeType: "org" | "dept" | "user";
  scopeId: string | null;
  threshold: number;
  level: "warn" | "critical";
  usedTokens: number;
  limitTokens: number | null;
  usedCost: number;
  limitCost: number | null;
  percent: number;
  createdAt: string;
  notified: boolean;
  notifyError: string | null;
}

export interface QuotaEvaluation {
  period: string;
  /** 本周期被评估的规则数（无启用规则时为 0） */
  ruleCount: number;
  /** 各规则的当期用量 */
  usages: RuleUsage[];
  /** 本次新触发的告警 */
  newAlerts: ScopedQuotaAlert[];
  /** 是否存在任一 `block` 规则超限（P3 据此 429） */
  blocking: RuleUsage[];
}

/** 单条规则的当期用量摘要（管理台列表展示进度用）。 */
export interface RuleUsageSummary {
  usedTokens: number;
  usedCost: number;
  /** tokens 使用率（0-100，两位小数）；未设 limit_tokens 时为 null */
  tokenPercent: number | null;
  costPercent: number | null;
  /** 任一维度已超限 */
  exceeded: boolean;
}

/**
 * 批量计算规则的当期用量（管理台列表一次取回）。
 *
 * 为什么放在服务端算而不是前端拼：口径必须与告警/阻断**完全一致**（同一份 `usageForRule`），
 * 否则页面显示"还剩很多"而用户已被 429，是最难排查的一类不一致。
 *
 * 性能：每条规则一次聚合查询。规则数是「少量级」（组织 1 条 + 部门若干 + 用户若干），
 * N+1 可接受；真到需要时再上物化计数器（方案 §5-P3 的口径）。
 */
export async function summarizeRulesUsage(
  db: IdentityDb,
  rules: QuotaRule[],
  period = currentPeriod(),
): Promise<Map<number, RuleUsageSummary>> {
  const { from, to } = periodRange(period);
  const out = new Map<number, RuleUsageSummary>();
  for (const rule of rules) {
    const { tokens, cost } = await usageForRule(db, rule, from, to);
    out.set(rule.id, {
      usedTokens: tokens,
      usedCost: cost,
      tokenPercent: pct(tokens, rule.limitTokens),
      costPercent: pct(cost, rule.limitCost),
      exceeded:
        (rule.limitTokens !== null && rule.limitTokens > 0 && tokens >= rule.limitTokens) ||
        (rule.limitCost !== null && rule.limitCost > 0 && cost >= rule.limitCost),
    });
  }
  return out;
}

/** 求某规则的当期用量（部门规则取子树，见文件头）。 */
async function usageForRule(
  db: IdentityDb,
  rule: QuotaRule,
  from: Date,
  to: Date,
): Promise<{ tokens: number; cost: number }> {
  const base = { from, to };
  if (rule.scopeType === "org") {
    // 组织口径含 system（Q5：KB 向量化等计入组织额度）
    const t = await aggregateUsage(db, base);
    return { tokens: t.totalTokens, cost: t.cost };
  }
  if (rule.scopeType === "user") {
    const t = await aggregateUsage(db, { ...base, uid: rule.scopeId ?? "", subjectKinds: ["user"] });
    return { tokens: t.totalTokens, cost: t.cost };
  }
  // 部门：该部门**子树**（不是祖先链 —— 方向相反）
  const subtree = await deptSubtreeIds(db, Number(rule.scopeId));
  if (subtree.length === 0) return { tokens: 0, cost: 0 };
  const t = await aggregateUsage(db, { ...base, deptIds: subtree, subjectKinds: ["user"] });
  return { tokens: t.totalTokens, cost: t.cost };
}

/** 惰性读旧策略（避免与 audit 域形成模块级循环依赖）。 */
async function getPolicyLazy(db: IdentityDb): Promise<{
  quota: { monthlyTokenLimit: number | null; alertThresholds: number[] };
} | null> {
  try {
    const { getPolicy } = await import("../audit/repo.js");
    return await getPolicy(db);
  } catch {
    return null;
  }
}

/** 百分比（保留 2 位；上限 99999999.99 与列宽对齐）。 */
function pct(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(99999999.99, Math.round((used / limit) * 10000) / 100);
}

/**
 * 逐规则算当期用量 → 触发告警（批量下发与单用户评估共用）。
 *
 * 为什么单独导出：批量下发（§11.7）一次要评估几百条 user 规则，若逐用户复用
 * `evaluateQuotaFor` 会退化成 N×M（每个用户重读全部启用规则再各自聚合一遍）。
 * 这里按**规则**维度一遍过，用量口径与 `summarizeRulesUsage` 同源。
 */
export async function evaluateRules(
  db: IdentityDb,
  rules: QuotaRule[],
  period = currentPeriod(),
  webhookUrl?: string,
): Promise<{ usages: RuleUsage[]; newAlerts: ScopedQuotaAlert[] }> {
  const { from, to } = periodRange(period);
  const usages: RuleUsage[] = [];
  for (const rule of rules) {
    const { tokens, cost } = await usageForRule(db, rule, from, to);
    usages.push({
      rule,
      tokens,
      cost,
      tokenPercent: pct(tokens, rule.limitTokens),
      costPercent: pct(cost, rule.limitCost),
      exceeded:
        (rule.limitTokens !== null && rule.limitTokens > 0 && tokens >= rule.limitTokens) ||
        (rule.limitCost !== null && rule.limitCost > 0 && cost >= rule.limitCost),
    });
  }
  const newAlerts = await triggerAlerts(db, usages, period, webhookUrl);
  return { usages, newAlerts };
}

/**
 * 逐规则 × 逐阈值落告警（token 维度；cost 维度先只用于阻断判定，避免双维度刷屏）。
 *
 * 幂等键 `(period, scope_type, scope_id, threshold)`：同周期同 scope 同阈值只一条，
 * 所以"把额度调低后重复评估"不会刷屏 —— 批量下发据此敢在写完后立即复评。
 */
async function triggerAlerts(
  db: IdentityDb,
  usages: RuleUsage[],
  period: string,
  webhookUrl?: string,
): Promise<ScopedQuotaAlert[]> {
  const newAlerts: ScopedQuotaAlert[] = [];
  for (const u of usages) {
    const thresholds = [...new Set(u.rule.alertThresholds)].filter((t) => t > 0 && t <= 100).sort((a, b) => a - b);
    if (thresholds.length === 0) continue;
    for (const threshold of thresholds) {
      const tokenPct = u.tokenPercent;
      const costPct = u.costPercent;
      const hitToken = tokenPct !== null && tokenPct >= threshold;
      const hitCost = costPct !== null && costPct >= threshold;
      if (!hitToken && !hitCost) continue;
      const percent = Math.max(tokenPct ?? 0, costPct ?? 0);
      const level: "warn" | "critical" = threshold >= 100 ? "critical" : "warn";
      const { rows } = await db.pool.query<{ id: number; created_at: Date }>(
        `INSERT INTO quota_alert (period, threshold, level, month_tokens, limit_tokens, percent, scope_type, scope_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id, created_at`,
        [period, threshold, level, u.tokens, u.rule.limitTokens ?? 0, percent, u.rule.scopeType, u.rule.scopeId],
      );
      const row = rows[0];
      if (!row) continue;
      const alert: ScopedQuotaAlert = {
        id: row.id,
        period,
        scopeType: u.rule.scopeType,
        scopeId: u.rule.scopeId,
        threshold,
        level,
        usedTokens: u.tokens,
        limitTokens: u.rule.limitTokens,
        usedCost: u.cost,
        limitCost: u.rule.limitCost,
        percent,
        createdAt: row.created_at.toISOString(),
        notified: false,
        notifyError: null,
      };
      if (webhookUrl) {
        const result = await notifyWebhook(webhookUrl, alert);
        alert.notified = result.ok;
        alert.notifyError = result.error ?? null;
        await db.pool
          .query(`UPDATE quota_alert SET notified = $1, notified_at = now(), notify_error = $2 WHERE id = $3`, [
            result.ok,
            result.error ?? null,
            row.id,
          ])
          .catch(() => undefined);
      }
      newAlerts.push(alert);
    }
  }
  return newAlerts;
}

/**
 * 评估某用户（或某 scope）的额度：算用量 → 逐规则比对阈值 → 落告警 → 返回阻断判定。
 *
 * `uid=null` 时只评估 org 与部门规则（系统调用/无主体场景）。
 */
export async function evaluateQuotaFor(
  db: IdentityDb,
  args: { uid: string | null; deptId: number | null; period?: string; webhookUrl?: string; policyOrgFallback?: boolean },
): Promise<QuotaEvaluation> {
  const period = args.period ?? currentPeriod();
  const allRules = await listEnabledQuotaRules(db);
  // 兼容合成：仅当调用方明确要求（审计上报路径与 /desktop/quota/me 都要它 ——
  // 否则老部署的额度在迁移前会静默失效）
  if (args.policyOrgFallback !== false && !allRules.some((r) => r.scopeType === "org")) {
    const policy = await getPolicyLazy(db);
    const synth = policy ? synthesizeOrgRule(policy) : null;
    if (synth) allRules.unshift(synth);
  }
  const ancestors = await deptAncestorIds(db, args.deptId);
  const rules = resolveApplicableRules(allRules, { uid: args.uid, deptAncestors: ancestors });

  const { usages, newAlerts } = await evaluateRules(db, rules, period, args.webhookUrl);

  return {
    period,
    ruleCount: rules.length,
    usages,
    newAlerts,
    blocking: usages.filter((u) => u.exceeded && u.rule.action === "block"),
  };
}

/** 告警外发（best-effort）：POST JSON，5s 超时；失败只回报，不抛。 */
async function notifyWebhook(
  url: string,
  alert: ScopedQuotaAlert,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "quota_alert",
        period: alert.period,
        scopeType: alert.scopeType,
        scopeId: alert.scopeId,
        threshold: alert.threshold,
        level: alert.level,
        monthTokens: alert.usedTokens,
        limitTokens: alert.limitTokens,
        percent: alert.percent,
        at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 列出某周期的告警（含各 scope 的当期用量，便于页面直接渲染）。 */
export async function listScopedQuotaAlerts(
  db: IdentityDb,
  period = currentPeriod(),
): Promise<{ period: string; alerts: ScopedQuotaAlert[] }> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM quota_alert WHERE period = $1 ORDER BY scope_type, scope_id NULLS FIRST, threshold`,
    [period],
  );
  return {
    period,
    alerts: rows.map((r) => ({
      id: Number(r.id),
      period: String(r.period),
      scopeType: r.scope_type === "dept" || r.scope_type === "user" ? r.scope_type : "org",
      scopeId: (r.scope_id as string | null) ?? null,
      threshold: Number(r.threshold),
      level: r.level === "critical" ? "critical" : "warn",
      usedTokens: Number(r.month_tokens),
      limitTokens: Number(r.limit_tokens),
      usedCost: 0,
      limitCost: null,
      percent: Number(r.percent),
      createdAt: (r.created_at as Date).toISOString(),
      notified: r.notified === true,
      notifyError: (r.notify_error as string | null) ?? null,
    })),
  };
}
