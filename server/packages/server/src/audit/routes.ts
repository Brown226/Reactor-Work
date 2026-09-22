/**
 * G0 数据面 HTTP 路由（审计上报 / 审计查询 / 用量聚合 / 策略下发）。
 *
 * **挂载方式**：由 identity/routes.ts 挂进 `authed` 组 —— 复用其 Bearer 中间件，
 * 因此这里不做自己的 `use("*")`（那会拦掉后续挂载的路由，见 admin-static.ts 的同类坑）。
 * 本模块只负责：角色数据范围收敛 + 参数校验 + 组装响应。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { normalizeAuditPolicyMode } from "@reactor/shared";
import type { AuditEventInput, DesktopPolicy, UsageGroupBy } from "@reactor/shared";
import type { TokenClaims } from "../identity/auth.js";
import { loadAllDepts, subtreeIds } from "../identity/depts.js";
import type { IdentityDb } from "../identity/db.js";
import { findUserByUid } from "../identity/users.js";
import { MAX_AUDIT_BATCH } from "./limits.js";
import {
  DEFAULT_POLICY,
  auditStats,
  evaluateQuotaAlerts,
  getPolicy,
  insertAuditBatch,
  putPolicy,
  queryAudit,
  summarizeUsage,
  type AuditActor,
  type AuditQueryFilters,
  type AuditScope,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
/** 默认查询窗口：最近 7 天 */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 解析时间参数（非法 → undefined，由调用方决定是否报错）。 */
function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : undefined;
}

/** 由令牌解析「写入归属」：uid 一律取令牌；部门取库中最新值（快照更准），缺省回落令牌。 */
async function resolveActor(db: IdentityDb, claims: TokenClaims): Promise<AuditActor> {
  const me = await findUserByUid(db, claims.sub);
  const deptId = me?.departmentId ?? claims.deptId ?? null;
  let deptPath: string | null = null;
  if (deptId !== null) {
    const depts = await loadAllDepts(db);
    deptPath = depts.find((d) => d.id === deptId)?.path ?? null;
  }
  return { uid: claims.sub, deptId, deptPath };
}

/** 由令牌解析「查询可见范围」。 */
async function resolveScope(db: IdentityDb, claims: TokenClaims): Promise<AuditScope> {
  if (claims.role === "platform_admin") return { role: "platform_admin", uid: claims.sub, deptIds: [] };
  if (claims.role === "dept_head") {
    const depts = await loadAllDepts(db);
    const deptId = claims.deptId;
    return {
      role: "dept_head",
      uid: claims.sub,
      deptIds: deptId === null || deptId === undefined ? [] : [...subtreeIds(depts, deptId)],
    };
  }
  return { role: "user", uid: claims.sub, deptIds: [] };
}

/** 解析查询过滤参数；from/to 缺省为最近 7 天。 */
function parseFilters(c: Ctx): AuditQueryFilters | { error: string } {
  const q = c.req.query();
  const limitRaw = Number(q.limit ?? DEFAULT_LIMIT);
  const offsetRaw = Number(q.offset ?? 0);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) return { error: `limit 需为 1-${MAX_LIMIT}` };
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) return { error: "offset 非法" };
  const to = parseDate(q.to) ?? new Date();
  const from = parseDate(q.from) ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from.getTime() > to.getTime()) return { error: "from 不能晚于 to" };
  const deptIdRaw = q.deptId === undefined ? undefined : Number(q.deptId);
  if (deptIdRaw !== undefined && !Number.isInteger(deptIdRaw)) return { error: "deptId 非法" };
  return {
    from,
    to,
    ...(q.uid ? { uid: q.uid } : {}),
    ...(deptIdRaw !== undefined ? { deptId: deptIdRaw } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.toolName ? { toolName: q.toolName } : {}),
    ...(q.sessionId ? { sessionId: q.sessionId } : {}),
    ...(q.outcome ? { outcome: q.outcome } : {}),
    limit: limitRaw,
    offset: offsetRaw,
  };
}

/** CSV 导出：加 UTF-8 BOM，Excel 直接打开不乱码；字段一律转义。 */
function toCsv(events: Awaited<ReturnType<typeof queryAudit>>["events"]): string {
  const head = [
    "id",
    "ts",
    "uid",
    "deptPath",
    "action",
    "toolName",
    "outcome",
    "approvalDecision",
    "policyMode",
    "sessionId",
    "sessionType",
    "model",
    "provider",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "cost",
    "durationMs",
    "filesTouched",
    "errorCode",
    "summary",
  ];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(",")];
  for (const e of events) {
    lines.push(
      [
        e.id,
        e.ts,
        e.uid,
        e.deptPath,
        e.action,
        e.toolName,
        e.outcome,
        e.approvalDecision,
        e.policyMode,
        e.sessionId,
        e.sessionType,
        e.usage?.model,
        e.usage?.provider,
        e.usage?.inputTokens,
        e.usage?.outputTokens,
        e.usage?.cacheReadTokens,
        e.usage?.cacheWriteTokens,
        e.usage?.totalTokens,
        e.usage?.cost,
        e.durationMs,
        e.filesTouched,
        e.errorCode,
        e.summary,
      ]
        .map(esc)
        .join(","),
    );
  }
  return `\uFEFF${lines.join("\n")}`;
}

