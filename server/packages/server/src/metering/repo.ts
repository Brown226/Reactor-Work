/**
 * 计量账本仓储（额度分配 P1）：写入（幂等）、按 scope 聚合、单条回读。
 *
 * 边界（与方案 §3 状态所有者一致）：
 *  - **写入方只有 gateway**；本模块不提供 UPDATE/DELETE —— 账本是只增的事实记录。
 *  - **不做费用核算**：cost/pricing_snapshot 由调用方（网关，唯一拿到上游回执 usage 的位置）
 *    按 `common/pricing.ts` 算好后传入，仓储保持无业务公式，避免两处计价漂移。
 *  - 聚合口径与 `audit/repo.ts` 的报表一致：端侧/上游未给 total 时按**四段之和**兜底。
 *  - `outcome != 'ok'` 的行也参与聚合：上游在报错前已消耗的 token 就是花掉的钱；
 *    失败行通常 token 全为 null，不会产生假用量。
 */

import type { IdentityDb } from "../identity/db.js";

export type LedgerSubjectKind = "user" | "system";
export type LedgerOutcome = "ok" | "error" | "aborted";

/** 写入一条账本行（一次代理的终局）。 */
export interface UsageLedgerEntry {
  /** 幂等键：网关每次代理生成；重放不重复计账 */
  requestId: string;
  /** 缺省 = now()（写库时刻） */
  ts?: Date;
  subjectKind: LedgerSubjectKind;
  /** user = 令牌 sub；system = `system:kb` 等（见方案 §2 Q5） */
  uid: string;
  deptId: number | null;
  deptPath: string | null;
  model: string | null;
  provider: string | null;
  /** anthropic | openai | embeddings | rerank */
  apiShape: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  /**
   * server = 网关按四段价核算；none = 该模型无价目；
   * client = 直连调用由端侧上报费用（网关没参与转发，无法自行核算）。
   */
  costSource: "server" | "none" | "client" | null;
  currency: string | null;
  /** 计费时所用的费率快照（事后甄别口径用；无价目时为 null） */
  pricingSnapshot?: unknown;
  outcome?: LedgerOutcome;
  httpStatus?: number | null;
}

/** 聚合过滤：全部可选，缺省 = 全量。 */
export interface UsageLedgerFilter {
  from?: Date;
  to?: Date;
  uid?: string;
  /** 部门子树（dept_head 口径）：dept_id = ANY(...) */
  deptIds?: number[];
  /** 主体类型过滤：缺省不过滤（user + system 都算） */
  subjectKinds?: LedgerSubjectKind[];
  model?: string;
}

/** 聚合结果（与 `UsageSummaryRow` 同口径，便于报表直接复用）。 */
export interface UsageLedgerTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

