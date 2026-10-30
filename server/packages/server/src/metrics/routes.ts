/**
 * 平台运营指标 HTTP 路由（双平台看板）。
 *
 * 挂载方式与 audit/routes.ts 一致：由 identity/routes.ts 挂进 `authed` 组，
 * 复用 Bearer 中间件，这里不再自带 `use("*")`。
 *
 * 权限：本批只开放给 `platform_admin`。部门维度的数据范围收敛（dept_head 只看本部门）
 * 留到看板有真实使用后再做——现在多做一层范围解析，反而会让口径更难核对。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  coverageInfo,
  heatmapByPlatform,
  listClientLogins,
  overviewByPlatform,
  presenceSnapshot,
  seriesByPlatform,
  type ClientPlatform,
  type MetricsWindow,
  type SeriesMetric,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

const RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** 看板按本地日历日聚合；容器默认 UTC，直接 extract 会把凌晨算到前一天。 */
function resolveTimeZone(): string {
  return process.env["REACTOR_METRICS_TZ"]?.trim() || "Asia/Shanghai";
}

function parseWindow(c: Ctx): MetricsWindow | { error: string } {
  const range = c.req.query("range") ?? "7d";
  const span = RANGE_MS[range];
  if (!span) return { error: `range 需为 ${Object.keys(RANGE_MS).join("|")}` };
  const to = new Date();
  return { from: new Date(to.getTime() - span), to };
}

function requireAdmin(c: Ctx): boolean {
  return c.get("claims").role === "platform_admin";
}

export function createPlatformMetricsRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/admin/metrics/platform/overview", async (c) => {
    if (!requireAdmin(c)) return err(c, 403, "仅平台管理员可查看平台指标");
    const window = parseWindow(c);
    if ("error" in window) return err(c, 400, window.error);
    const [platforms, coverage] = await Promise.all([
      overviewByPlatform(db, window),
      coverageInfo(db, window),
    ]);
    return c.json({
      generatedAt: new Date().toISOString(),
      range: c.req.query("range") ?? "7d",
      coverage,
      // 阶段一没有心跳：这里全部是「窗口内活跃」口径，不是实时在线
      approximation: { active: true, usagePlatform: "latest-login" },
      // 桶平铺在顶层（desktop/web/untagged），与管理台服务的 readOverview 对齐
      ...platforms,
    });
  });

  app.get("/admin/metrics/platform/series", async (c) => {
    if (!requireAdmin(c)) return err(c, 403, "仅平台管理员可查看平台指标");
    const window = parseWindow(c);
    if ("error" in window) return err(c, 400, window.error);
    const metric = (c.req.query("metric") ?? "active") as SeriesMetric;
    if (!["active", "requests", "tokens"].includes(metric)) {
      return err(c, 400, "metric 需为 active|requests|tokens");
    }
    const interval = (c.req.query("interval") ?? "day") as "hour" | "day";
    if (!["hour", "day"].includes(interval)) return err(c, 400, "interval 需为 hour|day");

    const [series, coverage] = await Promise.all([
      seriesByPlatform(db, window, metric, interval, resolveTimeZone()),
      coverageInfo(db, window),
    ]);
    return c.json({
      generatedAt: new Date().toISOString(),
      range: c.req.query("range") ?? "7d",
      metric,
      interval,
      coverage,
      ...series,
    });
  });

  app.get("/admin/metrics/platform/heatmap", async (c) => {
    if (!requireAdmin(c)) return err(c, 403, "仅平台管理员可查看平台指标");
    const window = parseWindow(c);
    if ("error" in window) return err(c, 400, window.error);
    const [cells, coverage] = await Promise.all([
      heatmapByPlatform(db, window, resolveTimeZone()),
      coverageInfo(db, window),
    ]);
    return c.json({
      generatedAt: new Date().toISOString(),
      range: c.req.query("range") ?? "7d",
      timeZone: resolveTimeZone(),
      coverage,
      ...cells,
    });
  });

  app.get("/admin/metrics/platform/presence", async (c) => {
    if (!requireAdmin(c)) return err(c, 403, "仅平台管理员可查看平台指标");
    const windowMinutes = Number(c.req.query("windowMinutes") ?? 15);
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 240) {
      return err(c, 400, "windowMinutes 需为 1-240 的整数");
    }
    const snapshot = await presenceSnapshot(db, windowMinutes);
    return c.json({
      generatedAt: new Date().toISOString(),
      // 如实标注：阶段一没有心跳，这是「最近登录」而不是「在线连接」
      approx: snapshot.approx,
      windowMinutes: snapshot.windowMinutes,
      desktop: snapshot.counts.desktop,
      web: snapshot.counts.web,
    });
  });

  app.get("/admin/metrics/platform/sessions", async (c) => {
    if (!requireAdmin(c)) return err(c, 403, "仅平台管理员可查看平台指标");
    const window = parseWindow(c);
    if ("error" in window) return err(c, 400, window.error);
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return err(c, 400, "limit 需为 1-500");
    if (!Number.isInteger(offset) || offset < 0) return err(c, 400, "offset 非法");
    const platformRaw = c.req.query("platform");
    const platform: ClientPlatform | null =
      platformRaw === "desktop" || platformRaw === "web" ? platformRaw : null;
    const uid = c.req.query("uid")?.trim() || undefined;
    const [{ total, items }, coverage] = await Promise.all([
      listClientLogins(db, window, { limit, offset, platform, uid }),
      coverageInfo(db, window),
    ]);
    return c.json({
      generatedAt: new Date().toISOString(),
      coverage,
      total,
      limit,
      offset,
      // 阶段一没有独立会话表：一行登录 ≈ 一次会话，sessionId 用登录行 id 兜底，
      // first/last 都取登录时间（没有心跳时两者相等）。字段驼峰化对齐管理台服务层。
      items: items.map((row) => ({
        sessionId: `login-${row.id}`,
        uid: row.uid,
        deptPath: row.dept_path,
        platform: row.platform,
        clientVersion: row.client_version,
        userAgent: row.user_agent,
        firstSeenAt: row.logged_in_at,
        lastSeenAt: row.last_seen_at,
      })),
    });
  });

  return app;
}
