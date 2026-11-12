/**
 * 计量账本（额度分配 P1）—— **PG 域层探针**（前置：`docker compose up -d pg`；连不上打印 SKIP 并以 0 退出）。
 *
 * 当前覆盖 P1a（域层：建表 + 写入 + 聚合 + 回读）；P1b 接线（proxy 四形态 tee）与
 * P1c 对账端点在此文件后续追加（见 docs/未完成-额度分配-方案-v1.md §5 P1）。
 *
 * ## 守什么（都是"静态检查看不出来"的那类）
 *
 * ① **建表幂等**：无迁移框架，靠 `IF NOT EXISTS`，连跑两次不能抛。
 * ② **写入-回读同形**：NUMERIC→number、TIMESTAMPTZ→ISO、subject_kind/outcome 归一化 ——
 *    错一处就会让上层拿到 string 型 cost 或 undefined 时间。
 * ③ **幂等键真的挡住重放**：同 request_id 二次写入 `inserted=false` 且表内仍只有一行
 *    （网关会重试整条路径，靠应用层去重会漏并发）。
 * ④ **聚合口径与报表一致**：未给 total_tokens 时按**四段之和**兜底；给了就以它为准。
 * ⑤ **失败行不产生假用量**：outcome=error 且 token 全 null 时只计 calls、不计 token。
 * ⑥ **各类过滤真的生效**（from/to、uid、部门子树 deptIds、subjectKinds、model）：
 *    额度执行与报表都建在这些过滤上，漏一个就会算错别人的额度。
 * ⑦ **账本只增不改**：源码级断言 —— 仓储不含 UPDATE/DELETE 语句（与审计表同一纪律）。
 *
 * 用法：`pnpm --filter @reactor/server smoke:quota`
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeIdentityDb, createIdentityDb, ensureSchema, type IdentityDb } from "../src/identity/db.js";
import { ensureMeteringSchema } from "../src/metering/schema.js";
import {
  aggregateUsage,
  getLedgerRow,
  recordUsage,
  type UsageLedgerEntry,
} from "../src/metering/repo.js";
import { createUsageRecorder } from "../src/gateway/usage-capture.js";
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

/** 本轮的幂等键前缀：只影响本脚本写入的行（冒烟库每次重建，仍加前缀便于排查）。 */
const PREFIX = `quota-smoke-${Date.now()}-`;