/** 回读的单条账本行（数据库形状 → 驼峰，NUMERIC 转 number）。 */
export interface UsageLedgerRecord {
  id: number;
  requestId: string;
  ts: string;
  subjectKind: LedgerSubjectKind;
  uid: string;
  deptId: number | null;
  deptPath: string | null;
  model: string | null;
  provider: string | null;
  apiShape: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  costSource: string | null;
  currency: string | null;
  outcome: LedgerOutcome;
  httpStatus: number | null;
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * 写入一条账本行。幂等：同 `request_id` 已存在时返回 `{ inserted: false }`（不报错）。
 *
 * 为什么用 `ON CONFLICT DO NOTHING` 而不是先查后写：网关可能重试整条路径
 * （网络抖动/上游 5xx 后的应用层重放），查+写在并发下仍有竞态；唯一索引是唯一可靠的判定。
 */
export async function recordUsage(
  db: IdentityDb,
  entry: UsageLedgerEntry,
): Promise<{ inserted: boolean }> {
  const result = await db.pool.query(
    `INSERT INTO usage_ledger (
       request_id, ts, subject_kind, uid, dept_id, dept_path,
       model, provider, api_shape,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
       cost, cost_source, currency, pricing_snapshot, outcome, http_status
     ) VALUES (
       $1, coalesce($2, now()), $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20
     )
     ON CONFLICT (request_id) DO NOTHING`,
    [
      entry.requestId,
      entry.ts ?? null,
      entry.subjectKind,
      entry.uid,
      entry.deptId,
      entry.deptPath,
      entry.model,
      entry.provider,
      entry.apiShape,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.totalTokens,
      entry.cost,
      entry.costSource,
      entry.currency,
      entry.pricingSnapshot === undefined ? null : JSON.stringify(entry.pricingSnapshot),
      entry.outcome ?? "ok",
      entry.httpStatus ?? null,
    ],
  );
  return { inserted: (result.rowCount ?? 0) > 0 };
}

/** 拼过滤条件（全部参数化；无过滤时 `where` 为空串）。 */
function buildLedgerWhere(f: UsageLedgerFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.from) conds.push(`ts >= ${p(f.from)}`);
  if (f.to) conds.push(`ts <= ${p(f.to)}`);
  if (f.uid) conds.push(`uid = ${p(f.uid)}`);
  if (f.deptIds && f.deptIds.length > 0) conds.push(`dept_id = ANY(${p(f.deptIds)}::int[])`);
  if (f.subjectKinds && f.subjectKinds.length > 0) conds.push(`subject_kind = ANY(${p(f.subjectKinds)}::text[])`);
  if (f.model) conds.push(`model = ${p(f.model)}`);
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

/**
 * 按 scope 聚合账本（报表/告警/执行前计数的共用口径）。
 * token 总额：优先 `total_tokens`，缺失时按四段之和兜底（与 audit 报表同公式）。
 */
export async function aggregateUsage(
  db: IdentityDb,
  f: UsageLedgerFilter = {},
): Promise<UsageLedgerTotals> {
  const { where, params } = buildLedgerWhere(f);
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT
       count(*)::int AS calls,
       coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
       coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
       coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
       coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens,
       coalesce(sum(coalesce(
         total_tokens,
         coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
           + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
       )), 0)::bigint AS total_tokens,
       coalesce(sum(cost), 0)::numeric AS cost
     FROM usage_ledger ${where}`,
    params,
  );
  const r = rows[0] ?? {};
  return {
    calls: Number(r.calls ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
    cost: Number(r.cost ?? 0),
  };
}

/* ---------------- 分组聚合（报表口径切换，P4） ---------------- */

/** 分组口径：与 `@reactor/shared` 的 `UsageGroupBy` 同词表（此处不 import，服务端 dist 自包含）。 */
export type LedgerGroupBy = "dept" | "model" | "user" | "day";

const GROUP_EXPR: Record<LedgerGroupBy, string> = {
  dept: "coalesce(dept_path, '(未分配)')",
  model: "coalesce(model, '(未知模型)')",
  user: "uid",
  day: "to_char(ts, 'YYYY-MM-DD')",
};

/**
 * 按维度分组聚合账本（报表主表）。
 *
 * 与 `/desktop/usage/summary` 的关系：P4 起该端点**用本函数**（账本口径），
 * 取代原先把 `audit_event` 当用量源的实现（`audit/repo.ts` 的 `summarizeUsage`
 * 随之删除，避免两套口径并存让"报表与额度对不上"）。
 *
 * 只统计带用量的事实行（同审计报表的过滤口径）；scope 过滤由 `filter` 承担
 * （uid / deptIds 由路由层按角色解析后传入）。
 */
export async function summarizeLedgerUsage(
  db: IdentityDb,
  filter: UsageLedgerFilter,
  groupBy: LedgerGroupBy,
): Promise<{
  rows: Array<{ key: string } & UsageLedgerTotals>;
  totals: UsageLedgerTotals;
}> {
  const { where, params } = buildLedgerWhere(filter);
  const usageOnly = `${where ? `${where} AND` : "WHERE"} (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cost IS NOT NULL)`;
  const agg = `
    count(*)::int AS calls,
    coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
    coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
    coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
    coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens,
    coalesce(sum(coalesce(
      total_tokens,
      coalesce(input_tokens, 0) + coalesce(output_tokens, 0)
        + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
    )), 0)::bigint AS total_tokens,
    coalesce(sum(cost), 0)::numeric AS cost`;

  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT ${GROUP_EXPR[groupBy]} AS key, ${agg} FROM usage_ledger ${usageOnly}
     GROUP BY 1 ORDER BY total_tokens DESC, calls DESC LIMIT 500`,
    params,
  );
  const { rows: totalRows } = await db.pool.query<Record<string, unknown>>(
    `SELECT ${agg} FROM usage_ledger ${usageOnly}`,
    params,
  );

  const toTotals = (r: Record<string, unknown> = {}): UsageLedgerTotals => ({
    calls: Number(r.calls ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
    cost: Number(r.cost ?? 0),
  });

  return {
    rows: rows.map((r) => ({ key: String(r.key), ...toTotals(r) })),
    totals: toTotals(totalRows[0]),
  };
}

/** 按 `request_id` 回读单条（探针与排查用；日常读路径是聚合）。 */
export async function getLedgerRow(
  db: IdentityDb,
  requestId: string,
): Promise<UsageLedgerRecord | null> {  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM usage_ledger WHERE request_id = $1`,
    [requestId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    requestId: String(r.request_id),
    ts: (r.ts as Date).toISOString(),
    subjectKind: r.subject_kind === "system" ? "system" : "user",
    uid: String(r.uid),
    deptId: numOrNull(r.dept_id),
    deptPath: (r.dept_path as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    apiShape: (r.api_shape as string | null) ?? null,
    inputTokens: numOrNull(r.input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    cacheReadTokens: numOrNull(r.cache_read_tokens),
    cacheWriteTokens: numOrNull(r.cache_write_tokens),
    totalTokens: numOrNull(r.total_tokens),
    cost: numOrNull(r.cost),
    costSource: (r.cost_source as string | null) ?? null,
    currency: (r.currency as string | null) ?? null,
    outcome: r.outcome === "error" || r.outcome === "aborted" ? r.outcome : "ok",
    httpStatus: numOrNull(r.http_status),
  };
}
