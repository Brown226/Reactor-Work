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
  getPolicy,
  insertAuditBatch,
  normalizeProductDocsUrl,
  putPolicy,
  queryAudit,
  type AuditActor,
  type AuditQueryFilters,
  type AuditScope,
} from "./repo.js";
// 额度评估统一走 metering 域（P2）：用量取账本，支持 org/dept/user 多维度规则
import { evaluateQuotaFor } from "../metering/quota-eval.js";
// 报表口径切账本（P4）：/desktop/usage/summary 改用账本聚合
import { recordUsage, summarizeLedgerUsage, type UsageLedgerFilter } from "../metering/repo.js";
// 编程模式受众（按 viewer 计算 allowedInterfaceModes，见 interface-mode/repo.ts）
import { allowedInterfaceModesFor, getInterfaceModePolicy } from "../interface-mode/repo.js";

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

/** 审计 outcome → 账本 outcome（账本只认 ok/error/aborted 三态）。 */
function ledgerOutcome(outcome: AuditEventInput["outcome"]): "ok" | "error" | "aborted" {
  if (outcome === "error" || outcome === "denied") return "error";
  if (outcome === "cancelled") return "aborted";
  return "ok";
}

/**
 * 直连调用补记账本（2026-10-22）。
 *
 * **为什么需要**：桌面端直连上游时请求不过网关，网关侧 metering 不会写 `usage_ledger`；
 * 而 `/desktop/usage/summary` 与部门额度评估**都以账本为唯一数据源**（见下方端点注释）。
 * 不补的话，直连流量的用量报表会偏低、部门额度算不到——这是「按模型分流」必须配套的一环。
 *
 * **口径约束**（三条都不能破）：
 *  · 只认带 `usage.directBaseUrl` 的 `model_call`：经网关转发的调用不带该字段，网关已记过账，
 *    再补就是重复计费；
 *  · 被 `validateEvent` 拒掉的事件不记账：不能凭非法上报产生费用；
 *  · `request_id` 用端侧 `eventId`，离线重传命中 `ON CONFLICT DO NOTHING`，天然幂等。
 *
 * **已知取舍**：账本权威性由「网关事实」降为「网关 + 端侧上报」。端侧漏报或崩溃时，
 * 那次直连调用的用量会缺失；对应的 `model_call` 审计事件仍在，可用于事后对账。
 */
