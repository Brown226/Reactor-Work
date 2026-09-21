/**
 * G0 治理数据面冒烟：审计上报 → 落库 → 查询/聚合 → 策略下发。
 *
 * 覆盖：
 *   A 上报：伪造防护（请求体带 uid/deptId → 400）、超批上限、正常入库、**幂等**（重传不重复）、
 *           脏数据逐条 rejected（不拖垮整批）、**归属由令牌决定**
 *   B 查询：三角色数据范围收敛（admin 全量 / head 本部门子树 / user 仅本人）、动作过滤、分页、CSV 导出
 *   C 聚合：按模型/用户分组、token 与 cost 求和、user 视角只见自己
 *   D 策略：默认值、越权 403、写入回读一致、非法值 400
 *
 * 前置：docker compose up -d pg；server 已 build；根 .env 已配（LDAP 用于 head 的部门）。
 * 用法：node packages/server/scripts/audit-smoke.mjs
 *
 * 清理：审计表设计为**只增不改**（无删除 API），本脚本结束时按 eventId 前缀直接 SQL 清理测试数据。
 */

import { spawn } from "node:child_process";
import { useSmokeDb } from "./lib/smoke-db.mjs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 靠外部环境 */
}

/**
 * 冒烟库地址由 lib/smoke-db.mjs 的 useSmokeDb() 在 main() 开头写进 process.env，
 * 所以这里**不能在模块级捕获** —— 否则拿到的是真实库地址（2026-09-18 事故的口径）。
 */
const dbUrl = () => process.env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor";
const PORT = Number(process.env.REACTOR_AUDIT_SMOKE_PORT ?? 8809);
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = `smoke-${Date.now()}-`;
const ADMIN_PWD = process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123";
const HEAD_PWD = process.env.REACTOR_TEST_HEAD_PWD ?? "Head@123";
const USER_PWD = process.env.REACTOR_TEST_USER_PWD ?? "User@123";

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const req = async (method, path, body, token) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* CSV 等非 JSON */
  }
  return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
};

const login = (u, p) => req("POST", "/auth/login", { username: u, password: p });

/** 造一条事件（默认是带用量的 model_call） */
const ev = (n, over = {}) => ({
  eventId: `${PREFIX}${n}`,
  ts: new Date().toISOString(),
  action: "model_call",
  sessionId: `${PREFIX}sess`,
  sessionType: "code",
  outcome: "ok",
  usage: { model: "smoke-model", provider: "tokenrhythm", inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01, currency: "CNY" },
  ...over,
});

let child = null;
const createdModelIds = [];
const createdSecretIds = [];

