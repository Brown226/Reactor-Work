/**
 * 额度规则仓储与解析器（额度分配 P2）。
 *
 * ## 解析语义（方案 §2 Q7：叠加检查，不做覆盖）
 *
 * 一次调用受**全部适用规则**约束：组织规则 + 该用户部门祖先链上每条启用的部门规则 +
 * 个人规则。任一 `block` 规则超限即阻断；不做"部门规则覆盖组织规则"这类隐式层级语义
 * （那会让"组织设了 5000 万"在部门设了 1000 万后失效，属于危险的静默行为）。
 *
 * 为什么是「祖先链」而不是「本部门」：额度通常按组织架构分层下发 ——
 * 研发部 1000 万，其下的平台组 300 万，是**子集**关系；组长在平台组，就同时受两条约束。
 *
 * ## 与告警的关系
 *
 * 告警按**每条规则独立评估**（同一条用量可能同时触发部门 80% 与个人 80%），
 * 幂等键带上 scope（见 quota-schema.ts 的约束迁移）。
 */

import type { IdentityDb } from "../identity/db.js";

export type QuotaScopeType = "org" | "dept" | "user";
export type QuotaAction = "warn" | "block";

export interface QuotaRule {
  id: number;
  scopeType: QuotaScopeType;
  /** org 为 null；dept 是 departments.id 的字符串；user 是 uid */
  scopeId: string | null;
  period: "month";
  limitTokens: number | null;
  limitCost: number | null;
  alertThresholds: number[];
  action: QuotaAction;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/** 规则写入形状（路由层已校验）。 */
export interface QuotaRuleInput {
  scopeType: QuotaScopeType;
  scopeId?: string | null;
  limitTokens?: number | null;
  limitCost?: number | null;
  alertThresholds?: number[];
  action?: QuotaAction;
  enabled?: boolean;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRule(r: Record<string, unknown>): QuotaRule {
  return {
    id: Number(r.id),
    scopeType: r.scope_type === "dept" || r.scope_type === "user" ? r.scope_type : "org",
    scopeId: (r.scope_id as string | null) ?? null,
    period: "month",
    limitTokens: numOrNull(r.limit_tokens),
    limitCost: numOrNull(r.limit_cost),
    alertThresholds: Array.isArray(r.alert_thresholds)
      ? (r.alert_thresholds as unknown[]).filter((n): n is number => typeof n === "number" && n > 0 && n <= 100)
      : [],
    action: r.action === "block" ? "block" : "warn",
    enabled: r.enabled !== false,
    updatedAt: (r.updated_at as Date).toISOString(),
    updatedBy: (r.updated_by as string | null) ?? null,
  };
}

/** 列出全部规则（管理台读）。 */
export async function listQuotaRules(db: IdentityDb): Promise<QuotaRule[]> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM quota_rule ORDER BY scope_type, scope_id NULLS FIRST, id`,
  );
  return rows.map(toRule);
}

/** 启用中的全部规则（解析器用；规则数量级很小，一次性读回内存过滤）。 */
export async function listEnabledQuotaRules(db: IdentityDb): Promise<QuotaRule[]> {
  const { rows } = await db.pool.query<Record<string, unknown>>(`SELECT * FROM quota_rule WHERE enabled`);
  return rows.map(toRule);
}

/**
 * upsert（按 `(scope_type, scope_id)` 覆盖）。
 *
 * org 走部分唯一索引（scope_id 为 NULL 时 UNIQUE 不生效），所以 org 用
 * `ON CONFLICT ... WHERE` 匹配不到 —— 改为先删后插（同一事务语义由单条 CTE 保证）。
 */
export async function upsertQuotaRule(
  db: IdentityDb,
  input: QuotaRuleInput,
  updatedBy: string,
): Promise<QuotaRule> {
  const scopeId = input.scopeType === "org" ? null : (input.scopeId ?? null);
  const thresholds = (input.alertThresholds ?? [80, 100]).filter((n) => n > 0 && n <= 100);
  const values = {
    scopeType: input.scopeType,
    scopeId,
    limitTokens: input.limitTokens ?? null,
    limitCost: input.limitCost ?? null,
    alertThresholds: thresholds.length > 0 ? thresholds : [80, 100],
    action: input.action ?? "warn",
    enabled: input.enabled ?? true,
    updatedBy,
  };
  if (input.scopeType === "org") {
    /**
     * org 的 scope_id 恒为 NULL，而 UNIQUE 里 NULL 不去重 ⇒ 走部分唯一索引
     * `quota_rule_org_uniq (period) WHERE scope_type='org'`。
     *
     * ⚠ 参数表必须与 SQL 里的占位符**一一对应**：这里 scope_id 直接写 NULL 字面量，
     * 所以没有 $2 —— 若仍按 8 个参数传，未使用的 $2 会让 PG 报
     * `could not determine data type of parameter $2`（本冒烟实测踩到过）。
     */
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `INSERT INTO quota_rule (scope_type, scope_id, limit_tokens, limit_cost, alert_thresholds, action, enabled, updated_by)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (period) WHERE scope_type = 'org'
         DO UPDATE SET limit_tokens = EXCLUDED.limit_tokens, limit_cost = EXCLUDED.limit_cost,
                       alert_thresholds = EXCLUDED.alert_thresholds, action = EXCLUDED.action,
                       enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [values.scopeType, values.limitTokens, values.limitCost, values.alertThresholds, values.action, values.enabled, values.updatedBy],
    );
    return toRule(rows[0]!);
  }
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `INSERT INTO quota_rule (scope_type, scope_id, limit_tokens, limit_cost, alert_thresholds, action, enabled, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (scope_type, scope_id, period)
       DO UPDATE SET limit_tokens = EXCLUDED.limit_tokens, limit_cost = EXCLUDED.limit_cost,
                     alert_thresholds = EXCLUDED.alert_thresholds, action = EXCLUDED.action,
                     enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [values.scopeType, values.scopeId, values.limitTokens, values.limitCost, values.alertThresholds, values.action, values.enabled, values.updatedBy],
  );
  return toRule(rows[0]!);
}

export async function deleteQuotaRule(db: IdentityDb, id: number): Promise<boolean> {
  const r = await db.pool.query(`DELETE FROM quota_rule WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 解析某用户当前适用的规则集合（org + 部门祖先链 + 个人）。
 *
 * `deptAncestors` 由调用方传入（identity 侧从 `departments.path` 解析；网关侧按 deptId 查），
 * 以保持本模块不依赖 identity 的内部实现。传空数组时只含 org 与个人规则。
 */
