/**
 * 知识板块 —— **PG + 路由探针**（前置：`docker compose up -d pg`；连不上打印 SKIP 并以 0 退出）。
 *
 * 覆盖「文件审查」的三个知识子域（docs/审查板块-方案-v1.md §4.4）：
 *   STD 标准规范清单 / TRM 术语白名单 / RUL 规范库（条文·审点）。
 *
 * ## 守什么（都是"静态检查看不出来"的那类）
 *
 * ① **三个域各自建表幂等**：无迁移框架，靠 `IF NOT EXISTS`，连跑两次不能抛。
 * ② **内置术语真的被 seed 了**：白名单空 = 校对型审查满屏误报，属于"功能静默失效"。
 *    同时守幂等（seed 会随版本增补，每次启动都跑，不能越跑越多）。
 * ③ **内置术语不可删**：它是权限字段不是展示字段，删除必须被服务端拒绝（403），
 *    批量删除要如实回话 `skippedBuiltin`，不能假装成功。
 * ④ **U+FFFD 护栏**：标准编号/术语/条文含替换字符时 import 丢弃、PATCH 返回 400 ——
 *    一旦写成 `????` 就无法从别处恢复，且会污染字符串比对结果（真实踩过）。
 * ⑤ **幂等导入**：标准按 (编号,名称)、术语按 (术语,分类)、条文按 (库,条文hash)，
 *    重跑一次 `inserted=0`。
 * ⑥ **total 与筛选同源**：搜索 10 行却报 13k 是真实出现过的 bug（用全表计数覆盖了筛选计数）。
 * ⑦ **规范库的状态语义**：草稿库消费面 404（不下发半成品），发布后只下发**启用中**的条文 ——
 *    否则"同一文件 + 同一库 = 同一结论"这条纪律失效。
 * ⑧ **编辑条文要重算幂等键**：不重算的话"改完条文再导入同一份清单"会被旧键挡住、静默不更新。
 * ⑨ **删库连带删条文**（ON DELETE CASCADE）并如实回话条数。
 *
 * 用法：`pnpm --filter @reactor/server exec tsx scripts/knowledge-smoke.ts`
 */

import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import { ensureAuditSchema } from "../src/audit/schema.js";
import type { TokenClaims } from "../src/identity/auth.js";
import { closeIdentityDb, createIdentityDb, ensureSchema, type IdentityDb } from "../src/identity/db.js";
// 冒烟库隔离（真实库不受影响）：见 lib/smoke-db.mjs 头注（2026-09-18 市场被清空事故）
import { useSmokeDb } from "./lib/smoke-db.mjs";

