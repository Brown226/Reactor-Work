/**
 * 审计与用量仓储（G0）：批量写入（幂等）、查询、聚合、策略读写。
 *
 * 全部参数化；只增不改（无 UPDATE/DELETE 审计事件的路径）。
 * 契约类型来自 @reactor/shared（**仅 type import**：服务端 dist 保持自包含，
 * 不做 @reactor/shared 运行时依赖 —— Dockerfile 依赖这一点）。
 */

import type {
  AuditBatchResponse,
  AuditEventInput,
  AuditEventRecord,
  AuditUsage,
  DesktopPolicy,
  UsageGroupBy,
  UsageSummaryResponse,
  UsageSummaryRow,
} from "@reactor/shared";
import type { IdentityDb } from "../identity/db.js";
import { computeCost, effectiveRates, hasBillableTokens, type PricingRates } from "../common/pricing.js";
import { MAX_AUDIT_BATCH, MAX_AUDIT_SUMMARY_CHARS } from "./limits.js";

/** 服务端写入归属（来自令牌，不信任请求体） */
export interface AuditActor {
  uid: string;
  deptId: number | null;
  deptPath: string | null;
}

/** 查询可见范围（按角色收敛） */
export interface AuditScope {
  role: "platform_admin" | "dept_head" | "user";
  uid: string;
  /** dept_head：本部门及子树（含自身）；user 不使用 */
  deptIds: number[];
}

const ACTIONS = new Set(["model_call", "tool_call", "approval", "policy_block", "session", "admin_action", "auth"]);
const OUTCOMES = new Set(["ok", "error", "denied", "cancelled"]);
const APPROVALS = new Set(["allow", "deny", "ask", "forbidden"]);
const POLICY_MODES = new Set(["readonly", "balanced", "trust", "strict"]);
const SESSION_TYPES = new Set(["code", "work", "general", "unknown"]);

/** 事件时间允许的偏差：不能太超前（时钟错乱/伪造），也不能太旧（离线补传上限 180 天）。 */
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_PAST_MS = 180 * 24 * 60 * 60 * 1000;

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** 校验单条事件；返回错误原因字符串（null = 通过）。 */
export function validateEvent(e: AuditEventInput, now = Date.now()): string | null {
  if (!e || typeof e !== "object") return "事件非法";
  if (typeof e.eventId !== "string" || e.eventId.length < 1 || e.eventId.length > 128) return "eventId 缺失或过长";
  const ts = Date.parse(e.ts);
  if (!Number.isFinite(ts)) return "ts 非法";
  if (ts - now > MAX_FUTURE_MS) return "ts 超前（时钟或伪造）";
  if (now - ts > MAX_PAST_MS) return "ts 过旧（超出 180 天补传窗口）";
  if (!ACTIONS.has(e.action)) return "action 非法";
  if (e.target !== undefined && (typeof e.target !== "string" || e.target.length > 128)) return "target 非法";
  if (e.summary !== undefined) {
    if (typeof e.summary !== "string") return "summary 类型非法";
    if (e.summary.length > MAX_AUDIT_SUMMARY_CHARS) return `summary 超长（>${MAX_AUDIT_SUMMARY_CHARS}）`;
  }
  if (e.outcome !== undefined && !OUTCOMES.has(e.outcome)) return "outcome 非法";
  if (e.approvalDecision !== undefined && !APPROVALS.has(e.approvalDecision)) return "approvalDecision 非法";
  if (e.policyMode !== undefined && !POLICY_MODES.has(e.policyMode)) return "policyMode 非法";
  if (e.sessionType !== undefined && !SESSION_TYPES.has(e.sessionType)) return "sessionType 非法";
  for (const [k, v] of Object.entries({ durationMs: e.durationMs, filesTouched: e.filesTouched })) {
    if (v !== undefined && intOrNull(v) === null) return `${k} 非法`;
  }
  const u = e.usage;
  if (u !== undefined) {
    if (typeof u !== "object" || u === null) return "usage 非法";
    for (const [k, v] of Object.entries(u)) {
      if (k === "currency" || k === "model" || k === "provider") continue;
      if (v !== undefined && numOrNull(v) === null) return `usage.${k} 非法`;
    }
  }
  return null;
}