/** 额度告警的 webhook mock：记录收到的载荷，供断言「真的外发了」 */
const webhookReceived = [];
function startWebhookMock() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        webhookReceived.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        webhookReceived.push({ type: "unparsable" });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/alert` })));
}

async function main() {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  const startedAt = new Date();
  const pool = new pg.Pool({ connectionString: dbUrl(), max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    console.log(`SKIP: PG 不可达（${dbUrl()}）: ${e.message}`);
    await pool.end().catch(() => {});
    process.exit(0);
  }

  const webhook = await startWebhookMock();

  child = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      REACTOR_IDENTITY_PORT: String(PORT),
      REACTOR_AUTH_MODE: "mixed",
      // 额度告警外发通道（mock）：证明「达阈值会真的推出去」
      REACTOR_QUOTA_WEBHOOK_URL: webhook.url,
    },
    stdio: "ignore",
  });

  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    const r = await login("admin", ADMIN_PWD).catch(() => null);
    if (r?.status === 200) ready = true;
    else await sleep(500);
  }
  if (!ready) {
    console.error("✗ identity 未就绪");
    child.kill();
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
  console.log("== G0 审计/用量冒烟 ==");

  try {
    const admin = (await login("admin", ADMIN_PWD)).json;
    const head = (await login("head", HEAD_PWD)).json;
    const user = (await login("user", USER_PWD)).json;
    check(
      "前置：三角色登录（admin/head/user）",
      Boolean(admin?.accessToken && head?.accessToken && user?.accessToken),
      `admin=${admin?.user?.role} head=${head?.user?.role} user=${user?.user?.role}`,
    );
    const AT = admin.accessToken;
    const HT = head.accessToken;
    const UT = user.accessToken;

    console.log("· A 上报");
    const spoof = await req("POST", "/desktop/audit/batch", { uid: "somebody-else", events: [ev("spoof")] }, UT);
    check("A1 请求体自带 uid 被拒（归属只认令牌）", spoof.status === 400, `${spoof.status} ${spoof.text.slice(0, 80)}`);

    const over = await req("POST", "/desktop/audit/batch", { events: Array.from({ length: 501 }, (_, i) => ev(`over-${i}`)) }, AT);
    check("A2 超过单批上限 400", over.status === 400, `status=${over.status}`);

    const batch = [ev("1"), ev("2", { action: "tool_call", toolName: "bash", durationMs: 1200, filesTouched: 2 }), ev("3", { action: "approval", approvalDecision: "deny", policyMode: "strict", outcome: "denied" })];
    const ins = await req("POST", "/desktop/audit/batch", { batchId: "b1", events: batch }, UT);
    check("A3 正常批量入库（3 条）", ins.status === 200 && ins.json?.accepted === 3, ins.text.slice(0, 120));

    const again = await req("POST", "/desktop/audit/batch", { batchId: "b1", events: batch }, UT);
    check(
      "A4 幂等：重复上报不重复入库（accepted=0 / duplicates=3）",
      again.status === 200 && again.json?.accepted === 0 && again.json?.duplicates === 3,
      JSON.stringify(again.json),
    );

    const dirty = await req(
      "POST",
      "/desktop/audit/batch",
      {
        events: [
          ev("dirty1", { summary: "x".repeat(201) }),
          ev("dirty2", { action: "not-an-action" }),
          ev("dirty3", { ts: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
          ev("4", {}),
        ],
      },
      UT,
    );
    check(
      "A5 脏数据逐条 rejected，其余照常入库",
      dirty.status === 200 && dirty.json?.rejected?.length === 3 && dirty.json?.accepted === 1,
      JSON.stringify(dirty.json),
    );

    const headIns = await req("POST", "/desktop/audit/batch", { events: [ev("head1", { usage: { model: "smoke-model", inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.002 } })] }, HT);
    check("A6 head 上报成功（归属取令牌）", headIns.status === 200 && headIns.json?.accepted === 1, headIns.text.slice(0, 80));

    const byUid = await pool.query(`SELECT uid, dept_id, dept_path FROM audit_event WHERE event_id = $1`, [`${PREFIX}head1`]);
    check(
      "A7 落库归属正确（uid=head 且有部门快照）",
      byUid.rows[0]?.uid === "head" && byUid.rows[0]?.dept_id !== null && String(byUid.rows[0]?.dept_path ?? "").includes("设计管理部"),
      JSON.stringify(byUid.rows[0]),
    );

    console.log("· B 查询与范围收敛");
    const allQ = await req("GET", `/desktop/audit?limit=100&action=model_call`, undefined, AT);
    check("B1 admin 可查全量", allQ.status === 200 && allQ.json?.total >= 2, `total=${allQ.json?.total}`);
    check("B2 按动作过滤生效", (allQ.json?.events ?? []).every((e) => e.action === "model_call"), JSON.stringify((allQ.json?.events ?? []).map((e) => e.action)));

    const userQ = await req("GET", "/desktop/audit?limit=100", undefined, UT);
    check(
      "B3 user 仅见本人（admin/head 的都不见）",
      userQ.status === 200 && (userQ.json?.events ?? []).every((e) => e.uid === "user") && (userQ.json?.events ?? []).length > 0,
      `uids=${JSON.stringify([...new Set((userQ.json?.events ?? []).map((e) => e.uid))])}`,
    );

    const headQ = await req("GET", "/desktop/audit?limit=100", undefined, HT);
    const headUids = [...new Set((headQ.json?.events ?? []).map((e) => e.uid))];
    check(
      "B4 head 仅见本部门子树（看不到 user 无部门事件）",
      headQ.status === 200 && headUids.includes("head") && !headUids.includes("user"),
      `uids=${JSON.stringify(headUids)}`,
    );

    const page = await req("GET", "/desktop/audit?limit=1&offset=0", undefined, AT);
    check("B5 分页：limit 生效而 total 不变", (page.json?.events ?? []).length === 1 && page.json?.total >= 2, `len=${(page.json?.events ?? []).length} total=${page.json?.total}`);

    // CSV 需按原始字节检查 BOM：res.text() 解码时会剥掉 BOM，用它判断会假失败
    const csvRes = await fetch(`${BASE}/desktop/audit?limit=100&format=csv`, { headers: { authorization: `Bearer ${AT}` } });
    const csvType = csvRes.headers.get("content-type") ?? "";
    const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
    const hasBom = csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf;
    const csvText = new TextDecoder().decode(csvBytes);
    check(
      "B6 CSV 导出（表头 + BOM 字节 + text/csv）",
      csvRes.status === 200 && csvType.includes("text/csv") && hasBom && csvText.includes("uid,deptPath,action"),
      `${csvType} bom=${hasBom} head=${csvText.slice(0, 30)}`,
    );

    // 报表统计（stats=1）：按动作/结果聚合过滤后的集合
    const stats = await req("GET", "/desktop/audit?limit=1&stats=1", undefined, AT);
    const byAction = stats.json?.stats?.byAction ?? [];
    const actionMap = Object.fromEntries(byAction.map((r) => [r.key, r.count]));
    check(
      "B7 stats=1 返回动作分布（模型调用/工具执行/审批计数正确）",
      stats.status === 200 && actionMap.model_call >= 1 && actionMap.tool_call >= 1 && actionMap.approval >= 1,
      JSON.stringify(byAction),
    );
    const statsFiltered = await req("GET", "/desktop/audit?limit=1&stats=1&action=tool_call", undefined, AT);
    const filteredActions = (statsFiltered.json?.stats?.byAction ?? []).map((r) => r.key);
    check(
      "B8 stats 与过滤条件联动（action=tool_call 时只剩该动作）",
      filteredActions.length === 1 && filteredActions[0] === "tool_call",
      JSON.stringify(filteredActions),
    );
    // CSV 导出不应携带 stats（只有明细）
    const csvOnly = await fetch(`${BASE}/desktop/audit?limit=1&format=csv`, {
      headers: { authorization: `Bearer ${AT}` },
    });
    const csvBody = new TextDecoder().decode(new Uint8Array(await csvOnly.arrayBuffer()));
    check("B9 CSV 只导出明细（无 stats 字段）", !csvBody.includes("byAction"), csvBody.slice(0, 60));

    console.log("· C 用量聚合");
    const byModel = await req("GET", "/desktop/usage/summary?groupBy=model&limit=100", undefined, AT);
    const modelRow = (byModel.json?.rows ?? []).find((r) => r.key === "smoke-model");
    check(
      "C1 按模型聚合：调用数与 token 求和正确",
      byModel.status === 200 && modelRow && modelRow.calls >= 2 && modelRow.totalTokens >= 160,
      JSON.stringify(modelRow),
    );
    check("C2 totals 与行数据一致（totalTokens >= 各行之和的模型行）", byModel.json?.totals?.totalTokens >= (modelRow?.totalTokens ?? 0), JSON.stringify(byModel.json?.totals));

    const byUser = await req("GET", "/desktop/usage/summary?groupBy=user", undefined, AT);
    const keys = (byUser.json?.rows ?? []).map((r) => r.key);
    check("C3 按用户聚合含 user 与 head", keys.includes("user") && keys.includes("head"), JSON.stringify(keys));

    const userSum = await req("GET", "/desktop/usage/summary?groupBy=user", undefined, UT);
    check(
      "C4 user 视角聚合仅含自己",
      (userSum.json?.rows ?? []).every((r) => r.key === "user") && (userSum.json?.rows ?? []).length === 1,
      JSON.stringify((userSum.json?.rows ?? []).map((r) => r.key)),
    );

    console.log("· D 策略下发");
    const p0 = await req("GET", "/desktop/policy", undefined, UT);
    check(
      "D1 未配置时下发默认策略（balanced + 80/100）",
      p0.status === 200 && p0.json?.policy?.defaultApprovalMode === "balanced" && JSON.stringify(p0.json?.policy?.quota?.alertThresholds) === "[80,100]",
      JSON.stringify(p0.json?.policy),
    );

    const forbid = await req("PUT", "/desktop/policy", { defaultApprovalMode: "trust" }, UT);
    check("D2 普通用户改策略 403", forbid.status === 403, `status=${forbid.status}`);

    const bad = await req("PUT", "/desktop/policy", { defaultApprovalMode: "whatever" }, AT);
    check("D3 非法 defaultApprovalMode 400", bad.status === 400, `status=${bad.status}`);

    const put = await req(
      "PUT",
      "/desktop/policy",
      { defaultApprovalMode: "readonly", commandBlacklist: ["rm -rf"], egressAllowlist: ["internal.corp"], quota: { monthlyTokenLimit: 5000000, alertThresholds: [80] } },
      AT,
    );
    check(
      "D4 写入回读一致（含操作者留痕）",
      put.status === 200 &&
        put.json?.policy?.defaultApprovalMode === "readonly" &&
        JSON.stringify(put.json?.policy?.commandBlacklist) === '["rm -rf"]' &&
        put.json?.policy?.quota?.monthlyTokenLimit === 5000000 &&
        put.json?.policy?.updatedBy === "admin",
      JSON.stringify(put.json?.policy),
    );

    // 复位为默认，避免影响其它人
    await req("PUT", "/desktop/policy", { defaultApprovalMode: "balanced", commandBlacklist: [], egressAllowlist: [], quota: { monthlyTokenLimit: null, alertThresholds: [80, 100] } }, AT);

    console.log("· E 服务端计费（四段价）");

    // 造两个模型：一个四段价齐全，一个只有输入/输出价（验证缓存价回落输入价）
    const mkModel = async (model, pricing) => {
      const { rows } = await pool.query(
        `INSERT INTO ai_models (provider_id, model, display_name, pricing)
         SELECT id, $1, $1, $2::jsonb FROM ai_providers ORDER BY id LIMIT 1
         RETURNING id`,
        [model, JSON.stringify(pricing)],
      );
      return rows[0]?.id;
    };
    const mFull = await mkModel(`${PREFIX}price-full`, { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5, cacheWritePerM: 1 });
    const mPartial = await mkModel(`${PREFIX}price-partial`, { inputPerM: 3, outputPerM: 9 });
    if (mFull) createdModelIds.push(mFull);
    if (mPartial) createdModelIds.push(mPartial);
    check("E0 前置：造两个价目模型（四段 / 仅两段）", Boolean(mFull && mPartial), `${mFull}/${mPartial}`);

    const tokens = { inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 200000, cacheWriteTokens: 10000 };
    const insE = await req(
      "POST",
      "/desktop/audit/batch",
      {
        events: [
          // 故意上报一个离谱的 cost（999）：服务端应无视它，自己按四段价算
          ev("price1", { usage: { model: `${PREFIX}price-full`, ...tokens, cost: 999, currency: "CNY" } }),
          ev("price2", { usage: { model: `${PREFIX}price-partial`, ...tokens, cost: 999 } }),
          ev("price3", { usage: { model: "no-pricing-model", ...tokens, cost: 1.23 } }),
        ],
      },
      AT,
    );
    check("E1 三条计费事件入库", insE.status === 200 && insE.json?.accepted === 3, insE.text.slice(0, 120));

    const priceRows = await pool.query(
      `SELECT event_id, cost::float8 AS cost, cost_reported::float8 AS reported, cost_source, pricing_snapshot
       FROM audit_event WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
      [[`${PREFIX}price1`, `${PREFIX}price2`, `${PREFIX}price3`]],
    );
    const rowOf = (id) => priceRows.rows.find((r) => r.event_id === `${PREFIX}${id}`);

    // 四段价齐备：(100000*2 + 50000*8 + 200000*0.5 + 10000*1)/1e6 = 0.71
    const r1 = rowOf("price1");
    check(
      "E2 四段价核算正确且无视端侧上报值（0.71，而非 999）",
      Math.abs(Number(r1?.cost) - 0.71) < 1e-9 && Number(r1?.reported) === 999 && r1?.cost_source === "server",
      JSON.stringify(r1),
    );
    check(
      "E3 记录计费快照（四段费率可事后审计）",
      r1?.pricing_snapshot &&
        r1.pricing_snapshot.inputPerM === 2 &&
        r1.pricing_snapshot.outputPerM === 8 &&
        r1.pricing_snapshot.cacheReadPerM === 0.5 &&
        r1.pricing_snapshot.cacheWritePerM === 1,
      JSON.stringify(r1?.pricing_snapshot),
    );

    // 仅两段价：缓存段回落输入价 → (100000*3 + 50000*9 + 200000*3 + 10000*3)/1e6 = 1.38
    const r2 = rowOf("price2");
    check(
      "E4 缓存价缺省回落输入价（两段价 → 1.38）",
      Math.abs(Number(r2?.cost) - 1.38) < 1e-9 && r2?.cost_source === "server",
      JSON.stringify(r2),
    );
    check(
      "E5 回落时快照里缓存价=输入价（口径可见）",
      r2?.pricing_snapshot?.cacheReadPerM === 3 && r2?.pricing_snapshot?.cacheWritePerM === 3,
      JSON.stringify(r2?.pricing_snapshot),
    );

    // 没配价目的模型：回落端侧上报值，并标记来源
    const r3 = rowOf("price3");
    check(
      "E6 无价目模型回落端侧上报值并标记 cost_source=client",
      Math.abs(Number(r3?.cost) - 1.23) < 1e-9 && r3?.cost_source === "client" && r3?.pricing_snapshot === null,
      JSON.stringify(r3),
    );

    // 聚合口径：cost 求和应包含服务端核算值
    const sumE = await req("GET", "/desktop/usage/summary?groupBy=model", undefined, AT);
    const fullRow = (sumE.json?.rows ?? []).find((r) => r.key === `${PREFIX}price-full`);
    check("E7 用量聚合采用服务端核算的 cost（模型行 = 0.71）", Boolean(fullRow) && Math.abs(fullRow.cost - 0.71) < 1e-9, JSON.stringify(fullRow));

    // 查询接口应带回 cost/costSource（供审计页展示来源）
    const qE = await req("GET", `/desktop/audit?action=model_call&limit=100`, undefined, AT);
    const evE = (qE.json?.events ?? []).find((e) => e.eventId === `${PREFIX}price1`);
    check(
      "E8 查询返回 cost 与 costSource（审计页可标注来源）",
      evE && Math.abs(evE.cost - 0.71) < 1e-9 && evE.costSource === "server" && Math.abs(evE.costReported - 999) < 1e-9,
      JSON.stringify({ cost: evE?.cost, src: evE?.costSource, reported: evE?.costReported }),
    );

    console.log("· F 管理操作审计（密钥访问留痕）");
    const adminAudit = async (filter = "") =>
      (await req("GET", `/desktop/audit?action=admin_action&limit=100${filter}`, undefined, AT)).json?.events ?? [];

    const before = await adminAudit();
    await req("GET", "/admin/secrets", undefined, AT);
    const afterList = await adminAudit();
    check(
      "F1 查看密钥列表被留痕（secrets.list）",
      // ⚠ 不能用 length 差断言：/desktop/audit 有 limit=100 上限，库里残留行多时会被截断
      //    （曾因此误红：残留 115 行 → before 已封顶 100，after 还是 100）
      Boolean(afterList[0]?.eventId) &&
        !before.some((e) => e.eventId === afterList[0].eventId) &&
        afterList[0]?.toolName === "secrets.list" &&
        afterList[0]?.uid === "admin",
      JSON.stringify(afterList[0]),
    );
    check("F1b 摘要说明值均为掩码（不含密钥值）", String(afterList[0]?.summary ?? "").includes("掩码"), String(afterList[0]?.summary));

    const plainKey = `sk-audit-${Math.random().toString(36).slice(2, 10)}`;
    const newSec = await req(
      "POST",
      "/admin/secrets",
      { name: `${PREFIX}audit-secret`, templateKey: "openai-compat", fieldValues: { baseUrl: "https://x/v1", apiKey: plainKey } },
      AT,
    );
    const secId = newSec.json?.id;
    if (secId) createdSecretIds.push(secId);
    const afterCreate = await adminAudit();
    check(
      "F2 新建密钥被留痕（secrets.create + target）",
      afterCreate[0]?.toolName === "secrets.create" && afterCreate[0]?.target === `secrets:${secId}`,
      JSON.stringify(afterCreate[0]),
    );

    await req("PATCH", `/admin/secrets/${secId}`, { fieldValues: { baseUrl: "https://x/v1", apiKey: `sk-rotated-${Math.random().toString(36).slice(2, 8)}` } }, AT);
    const afterPatch = await adminAudit();
    check(
      "F3 修改密钥值被留痕且标注「已变更」（不记录值本身）",
      afterPatch[0]?.toolName === "secrets.update" && String(afterPatch[0]?.summary ?? "").includes("已变更"),
      JSON.stringify(afterPatch[0]),
    );

    await req("DELETE", `/admin/secrets/${secId}`, undefined, AT);
    const afterDelete = await adminAudit();
    check(
      "F4 删除密钥被留痕（secrets.delete）",
      afterDelete[0]?.toolName === "secrets.delete" && String(afterDelete[0]?.target) === `secrets:${secId}`,
      JSON.stringify(afterDelete[0]),
    );

    // 连通性测试会用解密后的密钥打上游 → 也属密钥使用行为
    const provRow = (await pool.query(`SELECT id, code FROM ai_providers ORDER BY id LIMIT 1`)).rows[0];
    await req("POST", `/admin/providers/${provRow.id}/test`, { baseUrl: "http://127.0.0.1:1/v1" }, AT);
    const afterUse = await adminAudit();
    check(
      "F5 连通性测试（用解密密钥）被留痕（secrets.use）",
      afterUse[0]?.toolName === "secrets.use" && String(afterUse[0]?.target) === `providers:${provRow.code}`,
      JSON.stringify(afterUse[0]),
    );

    // 越权尝试：普通用户访问管理接口 → 403 且留痕
    const denied = await req("GET", "/admin/secrets", undefined, UT);
    const afterDenied = await adminAudit();
    check(
      "F6 越权尝试 403 且留痕（admin.denied / outcome=denied）",
      denied.status === 403 && afterDenied[0]?.toolName === "admin.denied" && afterDenied[0]?.outcome === "denied",
      `status=${denied.status} ${JSON.stringify(afterDenied[0])}`,
    );

    // 关键安全断言：任何审计摘要都不得出现密钥明文
    const leak = await pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE summary LIKE $1 OR target LIKE $1`, [`%${plainKey}%`]);
    check("F7 审计记录中不含密钥明文（全表扫）", leak.rows[0]?.n === 0, `命中 ${leak.rows[0]?.n} 条`);

    console.log("· G 额度告警（阈值触发 + 外发 + 幂等 + 不阻断）");

    // 以「本月已有用量」为基准反推一个额度，使当前正好约 50%，从而可控地跨阈值
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const base = await req(
      "GET",
      `/desktop/usage/summary?groupBy=day&from=${monthStart.toISOString()}&to=${new Date().toISOString()}`,
      undefined,
      AT,
    );
    const baseTokens = base.json?.totals?.totalTokens ?? 0;
    const limit = Math.max(1000, Math.ceil(baseTokens / 0.5) + 10); // 当前≈50%
    const setPolicy = (thresholds) =>
      req(
        "PUT",
        "/desktop/policy",
        { defaultApprovalMode: "balanced", commandBlacklist: [], egressAllowlist: [], quota: { monthlyTokenLimit: limit, alertThresholds: thresholds } },
        AT,
      );

    const g1 = await setPolicy([80]);
    check("G0 设置额度（当前约 50%）后**未**触发告警", g1.status === 200 && !g1.json?.quotaAlerts, JSON.stringify(g1.json?.quotaAlerts ?? null));

    const listAlerts = async () => (await req("GET", "/admin/quota-alerts", undefined, AT)).json;
    const gList0 = await listAlerts();
    check("G1 告警列表初始为空且带当前用量/额度", gList0?.alerts?.length === 0 && gList0?.limitTokens === limit, JSON.stringify({ n: gList0?.alerts?.length, limit: gList0?.limitTokens, pct: gList0?.percent }));

    // 冲过 80%
    const bump = Math.ceil(limit * 0.35);
    const g2 = await req(
      "POST",
      "/desktop/audit/batch",
      { events: [ev("quota1", { usage: { model: "quota-model", inputTokens: bump, outputTokens: 0, totalTokens: bump, cost: 0 } })] },
      AT,
    );
    check(
      "G2 跨过 80% 阈值 → 上报响应带出新告警（且上报本身仍成功）",
      g2.status === 200 && g2.json?.accepted === 1 && (g2.json?.quotaAlerts ?? []).length === 1 && g2.json.quotaAlerts[0].threshold === 80,
      JSON.stringify(g2.json?.quotaAlerts ?? null),
    );
    const gList1 = await listAlerts();
    check(
      "G3 告警落库并可查（含 period/percent/额度）",
      gList1?.alerts?.length === 1 && gList1.alerts[0].period === new Date().toISOString().slice(0, 7) && gList1.alerts[0].percent >= 80,
      JSON.stringify(gList1?.alerts?.[0]),
    );
    check(
      "G4 已通过 webhook 外发（notified=true，无错误）",
      gList1?.alerts?.[0]?.notified === true && gList1?.alerts?.[0]?.notifyError === null && gList1?.webhookConfigured === true,
      JSON.stringify({ notified: gList1?.alerts?.[0]?.notified, err: gList1?.alerts?.[0]?.notifyError, cfg: gList1?.webhookConfigured }),
    );

    // 幂等：再上报不应重复告警
    await req(
      "POST",
      "/desktop/audit/batch",
      { events: [ev("quota2", { usage: { model: "quota-model", inputTokens: 10, outputTokens: 0, totalTokens: 10, cost: 0 } })] },
      AT,
    );
    const gList2 = await listAlerts();
    check("G5 同一周期同一阈值只告警一次（幂等）", gList2?.alerts?.length === 1, `n=${gList2?.alerts?.length}`);

    // 加阈值 100 并冲过 → 第二条告警
    await setPolicy([80, 100]);
    const bump2 = Math.ceil(limit * 0.3);
    await req(
      "POST",
      "/desktop/audit/batch",
      { events: [ev("quota3", { usage: { model: "quota-model", inputTokens: bump2, outputTokens: 0, totalTokens: bump2, cost: 0 } })] },
      AT,
    );
    const gList3 = await listAlerts();
    const thresholds = (gList3?.alerts ?? []).map((a) => a.threshold);
    check("G6 新增 100% 阈值并冲过 → 追加一条 critical 告警", thresholds.includes(80) && thresholds.includes(100), JSON.stringify(thresholds));
    check(
      "G7 超过 100% 仍不阻断上报（只告警不阻断）",
      (await req("POST", "/desktop/audit/batch", { events: [ev("quota4", { usage: { model: "quota-model", inputTokens: 5, outputTokens: 0, totalTokens: 5, cost: 0 } })] }, AT)).status === 200,
    );

    // webhook mock 收到的载荷形状
    check(
      "G8 webhook 收到合规载荷（type/period/threshold/percent）",
      webhookReceived.length >= 2 &&
        webhookReceived.every((p) => p.type === "quota_alert" && p.period && typeof p.threshold === "number" && typeof p.percent === "number"),
      JSON.stringify(webhookReceived),
    );

    // 清理：删掉本轮的告警记录（否则会污染真实环境的用量页）
    const alertIds = (gList3?.alerts ?? []).map((a) => a.id);
    if (alertIds.length > 0) await pool.query(`DELETE FROM quota_alert WHERE id = ANY($1::int[])`, [alertIds]);
    await req("PUT", "/desktop/policy", { defaultApprovalMode: "balanced", commandBlacklist: [], egressAllowlist: [], quota: { monthlyTokenLimit: null, alertThresholds: [80, 100] } }, AT);
  } finally {
    // 审计表只增不改：测试数据在此按前缀直接清理（非 API 路径）
    const cleaned = await pool.query(`DELETE FROM audit_event WHERE event_id LIKE $1`, [`${PREFIX}%`]).catch(() => ({ rowCount: 0 }));
    console.log(`  ℹ 已清理测试事件 ${cleaned.rowCount ?? 0} 条`);
    // 管理操作审计由**服务端**生成 event_id（admin-…），不带前缀 → 按「本次运行时间窗 + action」清理
    // （口径统一在 lib/audit-cleanup.mjs，其余五个冒烟也用它，避免残留累积）
    await cleanupAdminAudit({ since: startedAt, pool });
    if (createdModelIds.length > 0) {
      const m = await pool.query(`DELETE FROM ai_models WHERE id = ANY($1::int[])`, [createdModelIds]).catch(() => ({ rowCount: 0 }));
      console.log(`  ℹ 已清理计费测试模型 ${m.rowCount ?? 0} 个`);
    }
    if (createdSecretIds.length > 0) {
      const s = await pool.query(`DELETE FROM secrets WHERE id = ANY($1::int[])`, [createdSecretIds]).catch(() => ({ rowCount: 0 }));
      console.log(`  ℹ 已清理审计测试密钥 ${s.rowCount ?? 0} 个`);
    }
    await pool.end().catch(() => undefined);
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
    webhook?.server?.close?.();
  }

  console.log(failed === 0 ? "\nAUDIT SMOKE PASS" : `\nAUDIT SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  try {
    child?.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