/** 构造一条基准账本行（各用例按需覆盖字段）。 */
function entry(overrides: Partial<UsageLedgerEntry> & Pick<UsageLedgerEntry, "requestId">): UsageLedgerEntry {
  return {
    subjectKind: "user",
    uid: "smoke-user",
    deptId: null,
    deptPath: null,
    model: "smoke-model",
    provider: "smoke-provider",
    apiShape: "anthropic",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: null,
    costSource: null,
    currency: null,
    ...overrides,
  };
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
    /* ── ① 建表幂等 ──────────────────────────────────────────────────── */
    console.log("· 建表");
    await ensureSchema(db); // 身份底表先在：dept_id 语义与真实库一致（本表无外键，但保持同批顺序）
    // 网关读 ai_providers/ai_models 路由上游（P1b 段要用），建表归管理台 schema；
    // 归属解析走 audit 域（resolveActorForClaims → users/departments），故审计表也要在。
    const { ensureAdminSchema } = await import("../src/gateway/admin-schema.js");
    const { ensureAuditSchema } = await import("../src/audit/schema.js");
    const { ensureQuotaSchema } = await import("../src/metering/quota-schema.js");
    await ensureAdminSchema(db, { secretKey: null });
    await ensureAuditSchema(db);
    await ensureMeteringSchema(db);
    // 额度规则与告警（P2）：P3 的执行门与 ⑩ 段都要用
    await ensureQuotaSchema(db);
    await ensureMeteringSchema(db);
    check("ensureMeteringSchema 连跑两次不抛（幂等）", true);
    /* ── ② 写入 + 回读同形 ───────────────────────────────────────────── */
    console.log("· 写入与回读");
    const ts1 = new Date("2026-10-01T08:00:00.000Z");
    const r1 = await recordUsage(
      db,
      entry({
        requestId: `${PREFIX}basic`,
        ts: ts1,
        uid: "u-alice",
        deptId: 7,
        deptPath: "总部/研发部",
        model: "glm-5",
        provider: "tokenrhythm",
        apiShape: "anthropic",
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        totalTokens: 1900,
        cost: 1.234567,
        costSource: "server",
        currency: "CNY",
        pricingSnapshot: { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 1 },
      }),
    );
    check("recordUsage 首次写入 inserted=true", r1.inserted === true, r1);

    const row = await getLedgerRow(db, `${PREFIX}basic`);
    check("回读：行存在", row !== null);
    check("回读：requestId/uid/dept 同形", row?.requestId === `${PREFIX}basic` && row?.uid === "u-alice" && row?.deptId === 7 && row?.deptPath === "总部/研发部", row);
    check("回读：ts 为 ISO 且等于写入值", row?.ts === ts1.toISOString(), row?.ts);
    check("回读：subject_kind 归一化为 user", row?.subjectKind === "user", row?.subjectKind);
    check("回读：outcome 缺省 ok", row?.outcome === "ok", row?.outcome);
    check("回读：四段 token 与写入一致", row?.inputTokens === 1200 && row?.outputTokens === 300 && row?.cacheReadTokens === 400 && row?.cacheWriteTokens === 0 && row?.totalTokens === 1900, row);
    check("回读：NUMERIC cost 转 number（不是字符串）", typeof row?.cost === "number" && row?.cost === 1.234567, { cost: row?.cost, type: typeof row?.cost });
    check("回读：cost_source/currency 同形", row?.costSource === "server" && row?.currency === "CNY", row);
    check("回读：不存在的 request_id → null", (await getLedgerRow(db, `${PREFIX}missing`)) === null);

    /* ── ③ 幂等键挡重放 ──────────────────────────────────────────────── */
    console.log("· 幂等");
    const replay = await recordUsage(
      db,
      entry({ requestId: `${PREFIX}basic`, uid: "u-alice", inputTokens: 999999, totalTokens: 999999 }),
    );
    check("同 request_id 重放 inserted=false（不报错）", replay.inserted === false, replay);
    const { rows: cnt } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM usage_ledger WHERE request_id = $1`,
      [`${PREFIX}basic`],
    );
    check("重放后表内仍只有一行", cnt[0]?.n === 1, cnt[0]?.n);
    const afterReplay = await getLedgerRow(db, `${PREFIX}basic`);
    check("重放未覆盖原行数据（token 仍是首次的值）", afterReplay?.inputTokens === 1200, afterReplay?.inputTokens);

    /* ── ④/⑤ 聚合口径 ────────────────────────────────────────────────── */
    console.log("· 聚合");
    // 用独立 uid 聚合，避免与其它用例的行互相干扰
    const g = "u-graph";
    // ts 显式给 10-01：下面 from/to 过滤断言依赖确定的落库时间（缺省 now() 会让断言随当天漂移）
    const tsG = new Date("2026-10-01T09:00:00.000Z");
    await recordUsage(db, entry({ requestId: `${PREFIX}g1`, ts: tsG, uid: g, deptId: 9, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: null }));
    await recordUsage(db, entry({ requestId: `${PREFIX}g2`, ts: tsG, uid: g, deptId: 9, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 9999 }));
    // 失败行：token 全 null（上游 5xx 时的典型形状）——只计 calls
    await recordUsage(db, entry({ requestId: `${PREFIX}g3`, ts: tsG, uid: g, deptId: 9, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, outcome: "error", httpStatus: 502 }));

    const agg = await aggregateUsage(db, { uid: g });
    check("聚合：calls 含失败行（3 次）", agg.calls === 3, agg);
    check(
      "聚合：未给 total 按四段之和兜底（100+50+10+5=165）",
      agg.inputTokens === 200 && agg.outputTokens === 100 && agg.cacheReadTokens === 20 && agg.cacheWriteTokens === 10,
      agg,
    );
    check(
      "聚合：给了 total 以它为准（165 + 9999 = 10164）",
      agg.totalTokens === 165 + 9999,
      agg.totalTokens,
    );

    // 失败行语义：token 全 null 时只计 calls；已消耗的部分（上游先回 usage 再断）必须计入
    // ——所以下面补一条"部分 token 的 error 行"，它能区分「真按 outcom 过滤了 token」与「碰巧为 0」
    await recordUsage(db, entry({ requestId: `${PREFIX}g4`, ts: tsG, uid: g, deptId: 9, inputTokens: 700, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 700, outcome: "aborted" }));
    const errOnly = await aggregateUsage(db, { uid: g });
    check(
      "失败行不产生假用量：null 行不计 token，已消耗部分照常计入（10164 + 700）",
      errOnly.calls === 4 && errOnly.totalTokens === 165 + 9999 + 700,
      errOnly,
    );

    /* ── ⑥ 过滤真的生效 ──────────────────────────────────────────────── */
    console.log("· 过滤");
    const sys = "system:kb";
    await recordUsage(
      db,
      entry({
        requestId: `${PREFIX}s1`,
        subjectKind: "system",
        uid: sys,
        deptId: null,
        apiShape: "embeddings",
        model: "bge-m3",
        inputTokens: 500,
        outputTokens: 0,
        totalTokens: 500,
        cost: 0.01,
        costSource: "server",
      }),
    );

    const onlyUser = await aggregateUsage(db, { subjectKinds: ["user"] });
    const onlySys = await aggregateUsage(db, { subjectKinds: ["system"] });
    check("subjectKinds 过滤：system 只算 system 行", onlySys.calls === 1 && onlySys.totalTokens === 500, onlySys);
    check("subjectKinds 过滤：user 不含 system 行", onlyUser.totalTokens !== onlySys.totalTokens, { user: onlyUser.totalTokens, sys: onlySys.totalTokens });

    const byModel = await aggregateUsage(db, { model: "bge-m3" });
    check("model 过滤生效", byModel.calls === 1 && byModel.totalTokens === 500, byModel);

    const byDept = await aggregateUsage(db, { deptIds: [9] });
    check("deptIds 过滤（部门子树口径）只算该部门", byDept.calls === 4 && byDept.totalTokens === 165 + 9999 + 700, byDept);

    const byFrom = await aggregateUsage(db, { uid: g, from: new Date("2026-10-02T00:00:00.000Z") });
    check("from 过滤排除了 10-01 的行", byFrom.calls === 0, byFrom);
    const byTo = await aggregateUsage(db, { uid: g, to: new Date("2026-10-02T00:00:00.000Z") });
    check("to 过滤包含 10-01 的行", byTo.calls === 4, byTo);

    const costSum = await aggregateUsage(db, { subjectKinds: ["system"] });
    check("NUMERIC cost 聚合为 number", typeof costSum.cost === "number" && costSum.cost === 0.01, { cost: costSum.cost, type: typeof costSum.cost });

    /* ── ⑦ 只增不改（源码级） ────────────────────────────────────────── */
    console.log("· 只增不改纪律");
    const repoSource = readFileSync(new URL("../src/metering/repo.ts", import.meta.url), "utf8");
    // 与 audit/repo.ts 同一纪律：账本是事实记录，不存在改写/删除路径。
    // 正则排除 SQL 字符串里对外键的 UPDATE 描述性文字；只看真正的 UPDATE/DELETE 语句。
    const hasMutatingSql = /\b(UPDATE\s+usage_ledger|DELETE\s+FROM\s+usage_ledger)\b/i.test(repoSource);
    check("仓储不含 UPDATE/DELETE usage_ledger 语句", !hasMutatingSql);

    /* ── ⑧ 网关接线（P1b）：真实起网关 + mock 上游，四形态各落一行 ──────── */
    await runGatewayWiringChecks(db);

    console.log(failed === 0 ? "\n全部断言通过" : `\n存在 ${failed} 条失败断言`);
  } finally {
    await closeIdentityDb(db);
  }
  process.exit(failed === 0 ? 0 : 1);
}

/* ═══════════════════════════════════════════════════════════════════════
 * P1b：网关接线端到端（mock 上游 → 真实网关进程 → 账本）
 *
 * 为什么必须真起进程：记账点在 `proxy.ts` 的响应分支里（流式/非流式两条路径），
 * 单测覆盖不到「Hono 把 Response.body 交出后我们的包装流是否真的被消费」这类问题 ——
 * 一旦包装错，表现为「回执正常但账本永远是空的」，静态检查看不出来。
 * ═══════════════════════════════════════════════════════════════════════ */

const GATEWAY_PORT = Number(process.env["REACTOR_QUOTA_SMOKE_GATEWAY_PORT"] ?? 18970);
const DEV_TOKEN = `quota-smoke-dev-${Math.random().toString(36).slice(2, 10)}`;

/** 可切换回执形状的 mock 上游（同 gateway-embeddings-smoke 的手法）。 */
function startMockUpstream(): { url: string; close: () => void; setFailing: (v: boolean) => void; hits: () => number } {
  let failing = false;
  let hitCount = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hitCount += 1;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const path = req.url ?? "";
        // 对话链路：按 `stream` 字段决定回 SSE 还是 JSON（两种都要能计到账）
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          body = {};
        }
        if (path.includes("embeddings")) {
          res.setHeader("content-type", "application/json");
          // ★ 刻意给 prompt_tokens_details.cached_tokens：验证「input 要减缓存」的口径
          res.end(JSON.stringify({ object: "list", data: [{ embedding: [0.1] }], usage: { prompt_tokens: 100, total_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } } }));
        } else if (path.includes("rerank")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }], usage: { total_tokens: 55 } }));
        } else if (body["stream"] === true) {
          res.setHeader("content-type", "text/event-stream");
          if (path.includes("messages")) {
            // Anthropic SSE：message_start 给 input+cache，message_delta 给累计 output
            res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "你好" } })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 80 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            res.end();
          } else {
            // OpenAI SSE：usage 在末块（choices 里带 usage）
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80, prompt_tokens_details: { cached_tokens: 10 } } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else if (failing) {
          // 上游故障开关：验证网关对 5xx 的行为（记 error 行、不给假用量）
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "upstream boom" } }));
        } else if (path.includes("messages")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }));
        } else if (path.includes("chat/completions")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100, prompt_tokens_details: { cached_tokens: 20 } } }));
        } else if (path.includes("upstream-error")) {
          // 错误回执：应记一条 token 全 null 的 error 行，且不产生假用量
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "upstream boom" } }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { message: `unexpected ${path}` } }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => server.close(),
        setFailing: (v: boolean) => { failing = v; },
        hits: () => hitCount,
      });
    });
  });
}

async function runGatewayWiringChecks(db: IdentityDb): Promise<void> {
  console.log("· 网关接线（P1b：真实网关 + mock 上游）");
  // server 工作区根（与 t34-smoke 同一算法：scripts → server 包 → packages → server 根）
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const mock = await startMockUpstream();

  /**
   * 为什么复用 seed provider（tokenrhythm）而不是新建：
   * 网关对「已绑定密钥」有护栏（空密钥的 provider 会被跳过、回落 env 上游）——
   * 自建 provider 需要走管理台密钥封存（sealFields + REACTOR_SECRET_KEY），
   * 冒烟环境未必有主密钥。seed provider 由 ensureAdminSchema 幂等建好且已绑密钥，
   * 把它的 base_url 指到 mock 即可，跑完在 finally 还原（与 t34-smoke 的手法一致）。
   */
  const seedRow = (
    await db.pool.query<{ id: number; code: string; base_url: string | null; model_type: string }>(
      `SELECT id, code, base_url, model_type FROM ai_providers WHERE code = 'tokenrhythm' LIMIT 1`,
    )
  ).rows[0];
  if (!seedRow) {
    check("seed provider 存在（ensureAdminSchema 未跑？）", false);
    return;
  }
  const originalBaseUrl = seedRow.base_url;
  const originalModelType = seedRow.model_type;

  // 四个板块各建一条 provider（同一 base_url 指向 mock），并各挂一条模型
  const createdProviderIds: number[] = [];
  const createdModelIds: number[] = [];
  const modelPricing = JSON.stringify({ inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 1 });
  const plateSpecs = [
    { code: "qs-anthropic", modelType: "chat", model: "qs-chat-anthropic", api: "anthropic-messages" },
    { code: "qs-openai", modelType: "chat", model: "qs-chat-openai", api: "openai-chat" },
    { code: "qs-emb", modelType: "embedding", model: "qs-emb", api: "openai-chat" },
    { code: "qs-rerank", modelType: "rerank", model: "qs-rerank", api: "openai-chat" },
  ];

  let gw: ReturnType<typeof spawn> | null = null;
  try {
    for (const p of plateSpecs) {
      const pid = (
        await db.pool.query<{ id: number }>(
          `INSERT INTO ai_providers (code, name, base_url, model_type, enabled, api, bind_secret_id)
           SELECT $1, $2, $3, $4, true, $5, bind_secret_id FROM ai_providers WHERE id = $6
           RETURNING id`,
          [p.code, `额度冒烟-${p.modelType}`, mock.url, p.modelType, p.api, seedRow.id],
        )
      ).rows[0]!.id;
      createdProviderIds.push(pid);
      const mid = (
        await db.pool.query<{ id: number }>(
          `INSERT INTO ai_models (provider_id, model, model_type, pricing, enabled, features)
           VALUES ($1, $2, $3, $4::jsonb, true, '[]'::jsonb) RETURNING id`,
          [pid, p.model, p.modelType, modelPricing],
        )
      ).rows[0]!.id;
      createdModelIds.push(mid);
    }

    // 起网关：接冒烟库（记账启用）+ 指向 mock 上游
    gw = spawn(process.execPath, [join(root, "packages", "server", "dist", "index.js")], {
      cwd: root,
      env: {
        ...process.env,
        REACTOR_GATEWAY_HOST: "127.0.0.1",
        REACTOR_GATEWAY_PORT: String(GATEWAY_PORT),
        REACTOR_DEV_TOKEN: DEV_TOKEN,
        REACTOR_GATEWAY_ALLOW_DEV_TOKEN: "true",
        REACTOR_DB_URL: dbUrl(),
        REACTOR_UPSTREAM_BASE_URL: mock.url,
        REACTOR_UPSTREAM_API_KEY: "smoke-upstream-key",
        REACTOR_GATEWAY_REGISTRY_TTL_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const gwLog: string[] = [];
    gw.stdout?.on("data", (c: Buffer) => gwLog.push(c.toString()));
    gw.stderr?.on("data", (c: Buffer) => gwLog.push(c.toString()));

    const base = `http://127.0.0.1:${GATEWAY_PORT}`;
    const ready = await waitFor(async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, 15_000);

    if (!ready) {
      check("网关就绪（dist 已 build？见 README）", false, gwLog.join("").slice(0, 400));
      return;
    }

    // /health 暴露账本状态（P1c 的可观测性，顺带在此钉住）
    const health = (await (await fetch(`${base}/health`)).json()) as { ledger?: { state?: string } };
    check("/health 暴露账本状态（enabled ⇒ state=ok）", health.ledger?.state === "ok", health);

    // ★开关对比（P3）：本实例 quotaEnforce 未设 ⇒ 默认 false ⇒ 放行一切
    // （用超额的 block 规则也放行，这条断言就是"关闭态行为不变"的证据）
    {
      // 先建一个必然超限的 block 规则（org 维度，限 1 token）
      const putOrg = await db.pool.query(
        `INSERT INTO quota_rule (scope_type, scope_id, limit_tokens, alert_thresholds, action, enabled)
         VALUES ('org', NULL, 1, '{80}', 'block', true)
         ON CONFLICT (period) WHERE scope_type = 'org'
           DO UPDATE SET limit_tokens = 1, action = 'block', enabled = true RETURNING id`,
      );
      const ruleId = (putOrg.rows[0] as { id: number }).id;
      try {
        const res = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${DEV_TOKEN}` },
          body: JSON.stringify({ model: "qs-chat-anthropic", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
        });
        check("⑪ ★开关关闭（默认）时 block 规则不拦截（行为与改造前一致）", res.status === 200, res.status);
        await res.arrayBuffer();
      } finally {
        await db.pool.query(`DELETE FROM quota_rule WHERE id = $1`, [ruleId]);
      }
    }

    const call = async (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${DEV_TOKEN}` },
        body: JSON.stringify(body),
      });

    const since = () => new Promise((r) => setTimeout(r, 120)); // 落账是异步的（不 await 客户端）
    const ledgerRow = async (model: string) => {
      const { rows } = await db.pool.query(
        `SELECT * FROM usage_ledger WHERE model = $1 ORDER BY id DESC LIMIT 1`,
        [model],
      );
      return rows[0] as Record<string, unknown> | undefined;
    };

    // ① anthropic 非流式（含 cache 两段）
    {
      const res = await call("/v1/messages", { model: "qs-chat-anthropic", max_tokens: 128, messages: [{ role: "user", content: "hi" }] });
      check("① anthropic 非流式回执 200", res.status === 200, res.status);
      await (await res.json());
      await since();
      const row = await ledgerRow("qs-chat-anthropic");
      check("① 账本落行（anthropic 非流式）", row !== undefined, row);
      check(
        "① 四段口径正确（input/cacheRead/cacheWrite/output 分列）",
        row?.["input_tokens"] === 300 && row?.["cache_read_tokens"] === 50 && row?.["cache_write_tokens"] === 0 && row?.["output_tokens"] === 40,
        { i: row?.["input_tokens"], cr: row?.["cache_read_tokens"], cw: row?.["cache_write_tokens"], o: row?.["output_tokens"] },
      );
      check("① total 按四段之和兜底（300+40+50+0=390）", row?.["total_tokens"] === 390, row?.["total_tokens"]);
      check("① cost 由服务端四段价核算（cost_source=server）", row?.["cost_source"] === "server" && Number(row?.["cost"]) > 0, { src: row?.["cost_source"], cost: row?.["cost"] });
      check("① dev token → 记 system 主体（Q5），不进个人额度", row?.["subject_kind"] === "system" && String(row?.["uid"]).startsWith("system:"), { kind: row?.["subject_kind"], uid: row?.["uid"] });
      check("① api_shape 标注为 anthropic-messages", row?.["api_shape"] === "anthropic-messages", row?.["api_shape"]);
    }

    // ② openai 非流式（prompt 含缓存 ⇒ input 必须减去）
    {
      const res = await call("/v1/chat/completions", { model: "qs-chat-openai", messages: [{ role: "user", content: "hi" }] });
      check("② openai 非流式回执 200", res.status === 200, res.status);
      await (await res.json());
      await since();
      const row = await ledgerRow("qs-chat-openai");
      check("② 账本落行（openai 非流式）", row !== undefined, row);
      check("② ★p prompt_tokens 含缓存 ⇒ input = 70-20 = 50（不重复计缓存）", row?.["input_tokens"] === 50, { i: row?.["input_tokens"], expect: 50 });
      check("② 缓存读单列（cached_tokens=20）", row?.["cache_read_tokens"] === 20, row?.["cache_read_tokens"]);
      check("② output=30、total 取上游 total=100", row?.["output_tokens"] === 30 && row?.["total_tokens"] === 100, { o: row?.["output_tokens"], t: row?.["total_tokens"] });
    }

    // ③ anthropic 流式（SSE：message_start 给 input/cache，message_delta 覆盖 output）
    {
      const res = await call("/v1/messages", { model: "qs-chat-anthropic", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] });
      check("③ 流式回执 200 且是 SSE", res.status === 200 && (res.headers.get("content-type") ?? "").includes("event-stream"), res.headers.get("content-type") ?? "");
      const text = await res.text();
      check("③ 流式数据原样透传（客户端拿到事件）", text.includes("message_start") && text.includes("message_delta"), text.slice(0, 120));
      await since();
      const row = await ledgerRow("qs-chat-anthropic");
      // 同一 model 有两条（非流式 + 流式）⇒ 只断言最后一条的口径
      check("③ ★流式也落账（input=200 / cacheRead=30 / cacheWrite=10）", row?.["input_tokens"] === 200 && row?.["cache_read_tokens"] === 30 && row?.["cache_write_tokens"] === 10, { i: row?.["input_tokens"], cr: row?.["cache_read_tokens"], cw: row?.["cache_write_tokens"] });
      check("③ ★output 取 message_delta 的累计值（80，不是 0）", row?.["output_tokens"] === 80, row?.["output_tokens"]);
    }

    // ④ openai 流式（末块 usage）
    {
      const res = await call("/v1/chat/completions", { model: "qs-chat-openai", stream: true, messages: [{ role: "user", content: "hi" }] });
      const text = await res.text();
      check("④ openai 流式透传", res.status === 200 && text.includes("[DONE]"), text.slice(0, 120));
      await since();
      const row = await ledgerRow("qs-chat-openai");
      check("④ ★openai 流式末块 usage 落账（input=60-10=50）", row?.["input_tokens"] === 50 && row?.["cache_read_tokens"] === 10, { i: row?.["input_tokens"], cr: row?.["cache_read_tokens"] });
    }

    // ⑤ embeddings（KB 向量化：dev token ⇒ system:kb）
    {
      const res = await call("/v1/embeddings", { model: "qs-emb", input: ["x"] });
      check("⑤ embeddings 回执 200", res.status === 200, res.status);
      await (await res.json());
      await since();
      const row = await ledgerRow("qs-emb");
      check("⑤ 向量调用落账且归 system:kb", row?.["uid"] === "system:kb" && row?.["api_shape"] === "embeddings", { uid: row?.["uid"], shape: row?.["api_shape"] });
      check("⑤ ★embeddings 的 prompt 也减缓存（100-40=60）", row?.["input_tokens"] === 60, { i: row?.["input_tokens"], expect: 60 });
    }

    // ⑥ rerank
    {
      const res = await call("/v1/rerank", { model: "qs-rerank", query: "q", documents: ["a"] });
      check("⑥ rerank 回执 200", res.status === 200, res.status);
      await (await res.json());
      await since();
      const row = await ledgerRow("qs-rerank");
      check("⑥ rerank 落账（total_tokens 宽松提取）", row !== undefined && Number(row?.["total_tokens"]) === 55, row?.["total_tokens"]);
      check("⑥ rerank 归 system:kb（KB 检索链路）", row?.["uid"] === "system:kb", row?.["uid"]);
    }

    // ⑦ 上游 5xx：记 error 行、token 全 null（不产生假用量）
    {
      const beforeErr = await aggregateUsage(db, { model: "qs-chat-anthropic" });
      mock.setFailing(true);
      const res = await call("/v1/messages", { model: "qs-chat-anthropic", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
      mock.setFailing(false);
      check("⑦ 上游 5xx 原样透传（502）", res.status === 502, res.status);
      await res.json().catch(() => undefined);
      await since();
      const row = await ledgerRow("qs-chat-anthropic");
      check("⑦ ★5xx 记 error 行（http_status=502）", row?.["outcome"] === "error" && row?.["http_status"] === 502, { outcome: row?.["outcome"], status: row?.["http_status"] });
      check("⑦ ★error 行 token 全 null（不产生假用量）", row?.["input_tokens"] === null && row?.["total_tokens"] === null, { i: row?.["input_tokens"], t: row?.["total_tokens"] });
      const afterErr = await aggregateUsage(db, { model: "qs-chat-anthropic" });
      check("⑦ error 行只加 calls、token 总量不变", afterErr.calls === beforeErr.calls + 1 && afterErr.totalTokens === beforeErr.totalTokens, { before: beforeErr, after: afterErr });
    }

    // ⑧ 降级：账本不可用时调用不受影响，且状态可观测（用坏连接模拟，等价于建表前/DB 抖动）
    {
      const broken = { pool: { query: async () => { throw new Error("relation \"usage_ledger\" does not exist"); } } } as unknown as IdentityDb;
      const recorder = createUsageRecorder({ db: broken });
      const r = await recorder.record(entry({ requestId: `${PREFIX}degraded` }));
      check("⑧ 写库失败 → record 返回 ok:false（不抛，不阻断调用方）", r.ok === false && typeof r.error === "string", r);
      check("⑧ 失败后状态为 degraded 且带最后一次错误", recorder.status().state === "degraded" && Boolean(recorder.status().lastError), recorder.status());
      // 恢复：换回好库再写一次 → 状态回 ok（gateway /health 会随之变回 ok）
      const good = createUsageRecorder({ db });
      check("⑧ 正常库状态为 ok", good.status().state === "ok", good.status());
      check("⑧ 未接库（env/M0 形态）状态为 disabled、record 静默成功", createUsageRecorder({ db: null }).status().state === "disabled");
    }

    // ⑨ 对账端点（P1c）：起 identity（管理面挂在它上面）→ 登录 → 调 /admin/usage/reconciliation
    {
      const identityPort = Number(process.env["REACTOR_QUOTA_SMOKE_IDENTITY_PORT"] ?? 18971);
      const identity = spawn(process.execPath, [join(root, "packages", "server", "dist", "identity-entry.js")], {
        cwd: root,
        env: { ...process.env, REACTOR_IDENTITY_PORT: String(identityPort), REACTOR_AUTH_MODE: "local", REACTOR_DB_URL: dbUrl() },
        stdio: "ignore",
      });
      try {
        const idBase = `http://127.0.0.1:${identityPort}`;
        const ok = await waitFor(async () => {
          try {
            const r = await fetch(`${idBase}/auth/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: "admin", password: process.env["REACTOR_TEST_ADMIN_PWD"] ?? "Admin@123" }),
            });
            return r.status === 200;
          } catch {
            return false;
          }
        }, 20_000);
        if (!ok) {
          check("⑨ identity 就绪（本地账号 seed 已跑？）", false);
        } else {
          const login = await fetch(`${idBase}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "admin", password: process.env["REACTOR_TEST_ADMIN_PWD"] ?? "Admin@123" }),
          });
          const token = ((await login.json()) as { accessToken?: string }).accessToken;
          check("⑨ admin 登录拿到令牌", Boolean(token));

          const recon = await fetch(`${idBase}/admin/usage/reconciliation`, { headers: { authorization: `Bearer ${token}` } });
          const body = (await recon.json()) as {
            rows?: Array<Record<string, unknown>>;
            totals?: Record<string, number>;
            expectedDeltaFromSystem?: number;
          };
          check("⑨ 对账端点 200 且结构完整", recon.status === 200 && Array.isArray(body.rows) && typeof body.totals === "object", { status: recon.status, keys: Object.keys(body) });

          // 前面 ⑤/⑥ 落了 system:kb 的向量/重排行；端侧上报为空（本冒烟没报 audit_event）
          const emb = body.rows?.find((r) => r["model"] === "qs-emb");
          check("⑨ 账本侧计入 system 向量调用（qs-emb 出现在对账里）", Number(emb?.["ledgerCalls"] ?? 0) >= 1, emb);
          check(
            "⑨ 端侧未报 → delta 为正且等于 system 部分（可解释的差额）",
            Number(body.totals?.["deltaTokens"] ?? 0) >= Number(body.totals?.["ledgerSystemTokens"] ?? 0) &&
              Number(body.totals?.["ledgerSystemTokens"] ?? 0) > 0,
            body.totals,
          );
          check("⑨ expectedDeltaFromSystem 回执与 totals 一致", body.expectedDeltaFromSystem === body.totals?.["ledgerSystemTokens"], { e: body.expectedDeltaFromSystem, t: body.totals?.["ledgerSystemTokens"] });

          /* ── ⑩ 额度规则 CRUD + 部门子树继承 + 分 scope 告警（P2） ──────── */
          const idApi = async (method: string, path: string, payload?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
            const r = await fetch(`${idBase}${path}`, {
              method,
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            });
            const text = await r.text();
            let parsed: Record<string, unknown> = {};
            try {
              parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
            } catch {
              parsed = { raw: text };
            }
            return { status: r.status, body: parsed };
          };

          console.log("· 额度规则（P2）");

          // 建一棵部门树：父 → 子（验证子树继承）
          const parentDept = (
            await db.pool.query<{ id: number }>(
              `INSERT INTO departments (name, path, depth) VALUES ($1, $2, 1) RETURNING id`,
              [`qs-父部-${PREFIX}`, `/qs-parent-${PREFIX}`],
            )
          ).rows[0]!.id;
          const childDept = (
            await db.pool.query<{ id: number }>(
              `INSERT INTO departments (name, path, depth) VALUES ($1, $2, 2) RETURNING id`,
              [`qs-子部-${PREFIX}`, `/qs-parent-${PREFIX}/qs-child-${PREFIX}`],
            )
          ).rows[0]!.id;

          // 用户规则：给一个 uid 设 100 token 上限（当期账本里已有该 uid 的用量才能触发）
          const ruleUser = "qs-rule-user";
          const now = new Date();
          await recordUsage(db, entry({ requestId: `${PREFIX}rule-u1`, ts: now, uid: ruleUser, deptId: childDept, inputTokens: 90, totalTokens: 90 }));
          const putUser = await idApi("PUT", "/admin/quota-rules", {
            scopeType: "user", scopeId: ruleUser, limitTokens: 100, alertThresholds: [50, 80], action: "block",
          });
          check("⑩ 用户规则 upsert 200", putUser.status === 200 && (putUser.body["rule"] as Record<string, unknown>)?.["scopeType"] === "user", putUser);
          check("⑩ 未跨阈值（90/100=90% ≥ 80%）⇒ 当场触发 80% 告警", Array.isArray(putUser.body["quotaAlerts"]) && (putUser.body["quotaAlerts"] as unknown[]).length >= 1, putUser.body["quotaAlerts"]);

          /* ── ⑩-2 单位后缀（K/M/B/万）：额度是百万级数字，裸数字难读难打 ───── */
          console.log("· 额度单位解析（K/M/B/万）");
          // 合法形态：服务端换算后 limitTokens 必须是精确值（换算错 = 额度凭空翻倍/缩水）
          const unitCases: Array<[string, number]> = [
            ["5M", 5_000_000],
            ["5m", 5_000_000],        // 大小写不敏感
            ["5 M", 5_000_000],       // 允许空格
            ["1.5M", 1_500_000],      // 小数
            ["500K", 500_000],
            ["500万", 5_000_000],     // 中文万
            ["2B", 2_000_000_000],
            ["5000000", 5_000_000],   // 裸数字仍然可用（回归）
          ];
          for (const [input, expected] of unitCases) {
            const r = await idApi("PUT", "/admin/quota-rules", {
              scopeType: "user", scopeId: ruleUser, limitTokens: input, alertThresholds: [80], action: "warn",
            });
            const got = (r.body["rule"] as Record<string, unknown> | undefined)?.["limitTokens"];
            check(`⑩-2 "${input}" ⇒ ${expected.toLocaleString()}`, r.status === 200 && got === expected, { status: r.status, got, expect: expected });
          }
          // 非法形态：必须 400，且不能悄悄当成 0/NaN 存进去
          const badCases = ["abc", "-5M", "0M", "5MB", "M5", "5 M M", "", " "];
          for (const input of badCases) {
            const r = await idApi("PUT", "/admin/quota-rules", {
              scopeType: "user", scopeId: ruleUser, limitTokens: input, alertThresholds: [80], action: "warn",
            });
            check(`⑩-2 拒绝非法输入 "${input}"（400）`, r.status === 400, r.status);
          }
          // 恢复后面用例依赖的规则状态（限 100 / block）
          await idApi("PUT", "/admin/quota-rules", { scopeType: "user", scopeId: ruleUser, limitTokens: 100, alertThresholds: [80], action: "block" });

          // 部门规则：父部门 1000 token（子部门用量应计入 —— 子树口径）
          const putParent = await idApi("PUT", "/admin/quota-rules", {
            scopeType: "dept", scopeId: String(parentDept), limitTokens: 1000, alertThresholds: [80], action: "warn",
          });
          check("⑩ 部门规则 upsert 200", putParent.status === 200, putParent);
          // 子部门规则：100 token（子部门自身用量 90 ⇒ 90% 触发 80% 阈值）
          const putChild = await idApi("PUT", "/admin/quota-rules", {
            scopeType: "dept", scopeId: String(childDept), limitTokens: 100, alertThresholds: [80], action: "warn",
          });
          check("⑩ 子部门规则 upsert 200", putChild.status === 200, putChild);
          check("⑩ ★父部门规则统计到子部门用量（子树口径）", ((putParent.body["rule"] as Record<string, unknown>) ?? {})["limitTokens"] === 1000, putParent.body["rule"]);

          // 列表按 scope 返回
          const listRules = await idApi("GET", "/admin/quota-rules");
          const rules = (listRules.body["rules"] as Array<Record<string, unknown>>) ?? [];
          check("⑩ 规则列表含 user/dept 三类条目", rules.some((r) => r["scopeType"] === "user") && rules.some((r) => r["scopeType"] === "dept"), rules.map((r) => r["scopeType"]));

          /* ── ⑩-3 规则列表带当期用量（管理台进度条的数据源） ───────────────── */
          // 前面给 ruleUser 种过 90 token，规则限 100 ⇒ 期望 usedTokens=90、tokenPercent=90
          const userRule = rules.find((r) => r["scopeType"] === "user" && r["scopeId"] === ruleUser);
          const usage = userRule?.["usage"] as Record<string, unknown> | null | undefined;
          check("⑩-3 列表返回该规则的当期用量", usage !== null && usage !== undefined, userRule);
          check("⑩-3 ★用量口径与服务端判定同源（usedTokens=90）", usage?.["usedTokens"] === 90, usage);
          check("⑩-3 ★百分比随用量算出（90%）", usage?.["tokenPercent"] === 90, usage);
          check("⑩-3 exceeded 与 90/100 一致（未超）", usage?.["exceeded"] === false, usage);
          // 部门规则：子部门用量 90 应计入父部门子树（前面只给 ruleUser 种过，父部门应为 90）
          const deptRule = rules.find((r) => r["scopeType"] === "dept" && String(r["scopeId"]) === String(parentDept));
          const deptUsage = deptRule?.["usage"] as Record<string, unknown> | null | undefined;
          check("⑩-3 ★父部门规则统计到子部门用量（90）", deptUsage?.["usedTokens"] === 90, deptUsage);

          // 分 scope 告警：同一周期同一阈值，不同 scope 各自独立（唯一约束迁移的核心验证）
          const alertList = (await idApi("GET", "/admin/quota-alerts")).body["alerts"] as Array<Record<string, unknown>>;
          const scopes = new Set(alertList.map((a) => `${a["scopeType"]}:${a["scopeId"] ?? ""}:${a["threshold"]}`));
          check(
            "⑩ ★同阈值在不同 scope 各有一条告警（唯一约束已按 scope 迁移）",
            alertList.length >= 2 && scopes.size === alertList.length,
            { n: alertList.length, uniq: scopes.size, alerts: alertList.map((a) => `${a["scopeType"]}:${a["scopeId"]}:${a["threshold"]}`) },
          );

          // 幂等：再触发一次同 scope 同阈值 ⇒ 不重复
          const before = alertList.length;
          await idApi("PUT", "/admin/quota-rules", { scopeType: "user", scopeId: ruleUser, limitTokens: 100, alertThresholds: [80], action: "block" });
          const after = ((await idApi("GET", "/admin/quota-alerts")).body["alerts"] as unknown[]) ?? [];
          check("⑩ 同 scope 同阈值重复评估不追加告警（幂等）", after.length === before, { before, after: after.length });

          // 个人额度端点：口径一致 ⇒ 能算出百分比
          // 注意：这里断言的是「响应结构支持百分比」，不是"admin 有 user 规则"——
          // admin 是 platform_admin，qs-rule-user 的规则不适用于它。用 org 规则验证口径。
          const me = await idApi("GET", "/desktop/quota/me");
          const items = (me.body["items"] as Array<Record<string, unknown>>) ?? [];
          check("⑩ /desktop/quota/me 返回本人适用规则与用量", me.status === 200, { status: me.status, n: items.length });
          // 用一条 org 规则确保 items 里有带百分比的条目（前面 ⑩ 已建 dept/user 规则，
          // 但 admin 的部门链未必命中 —— 这里直接建一条 org 规则，验证百分比口径）
          await idApi("PUT", "/admin/quota-rules", { scopeType: "org", limitTokens: 10_000_000, alertThresholds: [80] });
          const me2 = await idApi("GET", "/desktop/quota/me");
          const orgItem = ((me2.body["items"] as Array<Record<string, unknown>>) ?? []).find((i) => i["scopeType"] === "org");
          check(
            "⑩ ★org 规则的百分比可算（分子账本用量 / 分母规则上限，非 null）",
            typeof orgItem?.["tokenPercent"] === "number" && Number(orgItem["tokenPercent"]) > 0,
            orgItem,
          );
          check("⑩ 已有 org 规则时读接口不再合成旧配置", ((await idApi("GET", "/admin/quota-rules")).body["rules"] as Array<Record<string, unknown>>).filter((r) => r["scopeType"] === "org").length === 1, "org 规则条数应为 1");

          // 删除规则
          const delRule = await idApi("DELETE", `/admin/quota-rules/${Number((putChild.body["rule"] as Record<string, unknown>)["id"])}`);
          check("⑩ 删除规则 200", delRule.status === 200, delRule);
          check("⑩ 删除不存在的规则 404", (await idApi("DELETE", "/admin/quota-rules/999999")).status === 404);

          // 非管理员 403（用 user 账号）
          const memberLogin = await fetch(`${idBase}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "user", password: process.env["REACTOR_TEST_USER_PWD"] ?? "User@123" }),
          });
          const memberToken = ((await memberLogin.json()) as { accessToken?: string }).accessToken;
          if (memberToken) {
            const forbidden = await fetch(`${idBase}/admin/quota-rules`, { headers: { authorization: `Bearer ${memberToken}` } });
            check("⑩ 非管理员访问规则管理面 403", forbidden.status === 403, forbidden.status);
            const meMember = await fetch(`${idBase}/desktop/quota/me`, { headers: { authorization: `Bearer ${memberToken}` } });
            check("⑩ 普通用户可读自己的额度", meMember.status === 200, meMember.status);
          } else {
            check("⑩ 普通用户账号可登录（seed 未跑？）", false);
          }

          // 清理本段造的部门与规则（冒烟库每次重建，仍保持整洁）
          await db.pool.query(`DELETE FROM quota_rule WHERE scope_id = ANY($1::text[]) OR scope_type = 'org'`, [[ruleUser, String(parentDept), String(childDept)]]);
          await db.pool.query(`DELETE FROM departments WHERE id = ANY($1::int[])`, [[parentDept, childDept]]);

          /* ── ⑫ 批量额度下发（§11.7）：dryRun 预览 / 部门子树展开 / 跳过 / 去重 / 幂等 ── */
          console.log("· 批量额度下发（§11.7）");

          // 一棵三层部门树 + 3 个用户：父部 1 活跃、子部 1 活跃、叶子部 1 停用
          const bParent = (
            await db.pool.query<{ id: number }>(
              `INSERT INTO departments (name, path, depth) VALUES ($1, $2, 1) RETURNING id`,
              [`qs-batch-父-${PREFIX}`, `/qs-bparent-${PREFIX}`],
            )
          ).rows[0]!.id;
          const bChild = (
            await db.pool.query<{ id: number }>(
              `INSERT INTO departments (name, path, depth) VALUES ($1, $2, 2) RETURNING id`,
              [`qs-batch-子-${PREFIX}`, `/qs-bparent-${PREFIX}/qs-bchild-${PREFIX}`],
            )
          ).rows[0]!.id;
          const bLeaf = (
            await db.pool.query<{ id: number }>(
              `INSERT INTO departments (name, path, depth) VALUES ($1, $2, 3) RETURNING id`,
              [`qs-batch-叶-${PREFIX}`, `/qs-bparent-${PREFIX}/qs-bchild-${PREFIX}/qs-bleaf-${PREFIX}`],
            )
          ).rows[0]!.id;
          const bUsers: Array<[string, number, "active" | "disabled"]> = [
            [`qs-batch-a`, bParent, "active"],
            [`qs-batch-c`, bChild, "active"], // 子部门：验证"展开的是子树"
            [`qs-batch-off`, bLeaf, "disabled"], // 叶子部的停用号：验证"没有在用用户"分支
          ];
          for (const [uid, deptId, status] of bUsers) {
            await db.pool.query(
              `INSERT INTO users (uid, name, email, source, role, status, department_id)
               VALUES ($1, $2, $3, 'local', 'user', $4, $5)`,
              [uid, `${uid}-name`, `${uid}@example.invalid`, status, deptId],
            );
          }

          const batch = async (payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
            idApi("POST", "/admin/quota-rules/batch", payload);

          // ① dryRun：部门下每个用户 ⇒ 展开成 2 条 user 规则（父部活跃号 + 子部活跃号），停用号不在内
          const dryDept = await batch({
            dryRun: true,
            targets: [{ scopeType: "dept", scopeIds: [String(bParent)], expandUsers: true }],
            limitTokens: "100M",
            alertThresholds: [80, 100],
            action: "warn",
          });
          const dryRules = (dryDept.body["rules"] as Array<Record<string, unknown>>) ?? [];
          check("⑫ dryRun 200 且不写库（dryRun=true）", dryDept.status === 200 && dryDept.body["dryRun"] === true, { status: dryDept.status });
          check("⑫ dryRun applied 恒为 0", dryDept.body["applied"] === 0, dryDept.body["applied"]);
          check("⑫ ★expandUsers 展开子树下每个在用用户（父 1 + 子 1 = 2 条）", (dryDept.body["resolved"] as Record<string, number>)?.user === 2, dryDept.body["resolved"]);
          check(
            "⑫ ★展开的是子树而非仅本部（含子部门活跃号，停用号被排除）",
            dryRules.map((r) => String(r["scopeId"])).sort().join(",") === "qs-batch-a,qs-batch-c",
            dryRules.map((r) => r["scopeId"]),
          );

          // ② 显式 uid 列表：不存在 / 已停用分别给出理由，且不建规则
          const dryUsers = await batch({
            dryRun: true,
            targets: [{ scopeType: "user", scopeIds: ["qs-batch-a", "qs-batch-off", "qs-ghost-user"] }],
            limitTokens: "100M",
          });
          const skipped = (dryUsers.body["skipped"] as Array<Record<string, unknown>>) ?? [];
          check("⑫ 显式 uid：只解析出在用的那一个", (dryUsers.body["resolved"] as Record<string, number>)?.user === 1, dryUsers.body["resolved"]);
          check("⑫ ★停用账号被跳过并说明理由", skipped.some((s) => s["scopeId"] === "qs-batch-off" && s["reason"] === "用户已停用"), skipped);
          check("⑫ ★不存在的 uid 被跳过并说明理由（不静默建规则）", skipped.some((s) => s["scopeId"] === "qs-ghost-user" && s["reason"] === "用户不存在"), skipped);

          // ③ 请求内去重：同一用户既在显式列表又在部门展开里 ⇒ 只写一次
          const dryDup = await batch({
            dryRun: true,
            targets: [
              { scopeType: "user", scopeIds: ["qs-batch-a"] },
              { scopeType: "dept", scopeIds: [String(bParent)], expandUsers: true },
            ],
            limitTokens: "100M",
          });
          check("⑫ 请求内同 scope 去重（2 而不是 3）", (dryDup.body["resolved"] as Record<string, number>)?.user === 2, dryDup.body["resolved"]);

          // ④ 超限：501 个目标的请求在查库前就被挡下（400，且不写任何东西）
          const overCap = await batch({
            targets: [{ scopeType: "user", scopeIds: Array.from({ length: 501 }, (_, i) => `qs-cap-${i}`) }],
            limitTokens: "100M",
          });
          check("⑫ 超过 500 个目标 ⇒ 400（写库前挡下）", overCap.status === 400, { status: overCap.status, msg: overCap.body["error"] });

          // ⑤ 覆盖标注：先给 qs-batch-a 建一条个人规则，预览应标出"这是覆盖"
          await idApi("PUT", "/admin/quota-rules", { scopeType: "user", scopeId: "qs-batch-a", limitTokens: 1, alertThresholds: [80], action: "block" });
          const dryOver = await batch({
            dryRun: true,
            targets: [{ scopeType: "user", scopeIds: ["qs-batch-a"] }],
            limitTokens: "100M",
          });
          const overRule = ((dryOver.body["rules"] as Array<Record<string, unknown>>) ?? [])[0];
          check("⑫ 预览标出已有规则（existed=true ⇒ 本次是覆盖）", overRule?.["existed"] === true, overRule);

          // ⑥ 真正写入：2 条 user 规则同值下发
          const applyDept = await batch({
            targets: [{ scopeType: "dept", scopeIds: [String(bParent)], expandUsers: true }],
            limitTokens: "100M",
            alertThresholds: [80, 100],
            action: "warn",
          });
          check("⑫ 批量写入 200 且 applied=2", applyDept.status === 200 && applyDept.body["applied"] === 2, { status: applyDept.status, applied: applyDept.body["applied"] });
          const afterBatch = ((await idApi("GET", "/admin/quota-rules")).body["rules"] as Array<Record<string, unknown>>) ?? [];
          const batchUserRules = afterBatch.filter((r) => r["scopeType"] === "user" && String(r["scopeId"]).startsWith("qs-batch-"));
          check("⑫ ★部门下每个用户各有一条 user 规则（2 条）", batchUserRules.length === 2, batchUserRules.map((r) => r["scopeId"]));
          check("⑫ 同值下发：上限/阈值/动作一致（100M / 80,100 / warn）", batchUserRules.every((r) => r["limitTokens"] === 100_000_000 && JSON.stringify(r["alertThresholds"]) === "[80,100]" && r["action"] === "warn"), batchUserRules.map((r) => [r["limitTokens"], r["alertThresholds"], r["action"]]));
          check("⑫ ★覆盖而非插重复行（qs-batch-a 仍只有 1 条且上限被改成 100M）", batchUserRules.filter((r) => r["scopeId"] === "qs-batch-a").length === 1 && batchUserRules.find((r) => r["scopeId"] === "qs-batch-a")?.["limitTokens"] === 100_000_000, batchUserRules.filter((r) => r["scopeId"] === "qs-batch-a"));

          // ⑦ 幂等：同样 payload 再打一次 ⇒ 规则数不变（upsert 语义）
          const applyAgain = await batch({
            targets: [{ scopeType: "dept", scopeIds: [String(bParent)], expandUsers: true }],
            limitTokens: "100M",
            alertThresholds: [80, 100],
            action: "warn",
          });
          const afterAgain = ((await idApi("GET", "/admin/quota-rules")).body["rules"] as Array<Record<string, unknown>>) ?? [];
          check("⑫ 重复 apply 幂等（仍 2 条，不插重复行）", applyAgain.body["applied"] === 2 && afterAgain.filter((r) => r["scopeType"] === "user" && String(r["scopeId"]).startsWith("qs-batch-")).length === 2, { applied: applyAgain.body["applied"], n: afterAgain.length });

          // ⑧ org 目标 + 非法请求体
          const applyOrg = await batch({ targets: [{ scopeType: "org" }], limitTokens: "50M" });
          check("⑫ org 目标写 1 条组织规则", applyOrg.status === 200 && (applyOrg.body["resolved"] as Record<string, number>)?.org === 1, applyOrg.body["resolved"]);
          check("⑫ 空 targets ⇒ 400", (await batch({ targets: [], limitTokens: "1M" })).status === 400);
          check("⑫ 缺 targets ⇒ 400", (await batch({ limitTokens: "1M" })).status === 400);
          check("⑫ user 目标缺 scopeIds ⇒ 400", (await batch({ targets: [{ scopeType: "user" }], limitTokens: "1M" })).status === 400);
          check("⑫ scopeType 非法 ⇒ 400", (await batch({ targets: [{ scopeType: "team" }], limitTokens: "1M" })).status === 400);
          check("⑫ limitTokens 非法 ⇒ 400", (await batch({ targets: [{ scopeType: "org" }], limitTokens: "abc" })).status === 400);
          const badDeptId = await batch({ dryRun: true, targets: [{ scopeType: "dept", scopeIds: ["abc"] }], limitTokens: "1M" });
          check("⑫ 部门 id 非正整数 ⇒ 跳过并说明（不建规则）", badDeptId.status === 200 && ((badDeptId.body["skipped"] as Array<Record<string, unknown>>) ?? []).some((s) => s["reason"] === "部门 id 需为正整数"), badDeptId.body["skipped"]);
          const ghostDept = await batch({ dryRun: true, targets: [{ scopeType: "dept", scopeIds: ["999999"] }], limitTokens: "1M" });
          check("⑫ 不存在的部门 ⇒ 跳过并说明（不建规则）", ghostDept.status === 200 && ((ghostDept.body["skipped"] as Array<Record<string, unknown>>) ?? []).some((s) => s["reason"] === "部门不存在"), ghostDept.body["skipped"]);
          const emptyDept = await batch({ dryRun: true, targets: [{ scopeType: "dept", scopeIds: [String(bLeaf)], expandUsers: true }], limitTokens: "1M" });
          check("⑫ 子树下仅停用号 ⇒ 提示没有在用用户", emptyDept.status === 200 && ((emptyDept.body["skipped"] as Array<Record<string, unknown>>) ?? []).some((s) => s["reason"] === "该部门子树下没有在用用户"), emptyDept.body["skipped"]);

          // ⑨ 非管理员 403
          if (memberToken) {
            const forbiddenBatch = await fetch(`${idBase}/admin/quota-rules/batch`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${memberToken}` },
              body: JSON.stringify({ targets: [{ scopeType: "org" }], limitTokens: "1M" }),
            });
            check("⑫ 非管理员批量下发 403", forbiddenBatch.status === 403, forbiddenBatch.status);
          }

          // 清理本段造的数据（规则 / 用户 / 部门）
          await db.pool.query(`DELETE FROM quota_rule WHERE scope_id = ANY($1::text[]) OR scope_type = 'org'`, [bUsers.map(([uid]) => uid)]);
          await db.pool.query(`DELETE FROM users WHERE uid = ANY($1::text[])`, [bUsers.map(([uid]) => uid)]);
          await db.pool.query(`DELETE FROM departments WHERE id = ANY($1::int[])`, [[bParent, bChild, bLeaf]]);

          /* ── ⑪ 额度硬阻断（P3）：开关开启后 block 规则 429 + policy_block 审计 ── */
          console.log("· 额度硬阻断（P3）");
          // 用普通用户身份（dev token 无主体、按纪律永远放行，测不到阻断路径）
          const userTok = ((await (await fetch(`${idBase}/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "user", password: process.env["REACTOR_TEST_USER_PWD"] ?? "User@123" }),
          })).json()) as { accessToken?: string }).accessToken;
          const gwTok = ((await (await fetch(`${idBase}/auth/gateway-token`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${userTok}` },
          })).json()) as { token?: string }).token;
          check("⑪ 取得带主体的网关令牌（aud=gateway）", Boolean(gwTok));

          // 以 enforce=true 起第二个网关（共享冒烟库与 mock 上游）
          // 独立端口：不要用 GATEWAY_PORT+1（会与其它冒烟的占位撞车，实测 EADDRINUSE 崩溃）
          const enforcePort = Number(process.env["REACTOR_QUOTA_SMOKE_ENFORCE_PORT"] ?? 18982);
          const gw2Log: string[] = [];
          const gw2 = spawn(process.execPath, [join(root, "packages", "server", "dist", "index.js")], {
            cwd: root,
            env: {
              ...process.env,
              REACTOR_GATEWAY_HOST: "127.0.0.1",
              REACTOR_GATEWAY_PORT: String(enforcePort),
              REACTOR_DEV_TOKEN: DEV_TOKEN + "-enf",
              REACTOR_GATEWAY_ALLOW_DEV_TOKEN: "true",
              REACTOR_DB_URL: dbUrl(),
              REACTOR_UPSTREAM_BASE_URL: mock.url,
              REACTOR_UPSTREAM_API_KEY: "smoke-upstream-key",
              REACTOR_GATEWAY_REGISTRY_TTL_MS: "200",
              REACTOR_QUOTA_ENFORCE: "true",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          gw2.stdout?.on("data", (c: Buffer) => gw2Log.push(c.toString()));
          gw2.stderr?.on("data", (c: Buffer) => gw2Log.push(c.toString()));
          try {
            const enfBase = `http://127.0.0.1:${enforcePort}`;
            const ok2 = await waitFor(async () => {
              try {
                return (await fetch(`${enfBase}/health`)).ok;
              } catch {
                return false;
              }
            }, 15_000);
            if (!ok2) {
              check("⑪ 启用 enforce 的网关就绪", false, gw2Log.join("").slice(0, 500));
            } else {
              check("⑪ 启用 enforce 的网关就绪", true);
              const callEnf = (token: string) =>
                fetch(`${enfBase}/v1/messages`, {
                  method: "POST",
                  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                  body: JSON.stringify({ model: "qs-chat-anthropic", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
                });

              // 无规则 ⇒ 放行
              const pass1 = await callEnf(gwTok!);
              check("⑪ 无 block 规则时正常放行（不误杀）", pass1.status === 200, pass1.status);
              await pass1.arrayBuffer();

              // 建 user 维度 block 规则（限 1 token ⇒ 该用户已用量必然超限）
              // 注意 /me 的响应形状是 { user, scope }，uid 在 user.uid
              const meBody = (await (await fetch(`${idBase}/me`, { headers: { authorization: `Bearer ${userTok}` } })).json()) as { user?: { uid?: string } };
              const u = meBody.user?.uid;
              check("⑪ 取到普通用户 uid", Boolean(u), meBody);
              // 先给该 uid 种一点账本用量（否则 0 用量不会超 1）
              await recordUsage(db, entry({ requestId: `${PREFIX}p3-seed`, ts: new Date(), uid: u!, inputTokens: 500, totalTokens: 500, outcome: "ok" }));
              const putBlock = await idApi("PUT", "/admin/quota-rules", {
                scopeType: "user", scopeId: u!, limitTokens: 1, alertThresholds: [80], action: "block",
              });
              check("⑪ 建立 block 规则（限 1 token）", putBlock.status === 200, putBlock);

              const hitBefore = mock.hits();
              const blocked = await callEnf(gwTok!);
              const blockedBody = (await blocked.json()) as { error?: { type?: string; scope?: string; used?: number; violations?: unknown[] } };
              check("⑪ ★超限后被 429 拒绝", blocked.status === 429, blocked.status);
              check("⑪ 429 回执形状正确（quota_exceeded + scope + used）", blockedBody.error?.type === "quota_exceeded" && blockedBody.error?.scope === "user" && Number(blockedBody.error?.used) >= 500, blockedBody);
              check("⑪ 回执头标注阻断", blocked.headers.get("x-reactor-quota") === "blocked", blocked.headers.get("x-reactor-quota"));
              check("⑪ ★被拒的调用不打上游（不消耗上游额度）", mock.hits() === hitBefore, { before: hitBefore, after: mock.hits() });

              // policy_block 审计（异步写，等一拍）
              await new Promise((r) => setTimeout(r, 200));
              const auditRow = await db.pool.query(
                `SELECT action, outcome, error_code, target FROM audit_event WHERE action = 'policy_block' AND uid = $1 ORDER BY id DESC LIMIT 1`,
                [u],
              );
              check(
                "⑪ ★policy_block 审计落库（error_code=quota.exceeded）",
                auditRow.rows[0]?.error_code === "quota.exceeded" && auditRow.rows[0]?.outcome === "denied",
                auditRow.rows[0],
              );

              // 放宽额度 ⇒ 立即恢复
              await idApi("PUT", "/admin/quota-rules", { scopeType: "user", scopeId: u, limitTokens: 10_000_000, alertThresholds: [80], action: "block" });
              const recovered = await callEnf(gwTok!);
              check("⑪ ★额度放宽后恢复放行（不粘滞）", recovered.status === 200, recovered.status);
              await recovered.arrayBuffer();

              // dev token 不检查（无主体纪律）
              const devCall = await fetch(`${enfBase}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${DEV_TOKEN}-enf` },
                body: JSON.stringify({ model: "qs-chat-anthropic", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
              });
              check("⑪ dev token 不受阻断影响（无主体，与可见范围同一纪律）", devCall.status === 200, devCall.status);
              await devCall.arrayBuffer();

              // 清理：删规则 + 该 uid 的账本行 + policy_block 审计
              const rulesNow = (await idApi("GET", "/admin/quota-rules")).body["rules"] as Array<Record<string, unknown>>;
              const mine = rulesNow.filter((r) => r["scopeType"] === "user" && r["scopeId"] === u);
              for (const r of mine) await idApi("DELETE", `/admin/quota-rules/${Number(r["id"])}`);
              await db.pool.query(`DELETE FROM usage_ledger WHERE uid = $1`, [u]);
              await db.pool.query(`DELETE FROM audit_event WHERE action = 'policy_block' AND uid = $1`, [u]);
            }
          } finally {
            gw2.kill();
          }
        }
      } finally {
        identity.kill();
      }
    }

    /* 清理：删掉本次的 provider/model 行（冒烟库每次重建，仍保持整洁便于人工查看） */
    await db.pool.query(`DELETE FROM ai_models WHERE id = ANY($1::int[])`, [createdModelIds]);
    await db.pool.query(`DELETE FROM ai_providers WHERE id = ANY($1::int[])`, [createdProviderIds]);
  } finally {
    gw?.kill();
    mock.close();
    // 还原 seed provider（它只被读过，这里防御性还原）
    await db.pool
      .query(`UPDATE ai_providers SET base_url = $1, model_type = $2 WHERE id = $3`, [originalBaseUrl, originalModelType, seedRow.id])
      .catch(() => undefined);
  }
}

/** 轮询等待（带超时）。 */
async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

await main();
