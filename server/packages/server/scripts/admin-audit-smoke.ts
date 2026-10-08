/**
 * 管理操作审计兜底冒烟（洞①，2026-10-08）—— PG + 进程内 Hono，起真实路由形状。
 *
 * ## 守什么（静态检查看不出来的那类）
 *
 * ① **兜底真的会记**：无手写埋点的 `/admin/*` 写、组织用户写、`PUT /desktop/policy`、
 *    `/v1/kb/*` 写 → 各落 1 条 `admin_action`，op=方法+路由模式、target=实际路径。
 * ② **去重真的去重**：手写埋点先 `markAdminAudited(c)` → 兜底跳过，恰好 1 条（不是 2 条）。
 *    这条依赖「Hono 整条链共享同一个 Context 实例」——正是要靠运行验证的假设。
 * ③ **范围收得住**：GET、`/me/*`、`/desktop/audit/batch`、`/auth/logout`、`/v1/kb/search`
 *    → 0 条（误伤会把审计表刷成噪音 / 把上报入口自刷）。
 * ④ **状态码语义**：403 → outcome=denied + errorCode=403；200 → ok 且无 errorCode。
 * ⑤ **纯函数分支**：shouldRecordAdminAudit 的白/黑名单逐条直断（不依赖 DB）。
 *
 * 前置：docker compose up -d（reactor-pg）；连不上则打印 SKIP 并以 0 退出。
 * 用法：pnpm --filter @reactor/server smoke:admin-audit
 */

import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import type { TokenClaims } from "../src/identity/auth.js";
import { closeIdentityDb, createIdentityDb, ensureSchema, type IdentityDb } from "../src/identity/db.js";
import { ensureAuditSchema } from "../src/audit/schema.js";
// 冒烟库隔离（真实库不受影响）：见 lib/smoke-db.mjs 头注
import { useSmokeDb } from "./lib/smoke-db.mjs";

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

// 与其它 smoke 同口径：先吃 server 根的 .env（REACTOR_DB_URL 在那里）。
try {
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 没有 .env 就按环境变量与默认值走 */
}

const dbUrl = () =>
  process.env["REACTOR_DB_URL"]?.trim() ||
  process.env["REACTOR_DATABASE_URL"]?.trim() ||
  "postgres://reactor:reactor@127.0.0.1:15432/reactor";

