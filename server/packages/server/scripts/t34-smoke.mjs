/**
 * T3-4 冒烟：管理台配置「真正生效」+ 密钥落盘安全。
 *
 *   A) 密钥落盘（T3-4 安全项）
 *     A1 seed 密钥非空且已加密（enc:v1:）——历史空密钥自愈 + 就地加密
 *     A2 GET /admin/secrets 只返回掩码，响应体不含明文密钥
 *     A3 POST 新建密钥 → 库里是密文，用 dist 的解密函数能还原原文
 *     A4 PATCH 回传掩码 → 密文不变（防掩码覆盖真密钥）
 *     A5 PATCH 新值 → 密文变化且解密为新值
 *     A2x 密钥模板写端点（管理端移植）：CRUD / 启停 / 校验 400 / 被引用删除 409
 *
 *   B) 配置生效（T3-4 主功能）
 *     B1 网关以库为准：env 配的是「诱饵上游」，实际请求必须打到库里那个 provider
 *     B2 密钥解密链路：mock 上游收到的 x-api-key 是明文（库里存的是密文）
 *     B3 热生效：改 provider.baseUrl 后**不重启网关**，请求改打新上游
 *     B4 目录跟随：/v1/models 也打当前 provider
 *     B5 空密钥护栏：绑定的密钥被置空 → 回退 env 上游，绝不用空密钥打上游
 *     B6 库不可达护栏：网关仍可服务（回退 env）
 *
 *   C) 模型目录参与路由（T3-4b）
 *     C1/C2 按请求 model 选 provider（两个 provider 各挂一个模型，各自打自己的上游）
 *     C3 未知模型 → 404 model_not_found + 可用模型清单（且不打上游）
 *     C4 /v1/models 以库为准（价目/窗口/能力来自 ai_models，不打上游）
 *     C5 改模型归属 provider → 不重启即改道
 *     C6 agents 的 provider/modelId 引用校验（目录已配置时生效）
 *
 * 前置：docker compose up -d pg；server 已 build；根 .env 含 REACTOR_DB_URL / REACTOR_SECRET_KEY。
 * 用法：node packages/server/scripts/t34-smoke.mjs（仓库根执行）
 */

import { spawn } from "node:child_process";
import { useSmokeDb } from "./lib/smoke-db.mjs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";

// 显式按脚本位置加载仓库根 .env（不依赖 cwd，避免「在 packages/server 下跑就读不到 .env」的老坑）
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 无 .env 时靠外部环境变量 */
}

const { openSecret, isSealed, loadSecretKey, SECRET_MASK } = await import(
  new URL("../dist/common/secrets-crypto.js", import.meta.url).href
);

const SECRET_KEY = loadSecretKey();
/**
 * 冒烟库地址由 lib/smoke-db.mjs 的 useSmokeDb() 在 main() 开头写进 process.env，
 * 所以这里**不能在模块级捕获** —— 否则拿到的是真实库地址（2026-09-18 事故的口径）。
 */
const dbUrl = () => process.env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor";
const IDENTITY_PORT = Number(process.env.REACTOR_T34_IDENTITY_PORT ?? 8805);
const GATEWAY_PORT = Number(process.env.REACTOR_T34_GATEWAY_PORT ?? 18960);
const IDENTITY_BASE = `http://127.0.0.1:${IDENTITY_PORT}`;
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
const TTL_MS = 500;
const DEV_TOKEN = `t34-dev-${Math.random().toString(36).slice(2, 10)}`;
const ADMIN_PWD = process.env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123";
const SEED_SECRET_NAME = "TokenRhythm 默认密钥";
const SEED_PROVIDER_CODE = "tokenrhythm";