export function resolveApplicableRules(
  rules: QuotaRule[],
  args: { uid: string | null; deptAncestors: number[] },
): QuotaRule[] {
  const ancestorSet = new Set(args.deptAncestors.map(String));
  return rules.filter((r) => {
    if (r.scopeType === "org") return true;
    if (r.scopeType === "user") return args.uid !== null && r.scopeId === args.uid;
    return r.scopeId !== null && ancestorSet.has(r.scopeId);
  });
}

/**
 * 由部门 id 求祖先链（含自身）。
 *
 * 用 `path` 字符串（形如 `/1/5/9/`）解析：`departments.path` 是既有字段，
 * 比递归 CTE 便宜且没有环风险。找不到该部门时返回空数组（只留 org 与个人规则）。
 */
export async function deptAncestorIds(db: IdentityDb, deptId: number | null): Promise<number[]> {
  if (deptId === null) return [];
  const { rows } = await db.pool.query<{ path: string | null }>(
    `SELECT path FROM departments WHERE id = $1`,
    [deptId],
  );
  const path = rows[0]?.path;
  if (!path) return [deptId];
  const ids = path
    .split("/")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  // 防御：路径不含自身时补上（历史数据可能不带尾斜杠）
  if (!ids.includes(deptId)) ids.push(deptId);
  return ids;
}