async function recordDirectCallsToLedger(
  db: IdentityDb,
  actor: AuditActor,
  events: AuditEventInput[],
  rejected: ReadonlyArray<{ eventId: string }>,
): Promise<void> {
  const rejectedIds = new Set(rejected.map((r) => r.eventId));
  for (const e of events) {
    if (e.action !== "model_call") continue;
    const usage = e.usage;
    if (!usage?.directBaseUrl) continue;
    if (rejectedIds.has(e.eventId)) continue;
    // 全 0 的调用不计账（与端侧 hasBillableUsage、网关 metering 同一口径）
    const billable =
      (usage.totalTokens ?? 0) > 0 ||
      (usage.inputTokens ?? 0) > 0 ||
      (usage.outputTokens ?? 0) > 0;
    if (!billable) continue;
    const hasCost = typeof usage.cost === "number" && Number.isFinite(usage.cost);
    await recordUsage(db, {
      requestId: e.eventId,
      ts: new Date(e.ts),
      subjectKind: "user",
      uid: actor.uid,
      deptId: actor.deptId,
      deptPath: actor.deptPath,
      model: usage.model ?? null,
      // 存直连地址而不是供应商编码：报表里能一眼看出「这条没走网关」
      provider: usage.directBaseUrl,
      apiShape: "openai",
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cacheReadTokens: usage.cacheReadTokens ?? null,
      cacheWriteTokens: usage.cacheWriteTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      cost: hasCost ? usage.cost! : null,
      costSource: hasCost ? "client" : "none",
      currency: usage.currency ?? null,
      outcome: ledgerOutcome(e.outcome),
      httpStatus: null,
    });
  }
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
    /*
     * 直连补记账本：必须在审计入库之后做 —— 先拿到 rejected 名单，
     * 才能保证「被拒的非法事件不会产生费用」。失败不影响上报本身（审计是主路径）。
     */
    await recordDirectCallsToLedger(db, actor, body.events as AuditEventInput[], result.rejected).catch((e) => {
      console.warn(`[audit] 直连补记账本失败（不影响上报）：${e instanceof Error ? e.message : String(e)}`);
    });
    /**
     * 额度评估（P2 起统一走 metering 域的新引擎）：
     *  · 用量取**账本**（网关权威），不再用本批上报的事件 —— 端侧漏报不会让额度失真；
     *  · 合成开关默认开：老部署的 `desktop_policy.quota` 在迁移前仍然有效。
     * 这样"额度是否超线"全仓只有一个实现（metering/quota-eval.ts）。
     */
    const quota = await evaluateQuotaFor(db, {
      uid: actor.uid,
      deptId: actor.deptId,
      webhookUrl: process.env.REACTOR_QUOTA_WEBHOOK_URL,
    }).catch((e) => {
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

  /**
   * 用量聚合（部门 / 模型 / 用户 / 日）。
   *
   * **数据源 = 计量账本**（P4 口径切换）：账本是网关侧事实，端侧漏报/崩溃不会让报表缺数。
   * 审计事件里的 `model_call` 仍在「审计」页按事件口径可见（两处用途不同、口径也标注清楚）。
   * 过滤沿用同一套角色收敛（`resolveScope`）：普通用户只看自己、部门负责人看子树。
   */
  app.get("/desktop/usage/summary", async (c) => {
    const claims = c.get("claims");
    const groupRaw = (c.req.query("groupBy") ?? "dept") as UsageGroupBy;
    if (!["dept", "model", "user", "day"].includes(groupRaw)) return err(c, 400, "groupBy 需为 dept|model|user|day");
    const f = parseFilters(c);
    if ("error" in f) return err(c, 400, f.error);
    const scope = await resolveScope(db, claims);
    // scope → 账本过滤（与 buildWhere 的语义一一对应：user 限本人；dept_head 限子树）
    const ledgerFilter: UsageLedgerFilter = {
      ...(f.from ? { from: f.from } : {}),
      ...(f.to ? { to: f.to } : {}),
      ...(scope.role === "user" ? { uid: scope.uid } : {}),
      ...(scope.role === "dept_head" ? { deptIds: scope.deptIds } : {}),
      // 报表含 system 调用（KB 向量化等会消耗组织额度，管理视图应能看到）
    };
    const summary = await summarizeLedgerUsage(db, ledgerFilter, groupRaw);
    return c.json({
      groupBy: groupRaw,
      from: (f.from ?? new Date(0)).toISOString(),
      to: (f.to ?? new Date()).toISOString(),
      rows: summary.rows,
      totals: { key: "TOTAL", ...summary.totals },
      scope: scope.role,
      /** 口径标注：调用方（管理台/端侧）据此说明数据来源 */
      source: "ledger",
    });
  });

  /**
   * 策略下发（读取）：任意已登录用户拿「当前生效策略」。
   *
   * 其余字段是全组织单值；`allowedInterfaceModes` 例外 —— 它**按 viewer 计算**
   * （编程模式受众配置见 docs/未完成-编程模式权限-方案-v1.md）：未授权时不含 "coding"，
   * 端侧据此隐藏编程档入口。受众表为空/未配置时按白名单默认关闭处理。
   */
  app.get("/desktop/policy", async (c) => {
    const claims = c.get("claims");
    const policy = await getPolicy(db);
    const modePolicy = await getInterfaceModePolicy(db);
    const allowedInterfaceModes = allowedInterfaceModesFor(modePolicy, {
      uid: claims.sub,
      role: claims.role,
      deptId: claims.deptId ?? null,
    });
    return c.json({ policy: { ...policy, allowedInterfaceModes } });
  });

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
    // 产品文档地址：省略/null = 清空（与其它字段"整体替换"语义一致）；给了但非法
    // （非 http(s) / 超长）直接 400，不让管理员以为配上了却被静默丢弃。
    let productDocsUrl: string | null = null;
    if (body.productDocsUrl !== undefined && body.productDocsUrl !== null) {
      productDocsUrl = normalizeProductDocsUrl(body.productDocsUrl);
      if (!productDocsUrl) return err(c, 400, "productDocsUrl 非法（仅支持 http/https）");
    }
    const policy: DesktopPolicy = {
      defaultApprovalMode: mode,
      commandBlacklist: list(body.commandBlacklist, 200),
      egressAllowlist: list(body.egressAllowlist, 200),
      quota: {
        monthlyTokenLimit: typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null,
        alertThresholds: thresholds,
      },
      productDocsUrl,
    };
    const saved = await putPolicy(db, policy, claims.sub);
    /**
     * 额度/阈值变更后立即复评：把额度调低会**当场**触发告警，不必等到下次调用。
     * 注：`desktop_policy.quota` 是**旧配置位**；已有 org 规则时新引擎以规则为准
     * （此处复评用于让"只改了旧字段、还没迁移"的部署也能立刻看到跨线告警）。
     */
    const quota = await evaluateQuotaFor(db, {
      uid: claims.sub,
      deptId: claims.deptId ?? null,
      webhookUrl: process.env.REACTOR_QUOTA_WEBHOOK_URL,
    }).catch((e) => {
      console.warn(`[audit] 额度评估失败（不影响策略保存）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    return c.json({ policy: saved, ...(quota && quota.newAlerts.length > 0 ? { quotaAlerts: quota.newAlerts } : {}) });
  });

  return app;
}