export function createAuditRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** 批量上报（任意已登录用户；归属由令牌决定，请求体无法指定他人） */
  app.post("/desktop/audit/batch", async (c) => {
    const claims = c.get("claims");
    const body = (await c.req.json().catch(() => null)) as
      | { events?: unknown; batchId?: unknown; uid?: unknown; deptId?: unknown }
      | null;
    if (!body || !Array.isArray(body.events)) return err(c, 400, "events 必填且为数组");
    if (body.events.length === 0) return c.json({ accepted: 0, duplicates: 0, rejected: [] });
    if (body.events.length > MAX_AUDIT_BATCH) return err(c, 400, `单批最多 ${MAX_AUDIT_BATCH} 条`);
    // 伪造防护：请求体不允许自带归属字段
    if (body.uid !== undefined || body.deptId !== undefined) {
      return err(c, 400, "uid/deptId 由服务端按令牌写入，请勿在请求体中指定");
    }

    const actor = await resolveActor(db, claims);
    const result = await insertAuditBatch(db, actor, body.events as AuditEventInput[]);
    // 额度评估（只告警不阻断）：每次上报后检查是否跨过阈值；失败不影响上报结果，但**要可见**
    const quota = await evaluateQuotaAlerts(db, { webhookUrl: process.env.REACTOR_QUOTA_WEBHOOK_URL }).catch((e) => {
      console.warn(`[audit] 额度评估失败（不影响上报）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    return c.json(quota && quota.newAlerts.length > 0 ? { ...result, quotaAlerts: quota.newAlerts } : result);
  });

  /** 审计查询（按角色收敛；format=csv 导出） */
  app.get("/desktop/audit", async (c) => {
    const claims = c.get("claims");
    const f = parseFilters(c);
    if ("error" in f) return err(c, 400, f.error);
    const scope = await resolveScope(db, claims);
    const { events, total } = await queryAudit(db, scope, f);
    const format = (c.req.query("format") ?? "").toLowerCase();
    // 报表统计（仅 JSON 返回；CSV 只导出明细）
    const wantStats = format !== "csv" && ["1", "true", "yes"].includes((c.req.query("stats") ?? "").toLowerCase());
    const stats = wantStats ? await auditStats(db, scope, f) : undefined;
    if (format === "csv") {
      c.header("content-type", "text/csv; charset=utf-8");
      c.header("content-disposition", `attachment; filename="audit-${Date.now()}.csv"`);
      return c.body(toCsv(events));
    }
    return c.json({ events, total, limit: f.limit, offset: f.offset, scope: scope.role, ...(stats ? { stats } : {}) });
  });

  /** 用量聚合（部门 / 模型 / 用户 / 日） */
  app.get("/desktop/usage/summary", async (c) => {
    const claims = c.get("claims");
    const groupRaw = (c.req.query("groupBy") ?? "dept") as UsageGroupBy;
    if (!["dept", "model", "user", "day"].includes(groupRaw)) return err(c, 400, "groupBy 需为 dept|model|user|day");
    const f = parseFilters(c);
    if ("error" in f) return err(c, 400, f.error);
    const scope = await resolveScope(db, claims);
    const summary = await summarizeUsage(db, scope, f, groupRaw);
    return c.json({ ...summary, scope: scope.role });
  });

  /** 策略下发（读取）：任意已登录用户拿「当前生效策略」 */
  app.get("/desktop/policy", async (c) => c.json({ policy: await getPolicy(db) }));

  /** 策略下发（写入）：仅平台管理员 */
  app.put("/desktop/policy", async (c) => {
    const claims = c.get("claims");
    if (claims.role !== "platform_admin") return err(c, 403, "仅平台管理员可修改策略");
    const body = (await c.req.json().catch(() => null)) as Partial<DesktopPolicy> | null;
    if (!body) return err(c, 400, "请求体非法");
    // 只写新词表；旧词（readonly/balanced/trust/strict）在写入侧也接受，存的是映射后的新值。
    const mode =
      body.defaultApprovalMode === undefined
        ? DEFAULT_POLICY.defaultApprovalMode
        : normalizeAuditPolicyMode(body.defaultApprovalMode);
    if (!mode) return err(c, 400, "defaultApprovalMode 非法");
    const list = (v: unknown, max: number): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, max)
        : [];
    const quotaRaw = (body.quota ?? {}) as { monthlyTokenLimit?: unknown; alertThresholds?: unknown };
    const limit = quotaRaw.monthlyTokenLimit;
    const thresholds = Array.isArray(quotaRaw.alertThresholds)
      ? quotaRaw.alertThresholds.filter((n): n is number => typeof n === "number" && n > 0 && n <= 100).slice(0, 10)
      : DEFAULT_POLICY.quota.alertThresholds;
    const policy: DesktopPolicy = {
      defaultApprovalMode: mode,
      commandBlacklist: list(body.commandBlacklist, 200),
      egressAllowlist: list(body.egressAllowlist, 200),
      quota: {
        monthlyTokenLimit: typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null,
        alertThresholds: thresholds,
      },
    };
    const saved = await putPolicy(db, policy, claims.sub);
    // 额度/阈值变更后立即复评：把额度调低会**当场**触发告警，不必等到下次上报
    const quota = await evaluateQuotaAlerts(db, { webhookUrl: process.env.REACTOR_QUOTA_WEBHOOK_URL }).catch((e) => {
      console.warn(`[audit] 额度评估失败（不影响策略保存）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    return c.json({ policy: saved, ...(quota && quota.newAlerts.length > 0 ? { quotaAlerts: quota.newAlerts } : {}) });
  });

  return app;
}