/**
 * 部门子树 id 集合（含自身）—— 与 `deptAncestorIds` 方向相反，别混。
 *
 * 祖先链是"我受哪些部门规则约束"（向上），子树是"这个部门涵盖哪些部门"（向下）。
 * 用 `path` 前缀匹配：`path` 形如 `/1/5/9`，子树即 `path = 自身` 或 `path LIKE '自身/%'`。
 * 不递归查树：一次查询、无环风险，且 `departments.path` 有唯一索引。
 *
 * 从 quota-eval.ts 搬来此处：批量下发（§11.7 的 `expandUsers`）也要展开子树，
 * 两边各写一份必然漂移；且 SQL 归 repo 层（server/AGENTS.md 的分层）。
 */
export async function deptSubtreeIds(db: IdentityDb, deptId: number): Promise<number[]> {
  if (!Number.isInteger(deptId) || deptId <= 0) return [];
  const { rows } = await db.pool.query<{ path: string | null }>(
    `SELECT path FROM departments WHERE id = $1`,
    [deptId],
  );
  const path = rows[0]?.path;
  if (!path) return [deptId];
  const { rows: sub } = await db.pool.query<{ id: number }>(
    `SELECT id FROM departments WHERE path = $1 OR path LIKE $2`,
    [path, `${path}/%`],
  );
  const ids = sub.map((r) => Number(r.id));
  return ids.includes(deptId) ? ids : [...ids, deptId];
}

/** 这些部门 id 中实际存在的（批量下发挡掉"部门已删"：给不存在的部门建规则是静默失效）。 */
export async function existingDeptIds(db: IdentityDb, deptIds: number[]): Promise<Set<number>> {
  if (deptIds.length === 0) return new Set();
  const { rows } = await db.pool.query<{ id: number }>(
    `SELECT id FROM departments WHERE id = ANY($1::int[])`,
    [deptIds],
  );
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * 指定部门集合下**在用**用户的 uid（`expandUsers` 用）。
 *
 * 只取 `status='active'`：给已停用账号发额度没有意义（人已离职），
 * 且规则会一直挂在列表里成为噪声。停用/不存在的区分由 `uidStatusMap` 负责。
 */
export async function listActiveUidsInDepts(db: IdentityDb, deptIds: number[]): Promise<string[]> {
  if (deptIds.length === 0) return [];
  const { rows } = await db.pool.query<{ uid: string }>(
    `SELECT uid FROM users WHERE department_id = ANY($1::int[]) AND status = 'active' ORDER BY uid`,
    [deptIds],
  );
  return rows.map((r) => r.uid);
}

/** 指定 uid 的在库状态（区分"不存在"与"已停用"——两者对管理员的动作不同）。 */
export async function uidStatusMap(
  db: IdentityDb,
  uids: string[],
): Promise<Map<string, "active" | "disabled">> {
  const out = new Map<string, "active" | "disabled">();
  if (uids.length === 0) return out;
  const { rows } = await db.pool.query<{ uid: string; status: string }>(
    `SELECT uid, status FROM users WHERE uid = ANY($1::text[])`,
    [uids],
  );
  for (const r of rows) out.set(r.uid, r.status === "active" ? "active" : "disabled");
  return out;
}

/**
 * 库里已有规则的 scope 键集合（`scopeType:scopeId`，org 为 `org:`）。
 *
 * 供批量预览标注每条目标是"新建"还是"覆盖已有"—— 批量操作最怕的就是
 * 无声覆盖掉别人精心调过的单条规则。
 */
export async function existingRuleScopeKeys(db: IdentityDb): Promise<Set<string>> {
  const { rows } = await db.pool.query<{ scope_type: string; scope_id: string | null }>(
    `SELECT scope_type, scope_id FROM quota_rule`,
  );
  return new Set(
    rows.map((r) => `${r.scope_type}:${r.scope_id ?? ""}`),
  );
}