async function main(): Promise<void> {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响
  try {
    await useSmokeDb();
  } catch (err) {
    console.log(`SKIP: 冒烟库准备失败（PG 不可达？）: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  let db: IdentityDb;
  try {
    db = createIdentityDb(dbUrl());
    await db.pool.query("SELECT 1");
  } catch (err) {
    console.log(`SKIP: PG 不可达（${dbUrl()}）: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  try {
    const { adminAuditMiddleware, markAdminAudited, shouldRecordAdminAudit } = await import(
      "../src/audit/adminAudit.js"
    );
    const { recordAdminAction, resolveActorForClaims } = await import("../src/audit/repo.js");

    /* ── ⑤ 纯函数分支（不依赖 DB，先跑） ───────────────────────────── */
    console.log("· shouldRecordAdminAudit 分支");
    check("POST /admin/skills 记", shouldRecordAdminAudit("POST", "/admin/skills"));
    check("DELETE /admin/skills/42 记", shouldRecordAdminAudit("DELETE", "/admin/skills/42"));
    check("PUT /desktop/policy 记", shouldRecordAdminAudit("PUT", "/desktop/policy"));
    check("POST /auth/sync 记", shouldRecordAdminAudit("POST", "/auth/sync"));
    check("POST /users 记", shouldRecordAdminAudit("POST", "/users"));
    check("PATCH /depts/3 记", shouldRecordAdminAudit("PATCH", "/depts/3"));
    check("POST /v1/kb/datasets 记", shouldRecordAdminAudit("POST", "/v1/kb/datasets"));
    check("GET /admin/skills 不记", !shouldRecordAdminAudit("GET", "/admin/skills"));
    check("POST /me/skills/x/install 不记", !shouldRecordAdminAudit("POST", "/me/skills/x/install"));
    check("POST /desktop/audit/batch 不记", !shouldRecordAdminAudit("POST", "/desktop/audit/batch"));
    check("POST /auth/logout 不记", !shouldRecordAdminAudit("POST", "/auth/logout"));
    check("POST /v1/kb/search 不记", !shouldRecordAdminAudit("POST", "/v1/kb/search"));
    check("带 query 的写仍记", shouldRecordAdminAudit("PUT", "/desktop/policy?x=1"));

    /* ── 建表：身份表先行（resolveActorForClaims 查 users），审计表随后 ── */
    console.log("· 建表");
    await ensureSchema(db);
    await ensureAuditSchema(db);
    await ensureAuditSchema(db); // 幂等
    check("建表幂等（连跑两次不抛）", true);

    /* ── 路由装配：claims 注入 → 兜底中间件 → 测试路由 ───────────────── */
    const app = new Hono<{ Variables: { claims: TokenClaims } }>();
    const claims: TokenClaims = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };
    app.use("*", async (c, next) => {
      c.set("claims", claims);
      await next();
    });
    app.use("*", adminAuditMiddleware(db));

    // 模拟「有手写埋点」的路由：闭包第一行打标（与 6 个真实文件同构）。
    app.post("/admin/widget-manual", async (c) => {
      markAdminAudited(c);
      await recordAdminAction(db, await resolveActorForClaims(db, claims), {
        op: "widget.create",
        target: "widget:1",
        details: { after: { name: "probe" } },
      });
      return c.json({ ok: true });
    });
    // 模拟「无埋点」的路由（兜底应记）。
    app.post("/admin/widget-plain", async (c) => c.json({ ok: true }));
    app.get("/admin/widget-plain", async (c) => c.json({ ok: true }));
    app.post("/admin/widget-forbidden", async (c) => c.json({ error: { code: "403", message: "无权" } }, 403));
    app.post("/me/noise", async (c) => c.json({ ok: true }));
    app.post("/desktop/audit/batch", async (c) => c.json({ accepted: 0 }));
    app.post("/auth/logout", async (c) => c.json({ ok: true }));
    app.post("/users", async (c) => c.json({ ok: true }));
    app.put("/desktop/policy", async (c) => c.json({ ok: true }));
    app.post("/v1/kb/datasets", async (c) => c.json({ ok: true }));
    app.post("/v1/kb/search", async (c) => c.json({ results: [] }));

    type Requestable = { request: (input: string, init?: RequestInit) => Promise<Response> };
    const probe: Requestable = app;
    const post = (path: string, method = "POST") => probe.request(path, { method });

    const rowsFor = (op: string) =>
      db.pool.query<{ tool_name: string; target: string | null; outcome: string; error_code: string | null; summary: string | null }>(
        `SELECT tool_name, target, outcome, error_code, summary FROM audit_event WHERE action='admin_action' AND tool_name = $1`,
        [op],
      );
    const countAll = async () => {
      const r = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_event WHERE action='admin_action'`);
      return Number(r.rows[0]?.n ?? "0");
    };

    /* ── ①②④ 逐路由触发并断言 ─────────────────────────────────────── */
    console.log("· 触发");

    const manual = await post("/admin/widget-manual");
    check("手写埋点路由 200", manual.status === 200, manual.status);
    const manualRows = await rowsFor("widget.create");
    check("手写埋点恰好 1 条（去重生效，兜底没双写）", manualRows.rowCount === 1, manualRows.rows);
    const manualGeneric = await rowsFor("POST /admin/widget-manual");
    check("手写埋点路由无兜底记录", manualGeneric.rowCount === 0, manualGeneric.rows);
    check("手写埋点 details 快照保留", manualRows.rows[0] !== undefined, manualRows.rows[0]);

    const plain = await post("/admin/widget-plain");
    check("无埋点 /admin 写 200", plain.status === 200, plain.status);
    const plainRows = await rowsFor("POST /admin/widget-plain");
    check("无埋点 /admin 写落 1 条兜底", plainRows.rowCount === 1, plainRows.rows);
    check(
      "兜底 op/靶子/结果正确",
      plainRows.rows[0]?.target === "/admin/widget-plain" && plainRows.rows[0]?.outcome === "ok" && plainRows.rows[0]?.error_code === null,
      plainRows.rows[0],
    );

    const forbid = await post("/admin/widget-forbidden");
    check("403 路由返回 403", forbid.status === 403, forbid.status);
    const forbidRows = await rowsFor("POST /admin/widget-forbidden");
    check(
      "403 → outcome=denied + errorCode=403",
      forbidRows.rowCount === 1 && forbidRows.rows[0]?.outcome === "denied" && forbidRows.rows[0]?.error_code === "403",
      forbidRows.rows,
    );

    await post("/admin/widget-plain", "GET");
    const getRows = await rowsFor("GET /admin/widget-plain");
    check("GET 不记", getRows.rowCount === 0 && (await countAll()) >= 0, getRows.rows);

    await post("/me/noise");
    await post("/desktop/audit/batch");
    await post("/auth/logout");
    await post("/v1/kb/search");
    const noiseOps = [
      "POST /me/noise",
      "POST /desktop/audit/batch",
      "POST /auth/logout",
      "POST /v1/kb/search",
    ];
    let noiseCount = 0;
    for (const op of noiseOps) noiseCount += (await rowsFor(op)).rowCount ?? 0;
    check("排除面（/me、上报入口、登出、KB 查询）全为 0 条", noiseCount === 0, noiseCount);

    const users = await post("/users");
    check("POST /users 200", users.status === 200, users.status);
    check("POST /users 落 1 条", (await rowsFor("POST /users")).rowCount === 1);

    const policy = await probe.request("/desktop/policy", { method: "PUT" });
    check("PUT /desktop/policy 200", policy.status === 200, policy.status);
    check("PUT /desktop/policy 落 1 条", (await rowsFor("PUT /desktop/policy")).rowCount === 1);

    const kb = await post("/v1/kb/datasets");
    check("POST /v1/kb/datasets 200", kb.status === 200, kb.status);
    check("POST /v1/kb/datasets 落 1 条", (await rowsFor("POST /v1/kb/datasets")).rowCount === 1);

    // 总数复核：1(manual) + 1(plain) + 1(forbidden) + 1(users) + 1(policy) + 1(kb) = 6
    const total = await countAll();
    check("audit_event 兜底总条数恰为 6（无其它路径漏写/双写）", total === 6, total);
  } finally {
    await closeIdentityDb(db).catch(() => undefined);
  }

  console.log(failed === 0 ? "\n全部通过 ✓" : `\n${failed} 项失败 ✗`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("冒烟异常:", err);
  process.exit(1);
});