const COLS = [
  "event_id",
  "ts",
  "uid",
  "dept_id",
  "dept_path",
  "session_id",
  "session_type",
  "action",
  "tool_name",
  "target",
  "outcome",
  "approval_decision",
  "policy_mode",
  "duration_ms",
  "error_code",
  "summary",
  "files_touched",
  "model",
  "provider",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost",
  "cost_reported",
  "cost_source",
  "pricing_snapshot",
  "currency",
] as const;

/**
 * 取模型价目（四段价）用于服务端核算。
 * 一次查询覆盖本批所有模型（含已停用模型：历史事件仍按当时的配置核算）。
 */
async function loadPricing(db: IdentityDb, models: string[]): Promise<Map<string, PricingRates>> {
  const map = new Map<string, PricingRates>();
  if (models.length === 0) return map;
  const { rows } = await db.pool.query<{ model: string; pricing: unknown }>(
    `SELECT model, pricing FROM ai_models WHERE model = ANY($1::text[]) ORDER BY id`,
    [models],
  );
  for (const r of rows) {
    const rates = effectiveRates(r.pricing);
    if (rates && !map.has(r.model)) map.set(r.model, rates);
  }
  return map;
}

/**
 * 批量写入（幂等）。
 * 归属 uid/deptId/deptPath **由服务端按令牌写入**；请求体里的同名字段一律忽略。
 * 逐条校验：非法条目进 rejected，其余照常入库（不让一条脏数据拖垮整批）。
 */
