/**
 * 额度规则管理面（额度分配 P2c）：CRUD + 批量下发 + 个人额度查询。
 *
 * 挂载：由 identity/server.ts 挂在 authed 组之后（复用 Bearer），故本文件不自带 `use("*")`。
 *
 * ## 鉴权
 *
 *  · `/admin/quota-rules*`：仅 `platform_admin`（与既有 `/admin/*` 一致）；
 *  · `/desktop/quota/me`：任意已登录用户 —— **口径必须一致**：返回该用户适用规则
 *    各自的当期用量与上限，让端侧能正确渲染百分比（修掉 `accountCapabilityProjection.ts`
 *    记录的"非管理员不显示百分比"缺陷）。
 *
 * ## 为什么 read 也返回"未落库的缺省"
 *
 * 老部署里额度还在 `desktop_policy.quota`（组织级单值）。管理台若只读 `quota_rule` 会显示
 * "没有额度"，与用户实际被约束的状态不符。故读接口在无 org 规则时**合成**一条只读的
 * org 缺省项（`synthesized: true`），前端据此提示"来自旧配置，保存即迁移"。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import { getPolicy } from "../audit/repo.js";
import {
  applyQuotaBatch,
  deleteQuotaRule,
  evaluateQuotaFor,
  currentPeriod,
  listQuotaRules,
  listScopedQuotaAlerts,
  planQuotaBatch,
  QuotaBatchError,
  summarizeRulesUsage,
  upsertQuotaRule,
  type QuotaBatchInput,
  type QuotaBatchTarget,
  type QuotaRule,
  type QuotaRuleInput,
  type QuotaScopeType,
} from "./index.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

/** 管理面读出的规则 + 是否为旧配置合成（前端提示用）。 */
interface QuotaRuleItem extends QuotaRule {
  synthesized?: true;
}

/**
 * 解析 token 上限（支持单位后缀）。
 *
 * 为什么支持单位：额度动辄百万级（`5000000` 难读难打），而管理台列表早就在用
 * K/M 格式化展示 —— 输入却只认裸数字，用户要么数零要么先心算，这是真实的可用性缺口。
 *
 * 接受：`5000000` / `5M` / `5m` / `5 M` / `500K` / `1.5M` / `500万`。
 * 拒绝：负数、零、`0M`（换算后为 0）、`abc`、`5MB`（单位必须单独）。
 *
 * ⚠ 管理台 `Usage.tsx` 有一份同口径的解析（两包不共享代码：admin 不依赖 server 源码），
 *   改动时两边同步；冒烟以本函数为准（服务端是权威）。
 */
const TOKEN_UNIT_SCALE: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
  万: 10_000,
};

export function parseTokenLimit(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(K|M|B|万)?$/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const scale = m[2] ? (TOKEN_UNIT_SCALE[m[2].toUpperCase()] ?? 1) : 1;
  const out = Math.floor(value * scale);
  return out > 0 ? out : null;
}

/** 解析写入体（null = 非法，调用方 400）。 */
function parseRuleInput(body: unknown): QuotaRuleInput | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "请求体非法" };
  const b = body as Record<string, unknown>;
  const scopeType = b["scopeType"];
  if (scopeType !== "org" && scopeType !== "dept" && scopeType !== "user") {
    return { error: "scopeType 需为 org|dept|user" };
  }
  const rawScopeId = b["scopeId"];
  let scopeId: string | null = null;
  if (scopeType !== "org") {
    if (typeof rawScopeId !== "string" && typeof rawScopeId !== "number") return { error: "该维度必须提供 scopeId" };
    scopeId = String(rawScopeId).trim();
    if (scopeId.length === 0) return { error: "scopeId 不能为空" };
    // dept 必须是正整数（库层面 scope_id 是 TEXT，需要在这里挡住形状错误）
    if (scopeType === "dept" && !/^\d+$/.test(scopeId)) return { error: "部门 scopeId 需为正整数" };
  }
  const rawTokens = b["limitTokens"];
  const rawCost = b["limitCost"];
  // token 上限支持单位后缀（5M / 500K / 500万）；见 parseTokenLimit 注释
  const limitTokens = parseTokenLimit(rawTokens);
  const limitCost =
    typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null;
  if (limitTokens === null && limitCost === null) {
    return { error: "limitTokens 需为正数（可带单位：5M / 500K / 500万），或提供 limitCost" };
  }
  const rawThresholds = b["alertThresholds"];
  const thresholds = Array.isArray(rawThresholds)
    ? rawThresholds.filter((n): n is number => typeof n === "number" && n > 0 && n <= 100).slice(0, 10)
    : [80, 100];
  const action = b["action"] === "block" ? "block" : "warn";
  const enabled = b["enabled"] !== false;
  return { scopeType, scopeId, limitTokens, limitCost, alertThresholds: thresholds.length > 0 ? thresholds : [80, 100], action, enabled };
}

/**
 * 解析批量写入体（null = 非法，调用方 400）。
 *
 * 与 `parseRuleInput` 的分工：单条管"一条规则的完整形状"，这里管"一批目标 +
 * 一套同值参数"。上限的单位后缀换算复用同一个 `parseTokenLimit`（权威只有一份）。
 */
