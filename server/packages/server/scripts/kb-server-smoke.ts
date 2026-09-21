/**
 * 公共知识库 —— **PG 探针**（KB-⑥ 服务端，`infra` 组：前置 docker compose 的 pg）。
 *
 * 前置：`docker compose up -d pg`（pgvector 镜像）；连不上则打印 SKIP 并以 0 退出。
 *
 * ## 守什么（都是"静态检查看不出来"的那类）
 *
 * ① **建表幂等**：连跑两次不报错（无迁移框架，靠 `IF NOT EXISTS`）。
 * ② **向量能力如实探测**：pgvector 可用/不可用两条路都能建表，且返回值不撒谎。
 * ③ **红线 ① 应用层裁剪**：跨部门的库被剔除并**点名**。
 * ④ **红线 ② SQL 层过滤**：绕过应用层直接走仓储查询，跨部门片段**仍然看不到** ——
 *    这一条与「裸查能看到」形成对照，是纵深防御真正生效的证据（不是"代码里写了就算"）。
 * ⑤ **三模式实际检索**：lexical 中文命中（bigram）、vector 走 SQL `<=>`、hybrid 融合去重。
 * ⑥ **降级如实标注**：不注入向量化器时 `meta.degraded` 为真且 `effectiveMode` 变成 lexical。
 *
 * 测试数据**自清理**（写的是真实表 —— 见 `docs/工程铁律/后端与架构.md`「数据与测试约定」）。
 *
 * 用法：`pnpm --filter @reactor/server exec tsx scripts/kb-server-smoke.ts`
 */

import { Hono } from "hono";
import {
  addDocument,
  createDataset,
  deleteDataset,
  ensureDatasetsSchema,
  findDataset,
  listDocuments,
  listVisibleDatasets,
  loadSearchSegments,
  type KbViewer,
} from "../src/datasets/repo.js";
import { resolveDatasetScope, searchKb } from "../src/datasets/retrieval.js";
import { createDatasetsRoutes } from "../src/datasets/routes.js";
import type { TokenClaims } from "../src/identity/auth.js";
import { createIdentityDb, closeIdentityDb, type IdentityDb } from "../src/identity/db.js";
// 冒烟库隔离（真实库不受影响）：见 lib/smoke-db.mjs 头注（2026-09-18 市场被清空事故）
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

/** 与生产同一维度（建表维度一旦定了不可改；探针用默认值以免与既有表冲突） */
const DIM = 1024;

/** 稀疏 one-hot 向量：索引处为 1，其余 0 —— 余弦可精确预期 */
function vecAt(index: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[index % DIM] = 1;
  return v;
}

/** 假向量化器：按关键词给固定方向（不联网，可精确预期命中哪一条） */
function fakeEmbedder(map: Record<string, number>): (texts: readonly string[]) => Promise<number[][]> {
  return async (texts) =>
    texts.map((t) => {
      for (const [kw, idx] of Object.entries(map)) if (t.includes(kw)) return vecAt(idx);
      return vecAt(0);
    });
}

/**
 * 冒烟库地址由 lib/smoke-db.mjs 的 useSmokeDb() 在 main() 开头写进 process.env，
 * 所以这里**不能在模块级捕获** —— 否则拿到的是真实库地址。
 */
const dbUrl = () =>
  process.env["REACTOR_DB_URL"]?.trim() ||
  process.env["REACTOR_DATABASE_URL"]?.trim() ||
  "postgres://reactor:reactor@127.0.0.1:55432/reactor";