export async function insertAuditBatch(
  db: IdentityDb,
  actor: AuditActor,
  events: AuditEventInput[],
): Promise<AuditBatchResponse> {
  const rejected: AuditBatchResponse["rejected"] = [];
  const valid: AuditEventInput[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const e of events) {
    const reason = validateEvent(e, now);
    if (reason) {
      rejected.push({ eventId: typeof e?.eventId === "string" ? e.eventId : "(missing)", reason });
      continue;
    }
    if (seen.has(e.eventId)) {
      rejected.push({ eventId: e.eventId, reason: "同一批次内 eventId 重复" });
      continue;
    }
    seen.add(e.eventId);
    valid.push(e);
  }
  if (valid.length === 0) return { accepted: 0, duplicates: 0, rejected };

  // 服务端核算：按模型价目（四段价）算出权威 cost；端侧上报值仅存为对照
  const models = [...new Set(valid.map((e) => e.usage?.model).filter((m): m is string => typeof m === "string" && m.length > 0))];
  const pricing = await loadPricing(db, models);

  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const e of valid) {
    const u: AuditUsage = e.usage ?? {};
    const reported = numOrNull(u.cost);
    const rates = u.model ? pricing.get(u.model) : undefined;
    const billable = rates !== undefined && hasBillableTokens(u);
    const authoritative = billable
      ? computeCost(u, rates)
      : reported; // 无量价配置时退回端侧上报值（并标记来源，便于事后甄别）
    const costSource = billable ? "server" : reported !== null ? "client" : null;
    const row: unknown[] = [
      e.eventId,
      new Date(Date.parse(e.ts)),
      actor.uid,
      actor.deptId,
      actor.deptPath,
      e.sessionId ?? null,
      e.sessionType ?? null,
      e.action,
      e.toolName ?? null,
      e.target ?? null,
      e.outcome ?? null,
      e.approvalDecision ?? null,
      e.policyMode ?? null,
      intOrNull(e.durationMs),
      e.errorCode ?? null,
      e.summary ?? null,
      intOrNull(e.filesTouched),
      u.model ?? null,
      u.provider ?? null,
      intOrNull(u.inputTokens),
      intOrNull(u.outputTokens),
      intOrNull(u.cacheReadTokens),
      intOrNull(u.cacheWriteTokens),
      intOrNull(u.totalTokens),
      authoritative,
      reported,
      costSource,
      billable ? JSON.stringify(rates) : null,
      u.currency ?? (authoritative !== null ? "CNY" : null),
    ];
    const start = values.length;
    values.push(...row);
    tuples.push(`(${row.map((_, i) => `$${start + i + 1}`).join(",")})`);
  }

  const { rows } = await db.pool.query<{ event_id: string }>(
    `INSERT INTO audit_event (${COLS.join(",")}) VALUES ${tuples.join(",")}
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    values,
  );
  const accepted = rows.length;
  return { accepted, duplicates: valid.length - accepted, rejected };
}

/** 服务端单批上限（与 shared/src/audit.ts 的 MAX_AUDIT_BATCH 保持一致）。 */
export { MAX_AUDIT_BATCH };

export interface AuditQueryFilters {
  from?: Date;
  to?: Date;
  uid?: string;
  deptId?: number;
  action?: string;
  toolName?: string;
  sessionId?: string;
  outcome?: string;
  limit: number;
  offset: number;
}

/** 组装范围 + 过滤条件的 WHERE（全参数化）。 */
function buildWhere(scope: AuditScope, f: AuditQueryFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  if (scope.role === "user") conds.push(`uid = ${p(scope.uid)}`);
  else if (scope.role === "dept_head") conds.push(`dept_id = ANY(${p(scope.deptIds)}::int[])`);

  if (f.from) conds.push(`ts >= ${p(f.from)}`);
  if (f.to) conds.push(`ts <= ${p(f.to)}`);
  if (f.uid) conds.push(`uid = ${p(f.uid)}`);
  if (f.deptId !== undefined) conds.push(`dept_id = ${p(f.deptId)}`);
  if (f.action) conds.push(`action = ${p(f.action)}`);
  if (f.toolName) conds.push(`tool_name = ${p(f.toolName)}`);
  if (f.sessionId) conds.push(`session_id = ${p(f.sessionId)}`);
  if (f.outcome) conds.push(`outcome = ${p(f.outcome)}`);

  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

function toRecord(r: Record<string, unknown>): AuditEventRecord {
  const num = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v));
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const usage: AuditUsage | undefined =
    r.model || r.provider || r.input_tokens !== null || r.output_tokens !== null || r.cost !== null
      ? {
          model: str(r.model),
          provider: str(r.provider),
          inputTokens: num(r.input_tokens),
          outputTokens: num(r.output_tokens),
          cacheReadTokens: num(r.cache_read_tokens),
          cacheWriteTokens: num(r.cache_write_tokens),
          totalTokens: num(r.total_tokens),
          cost: num(r.cost),
          currency: str(r.currency),
        }
      : undefined;
  return {
    id: Number(r.id),
    eventId: String(r.event_id),
    ts: new Date(r.ts as string).toISOString(),
    sessionId: str(r.session_id),
    sessionType: str(r.session_type) as AuditEventRecord["sessionType"],
    action: String(r.action) as AuditEventRecord["action"],
    toolName: str(r.tool_name),
    outcome: str(r.outcome) as AuditEventRecord["outcome"],
    approvalDecision: str(r.approval_decision) as AuditEventRecord["approvalDecision"],
    policyMode: str(r.policy_mode) as AuditEventRecord["policyMode"],
    durationMs: num(r.duration_ms),
    errorCode: str(r.error_code),
    summary: str(r.summary),
    filesTouched: num(r.files_touched),
    usage,
    target: str(r.target) ?? undefined,
    cost: num(r.cost),
    costReported: num(r.cost_reported),
    costSource: (r.cost_source === "server" || r.cost_source === "client" ? r.cost_source : null) as
      | "server"
      | "client"
      | null,
    uid: String(r.uid),
    deptId: r.dept_id === null ? null : Number(r.dept_id),
    deptPath: str(r.dept_path) ?? null,
    receivedAt: new Date(r.received_at as string).toISOString(),
  };
}

/** 查询（按 scope 收敛；服务端分页）。 */
export async function queryAudit(  db: IdentityDb,
  scope: AuditScope,
  f: AuditQueryFilters,
): Promise<{ events: AuditEventRecord[]; total: number }> {
  const { where, params } = buildWhere(scope, f);
  const { rows: countRows } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_event ${where}`,
    params,
  );
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT * FROM audit_event ${where} ORDER BY ts DESC, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, f.limit, f.offset],
  );
  return { events: rows.map(toRecord), total: countRows[0]?.n ?? 0 };
}