function parseBatchInput(
  body: unknown,
): { input: QuotaBatchInput; dryRun: boolean } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "请求体非法" };
  const b = body as Record<string, unknown>;
  const rawTargets = b["targets"];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return { error: "targets 需为非空数组" };
  if (rawTargets.length > 50) return { error: "单次最多 50 个目标组（组内可含多个 scopeIds）" };
  const targets: QuotaBatchTarget[] = [];
  for (const raw of rawTargets) {
    if (typeof raw !== "object" || raw === null) return { error: "targets 含非法项" };
    const t = raw as Record<string, unknown>;
    const scopeType = t["scopeType"];
    if (scopeType !== "org" && scopeType !== "dept" && scopeType !== "user") {
      return { error: "scopeType 需为 org|dept|user" };
    }
    let scopeIds: string[] | undefined;
    if (scopeType !== "org") {
      if (!Array.isArray(t["scopeIds"])) return { error: `${scopeType} 目标需提供 scopeIds 数组` };
      scopeIds = t["scopeIds"]
        .filter((s): s is string | number => typeof s === "string" || typeof s === "number")
        .map((s) => String(s));
      if (scopeIds.length === 0) return { error: `${scopeType} 目标的 scopeIds 不能为空` };
      if (scopeIds.length > 500) return { error: "单个目标组的 scopeIds 不能超过 500 个" };
    }
    targets.push({
      scopeType,
      scopeIds,
      // dept 专用开关：展开子树下每个在用用户（"给部门里每个人发额度"）
      ...(scopeType === "dept" && t["expandUsers"] === true ? { expandUsers: true } : {}),
    });
  }
  const limitTokens = parseTokenLimit(b["limitTokens"]);
  const rawCost = b["limitCost"];
  const limitCost = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null;
  if (limitTokens === null && limitCost === null) {
    return { error: "limitTokens 需为正数（可带单位：5M / 500K / 500万），或提供 limitCost" };
  }
  const rawThresholds = b["alertThresholds"];
  const thresholds = Array.isArray(rawThresholds)
    ? rawThresholds.filter((n): n is number => typeof n === "number" && n > 0 && n <= 100).slice(0, 10)
    : [80, 100];
  const action = b["action"] === "block" ? "block" : "warn";
  const enabled = b["enabled"] !== false;
  return {
    dryRun: b["dryRun"] === true,
    input: {
      targets,
      limitTokens,
      limitCost,
      alertThresholds: thresholds.length > 0 ? thresholds : [80, 100],
      action,
      enabled,
    },
  };
}