// 本次运行起点：用于收尾时按时间窗清理服务端自记的 admin_action 审计行（见 lib/audit-cleanup.mjs）
const STARTED_AT = new Date();

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 mock 上游：记录命中的请求（路径 + 透传上来的密钥）。 */
function makeMock(name) {
  const state = { name, hits: [], headers: [], bodies: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.hits.push(req.method + " " + req.url);
      state.bodies.push(Buffer.concat(chunks).toString("utf8"));
      state.headers.push({
        "x-api-key": req.headers["x-api-key"] ?? null,
        authorization: req.headers.authorization ?? null,
      });
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/models")) {
        res.end(JSON.stringify({ object: "list", data: [{ id: "smoke-model", context_length: 1024 }] }));
      } else {
        res.end(JSON.stringify({ id: "msg_mock", type: "message", content: [{ type: "text", text: `mock:${name}` }] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ state, url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

async function req(base, method, path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
}

async function waitReady(url, predicate, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await predicate()) return true;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return false;
}

const children = [];
function cleanupChildren() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  // ★ 必须最先执行：切到独立冒烟库（每次重建），真实库不受影响（见 lib/smoke-db.mjs 头注）
  await useSmokeDb();
  const pool = new pg.Pool({ connectionString: dbUrl(), max: 2, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    console.log(`SKIP: PG 不可达（${dbUrl()}）: ${e.message}`);
    await pool.end().catch(() => {});
    process.exit(0);
  }
  if (!SECRET_KEY) {
    console.log("SKIP: 未配置 REACTOR_SECRET_KEY（密钥加密项需要主密钥）");
    await pool.end().catch(() => {});
    process.exit(0);
  }

  const mockEnv = await makeMock("env-decoy");
  const mockA = await makeMock("admin-A");
  const mockB = await makeMock("admin-B");

  // 起身份服务（local 模式，免 LDAP）
  const identity = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "identity-entry.js")], {
    cwd: ROOT,
    env: { ...process.env, REACTOR_IDENTITY_PORT: String(IDENTITY_PORT), REACTOR_AUTH_MODE: "local" },
    stdio: "ignore",
  });
  children.push(identity);

  const login = () => req(IDENTITY_BASE, "POST", "/auth/login", { username: "admin", password: ADMIN_PWD });
  if (!(await waitReady(IDENTITY_BASE, async () => (await login()).status === 200))) {
    console.error("✗ identity 未就绪");
    cleanupChildren();
    process.exit(1);
  }

  // 起网关：env 指诱饵上游，db 指真实库 → 谁生效一目了然
  const gateway = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      REACTOR_GATEWAY_HOST: "127.0.0.1",
      REACTOR_GATEWAY_PORT: String(GATEWAY_PORT),
      REACTOR_DEV_TOKEN: DEV_TOKEN,
      REACTOR_DB_URL: dbUrl(),
      REACTOR_UPSTREAM_BASE_URL: mockEnv.url,
      REACTOR_UPSTREAM_API_KEY: "env-decoy-key",
      REACTOR_GATEWAY_REGISTRY_TTL_MS: String(TTL_MS),
    },
    stdio: "ignore",
  });
  children.push(gateway);
  if (!(await waitReady(GATEWAY_BASE, async () => (await fetch(`${GATEWAY_BASE}/health`)).ok))) {
    console.error("✗ gateway 未就绪");
    cleanupChildren();
    process.exit(1);
  }

  const adminTok = (await login()).json?.accessToken;
  const createdSecretIds = [];
  const createdProviderIds = [];
  const createdModelIds = [];
  const createdAgentIds = [];
  let seedProviderId = null;
  let seedProviderWasEnabled = null;
  let smokeProviderId = null;

  try {
    console.log("== T3-4 冒烟 ==");
    console.log("· A) 密钥落盘安全");

    // A1 seed 密钥：非空 + 密文
    const seedRow = (
      await pool.query(`SELECT id, field_values FROM secrets WHERE name = $1 LIMIT 1`, [SEED_SECRET_NAME])
    ).rows[0];
    const seedKey = seedRow?.field_values?.apiKey ?? "";
    check(
      "A1 seed 密钥已自愈非空且加密落盘（enc:v1:）",
      Boolean(seedKey) && isSealed(seedKey),
      `len=${String(seedKey).length} sealed=${isSealed(seedKey)}`,
    );
    check("A1b seed 密钥可解密", (() => {
      try {
        return openSecret(seedKey, SECRET_KEY).length > 0;
      } catch {
        return false;
      }
    })());

    // A2 读取接口只给掩码
    const listed = await req(IDENTITY_BASE, "GET", "/admin/secrets", undefined, adminTok);
    const listedSeed = (listed.json?.secrets ?? []).find((s) => s.name === SEED_SECRET_NAME);
    check("A2 GET /admin/secrets 敏感字段为掩码", listedSeed?.fieldValues?.apiKey === SECRET_MASK, JSON.stringify(listedSeed?.fieldValues));
    const plainSeedKey = openSecret(seedKey, SECRET_KEY);
    check("A2b 列表响应体不含明文密钥（也不含密文）", !listed.text.includes(plainSeedKey) && !listed.text.includes("enc:v1:"));

    // A3 新建 → 密文入库 + 可解密
    const plainNew = `sk-t34-plain-${Math.random().toString(36).slice(2, 8)}`;
    const created = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/secrets",
      { name: "smoke-t34-secret", templateKey: "openai-compat", fieldValues: { baseUrl: mockA.url, apiKey: plainNew } },
      adminTok,
    );
    check("A3 新建密钥 201", created.status === 201, created.text);
    const smokeSecretId = created.json?.id;
    if (smokeSecretId) createdSecretIds.push(smokeSecretId);
    const storedNew = (await pool.query(`SELECT field_values FROM secrets WHERE id = $1`, [smokeSecretId])).rows[0]?.field_values ?? {};
    check(
      "A3b 库内为密文且非明文",
      isSealed(storedNew.apiKey) && storedNew.apiKey !== plainNew,
      `sealed=${isSealed(storedNew.apiKey)}`,
    );
    check("A3c 密文可解密回原文", openSecret(storedNew.apiKey, SECRET_KEY) === plainNew);

    // A4 掩码回写不覆盖
    const patchMask = await req(
      IDENTITY_BASE,
      "PATCH",
      `/admin/secrets/${smokeSecretId}`,
      { fieldValues: { baseUrl: "https://changed-by-mask-test/v1", apiKey: SECRET_MASK } },
      adminTok,
    );
    const afterMask = (await pool.query(`SELECT field_values FROM secrets WHERE id = $1`, [smokeSecretId])).rows[0]?.field_values ?? {};
    check(
      "A4 回传掩码：密钥密文不变、其余字段照常更新",
      patchMask.status === 200 &&
        afterMask.apiKey === storedNew.apiKey &&
        afterMask.baseUrl === "https://changed-by-mask-test/v1",
      `sameCipher=${afterMask.apiKey === storedNew.apiKey} baseUrl=${afterMask.baseUrl}`,
    );

    // A5 轮换新值
    const plainRotated = `sk-t34-rotated-${Math.random().toString(36).slice(2, 8)}`;
    await req(
      IDENTITY_BASE,
      "PATCH",
      `/admin/secrets/${smokeSecretId}`,
      { fieldValues: { baseUrl: mockA.url, apiKey: plainRotated } },
      adminTok,
    );
    const afterRotate = (await pool.query(`SELECT field_values FROM secrets WHERE id = $1`, [smokeSecretId])).rows[0]?.field_values ?? {};
    check(
      "A5 轮换新值：密文变化且解密为新值",
      afterRotate.apiKey !== storedNew.apiKey && openSecret(afterRotate.apiKey, SECRET_KEY) === plainRotated,
    );

    /*
     * A2) 密钥模板**已下线**（2026-09-19 用户口径：不需要针对密钥做单独的管理界面；
     *     模板概念一并取消，密钥改在供应商配置里直接填）。
     *
     * 这一节原本有 8 条断言在测模板的增删改启停与引用保护。端点删除后，
     * 与其把这些断言删掉了事，不如**反过来钉住「它们确实不在了」** ——
     * 这样将来谁把端点加回来（比如从上游又同步了一次），门禁会立刻发现。
     */
    console.log("· A2) 密钥模板已下线（端点必须 404，防被同步回来）");
    {
      const goneList = await req(IDENTITY_BASE, "GET", "/admin/secret-templates", undefined, adminTok);
      check("A2-1 GET /admin/secret-templates 已下线（404）", goneList.status === 404, `status=${goneList.status}`);
      const goneCreate = await req(
        IDENTITY_BASE,
        "POST",
        "/admin/secret-templates",
        { name: "x", fields: [{ key: "k", label: "k" }] },
        adminTok,
      );
      check("A2-2 POST /admin/secret-templates 已下线（404）", goneCreate.status === 404, `status=${goneCreate.status}`);
      const gonePatch = await req(IDENTITY_BASE, "PATCH", "/admin/secret-templates/openai-compat", { name: "x" }, adminTok);
      check("A2-3 PATCH /admin/secret-templates 已下线（404）", gonePatch.status === 404, `status=${gonePatch.status}`);
      const goneDel = await req(IDENTITY_BASE, "DELETE", "/admin/secret-templates/openai-compat", undefined, adminTok);
      check("A2-4 DELETE /admin/secret-templates 已下线（404）", goneDel.status === 404, `status=${goneDel.status}`);

      /*
       * A2-5：供应商 **直填 API Key** 的端到端（替代原来「先建密钥再绑定」的两步操作）。
       * 这是新交互的核心路径：填一个 Key → 服务端加密落库 → 网关能解出来用。
       */
      const directKey = `sk-direct-${Math.random().toString(36).slice(2, 8)}`;
      /*
       * `enabled: false` 是关键：本段只验证**存储与回显**，不需要它参与路由。
       * 供应商一旦启用会被网关注册表收进去（WHERE p.enabled），
       * 而它指向 mockA —— 会把后面 B 段“请求该打哪个上游”的断言全部带偏
       *（第一版就是漏了这个，B 段六条红）。
       */
      const created = await req(
        IDENTITY_BASE,
        "POST",
        "/admin/providers",
        { code: `smoke-direct-${Date.now()}`, name: "直填密钥供应商", baseUrl: `${mockA.url}/v1`, apiKey: directKey, enabled: false },
        adminTok,
      );
      check("A2-5 建供应商时直填 apiKey → 201", created.status === 201 && Number.isInteger(created.json?.id), created.text);
      const provId = created.json?.id;
      if (provId) createdProviderIds.push(provId);

      // 落库必须是**密文**（明文绝不出现在库里），且能解回原值
      if (provId) {
        const { rows } = await pool.query(
          `SELECT s.field_values FROM ai_providers p JOIN secrets s ON s.id = p.bind_secret_id WHERE p.id = $1`,
          [provId],
        );
        const stored = JSON.stringify(rows[0]?.field_values ?? {});
        check("A2-6 直填的 Key 以密文落库（库里不含明文）", rows.length === 1 && !stored.includes(directKey), stored.slice(0, 80));
        // 用脚本已加载的那份主密钥（文件顶部已经 import 过），不再重复 import ——
        // 两份模块实例虽然等价，但复用现成的更不容易随着 crypto 模块改名而失效
        const { openFields } = await import(new URL("../dist/common/secrets-crypto.js", import.meta.url).href);
        const opened = openFields(rows[0]?.field_values ?? {}, null, SECRET_KEY);
        check("A2-7 密文可解回原值（否则网关拿不到密钥）", opened.apiKey === directKey, String(opened.apiKey).slice(0, 12));
      }

      // 列表只回报「有没有」，不回传值
      const listed2 = await req(IDENTITY_BASE, "GET", "/admin/providers", undefined, adminTok);
      const row2 = (listed2.json?.providers ?? []).find((p) => p.id === provId);
      check("A2-8 列表只回报 hasApiKey 布尔（不回传任何密钥值）", row2?.hasApiKey === true && row2?.apiKey === undefined, JSON.stringify(row2));
    }

    /*
     * A3) 配置变更审计（2026-09-19 补）
     *
     * 背景：在此之前**供应商/模型的删除与修改没有审计** —— 2 个供应商被删掉后
     * 既查不到是谁删的、也无从恢复。本段把「谁在何时改了什么 + 改前快照」钉住：
     *   · 删除 → details.deleted 存**全量**快照（删了就只剩这一份，人工恢复靠它）；
     *   · 修改 → details.changed/before/after **只含变动字段**（审计只增不改，不能整行反复写）；
     *   · 删供应商要连**级联删掉的模型**一起存（ai_models 是 ON DELETE CASCADE，
     *     不然用户以为只删了个供应商，实际丢了整张模型表却不知道丢了什么）；
     *   · **密钥值绝不入审计**（只记 bindSecretId 引用）。
     */
    console.log("· A3) 配置变更审计（改前快照 / 删除全量 / 密钥不落库）");
    {
      const suffix = Date.now();
      const code = `smoke-audit-${suffix}`;
      const mk = await req(IDENTITY_BASE, "POST", "/admin/providers", {
        code,
        name: "审计冒烟供应商",
        baseUrl: `${mockA.url}/v1`,
        apiKey: "sk-audit-should-never-appear-in-audit",
        modelType: "chat",
      }, adminTok);
      const pid = mk.json?.id;
      if (pid) createdProviderIds.push(pid);
      check("A3-0 建测试供应商 201", mk.status === 201 && Number.isInteger(pid), mk.text);

      await req(IDENTITY_BASE, "PATCH", `/admin/providers/${pid}`, { name: "审计冒烟（改名）", baseUrl: `${mockA.url}/v2` }, adminTok);
      const m2 = await req(IDENTITY_BASE, "POST", "/admin/models", { providerId: pid, model: `audit-model-${suffix}`, displayName: "审计模型", maxContext: 1000 }, adminTok);
      const mid = m2.json?.id;
      if (mid) createdModelIds.push(mid);
      await req(IDENTITY_BASE, "PATCH", `/admin/models/${mid}`, { displayName: "审计模型（改名）", maxContext: 2000 }, adminTok);
      await req(IDENTITY_BASE, "DELETE", `/admin/providers/${pid}`, undefined, adminTok);

      const { rows } = await pool.query(
        `SELECT tool_name AS op, target, summary, details
           FROM audit_event
          WHERE action = 'admin_action' AND ts >= $1
            AND (target LIKE $2 OR tool_name = ANY($3::text[]))
          ORDER BY ts ASC`,
        [STARTED_AT, `providers:${code}`, ["providers.update", "providers.delete", "models.update", "models.create"]],
      );
      const find = (op, pred = () => true) => rows.find((r) => r.op === op && pred(r));

      const upd = find("providers.update", (r) => String(r.target).includes(code));
      check("A3-1 供应商修改有审计（providers.update）", Boolean(upd), rows.map((r) => r.op));
      check(
        "A3-2 只记变动字段，且带 before/after",
        upd?.details?.changed?.includes("name") && upd?.details?.changed?.includes("baseUrl") &&
          upd?.details?.before?.name === "审计冒烟供应商" && upd?.details?.after?.name === "审计冒烟（改名）",
        upd?.details,
      );
      check("A3-3 未变动的字段不进快照（避免整行反复写）", !upd?.details?.changed?.includes("enabled"), upd?.details?.changed);

      const mUpd = find("models.update");
      check("A3-4 模型修改有审计且带变动字段", mUpd?.details?.changed?.includes("maxContext") && mUpd?.details?.before?.maxContext === 1000, mUpd?.details);
      check("A3-5 模型新增有审计（models.create）", Boolean(find("models.create")), rows.map((r) => r.op));

      const del = find("providers.delete", (r) => String(r.target).includes(code));
      check("A3-6 删除有审计且 details.deleted 是全量快照", del?.details?.deleted?.code === code && del?.details?.deleted?.baseUrl === `${mockA.url}/v2`, del?.details?.deleted);
      check(
        "A3-7 删供应商时把级联删掉的模型一并存下来",
        Array.isArray(del?.details?.deletedModels) && del.details.deletedModels.some((m) => m.model === `audit-model-${suffix}`),
        del?.details?.deletedModels,
      );
      const allDetails = JSON.stringify(rows.map((r) => r.details));
      check("A3-8 ★ 密钥明文绝不入审计（只记 bindSecretId 引用）", !allDetails.includes("sk-audit-should-never-appear"), allDetails.slice(0, 120));
    }



    console.log("· B) 管理台配置生效");

    // 让本次测试的 provider 成为「第一个有效 provider」：临时停用 seed provider（finally 恢复）
    const seedProv = (
      await pool.query(`SELECT id, enabled FROM ai_providers WHERE code = $1 LIMIT 1`, [SEED_PROVIDER_CODE])
    ).rows[0];
    seedProviderId = seedProv?.id ?? null;
    seedProviderWasEnabled = seedProv?.enabled ?? null;
    if (seedProviderId && seedProviderWasEnabled === false) {
      // 这个状态很危险而且很难被发现：seed provider 停用 → 网关静默回退 env，
      // 管理台配的 provider/密钥/模型目录全部不生效（只有 /v1/models 的 x-reactor-catalog 头能看出来）。
      console.warn(`  ⚠ seed provider（${SEED_PROVIDER_CODE}）进来时是「停用」的 —— 网关此刻在走 env 回退，管理台配置不生效。`);
      console.warn("     本冒烟跑完会把它恢复为「启用」，不再把这个状态留在库里。");
    }
    if (seedProviderId) {
      await req(IDENTITY_BASE, "PATCH", `/admin/providers/${seedProviderId}`, { enabled: false }, adminTok);
    }

    const provCreated = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/providers",
      { code: "smoke-t34", name: "Smoke T34", baseUrl: mockA.url, bindSecretId: smokeSecretId },
      adminTok,
    );
    check("B0 建立测试 provider 201", provCreated.status === 201, provCreated.text);
    smokeProviderId = provCreated.json?.id;

    const callGateway = async (path = "/v1/messages", model = "smoke-model") => {
      const isGet = path === "/v1/models";
      const res = await fetch(`${GATEWAY_BASE}${path}`, {
        method: isGet ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-api-key": DEV_TOKEN },
        ...(isGet ? {} : { body: JSON.stringify({ model, messages: [] }) }),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON 响应 */
      }
      return {
        status: res.status,
        upstream: res.headers.get("x-reactor-upstream"),
        catalog: res.headers.get("x-reactor-catalog"),
        json,
        text,
      };
    };

    // B1/B2：库赢 + 密钥解密后透传
    const first = await callGateway();
    check("B1 网关打的是库里的 provider（env 诱饵未被使用）", mockA.state.hits.length === 1 && mockEnv.state.hits.length === 0,
      `adminA=${mockA.state.hits.length} envDecoy=${mockEnv.state.hits.length} status=${first.status}`);
    check(
      "B2 mock 上游收到的上游密钥是明文（库中为密文，网关解密后透传）",
      mockA.state.headers[0]?.["x-api-key"] === plainRotated,
      `got=${mockA.state.headers[0]?.["x-api-key"] === plainRotated ? "expected" : "unexpected"}`,
    );

    // B3：热生效——改 provider.baseUrl，不重启网关
    await req(IDENTITY_BASE, "PATCH", `/admin/providers/${smokeProviderId}`, { baseUrl: mockB.url }, adminTok);
    await sleep(TTL_MS + 400);
    const second = await callGateway();
    check("B3 改 baseUrl 后无需重启即生效（请求改打 B）", mockB.state.hits.length === 1 && mockA.state.hits.length === 1,
      `adminA=${mockA.state.hits.length} adminB=${mockB.state.hits.length} status=${second.status}`);
    check("B3b 网关回执头标记当前上游", second.upstream === "smoke-t34", `x-reactor-upstream=${second.upstream}`);

    // B4：目录跟随
    const models = await callGateway("/v1/models");
    check("B4 /v1/models 打当前 provider（B）并返回目录", mockB.state.hits.some((h) => h.startsWith("GET")) && models.status === 200,
      `status=${models.status} hits=${JSON.stringify(mockB.state.hits)}`);

    // B5：空密钥护栏 → 回退 env 上游，绝不用空密钥打上游
    await req(IDENTITY_BASE, "PATCH", `/admin/secrets/${smokeSecretId}`, { fieldValues: { baseUrl: mockA.url, apiKey: "" } }, adminTok);
    await sleep(TTL_MS + 400);
    const beforeGuard = { a: mockA.state.hits.length, b: mockB.state.hits.length };
    const third = await callGateway();
    check(
      "B5 密钥被置空 → 回退 env 上游，不用空密钥打上游",
      mockEnv.state.hits.length === 1 &&
        mockA.state.hits.length === beforeGuard.a &&
        mockB.state.hits.length === beforeGuard.b,
      `envDecoy=${mockEnv.state.hits.length} a=${mockA.state.hits.length} b=${mockB.state.hits.length} status=${third.status}`,
    );
    check("B5b 回退时回执头标记 env 上游", third.upstream === "tokenrhythm", `x-reactor-upstream=${third.upstream}`);
    check(
      "B5c 诱饵上游收到的是 env 密钥而非空串",
      mockEnv.state.headers[0]?.["x-api-key"] === "env-decoy-key",
    );

    // B6：库不可达 → 网关仍可用（回退 env），不至于全站不可用
    const deadPort = 19_700 + Math.floor(Math.random() * 200);
    const gw2Port = GATEWAY_PORT + 1;
    const gw2 = spawn(process.execPath, [join(ROOT, "packages", "server", "dist", "index.js")], {
      cwd: ROOT,
      env: {
        ...process.env,
        REACTOR_GATEWAY_HOST: "127.0.0.1",
        REACTOR_GATEWAY_PORT: String(gw2Port),
        REACTOR_DEV_TOKEN: DEV_TOKEN,
        REACTOR_DB_URL: `postgres://reactor:reactor@127.0.0.1:${deadPort}/reactor`,
        REACTOR_UPSTREAM_BASE_URL: mockEnv.url,
        REACTOR_UPSTREAM_API_KEY: "env-decoy-key",
        REACTOR_GATEWAY_REGISTRY_TTL_MS: String(TTL_MS),
      },
      stdio: "ignore",
    });
    children.push(gw2);
    const gw2Base = `http://127.0.0.1:${gw2Port}`;
    if (await waitReady(gw2Base, async () => (await fetch(`${gw2Base}/health`)).ok)) {
      const envHitsBefore = mockEnv.state.hits.length;
      const res = await fetch(`${gw2Base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": DEV_TOKEN },
        body: JSON.stringify({ model: "smoke-model", messages: [] }),
      });
      check(
        "B6 库不可达时网关仍可服务（回退 env 上游）",
        res.status === 200 && mockEnv.state.hits.length === envHitsBefore + 1,
        `status=${res.status} envDecoyHits=${mockEnv.state.hits.length}`,
      );
      check("B6b 回退时回执头标记 env 上游", res.headers.get("x-reactor-upstream") === "tokenrhythm", `got=${res.headers.get("x-reactor-upstream")}`);
    } else {
      check("B6 库不可达时网关仍可服务（回退 env 上游）", false, "网关未就绪");
    }

    // ============================================================ C) 模型目录参与路由
    console.log("· C) 模型目录参与路由（T3-4b）");

    // 复位：B5 把密钥置空过，这里换回有效密钥并把 provider 指回 mockA
    const plainB = `sk-t34-b-${Math.random().toString(36).slice(2, 8)}`;
    await req(
      IDENTITY_BASE,
      "PATCH",
      `/admin/secrets/${smokeSecretId}`,
      { fieldValues: { baseUrl: mockA.url, apiKey: plainRotated } },
      adminTok,
    );
    await req(IDENTITY_BASE, "PATCH", `/admin/providers/${smokeProviderId}`, { baseUrl: mockA.url }, adminTok);

    // 第二个 provider（独立密钥 → 独立上游 mockB）
    const secB = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/secrets",
      { name: "smoke-t34-secret-b", templateKey: "openai-compat", fieldValues: { baseUrl: mockB.url, apiKey: plainB } },
      adminTok,
    );
    const secBId = secB.json?.id;
    if (secBId) createdSecretIds.push(secBId);
    const provB = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/providers",
      { code: "smoke-t34b", name: "Smoke T34B", baseUrl: mockB.url, bindSecretId: secBId },
      adminTok,
    );
    const provBId = provB.json?.id;
    if (provBId) createdProviderIds.push(provBId);
    check("C0 准备第二个 provider/密钥 201", secB.status === 201 && provB.status === 201, `${secB.text} ${provB.text}`);

    // 两个模型：各挂一个 provider，带价目/窗口/能力
    const mktA = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/models",
      {
        providerId: smokeProviderId,
        model: "smoke-model-a",
        displayName: "Smoke A",
        features: ["tools", "reasoning"],
        maxContext: 128000,
        maxOutput: 8192,
        pricing: { inputPerM: 1.5, outputPerM: 6, cacheReadPerM: 0.15, cacheWritePerM: 0.5 },
      },
      adminTok,
    );
    const mktB = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/models",
      {
        providerId: provBId,
        model: "smoke-model-b",
        displayName: "Smoke B",
        features: ["anthropic"],
        maxContext: 200000,
        pricing: { inputPerM: 2, outputPerM: 8 },
      },
      adminTok,
    );
    const modelAId = mktA.json?.id;
    const modelBId = mktB.json?.id;
    if (modelAId) createdModelIds.push(modelAId);
    if (modelBId) createdModelIds.push(modelBId);
    check("C0b 注册两个模型 201", mktA.status === 201 && mktB.status === 201, `${mktA.text} ${mktB.text}`);
    await sleep(TTL_MS + 400);

    // C1/C2：按 model 路由
    const hitsBeforeC = { a: mockA.state.hits.length, b: mockB.state.hits.length };
    const c1 = await callGateway("/v1/messages", "smoke-model-a");
    const afterC1 = { a: mockA.state.hits.length, b: mockB.state.hits.length };
    const c2 = await callGateway("/v1/messages", "smoke-model-b");
    check(
      "C1 model=smoke-model-a → 打到 A 的 provider",
      c1.status === 200 && afterC1.a === hitsBeforeC.a + 1 && afterC1.b === hitsBeforeC.b,
      `status=${c1.status} a=${afterC1.a} b=${afterC1.b}`,
    );
    check(
      "C2 model=smoke-model-b → 打到 B 的 provider（按 model 选上游）",
      c2.status === 200 && mockB.state.hits.length === afterC1.b + 1 && mockA.state.hits.length === afterC1.a,
      `status=${c2.status} a=${mockA.state.hits.length} b=${mockB.state.hits.length}`,
    );
    check("C2b 回执头标记 B 的 provider", c2.upstream === "smoke-t34b", `got=${c2.upstream}`);
    check("C2c 打到 B 的是 B 自己的密钥", mockB.state.headers.at(-1)?.["x-api-key"] === plainB);

    // C3：未知模型 → 404 白名单语义，且不消耗上游
    const hitsBeforeUnknown = { a: mockA.state.hits.length, b: mockB.state.hits.length, env: mockEnv.state.hits.length };
    const c3 = await callGateway("/v1/messages", "no-such-model");
    const available = c3.json?.error?.available_models ?? [];
    check(
      "C3 未知模型 → 404 model_not_found（白名单语义）",
      c3.status === 404 && c3.json?.error?.type === "model_not_found",
      `status=${c3.status} type=${c3.json?.error?.type}`,
    );
    check(
      "C3b 附带可用模型清单且未打上游",
      available.includes("smoke-model-a") &&
        available.includes("smoke-model-b") &&
        mockA.state.hits.length === hitsBeforeUnknown.a &&
        mockB.state.hits.length === hitsBeforeUnknown.b &&
        mockEnv.state.hits.length === hitsBeforeUnknown.env,
      `available=${JSON.stringify(available)}`,
    );

    // C4：目录以库为准（不打上游，价目/能力来自 ai_models）
    const hitsBeforeCatalog = { a: mockA.state.hits.length, b: mockB.state.hits.length };
    const c4 = await callGateway("/v1/models");
    const catalogModels = c4.json?.data ?? [];
    const entryA = catalogModels.find((m) => m.id === "smoke-model-a");
    check("C4 /v1/models 来源标记为 db", c4.catalog === "db", `x-reactor-catalog=${c4.catalog}`);
    check(
      "C4b 目录内容来自 ai_models（四段价/窗口/能力齐备）",
      catalogModels.length === 2 &&
        entryA?.context_length === 128000 &&
        entryA?.max_completion_tokens === 8192 &&
        entryA?.input_price_per_million === 1.5 &&
        entryA?.output_price_per_million === 6 &&
        entryA?.cache_read_price_per_million === 0.15 &&
        entryA?.cache_write_price_per_million === 0.5 &&
        entryA?.supports_tools === true &&
        entryA?.supports_reasoning === true &&
        entryA?.owned_by === "smoke-t34",
      JSON.stringify(entryA),
    );
    const c4d = await req(IDENTITY_BASE, "GET", "/admin/models", undefined, adminTok);
    const adminA = (c4d.json?.models ?? []).find((m) => m.model === "smoke-model-a");
    check(
      "C4d 管理台 API 四段价往返一致（含缓存段）",
      adminA?.pricing?.inputPerM === 1.5 &&
        adminA?.pricing?.outputPerM === 6 &&
        adminA?.pricing?.cacheReadPerM === 0.15 &&
        adminA?.pricing?.cacheWritePerM === 0.5,
      JSON.stringify(adminA?.pricing),
    );
    check(
      "C4c 走库目录时不打上游 /models",
      mockA.state.hits.length === hitsBeforeCatalog.a && mockB.state.hits.length === hitsBeforeCatalog.b,
    );

    // C5：改模型归属 → 不重启即改道
    await req(IDENTITY_BASE, "PATCH", `/admin/models/${modelAId}`, { providerId: provBId }, adminTok);
    await sleep(TTL_MS + 400);
    const hitsBeforeMove = { a: mockA.state.hits.length, b: mockB.state.hits.length };
    const c5 = await callGateway("/v1/messages", "smoke-model-a");
    check(
      "C5 模型改挂 B 后，model=a 改打 B（热生效）",
      c5.status === 200 &&
        mockB.state.hits.length === hitsBeforeMove.b + 1 &&
        mockA.state.hits.length === hitsBeforeMove.a &&
        c5.upstream === "smoke-t34b",
      `status=${c5.status} a=${mockA.state.hits.length} b=${mockB.state.hits.length} up=${c5.upstream}`,
    );

    // C6：agents 的 provider/modelId 引用校验（目录已配置 → 必须命中）
    const badAgent = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/agents",
      { name: "smoke-t34-agent-bad", title: "坏引用", provider: "smoke-t34", modelId: "no-such-model", scope: { kind: "all" } },
      adminTok,
    );
    check("C6 agents 引用不存在的模型 → 400", badAgent.status === 400, badAgent.text);
    const goodAgent = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/agents",
      { name: "smoke-t34-agent", title: "好引用", provider: "smoke-t34b", modelId: "smoke-model-b", scope: { kind: "all" } },
      adminTok,
    );
    const agentId = goodAgent.json?.agent?.id;
    if (agentId) createdAgentIds.push(agentId);
    check("C6b agents 引用目录内模型 → 201", goodAgent.status === 201, goodAgent.text);
    const badPatch = await req(IDENTITY_BASE, "PATCH", `/admin/agents/${agentId}`, { modelId: "no-such-model" }, adminTok);
    check("C6c PATCH 改成不存在的模型 → 400", badPatch.status === 400, badPatch.text);

    // ============================================================ F) 输出窗口钳制
    console.log("· F) 输出窗口钳制（max_tokens 超限）");

    // 发一条自定义 body（带 max_tokens 超限值）：smoke-model-a 的 maxOutput=8192
    const sendRaw = async (path, body) => {
      const res = await fetch(`${GATEWAY_BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": DEV_TOKEN },
        body: JSON.stringify(body),
      });
      await res.text();
      return { status: res.status, clamped: res.headers.get("x-reactor-clamped") };
    };

    const f1 = await sendRaw("/v1/messages", { model: "smoke-model-a", max_tokens: 999999, messages: [] });
    const lastBodyA = JSON.parse(mockB.state.bodies.at(-1) ?? "{}");
    check(
      "F1 Anthropic max_tokens 超限被钳到 maxOutput（8192）",
      f1.status === 200 && lastBodyA.max_tokens === 8192,
      `status=${f1.status} upstream max_tokens=${lastBodyA.max_tokens}`,
    );
    check("F1b 回执头明确告知被钳制（不静默改写）", f1.clamped === "max_tokens:8192", `x-reactor-clamped=${f1.clamped}`);

    const f2 = await sendRaw("/v1/messages", { model: "smoke-model-a", max_tokens: 4096, messages: [] });
    const lastBodyA2 = JSON.parse(mockB.state.bodies.at(-1) ?? "{}");
    check("F2 未超限时原样透传（不改写、无回执头）", f2.status === 200 && lastBodyA2.max_tokens === 4096 && !f2.clamped, `max_tokens=${lastBodyA2.max_tokens} clamped=${f2.clamped}`);

    const f3 = await sendRaw("/v1/chat/completions", { model: "smoke-model-a", max_completion_tokens: 20000, messages: [] });
    const lastBodyA3 = JSON.parse(mockB.state.bodies.at(-1) ?? "{}");
    check(
      "F3 OpenAI max_completion_tokens 同样被钳制",
      f3.status === 200 && lastBodyA3.max_completion_tokens === 8192 && f3.clamped === "max_completion_tokens:8192",
      `max_completion_tokens=${lastBodyA3.max_completion_tokens} clamped=${f3.clamped}`,
    );

    // 未登记模型目录（兼容期）时不知窗口 → 不钳制
    const f4 = await sendRaw("/v1/messages", { model: "unregistered-xyz", max_tokens: 999999, messages: [] });
    check("F4 无法确定窗口时不钳制（宁可交给上游裁决）", f4.status !== 200 || !f4.clamped, `status=${f4.status} clamped=${f4.clamped}`);

    // ============================================================ D) 管理台辅助接口
    console.log("· D) 管理台辅助接口（模板下发 / 连通性测试）");

    /*
     * 原来这里有 D1「GET /admin/secret-templates 下发模板字段」。
     * 该端点已随密钥模板下线（2026-09-19），本节的职责改为**验证连通性测试**；
     * 「端点确实不在了」的断言放在 A2 段（A2-1..A2-4），不在两处重复。
     */

    const okTest = await req(IDENTITY_BASE, "POST", `/admin/providers/${smokeProviderId}/test`, {}, adminTok);
    check(
      "D2 连通性测试成功（打 mockA 的 /models 并回报模型数）",
      okTest.status === 200 && okTest.json?.ok === true && okTest.json?.modelCount === 1,
      okTest.text,
    );

    const badTest = await req(
      IDENTITY_BASE,
      "POST",
      `/admin/providers/${smokeProviderId}/test`,
      { baseUrl: "file:///etc/passwd" },
      adminTok,
    );
    check(
      "D3 非 http(s) 地址被拒（不当上游抓取）",
      badTest.status === 200 && badTest.json?.ok === false && String(badTest.json?.error).includes("http"),
      badTest.text,
    );

    const deadTest = await req(
      IDENTITY_BASE,
      "POST",
      `/admin/providers/${smokeProviderId}/test`,
      { baseUrl: "http://127.0.0.1:1/v1" },
      adminTok,
    );
    check(
      "D4 连不通时返回脱敏结论（不回传上游细节）",
      deadTest.status === 200 &&
        deadTest.json?.ok === false &&
        !String(deadTest.json?.error).includes("ECONNREFUSED"),
      deadTest.text,
    );
    /*
     * E) 模型板块（2026-09-19 重构）：每个板块有专属供应商 + 知识库检索配置
     *
     * 这一节钉的是**只有真起服务才能验**的东西：
     *   · 预留板块在服务端被拒（界面上写着「预留」，接口也必须一致）；
     *   · 模型类型由**供应商的板块**强制对齐（不信前端传值）；
     *   · /admin/kb-retrieval 的 env 兜底与维度闸门（换维度不一致必须拒绝，而不是悄悄生效）。
     */
    console.log("· E) 模型板块与知识库检索配置");

    // E1：新建一个「向量」板块的供应商 —— 允许
    const embProv = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/providers",
      { code: `smoke-emb-${Date.now()}`, name: "冒烟向量上游", baseUrl: `${mockA.url}/v1`, bindSecretId: smokeSecretId, modelType: "embedding" },
      adminTok,
    );
    check("E1 可创建「向量」板块供应商", embProv.status === 201 && Number.isInteger(embProv.json?.id), embProv.text);
    const embProvId = embProv.json?.id;
    if (embProvId) createdProviderIds.push(embProvId);

    const provList = await req(IDENTITY_BASE, "GET", "/admin/providers", undefined, adminTok);
    const embRow = (provList.json?.providers ?? []).find((p) => p.id === embProvId);
    check("E1b 列表回报 modelType（界面据此分栏）", embRow?.modelType === "embedding", embRow);

    // E2：预留板块必须被拒（界面说「预留」，接口也不能写）
    for (const t of ["image", "audio"]) {
      const r = await req(
        IDENTITY_BASE,
        "POST",
        "/admin/providers",
        { code: `smoke-${t}-${Date.now()}`, name: "预留板块", baseUrl: `${mockA.url}/v1`, bindSecretId: smokeSecretId, modelType: t },
        adminTok,
      );
      check(`E2 预留板块「${t}」被拒（400 + 可理解原因）`, r.status === 400 && String(r.json?.error?.message).includes("尚未接入"), r.text);
    }

    // E2b：PATCH 也拦得住（否则先建 chat 再改成 image 就绕过去了）
    if (embProvId) {
      const r = await req(IDENTITY_BASE, "PATCH", `/admin/providers/${embProvId}`, { modelType: "image" }, adminTok);
      check("E2b 更新路径同样拒绝预留板块（只堵一处 = 没堵）", r.status === 400, r.text);
    }

    // E3：导入到向量供应商 → 类型被强制为 embedding（即使请求里传了 chat）
    const imp = await req(
      IDENTITY_BASE,
      "POST",
      "/admin/models/import",
      { providerId: embProvId, models: [{ model: "smoke-embed-a", modelType: "chat" }] },
      adminTok,
    );
    check("E3 导入成功（幂等 upsert）", imp.status === 200 && imp.json?.added === 1, imp.text);
    const embModels = await req(IDENTITY_BASE, "GET", "/admin/models", undefined, adminTok);
    const embModel = (embModels.json?.models ?? []).find((m) => m.model === "smoke-embed-a");
    check("E3b 落库类型 = 供应商的板块（不看前端传的 chat）", embModel?.modelType === "embedding", embModel);
    if (embModel?.id) createdModelIds.push(embModel.id);

    // E4：KB 检索配置读接口（含 env 兜底与库内维度）
    const kb0 = await req(IDENTITY_BASE, "GET", "/admin/kb-retrieval", undefined, adminTok);
    check(
      "E4 读接口回报 config/env/effective/dim 四段",
      kb0.status === 200 && kb0.json?.config !== undefined && kb0.json?.env !== undefined && kb0.json?.effective !== undefined && "dim" in (kb0.json ?? {}),
      kb0.text,
    );

    // E5：启用向量化但不选模型 → 400（「开了但不知道用哪个」是最容易配出来的坏状态）
    const noModel = await req(IDENTITY_BASE, "PATCH", "/admin/kb-retrieval", { embeddingEnabled: true, embeddingModel: null }, adminTok);
    check("E5 开启向量化必须选模型", noModel.status === 400, noModel.text);

    // E6：选了不在「向量」板块的模型 → 400（防止拿 chat 模型去向量化）
    const wrongBoard = await req(
      IDENTITY_BASE,
      "PATCH",
      "/admin/kb-retrieval",
      { embeddingEnabled: true, embeddingModel: "smoke-model-a" },
      adminTok,
    );
    check("E6 只接受向量板块里的模型（跨板块被拒）", wrongBoard.status === 400, wrongBoard.text);

    // E7：维度闸门 —— 实测维度与库内不一致时必须拒绝（而不是保存成功、检索悄悄变差）
    if (kb0.json?.dim) {
      const mismatch = await req(
        IDENTITY_BASE,
        "PATCH",
        "/admin/kb-retrieval",
        { embeddingEnabled: true, embeddingModel: "smoke-embed-a", embeddingDim: kb0.json.dim + 1 },
        adminTok,
      );
      check(
        "E7 维度不一致被拒（409 + 说明要重建向量）",
        mismatch.status === 409 && String(mismatch.json?.error?.message).includes("维度"),
        mismatch.text,
      );
    }

    // E8：正常保存（维度一致）→ 200，且回报需要重启（装配发生在启动时，不假装热生效）
    const okSave = await req(
      IDENTITY_BASE,
      "PATCH",
      "/admin/kb-retrieval",
      { embeddingEnabled: true, embeddingModel: "smoke-embed-a", ...(kb0.json?.dim ? { embeddingDim: kb0.json.dim } : {}) },
      adminTok,
    );
    check("E8 配置保存成功且如实回报 needsRestart", okSave.status === 200 && okSave.json?.requiresRestart === true, okSave.text);

    // E9：还原为「未启用」，别把冒烟库的状态留给后续用例
    await req(IDENTITY_BASE, "PATCH", "/admin/kb-retrieval", { embeddingEnabled: false, embeddingModel: null }, adminTok).catch(() => undefined);
  } finally {
    // 清理：删 agent / 模型 / provider / 测试密钥，恢复 seed provider 的启用状态
    // ⚠ 必须删净 ai_models：残留会让 agents 的模型引用校验生效，影响其它冒烟
    for (const id of createdAgentIds) {
      await req(IDENTITY_BASE, "DELETE", `/admin/agents/${id}`, undefined, adminTok).catch(() => undefined);
    }
    for (const id of createdModelIds) {
      await req(IDENTITY_BASE, "DELETE", `/admin/models/${id}`, undefined, adminTok).catch(() => undefined);
    }
    for (const id of createdProviderIds) {
      await req(IDENTITY_BASE, "DELETE", `/admin/providers/${id}`, undefined, adminTok).catch(() => undefined);
    }
    if (smokeProviderId) await req(IDENTITY_BASE, "DELETE", `/admin/providers/${smokeProviderId}`, undefined, adminTok).catch(() => undefined);
    for (const id of createdSecretIds) {
      await req(IDENTITY_BASE, "DELETE", `/admin/secrets/${id}`, undefined, adminTok).catch(() => undefined);
    }
    // ⚠ 无条件恢复为「启用」：seed provider 停用会让网关静默回退 env（管理台配置全部失效），
    //   而本脚本只把它当「临时让位」用 —— 不管它进来时是什么状态，跑完都必须是启用。
    //   （历史事故：脚本被中断 / 外部改动把它留在停用态，很久都没人发现）
    if (seedProviderId) {
      await req(IDENTITY_BASE, "PATCH", `/admin/providers/${seedProviderId}`, { enabled: true }, adminTok).catch(() => undefined);
    }
    // ⚠ 必须放在最后：上面的删除/恢复都是管理接口调用，本身又会写新的审计行
    await cleanupAdminAudit({ since: STARTED_AT, pool });
    cleanupChildren();
    mockEnv.close();
    mockA.close();
    mockB.close();
    await pool.end().catch(() => undefined);
  }

  console.log(failed === 0 ? "\nT34 SMOKE PASS" : `\nT34 SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  cleanupChildren();
  process.exit(1);
});