/** 报表统计（「审计与报表」页）：对**过滤后的集合**按动作/结果/用户聚合。 */
export async function auditStats(
  db: IdentityDb,
  scope: AuditScope,
  f: AuditQueryFilters,
): Promise<{
  byAction: Array<{ key: string; count: number }>;
  byOutcome: Array<{ key: string; count: number }>;
  byUid: Array<{ key: string; count: number }>;
}> {
  const { where, params } = buildWhere(scope, f);
  const group = async (expr: string): Promise<Array<{ key: string; count: number }>> => {
    const { rows } = await db.pool.query<{ key: string | null; n: number }>(
      `SELECT ${expr} AS key, count(*)::int AS n FROM audit_event ${where} GROUP BY 1 ORDER BY n DESC LIMIT 50`,
      params,
    );
    return rows.map((r) => ({ key: r.key ?? "(未记录)", count: r.n }));
  };
  const [byAction, byOutcome, byUid] = await Promise.all([
    group("action"),
    group("coalesce(outcome, '(未记录)')"),
    group("uid"),
  ]);
  return { byAction, byOutcome, byUid };
}

/* ---------------- 管理操作审计（服务端自记） ---------------- */

/**
 * 由令牌解析写入归属：uid 取令牌；部门取库中最新值（快照更准），缺省回落令牌。
 * 供「端侧上报」与「服务端自记管理操作」共用。
 */
export async function resolveActorForClaims(
  db: IdentityDb,
  claims: { sub: string; deptId?: number | null },
): Promise<AuditActor> {
  const { findUserByUid } = await import("../identity/users.js");
  const me = await findUserByUid(db, claims.sub);
  const deptId = me?.departmentId ?? claims.deptId ?? null;
  let deptPath: string | null = null;
  if (deptId !== null) {
    const { loadAllDepts } = await import("../identity/depts.js");
    const depts = await loadAllDepts(db);
    deptPath = depts.find((d) => d.id === deptId)?.path ?? null;
  }
  return { uid: claims.sub, deptId, deptPath };
}

export interface AdminActionEntry {
  /** 操作码，如 secrets.list / secrets.create / secrets.update / secrets.delete / secrets.use */
  op: string;
  /** 对象标识，如 secrets:3 */
  target?: string;
  /** 短摘要（≤200 字，**不得包含密钥值**） */
  summary?: string;
  outcome?: "ok" | "error" | "denied";
  errorCode?: string;
  /**
   * 结构化附件：配置类操作的**改前/改后快照**（2026-09-19）。
   *
   * 用途：删了什么、改了什么字段，事后能查、能对照，必要时能人工恢复。
   * 约定：
   *   · **删除** → `{ deleted: {…被删记录的完整字段} }`（删了就只剩这一份，必须存全）；
   *   · **修改** → `{ changed: [字段名…], before: {…}, after: {…} }`，只存**变动的那几个字段**，
   *     不把整个对象反复写进审计（审计表只增不改，写得越大越难维护）；
   *   · **密钥/令牌值一律不得入内**：供应商只记 `bindSecretId` 引用，不记密钥内容。
   */
  details?: unknown;
}

/**
 * 记录一次管理台敏感操作（服务端自记，不依赖端侧上报）。
 *
 * 用途：密钥这类高敏资源的「谁在何时看过/改过」必须留痕，而端侧不参与管理台操作。
 * 复用 audit_event 表 → 审计页/查询/CSV 一套口径即覆盖，无需第二张表。
 */