export function createQuotaRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /* ---------------- 管理面：规则 CRUD ---------------- */

  /** 列出全部规则（含旧配置合成的 org 缺省项）。 */
  app.get("/admin/quota-rules", async (c) => {
    const claims = c.get("claims");
    if (claims.role !== "platform_admin") return err(c, 403, "仅平台管理员可查看额度规则");
    const rules = (await listQuotaRules(db)) as QuotaRuleItem[];
    if (!rules.some((r) => r.scopeType === "org")) {
      // 旧配置合成（只读）：让管理台看到"当前真实生效的 org 额度"来自 desktop_policy
      const policy = await getPolicy(db);
      const quota = policy.quota;
      if (quota.monthlyTokenLimit !== null || quota.alertThresholds.length > 0) {
        rules.unshift({
          id: -1,
          scopeType: "org",
          scopeId: null,
          period: "month",
          limitTokens: quota.monthlyTokenLimit,
          limitCost: null,
          alertThresholds: quota.alertThresholds,
          action: "warn",
          enabled: true,
          updatedAt: policy.updatedAt ?? new Date().toISOString(),
          updatedBy: policy.updatedBy ?? null,
          synthesized: true,
        });
      }
    }
    /**
     * 每条规则的当期用量（管理台列表要显示"用了多少/还剩多少"的进度条）。
     *
     * 为什么必须在服务端算：口径必须与告警、阻断**同源**（同一个 `usageForRule`）——
     * 否则会出现"页面显示还剩很多、用户却被 429"这类最难排查的不一致。
     * 失败不阻断列表（降级为无用量，页面显示「—」），规则本身仍要能看。
     */
    const usage = await summarizeRulesUsage(db, rules).catch((e) => {
      console.warn(`[quota] 规则用量汇总失败（不影响规则列表）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    const items = rules.map((r) => ({ ...r, usage: usage?.get(r.id) ?? null }));
    return c.json({ rules: items });
  });

  /** upsert 一条规则（按 scope 覆盖）；写后立即复评（把额度调低当场触发告警，不必等下次调用）。 */
  app.put("/admin/quota-rules", async (c) => {
    const claims = c.get("claims");
    if (claims.role !== "platform_admin") return err(c, 403, "仅平台管理员可修改额度规则");
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = parseRuleInput(body);
    if ("error" in parsed) return err(c, 400, parsed.error);
    const saved = await upsertQuotaRule(db, parsed, claims.sub);
    const evaluation = await evaluateQuotaFor(db, {
      uid: parsed.scopeType === "user" ? (parsed.scopeId ?? null) : null,
      deptId: parsed.scopeType === "dept" ? Number(parsed.scopeId) : null,
      webhookUrl: process.env["REACTOR_QUOTA_WEBHOOK_URL"],
    }).catch((e) => {
      console.warn(`[quota] 规则保存后复评失败（不影响保存）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    /**
     * 保存回执也带当期用量：否则前端把新规则插进列表时 usage 缺失，进度条显示「- / 5M」
     * （看着像"没有用量数据"，实际是 0）。用同一个 `summarizeRulesUsage` 保证口径同源。
     */
    const savedUsage = await summarizeRulesUsage(db, [saved])
      .then((m) => m.get(saved.id) ?? null)
      .catch(() => null);
    return c.json({
      rule: { ...saved, usage: savedUsage },
      ...(evaluation && evaluation.newAlerts.length > 0 ? { quotaAlerts: evaluation.newAlerts } : {}),
    });
  });

  app.delete("/admin/quota-rules/:id", async (c) => {
    const claims = c.get("claims");
    if (claims.role !== "platform_admin") return err(c, 403, "仅平台管理员可删除额度规则");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return err(c, 400, "id 非法");
    const ok = await deleteQuotaRule(db, id);
    return ok ? c.json({ ok: true }) : err(c, 404, "规则不存在");
  });

  /**
   * 批量下发（§11.7）：一次给多个目标**同值**写规则。
   *
   * `dryRun: true` 只解析不写库（管理台「预览」按钮）；同一端点两种模式，
   * 避免再开一个 preview 面导致两处解析逻辑漂移。
   *
   * 预览与写入走同一个 `planQuotaBatch`：**预览看到什么就写什么**，
   * 不存在"预览说 800 条、实际写 700 条"的中间态。
   */
  app.post("/admin/quota-rules/batch", async (c) => {
    const claims = c.get("claims");
    if (claims.role !== "platform_admin") return err(c, 403, "仅平台管理员可批量修改额度规则");
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = parseBatchInput(body);
    if ("error" in parsed) return err(c, 400, parsed.error);
    try {
      if (parsed.dryRun) {
        const plan = await planQuotaBatch(db, parsed.input);
        return c.json({ dryRun: true, ...plan, applied: 0 });
      }
      const result = await applyQuotaBatch(
        db,
        parsed.input,
        claims.sub,
        process.env["REACTOR_QUOTA_WEBHOOK_URL"],
      );
      return c.json(result);
    } catch (e) {
      // 目标数超限等"请求本身不合法"→ 400（此时尚未写任何规则）；
      // 其余（库故障等）→ 500，不回写半成品。
      if (e instanceof QuotaBatchError) return err(c, 400, e.message);
      console.warn(`[quota] 批量下发失败：${e instanceof Error ? e.message : String(e)}`);
      return err(c, 500, "批量下发失败");
    }
  });

  /** 告警列表（含各 scope 的当期用量），替代旧的 /admin/quota-alerts 口径。 */
  app.get("/admin/quota-alerts", async (c) => {
    const claims = c.get("claims");
    if (claims.role !== "platform_admin") return err(c, 403, "仅平台管理员可查看额度告警");
    const period = c.req.query("period") ?? currentPeriod();
    const data = await listScopedQuotaAlerts(db, period);
    return c.json({ ...data, webhookConfigured: Boolean(process.env["REACTOR_QUOTA_WEBHOOK_URL"]) });
  });

  /* ---------------- 用户侧：我的额度 ---------------- */

  /**
   * 我的额度：返回**本人适用**的各类规则与当期用量（口径一致 ⇒ 端侧可正确算百分比）。
   *
   * 与 `/desktop/usage/summary` 的关系：那个是"我可见范围内的用量明细"，
   * 这个是"约束我的额度线与各自用量" —— 两者用途不同，都会保留。
   */
  app.get("/desktop/quota/me", async (c) => {
    const claims = c.get("claims");
    const evaluation = await evaluateQuotaFor(db, {
      uid: claims.sub,
      deptId: claims.deptId ?? null,
      webhookUrl: process.env["REACTOR_QUOTA_WEBHOOK_URL"],
    });
    return c.json({
      period: evaluation.period,
      // 面向端侧只暴露渲染所需字段（不回 id/updatedBy 等管理信息）
      items: evaluation.usages.map((u) => ({
        scopeType: u.rule.scopeType,
        scopeId: u.rule.scopeId,
        limitTokens: u.rule.limitTokens,
        limitCost: u.rule.limitCost,
        usedTokens: u.tokens,
        usedCost: u.cost,
        tokenPercent: u.tokenPercent,
        costPercent: u.costPercent,
        alertThresholds: u.rule.alertThresholds,
        action: u.rule.action,
        exceeded: u.exceeded,
      })),
      /** 任一 block 规则超限（端侧据此提示；真正的阻断在网关） */
      blocked: evaluation.blocking.length > 0,
    });
  });

  return app;
}

export type { QuotaScopeType };