// 与其余冒烟同口径：先吃 **server 根**的 .env（绝对路径，不依赖 cwd），否则会回落到
// 55432（compose 映射在 15432）而静默 SKIP。必须 fileURLToPath：仓库路径含中文。
try {
  process.loadEnvFile?.(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 没有 .env 就按环境变量与默认值走 */
}

let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`);
}

const dbUrl = () =>
  process.env["REACTOR_DB_URL"]?.trim() ||
  process.env["REACTOR_DATABASE_URL"]?.trim() ||
  "postgres://reactor:reactor@127.0.0.1:15432/reactor";

const MOJIBAKE = "\uFFFD";

interface Json {
  [key: string]: unknown;
}

async function main(): Promise<void> {
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
    const { ensureStandardsSchema } = await import("../src/standards/schema.js");
    const {
      createStandardsAdminRoutes,
      createStandardsQueryRoutes,
    } = await import("../src/standards/routes.js");
    const { ensureTerminologySchema } = await import("../src/terminology/schema.js");
    const { BUILTIN_TERMS } = await import("../src/terminology/builtin.js");
    const {
      createTerminologyAdminRoutes,
      createTerminologyQueryRoutes,
    } = await import("../src/terminology/routes.js");
    const { ensureRuleLibrariesSchema } = await import("../src/rule-libraries/schema.js");
    const {
      createRuleLibraryAdminRoutes,
      createRuleLibraryQueryRoutes,
    } = await import("../src/rule-libraries/routes.js");

    /* ── ① 建表幂等 ──────────────────────────────────────────────────── */
    console.log("· 建表");
    // 身份与审计两张底表必须先在：管理面写审计要 resolveActorForClaims → 查 users 表，
    // 空库上只建业务表会让每次写操作 500（updates-smoke 真实踩过）。
    await ensureSchema(db);
    await ensureAuditSchema(db);
    await ensureStandardsSchema(db);
    await ensureTerminologySchema(db);
    await ensureRuleLibrariesSchema(db);
    // 第二轮：全部幂等（含术语 seed 的 ON CONFLICT）
    await ensureStandardsSchema(db);
    await ensureTerminologySchema(db);
    await ensureRuleLibrariesSchema(db);
    check("三个子域建表幂等（连跑两次不抛）", true);

    /* ── 路由装配：管理面注入 claims（可切成非管理员），消费面只要求登录 ── */
    const admin = new Hono<{ Variables: { claims: TokenClaims } }>();
    let currentClaims: TokenClaims | null = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };
    admin.use("*", async (c, next) => {
      const claims = currentClaims;
      if (!claims) return c.json({ error: { code: "401", message: "未登录" } }, 401);
      c.set("claims", claims);
      await next();
    });
    admin.route("/", createStandardsAdminRoutes(db));
    admin.route("/", createTerminologyAdminRoutes(db));
    admin.route("/", createRuleLibraryAdminRoutes(db));

    // 消费面：只注入"登录态"，不带角色门槛（这就是它与管理面的区别）
    const viewer = new Hono<{ Variables: { claims: TokenClaims } }>();
    viewer.use("*", async (c, next) => {
      c.set("claims", { sub: "probe-user", name: "探针用户", role: "user" });
      await next();
    });
    viewer.route("/", createStandardsQueryRoutes(db));
    viewer.route("/", createTerminologyQueryRoutes(db));
    viewer.route("/", createRuleLibraryQueryRoutes(db));

    type Requestable = { request: (input: string, init?: RequestInit) => Promise<Response> };
    const app: Requestable = admin;
    const consumer: Requestable = viewer;

    const call = async (
      target: Requestable,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: Json; lastModified: string | null }> => {
      const res = await target.request(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: Json = {};
      try {
        json = text ? (JSON.parse(text) as Json) : {};
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json, lastModified: res.headers.get("last-modified") };
    };
    const get = (p: string) => call(app, "GET", p);
    const post = (p: string, b?: unknown) => call(app, "POST", p, b);
    const patch = (p: string, b?: unknown) => call(app, "PATCH", p, b);
    const del = (p: string) => call(app, "DELETE", p);

    /* ── ② 鉴权边界 ──────────────────────────────────────────────────── */
    console.log("· 鉴权");
    currentClaims = { sub: "probe-user", name: "探测用户", role: "user" };
    check("非 platform_admin 读管理面 → 403", (await get("/admin/terminology")).status === 403);
    check("非 platform_admin 写管理面 → 403", (await post("/admin/rule-libraries", { name: "x" })).status === 403);
    currentClaims = null;
    check("未登录访问管理面 → 401", (await get("/admin/standards")).status === 401);
    currentClaims = { sub: "probe-admin", name: "探针管理员", role: "platform_admin" };

    /* ── ③ 术语白名单 ────────────────────────────────────────────────── */
    console.log("· 术语白名单（TRM）");
    const listed = await get("/admin/terminology?page=1&pageSize=1");
    check(
      `建表 seed 内置术语（应 ${BUILTIN_TERMS.length} 条）`,
      listed.json["total"] === BUILTIN_TERMS.length,
      listed.json["total"],
    );
    const byAlias = await get(`/admin/terminology?search=${encodeURIComponent("安注")}`);
    check(
      "按别名可搜到主术语（安注 → 安全注射）",
      ((byAlias.json["items"] as Json[]) ?? []).some((item) => item["term"] === "安全注射"),
      byAlias.json["items"],
    );
    const catFiltered = await get(`/admin/terminology?category=${encodeURIComponent("核安全术语")}`);
    check(
      "按分类筛选 + total 与筛选同源",
      Number(catFiltered.json["total"]) > 0 &&
        Number(catFiltered.json["total"]) < BUILTIN_TERMS.length &&
        ((catFiltered.json["items"] as Json[]) ?? []).every((item) => item["category"] === "核安全术语"),
      catFiltered.json["total"],
    );

    const builtinRow = ((catFiltered.json["items"] as Json[]) ?? [])[0]!;
    check("内置行标记 isBuiltin", builtinRow["isBuiltin"] === true);
    check("删除内置术语 → 403（权限字段，不是展示字段）", (await del(`/admin/terminology/${builtinRow["id"]}`)).status === 403);

    const created = await post("/admin/terminology", { term: "冒烟术语", category: "自定义", aliases: "smoke,烟测" });
    check("新增自定义术语 → 201 且 isBuiltin=false", created.status === 201 && created.json["isBuiltin"] === false, created.json);
    check("同 (术语,分类) 重复新增 → 409", (await post("/admin/terminology", { term: "冒烟术语", category: "自定义" })).status === 409);
    const termId = Number(created.json["id"]);
    check("PATCH 别名生效", (await patch(`/admin/terminology/${termId}`, { aliases: "smoke-term" })).json["aliases"] === "smoke-term");
    check("乱码护栏：PATCH 术语含 U+FFFD → 400", (await patch(`/admin/terminology/${termId}`, { term: `坏${MOJIBAKE}字` })).status === 400);

    const termImport = await post("/admin/terminology/import", {
      items: [
        { term: "冒烟术语", category: "自定义" },
        { term: "冒烟术语二", category: "自定义", aliases: ["a", "b"] },
        { term: `坏${MOJIBAKE}术语`, category: "自定义" },
      ],
    });
    check(
      "导入：已存在跳过、乱码条目丢弃（received 只算可用条目）",
      termImport.json["inserted"] === 1 && termImport.json["received"] === 2,
      termImport.json,
    );
    const termReimport = await post("/admin/terminology/import", {
      items: [{ term: "冒烟术语二", category: "自定义" }],
    });
    check("导入幂等：重跑 inserted=0", termReimport.json["inserted"] === 0 && termReimport.json["skipped"] === 1, termReimport.json);

    const termIndex = await call(consumer, "GET", "/v1/terminology/index");
    check("消费面全量下发（含内置 + 新增）", Number(termIndex.json["total"]) === BUILTIN_TERMS.length + 2, termIndex.json["total"]);
    const safety = ((termIndex.json["items"] as Json[]) ?? []).find((item) => item["term"] === "安全注射");
    check("消费面把 aliases 拆成数组（拆分口径只有一处）", Array.isArray(safety?.["aliases"]), safety);
    check("消费面带 Last-Modified", Boolean(termIndex.lastModified));
    const notModified = await consumer.request("/v1/terminology/index", {
      headers: { "if-modified-since": termIndex.lastModified ?? "" },
    });
    check("条件请求 → 304", notModified.status === 304, notModified.status);

    /* ── ④ 规范库 ────────────────────────────────────────────────────── */
    console.log("· 规范库（RUL）");
    const lib = await post("/admin/rule-libraries", {
      name: "冒烟规范库",
      description: "探针创建",
      status: "draft",
      standardNo: "GB 50974-2014",
    });
    check("新建规范库 → 201 且默认 draft", lib.status === 201 && lib.json["status"] === "draft", lib.json);
    check("同名库重复创建 → 409", (await post("/admin/rule-libraries", { name: "冒烟规范库" })).status === 409);
    const libId = Number(lib.json["id"]);

    const clauseA = "消防给水系统应保证在火灾时能连续供水，且压力不低于设计要求。";
    const itemA = await post(`/admin/rule-libraries/${libId}/items`, {
      ruleCode: "SMOKE-1",
      ruleName: "连续供水",
      clauseText: clauseA,
      checkPrompt: "检查设计说明是否明确消防给水的连续供水要求",
      category: "给水",
      severity: "error",
    });
    check("新增条文 → 201", itemA.status === 201, itemA.json);
    const itemAId = Number(itemA.json["id"]);
    check(
      "服务端推导条款幂等键（sha256 前 16 位）",
      typeof itemA.json["clauseHash"] === "string" && String(itemA.json["clauseHash"]).length === 16,
      itemA.json["clauseHash"],
    );
    check("同条文重复新增 → 409（不静默重复）", (await post(`/admin/rule-libraries/${libId}/items`, { clauseText: clauseA })).status === 409);

    const itemImport = await post(`/admin/rule-libraries/${libId}/items/import`, {
      items: [
        { clauseText: clauseA },
        { ruleCode: "SMOKE-2", clauseText: "消火栓的布置应保证两支水枪的充实水柱同时到达室内任何部位。" },
        { ruleCode: "SMOKE-3", clauseText: "自动喷水灭火系统应设置末端试水装置。" },
        { clauseText: `坏${MOJIBAKE}条文` },
      ],
    });
    check(
      "导入条文：幂等跳过 + 乱码丢弃",
      itemImport.json["inserted"] === 2 && itemImport.json["received"] === 3,
      itemImport.json,
    );

    const itemList = await get(`/admin/rule-libraries/${libId}/items?page=1&pageSize=20`);
    check("条文列表 total 与筛选同源", itemList.json["total"] === 3, itemList.json["total"]);
    const itemSearch = await get(`/admin/rule-libraries/${libId}/items?search=${encodeURIComponent("末端试水")}`);
    check(
      "搜索命中条文原文（人记的是内容不是编号）",
      itemSearch.json["total"] === 1 && (itemSearch.json["items"] as Json[])[0]?.["ruleCode"] === "SMOKE-3",
      itemSearch.json["total"],
    );
    const libDetail = await get(`/admin/rule-libraries/${libId}`);
    check(
      "库列表带条目计数（total/enabled）",
      libDetail.json["itemCount"] === 3 && libDetail.json["enabledItemCount"] === 3,
      libDetail.json,
    );

    check(
      "草稿库消费面 → 404（不下发半成品）",
      (await call(consumer, "GET", `/v1/rule-libraries/${libId}/items`)).status === 404,
    );
    const publishedList = await call(consumer, "GET", "/v1/rule-libraries");
    check(
      "可下发库列表不含草稿库",
      ((publishedList.json["items"] as Json[]) ?? []).every((x) => x["status"] === "published"),
    );

    await patch(`/admin/rule-libraries/${libId}`, { status: "published" });
    check("停用条文生效", (await patch(`/admin/rule-libraries/${libId}/items/${itemAId}`, { enabled: false })).json["enabled"] === false);
    const pubItems = await call(consumer, "GET", `/v1/rule-libraries/${libId}/items`);
    check("发布后消费面可读", pubItems.status === 200, pubItems.status);
    check("只下发启用中的条文（2/3）", (pubItems.json["items"] as Json[]).length === 2, pubItems.json["items"]);
    check(
      "下发库元信息与 Last-Modified",
      (pubItems.json["library"] as Json)?.["id"] === libId && Boolean(pubItems.lastModified),
      pubItems.json["library"],
    );

    const edited = await patch(`/admin/rule-libraries/${libId}/items/${itemAId}`, {
      clauseText: "条文已修订：消防给水应连续供水。",
    });
    check("改条文会重算幂等键", edited.json["clauseHash"] !== itemA.json["clauseHash"], {
      before: itemA.json["clauseHash"],
      after: edited.json["clauseHash"],
    });
    const reimportItems = await post(`/admin/rule-libraries/${libId}/items/import`, {
      items: [{ clauseText: "条文已修订：消防给水应连续供水。" }, { clauseText: clauseA }],
    });
    // 幂等键由**内容**派生：改后的新条文与库里同内容 → 跳过；原条文内容与库里都不同 → 新增。
    // 这正是"不重算键就会被旧键挡住、静默不更新"这条注释要守的行为。
    check(
      "改后再导入：新条文跳过、旧条文作为独立条目新增",
      reimportItems.json["inserted"] === 1 && reimportItems.json["skipped"] === 1,
      reimportItems.json,
    );

    /* ── ⑤ 清理路径 ──────────────────────────────────────────────────── */
    console.log("· 清理");
    const deleted = await del(`/admin/rule-libraries/${libId}`);
    check(
      "删库连带删条文（CASCADE）并如实回话条数",
      deleted.json["deleted"] === 1 && deleted.json["deletedItems"] === 4,
      deleted.json,
    );
    check("删除后消费面 → 404", (await call(consumer, "GET", `/v1/rule-libraries/${libId}/items`)).status === 404);
    const bulk = await post("/admin/terminology/bulk-delete", { ids: [termId, Number(builtinRow["id"])] });
    check(
      "批量删除跳过内置术语并如实回话",
      bulk.json["deleted"] === 1 && bulk.json["skippedBuiltin"] === 1,
      bulk.json,
    );

    /* ── ⑥ 标准清单（STD）：M3a 既有能力的回归 ───────────────────────── */
    console.log("· 标准清单（STD）回归");
    const stdImport = await post("/admin/standards/import", {
      items: [
        { standardNo: "GB 50974-2014", standardName: "消防给水及消火栓系统技术规范", status: "现行", category: "暖通/给排水/消防" },
        { standardNo: "GB 50016-2006", standardName: "建筑设计防火规范", status: "废止", category: "暖通/给排水/消防" },
        { standardNo: `GB 9999-2020${MOJIBAKE}`, standardName: "乱码编号应被丢弃" },
      ],
    });
    check(
      "标准导入：中文状态归一 + 乱码条目丢弃",
      stdImport.json["inserted"] === 2 && stdImport.json["received"] === 2,
      stdImport.json,
    );
    check("标准导入幂等：重跑 inserted=0", (await post("/admin/standards/import", {
      items: [{ standardNo: "GB 50974-2014", standardName: "消防给水及消火栓系统技术规范" }],
    })).json["inserted"] === 0);
    const stdFiltered = await get("/admin/standards?status=abolished&page=1&pageSize=5");
    check(
      "状态筛选 + total 与筛选同源（不是全表数）",
      stdFiltered.json["total"] === 1 && ((stdFiltered.json["items"] as Json[]) ?? []).every((x) => x["status"] === "abolished"),
      stdFiltered.json["total"],
    );
    const stdIndex = await call(consumer, "GET", "/v1/standards/index");
    check("消费面索引下发（含 ident 与 Last-Modified）", Number(stdIndex.json["total"]) === 2 && Boolean(stdIndex.lastModified), stdIndex.json["total"]);
    check("消费面不含管理字段（只发轻量索引）", !("replaceInfo" in (((stdIndex.json["items"] as Json[]) ?? [])[0] ?? {})));
    // 单字段 PATCH 不能把其它日期清空（真实踩过 String(undefined) → PG DateTimeParseError）
    const stdRow = ((stdFiltered.json["items"] as Json[]) ?? [])[0]!;
    const stdPatched = await patch(`/admin/standards/${stdRow["id"]}`, { status: "current" });
    check(
      "单字段 PATCH 不清空其它字段、不因 undefined 报 500",
      stdPatched.status === 200 && stdPatched.json["status"] === "current",
      stdPatched.json,
    );
    check(
      "清空日期用空串（而不是 undefined 语义）",
      (await patch(`/admin/standards/${stdRow["id"]}`, { publishDate: "" })).json["publishDate"] === null,
    );

    console.log(failed === 0 ? "\n全部断言通过" : `\n存在 ${failed} 条失败断言`);
  } finally {
    await closeIdentityDb(db);
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