export async function recordAdminAction(db: IdentityDb, actor: AuditActor, entry: AdminActionEntry): Promise<void> {
  try {
    const now = new Date();
    await db.pool.query(
      `INSERT INTO audit_event (event_id, ts, uid, dept_id, dept_path, action, tool_name, target, outcome, summary, error_code, details)
       VALUES ($1, $2, $3, $4, $5, 'admin_action', $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        `admin-${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`,
        now,
        actor.uid,
        actor.deptId,
        actor.deptPath,
        entry.op,
        entry.target ?? null,
        entry.outcome ?? "ok",
        entry.summary ?? null,
        entry.errorCode ?? null,
        entry.details === undefined ? null : JSON.stringify(entry.details),
      ],
    );
  } catch (err) {
    // 审计写入失败不能反过来阻断管理操作（只告警）
    console.warn(`[audit] 管理操作审计写入失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ---------------- 用量聚合 ---------------- */

const GROUP_EXPR: Record<UsageGroupBy, string> = {
  dept: "coalesce(dept_path, '(未分配)')",
  model: "coalesce(model, '(未知模型)')",
  user: "uid",
  day: "to_char(ts, 'YYYY-MM-DD')",
};

/** 用量聚合（部门/模型/用户/日）。只统计带用量的事件（通常是 model_call）。 */
export async function summarizeUsage(
  db: IdentityDb,
  scope: AuditScope,
  f: AuditQueryFilters,
  groupBy: UsageGroupBy,
): Promise<UsageSummaryResponse> {
  const { where, params } = buildWhere(scope, f);
  const usageOnly = `${where ? `${where} AND` : "WHERE"} (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cost IS NOT NULL)`;
  const agg = `
    count(*)::int AS calls,
    coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
    coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
    coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read_tokens,
    coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens,
    -- 端侧未上报 totalTokens 时，按四段之和兜底（避免报表为 0 而分项有值）
    coalesce(sum(coalesce(
      total_tokens,
      coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
    )), 0)::bigint AS total_tokens,
    coalesce(sum(cost), 0)::numeric AS cost`;

  const { rows } = await db.pool.query<Record<string, unknown>>(
    `SELECT ${GROUP_EXPR[groupBy]} AS key, ${agg} FROM audit_event ${usageOnly}
     GROUP BY 1 ORDER BY total_tokens DESC, calls DESC LIMIT 500`,
    params,
  );
  const { rows: totalRows } = await db.pool.query<Record<string, unknown>>(
    `SELECT ${agg} FROM audit_event ${usageOnly}`,
    params,
  );

  const toRow = (key: string, r: Record<string, unknown>): UsageSummaryRow => ({
    key,
    calls: Number(r.calls ?? 0),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    cacheReadTokens: Number(r.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(r.cache_write_tokens ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
    cost: Number(r.cost ?? 0),
  });

  return {
    groupBy,
    from: (f.from ?? new Date(0)).toISOString(),
    to: (f.to ?? new Date()).toISOString(),
    rows: rows.map((r) => toRow(String(r.key), r)),
    totals: toRow("TOTAL", totalRows[0] ?? {}),
  };
}

/* ---------------- 额度告警（M9） ---------------- */

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

export interface QuotaCheckResult {
  checked: boolean;
  period: string;
  percent: number | null;
  monthTokens: number;
  limitTokens: number | null;
  /** 本次新触发的告警（已触发过的不会重复） */
  newAlerts: QuotaAlert[];
}

/** 当前周期（UTC，YYYY-MM） */
export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** 组织级月度用量（与用量报表同一口径：端侧未报 totalTokens 时按四段之和兜底） */
async function monthTokens(db: IdentityDb, period: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    `SELECT coalesce(sum(coalesce(
       total_tokens,
       coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)
     )), 0)::bigint AS n
     FROM audit_event
     WHERE to_char(ts, 'YYYY-MM') = $1`,
    [period],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * 评估月度额度是否触发告警（幂等）。
 *
 * 触发时机：每次批量上报之后 + 策略（额度/阈值）变更之后。
 * 幂等：`UNIQUE (period, threshold)` —— 同一周期同一阈值只产生一条告警，不会刷屏。
 * **只告警不阻断**：本函数只记录与通知，不影响上报/调用是否成功。
 * webhook 为 best-effort：失败只记 notify_error，不抛错、不影响主流程。
 */
export async function evaluateQuotaAlerts(
  db: IdentityDb,
  opts: { webhookUrl?: string; period?: string } = {},
): Promise<QuotaCheckResult> {
  const period = opts.period ?? currentPeriod();
  const policy = await getPolicy(db);
  const limit = policy.quota.monthlyTokenLimit;
  const thresholds = [...new Set(policy.quota.alertThresholds)].filter((t) => t > 0 && t <= 100).sort((a, b) => a - b);
  if (limit === null || limit <= 0 || thresholds.length === 0) {
    return { checked: false, period, percent: null, monthTokens: 0, limitTokens: limit ?? null, newAlerts: [] };
  }

  const tokens = await monthTokens(db, period);
  // clamp：额度设得极低时 percent 可能远超 100；收敛到列宽能装的范围
  const percent = Math.min(99999999.99, Math.round((tokens / limit) * 10000) / 100);
  const newAlerts: QuotaAlert[] = [];

  for (const threshold of thresholds) {
    if (percent < threshold) continue;
    const level = threshold >= 100 ? "critical" : "warn";
    const { rows } = await db.pool.query<{ id: number; created_at: Date }>(
      `INSERT INTO quota_alert (period, threshold, level, month_tokens, limit_tokens, percent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (period, threshold) DO NOTHING
       RETURNING id, created_at`,
      [period, threshold, level, tokens, limit, percent],
    );
    const row = rows[0];
    if (!row) continue; // 该阈值本周期已告警过
    const alert: QuotaAlert = {
      id: row.id,
      period,
      threshold,
      level,
      monthTokens: tokens,
      limitTokens: limit,
      percent,
      createdAt: row.created_at.toISOString(),
      notified: false,
      notifyError: null,
    };
    if (opts.webhookUrl) {
      const result = await notifyWebhook(opts.webhookUrl, alert);
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

  return { checked: true, period, percent, monthTokens: tokens, limitTokens: limit, newAlerts };
}

/** 告警外发（best-effort）：POST JSON，5s 超时；失败只回报，不抛。 */
async function notifyWebhook(url: string, alert: QuotaAlert): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "quota_alert",
        period: alert.period,
        threshold: alert.threshold,
        level: alert.level,
        monthTokens: alert.monthTokens,
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

/** 列出某周期的告警（含当前用量与额度，便于页面直接渲染）。 */
export async function listQuotaAlerts(
  db: IdentityDb,
  period = currentPeriod(),
): Promise<{ period: string; monthTokens: number; limitTokens: number | null; percent: number | null; alerts: QuotaAlert[] }> {
  const policy = await getPolicy(db);
  const limit = policy.quota.monthlyTokenLimit;
  const tokens = await monthTokens(db, period);
  const { rows } = await db.pool.query<{
    id: number;
    period: string;
    threshold: number;
    level: string;
    month_tokens: string;
    limit_tokens: string;
    percent: string;
    created_at: Date;
    notified: boolean;
    notify_error: string | null;
  }>(`SELECT * FROM quota_alert WHERE period = $1 ORDER BY threshold`, [period]);
  return {
    period,
    monthTokens: tokens,
    limitTokens: limit,
    percent: limit && limit > 0 ? Math.round((tokens / limit) * 10000) / 100 : null,
    alerts: rows.map((r) => ({
      id: r.id,
      period: r.period,
      threshold: r.threshold,
      level: r.level === "critical" ? "critical" : "warn",
      monthTokens: Number(r.month_tokens),
      limitTokens: Number(r.limit_tokens),
      percent: Number(r.percent),
      createdAt: r.created_at.toISOString(),
      notified: r.notified,
      notifyError: r.notify_error,
    })),
  };
}

/* ---------------- 策略下发 ---------------- */

/** 缺省策略（未配置时下发它，保证端侧行为与改造前一致）。 */
export const DEFAULT_POLICY: DesktopPolicy = {
  defaultApprovalMode: "balanced",
  commandBlacklist: [],
  egressAllowlist: [],
  quota: { monthlyTokenLimit: null, alertThresholds: [80, 100] },
};

export async function getPolicy(db: IdentityDb): Promise<DesktopPolicy> {
  const { rows } = await db.pool.query<{ policy: Partial<DesktopPolicy>; updated_at: Date; updated_by: string | null }>(
    `SELECT policy, updated_at, updated_by FROM desktop_policy WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_POLICY };
  const p = row.policy ?? {};
  return {
    ...DEFAULT_POLICY,
    ...p,
    quota: { ...DEFAULT_POLICY.quota, ...(p.quota ?? {}) },
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by ?? undefined,
  };
}

/** 写入策略（仅平台管理员，路由层已校验角色）。 */
export async function putPolicy(db: IdentityDb, policy: DesktopPolicy, updatedBy: string): Promise<DesktopPolicy> {
  const toStore: DesktopPolicy = {
    defaultApprovalMode: policy.defaultApprovalMode,
    commandBlacklist: policy.commandBlacklist,
    egressAllowlist: policy.egressAllowlist,
    quota: policy.quota,
  };
  await db.pool.query(
    `INSERT INTO desktop_policy (id, policy, updated_at, updated_by) VALUES (1, $1, now(), $2)
     ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(toStore), updatedBy],
  );
  return getPolicy(db);
}