async function main(): Promise<void> {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  let db: IdentityDb;
  try {
    db = createIdentityDb(dbUrl());
    await db.pool.query("SELECT 1");
  } catch (err) {
    console.log(`SKIP: PG 不可达（${dbUrl()}）: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  const created: number[] = [];
  try {
    /* ── ① 建表幂等 + 向量探测 ─────────────────────────────────────────── */
    console.log("· 建表与能力探测");
    const info1 = await ensureDatasetsSchema(db);
    const info2 = await ensureDatasetsSchema(db); // 幂等：第二次不应报错
    check("建表幂等（连跑两次不抛）", info1.dim === info2.dim && info1.vectorReady === info2.vectorReady);
    check(`pgvector 探测结果如实返回（vectorReady=${info1.vectorReady}）`, typeof info1.vectorReady === "boolean");
    console.log(`  · 本机 pgvector 可用性：${info1.vectorReady ? "可用（走 SQL 向量检索）" : "不可用（降级为词法 + Node 余弦）"}`);

    /* ── ② 造数据：三个不同 scope 的库 ────────────────────────────────── */
    console.log("· 造测试数据（三个 scope 的库）");
    const orgId = await createDataset(db, {
      name: `[probe] 全员库 ${Date.now()}`,
      description: "探针数据",
      scope: { kind: "all", roles: [], deptIds: [], uids: [] },
      createdBy: "probe",
    });
    const dept1Id = await createDataset(db, {
      name: `[probe] 一部库 ${Date.now()}`,
      scope: { kind: "dept", roles: [], deptIds: [101], uids: [] },
      createdBy: "probe",
    });
    const dept2Id = await createDataset(db, {
      name: `[probe] 二部库 ${Date.now()}`,
      scope: { kind: "dept", roles: [], deptIds: [202], uids: [] },
      createdBy: "probe",
    });
    created.push(orgId, dept1Id, dept2Id);

    await addDocument(db, {
      datasetId: orgId,
      name: "全员手册.md",
      addedBy: "probe",
      vectorReady: info1.vectorReady,
      segments: [
        { position: 0, text: "公司全员都可以看到的量子计算入门材料，讲量子比特与退相干。", embedding: vecAt(1) },
        { position: 1, text: "报销流程与差旅标准，适用于所有部门员工。", embedding: vecAt(2) },
      ],
    });
    await addDocument(db, {
      datasetId: dept1Id,
      name: "一部报表.md",
      addedBy: "probe",
      vectorReady: info1.vectorReady,
      segments: [{ position: 0, text: "一部的季度报表口径与统计说明，只给一部同事看。", embedding: vecAt(3) }],
    });
    await addDocument(db, {
      datasetId: dept2Id,
      name: "二部机密.md",
      addedBy: "probe",
      vectorReady: info1.vectorReady,
      segments: [{ position: 0, text: "二部机密：跨部门不可见的量子实验记录。", embedding: vecAt(1) }],
    });
    check("库已建立且可查回", (await findDataset(db, orgId))?.id === orgId);

    const viewerDept1: KbViewer = { uid: "probe-u1", role: "user", deptId: 101 };
    const scopeKinds = new Map([
      [orgId, "all"],
      [dept1Id, "dept"],
      [dept2Id, "dept"],
    ]);

    /* ── ③ 红线 ①：应用层裁剪（越权要剔除并点名） ──────────────────────── */
    console.log("· 红线 ① 应用层裁剪");
    const clipped = await resolveDatasetScope(db, viewerDept1, [orgId, dept1Id, dept2Id]);
    check("可见集合含全员库", clipped.ids.includes(orgId), clipped);
    check("可见集合含本部库", clipped.ids.includes(dept1Id), clipped);
    check("★ 跨部门库被剔除（不在 ids 里）", !clipped.ids.includes(dept2Id), clipped);
    check("★ 被剔除的库**点名**在 dropped 里（不静默）", clipped.dropped.includes(dept2Id), clipped);

    /* ── ④ 红线 ②：SQL 层过滤（绕过应用层也看不到） ────────────────────── */
    console.log("· 红线 ② SQL 层过滤（纵深防御）");
    const raw = await db.pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM kb_segments WHERE dataset_id = $1",
      [dept2Id],
    );
    check("对照：裸查（不带可见性谓词）**能**看到跨部门片段（证明数据确实在）", Number(raw.rows[0]?.n ?? 0) > 0);
    const direct = await loadSearchSegments(db, viewerDept1, [dept2Id]);
    check("★ 走仓储查询（含 visibilitySql）看不到跨部门片段", direct.length === 0, direct.length);
    const own = await loadSearchSegments(db, viewerDept1, [orgId, dept1Id, dept2Id]);
    check("同一次查询里，本部与全员片段仍然拿得到（不是把整条查询禁掉）", own.length >= 3, own.length);

    /* ── ⑤ 三模式实际检索 ─────────────────────────────────────────────── */
    console.log("· 三模式检索");
    const lex = await searchKb(
      db,
      viewerDept1,
      { queries: ["量子计算"], mode: "lexical", datasetIds: [orgId, dept1Id, dept2Id] },
      { vectorReady: info1.vectorReady },
      scopeKinds,
    );
    check("lexical：中文 bigram 命中「量子」那条", lex.hits.length > 0 && lex.hits[0]!.chunk.includes("量子"), lex.hits[0]);
    check("lexical：命中带来源标注 org（全员库）", lex.hits.some((h) => h.source === "org"), lex.hits.map((h) => h.source));
    check("lexical：**没有**跨部门命中（裁剪生效）", !lex.hits.some((h) => h.chunk.includes("二部机密")), lex.hits.map((h) => h.chunk.slice(0, 12)));

    const embedder = fakeEmbedder({ 量子: 1, 报销: 2, 报表: 3 });
    const vec = await searchKb(
      db,
      viewerDept1,
      { queries: ["量子"], mode: "vector", datasetIds: [orgId, dept1Id, dept2Id] },
      { vectorReady: info1.vectorReady, embedder },
      scopeKinds,
    );
    check("vector：向量路命中（有结果）", vec.hits.length > 0, vec.meta);
    check("vector：命中的是向量方向一致的那条（全员库的量子片段）", vec.hits[0]!.chunk.includes("量子比特"), vec.hits[0]);
    if (info1.vectorReady) {
      check("★ vector：本机 pgvector 可用 ⇒ 确实走了 SQL 路", vec.meta.vectorUsed, vec.meta);
    } else {
      check("★ vector：pgvector 不可用 ⇒ 降级走 Node 余弦且如实标注", vec.meta.degraded, vec.meta);
    }

    const hybrid = await searchKb(
      db,
      viewerDept1,
      { queries: ["量子计算"], mode: "hybrid", datasetIds: [orgId, dept1Id, dept2Id] },
      { vectorReady: info1.vectorReady, embedder },
      scopeKinds,
    );
    check("hybrid：两路融合后有结果", hybrid.hits.length > 0, hybrid.meta);
    check("hybrid：同一片段不重复（fuseAndRank 去重生效）", new Set(hybrid.hits.map((h) => `${h.datasetName}#${h.position}`)).size === hybrid.hits.length);

    /* ── ⑥ 降级如实标注 ───────────────────────────────────────────────── */
    console.log("· 降级标注");
    const noEmbedder = await searchKb(
      db,
      viewerDept1,
      { queries: ["量子计算"], mode: "hybrid", datasetIds: [orgId] },
      { vectorReady: info1.vectorReady },
      scopeKinds,
    );
    check("★ 未配置向量化器 ⇒ degraded=true（不假装已启用向量）", noEmbedder.meta.degraded, noEmbedder.meta);
    check("★ 且 effectiveMode 降为 lexical", noEmbedder.meta.effectiveMode === "lexical", noEmbedder.meta);
    check("降级后仍有结果（功能不消失，只是弱）", noEmbedder.hits.length > 0, noEmbedder.meta);

    /* ── ⑦ 列表与 CRUD 闭环 ───────────────────────────────────────────── */
    console.log("· 列表与 CRUD");
    const list = await listVisibleDatasets(db, viewerDept1);
    const mine = list.filter((d) => created.includes(d.id));
    check("可见列表只含全员库 + 本部库（不含二部库）", mine.length === 2, mine.map((d) => d.name));
    check("列表带统计（文档数已回填）", mine.every((d) => d.documentCount >= 1), mine.map((d) => d.documentCount));
    const docs = await listDocuments(db, orgId);
    check("文档列表可读回", docs.length === 1 && docs[0]!.name === "全员手册.md", docs);

    /* ── ⑧ 路由层（HTTP 级，注入 claims —— 不需要登录） ────────────────── */
    //
    // 这一节验的是「接口真的能按 HTTP 语义工作」：状态码、鉴权、越权、降级标注。
    // 用 Hono 的 `app.request()` 在**进程内**打真路由，claims 由中间件注入 ——
    // 这样不必有可用账号（本仓的登录账号是 807 条真实员工数据，探针不去碰）。
    console.log("· 路由层（HTTP 级）");
    {
      const app = new Hono<{ Variables: { claims: TokenClaims } }>();
      let currentClaims: TokenClaims = { sub: "probe-u1", name: "probe", role: "user", deptId: 101 };
      app.use("*", async (c, next) => {
        c.set("claims", currentClaims);
        await next();
      });
      app.route("/", createDatasetsRoutes(db, { schema: info1 }));

      const get = (p: string) => app.request(p, { method: "GET" });
      const post = (p: string, body: unknown) =>
        app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const patch = (p: string, body: unknown) =>
        app.request(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const del = (p: string) => app.request(p, { method: "DELETE" });

      const health = await (await get("/v1/kb/health")).json();
      check("GET /v1/kb/health 200 且如实报能力", typeof (health as { vectorReady: boolean }).vectorReady === "boolean", health);

      const listRes = await get("/v1/kb/datasets");
      const listBody = (await listRes.json()) as { items: Array<{ id: string; name: string; source: string }> };
      check("GET /v1/kb/datasets 200", listRes.status === 200);
      check("列表只含可见库（无二部库）", !listBody.items.some((d) => d.id === String(dept2Id)), listBody.items.map((d) => d.name));
      check("列表带 source 标注（org / department）", listBody.items.some((d) => d.source === "org"), listBody.items.map((d) => d.source));

      // 越权：普通用户建库 ⇒ 403
      const denied = await post("/v1/kb/datasets", { name: "越权建库" });
      check("★ 普通用户 POST /v1/kb/datasets ⇒ 403（写接口要管理员）", denied.status === 403, denied.status);

      // 越权读：别人的库 ⇒ 404（不泄露"存在但你看不到"）
      const forbiddenDetail = await get(`/v1/kb/datasets/${dept2Id}`);
      check("★ 读不可见库 ⇒ 404（不泄露存在性）", forbiddenDetail.status === 404, forbiddenDetail.status);

      // 检索：命中 + 来源 + 降级标注
      const searchRes = await post("/v1/kb/search", { queries: ["量子计算"], datasetIds: [orgId, dept2Id] });
      const searchBody = (await searchRes.json()) as {
        hits: Array<{ chunk: string; source: string }>;
        meta: { droppedDatasetIds: number[]; degraded: boolean; effectiveMode: string };
      };
      check("POST /v1/kb/search 200", searchRes.status === 200);
      check("★ 检索回执点名被剔除的越权库（droppedDatasetIds）", searchBody.meta.droppedDatasetIds.includes(dept2Id), searchBody.meta);
      check("检索命中带来源标注", searchBody.hits.length > 0 && searchBody.hits[0]!.source === "org", searchBody.hits[0]);
      check("★ 未配向量化器 ⇒ 回执如实标注 degraded + effectiveMode", searchBody.meta.degraded && searchBody.meta.effectiveMode === "lexical", searchBody.meta);

      // 空 queries ⇒ 400
      check("POST /v1/kb/search 空 queries ⇒ 400", (await post("/v1/kb/search", { queries: [] })).status === 400);

      // 管理员建库 → 加文档 → 列表可见 → 删库（完整闭环）
      currentClaims = { sub: "probe-admin", name: "probe", role: "platform_admin", deptId: null };
      const created2 = await post("/v1/kb/datasets", {
        name: `[probe] 路由建库 ${Date.now()}`,
        scope: { kind: "all", roles: [], deptIds: [], uids: [] },
      });
      const created2Body = (await created2.json()) as { id: string };
      check("管理员建库 201", created2.status === 201, created2Body);
      created.push(Number(created2Body.id));

      const docRes = await post(`/v1/kb/datasets/${created2Body.id}/documents`, {
        name: "路由入库.md",
        content: "这是一段用于验证路由入库的中文内容，包含量子与报表两个关键词。",
      });
      const docBody = (await docRes.json()) as { segmentCount: number };
      check("管理员加文档 201 且切片入库", docRes.status === 201 && docBody.segmentCount >= 1, docBody);

      const docsRes = await get(`/v1/kb/datasets/${created2Body.id}/documents`);
      const docsBody = (await docsRes.json()) as { items: Array<{ name: string }> };
      check("文档列表读回", docsBody.items.some((d) => d.name === "路由入库.md"), docsBody.items);

      const memberRes = await post(`/v1/kb/datasets/${created2Body.id}/members`, { uid: "probe-u1", role: "writer" });
      check("加成员 200", memberRes.status === 200, memberRes.status);
      const membersRes = await get(`/v1/kb/datasets/${created2Body.id}/members`);
      const membersBody = (await membersRes.json()) as { items: Array<{ uid: string; role: string }> };
      check("成员列表读回（角色映射正确）", membersBody.items.some((m) => m.uid === "probe-u1" && m.role === "writer"), membersBody.items);

      const patchRes = await patch(`/v1/kb/datasets/${created2Body.id}`, { name: "[probe] 改名后" });
      check("改名 200", patchRes.status === 200, patchRes.status);
      check("改名生效", (await findDataset(db, Number(created2Body.id)))?.name === "[probe] 改名后");

      const delRes = await del(`/v1/kb/datasets/${created2Body.id}`);
      check("删库 200 且确实删除", delRes.status === 200 && (await findDataset(db, Number(created2Body.id))) === null);
    }
  } finally {
    // 自清理：探针写的是真实表
    for (const id of created) {
      await deleteDataset(db, id).catch(() => undefined);
    }
    const left = await db.pool
      .query<{ n: string }>("SELECT COUNT(*) AS n FROM kb_datasets WHERE created_by = 'probe'")
      .catch(() => null);
    if (left !== null && Number(left.rows[0]?.n ?? 0) > 0) {
      console.warn(`⚠ 清理后仍有 ${left.rows[0]?.n} 条 probe 数据残留（请手动核查）`);
    }
    await closeIdentityDb(db).catch(() => undefined);
  }

  console.log(failed === 0 ? "\n全部断言通过" : `\n${failed} 条断言失败`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
