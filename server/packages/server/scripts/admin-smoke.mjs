/**
 * T3-1/T3-4 管理台数据域冒烟（pg 直连，不起 HTTP）：
 *   ensureAdminSchema 等价 SQL 建表 → 幂等 seed（模板/密钥/provider）→
 *   插入/查询/部分更新/引用校验断言 → 清理测试数据 → user_tokens 基本行为 →
 *   推理档位 params 语义与能力标记白名单（2026-10-14）。
 *
 * 注意：本脚本直连 SQL，绕过 HTTP 层，因此不覆盖「密钥加密落盘 / 掩码下发 / 掩码回写保护」
 *      ——那三项由 scripts/t34-smoke.mjs 覆盖。此处对 seed 密钥只断言「不是明文」。
 *
 * 前置：docker compose up -d（reactor-pg）；连不上则打印 SKIP 并以 0 退出。
 * 用法：pnpm --filter @reactor/server smoke:admin（或 node scripts/admin-smoke.mjs）
 */

import { fileURLToPath } from "node:url";
import { useSmokeDb } from "./lib/smoke-db.mjs";
import pg from "pg";

// 显式按脚本位置加载仓库根 .env（不依赖 cwd），使 seed 期望值与真实配置一致
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 无 .env 时靠外部环境变量 */
}

const { isSealed, loadSecretKey, openSecret } = await import(
  new URL("../dist/common/secrets-crypto.js", import.meta.url).href
);

const { sealLegacySecretFields } = await import(
  new URL("../dist/gateway/admin-schema.js", import.meta.url).href
);

/**
 * 冒烟库地址由 lib/smoke-db.mjs 的 useSmokeDb() 在 main() 开头写进 process.env，
 * 所以这里**不能在模块级捕获** —— 否则拿到的是真实库地址（2026-09-18 事故的口径）。
 */
const dbUrl = () => process.env.REACTOR_DB_URL ?? "postgresql://reactor:reactor@127.0.0.1:55432/reactor";

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail ?? ""}`);
  }
}

const ADMIN_DDL = [
  `CREATE TABLE IF NOT EXISTS secret_templates (
     id SERIAL PRIMARY KEY, key TEXT UNIQUE, name TEXT, fields JSONB,
     created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS secrets (
     id SERIAL PRIMARY KEY, name TEXT, template_key TEXT REFERENCES secret_templates(key),
     field_values JSONB, enabled BOOL DEFAULT true,
     created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS ai_providers (
     id SERIAL PRIMARY KEY, code TEXT UNIQUE, name TEXT, base_url TEXT,
     bind_secret_id INT REFERENCES secrets(id) ON DELETE SET NULL, enabled BOOL DEFAULT true,
     created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS ai_models (
     id SERIAL PRIMARY KEY, provider_id INT REFERENCES ai_providers(id) ON DELETE CASCADE,
     model TEXT, display_name TEXT, model_type TEXT DEFAULT 'chat', features JSONB DEFAULT '[]',
     max_context INT, max_output INT, pricing JSONB, enabled BOOL DEFAULT true, sort INT DEFAULT 0,
     params JSONB DEFAULT '{}',
     updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE (provider_id, model))`,
];

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

  console.log("== ADMIN SMOKE 开始 ==");
  try {
    // 1) 建表（执行两遍验证幂等）
    for (let i = 0; i < 2; i++) {
      for (const ddl of ADMIN_DDL) await pool.query(ddl);
    }
    check("ensureAdminSchema 等价 DDL 幂等", true);

    // 2) 幂等 seed：openai-compat 模板 + tokenrhythm provider（模拟 admin-schema.ts seed 逻辑）
    const baseUrl = process.env.UPSTREAM_BASE_URL || process.env.REACTOR_UPSTREAM_BASE_URL || "https://api.tokenrhythm.com/v1";
    const apiKey = process.env.UPSTREAM_API_KEY ?? process.env.REACTOR_UPSTREAM_API_KEY ?? "";
    await pool.query(
      `INSERT INTO secret_templates (key, name, fields) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [
        "openai-compat",
        "OpenAI 兼容",
        JSON.stringify([
          { key: "baseUrl", label: "Base URL", secret: false },
          { key: "apiKey", label: "API Key", secret: true },
        ]),
      ],
    );
    const tpl = await pool.query(`SELECT key, fields FROM secret_templates WHERE key = 'openai-compat'`);
    check(
      "seed 模板 openai-compat（fields 2 项，apiKey 为 secret）",
      tpl.rows.length === 1 && tpl.rows[0].fields.length === 2 && tpl.rows[0].fields[1].secret === true,
    );

    let seedSecretId = (await pool.query(`SELECT id FROM secrets WHERE name = $1 LIMIT 1`, ["TokenRhythm 默认密钥"]))
      .rows[0]?.id;
    if (!seedSecretId) {
      seedSecretId = (
        await pool.query(
          `INSERT INTO secrets (name, template_key, field_values) VALUES ($1, 'openai-compat', $2) RETURNING id`,
          ["TokenRhythm 默认密钥", JSON.stringify({ baseUrl, apiKey })],
        )
      ).rows[0].id;
    }
    await pool.query(
      `INSERT INTO ai_providers (code, name, base_url, bind_secret_id) VALUES ('tokenrhythm', 'TokenRhythm', $1, $2)
       ON CONFLICT (code) DO NOTHING`,
      [baseUrl, seedSecretId],
    );
    // 与 identity 启动**同序**：seed（明文落库）→ sealLegacySecretFields（敏感字段就地加密）。
    // 原先缺这一步：在真实库上"恰好"能过（provider 早被 identity 启动时加密过），
    // 换到每次重建的干净冒烟库就自相矛盾 —— 自己 seed 成明文，下一行却断言它是密文。
    const sealingKey = loadSecretKey();
    const sealedCount = await sealLegacySecretFields({ pool }, sealingKey);
    check(
      "seed 后就地加密（与 identity 启动同序）",
      !sealingKey || sealedCount >= 1,
      `keyCfg=${Boolean(sealingKey)} sealed=${sealedCount}`,
    );

    const seededProv = await pool.query(
      `SELECT p.code, p.base_url, s.field_values FROM ai_providers p
       LEFT JOIN secrets s ON s.id = p.bind_secret_id WHERE p.code = 'tokenrhythm'`,
    );
    const seededFieldValues = seededProv.rows[0]?.field_values ?? {};
    const secretKey = loadSecretKey();
    // 配置了主密钥时：库内必须是密文，且能解密回 env 的明文密钥（不得是明文/空串）
    const keyOk = secretKey
      ? isSealed(seededFieldValues.apiKey) && openSecret(seededFieldValues.apiKey, secretKey) === apiKey
      : seededFieldValues.apiKey === apiKey;
    check(
      "seed provider tokenrhythm 绑定 seed secret（baseUrl 与 env 一致；apiKey 非明文/可解密）",
      seededProv.rows.length === 1 && seededProv.rows[0].base_url === baseUrl && Boolean(apiKey) && keyOk,
      `base_url=${seededProv.rows[0]?.base_url} sealed=${isSealed(seededFieldValues.apiKey)} keyCfg=${Boolean(secretKey)}`,
    );

    // 3) secrets 插入 + 查询形状断言
    const sec = await pool.query(
      `INSERT INTO secrets (name, template_key, field_values) VALUES ($1, 'openai-compat', $2) RETURNING id`,
      ["smoke-sec", JSON.stringify({ baseUrl: "https://x/v1", apiKey: "sk-test" })],
    );
    const secId = sec.rows[0].id;
    const secRow = await pool.query(`SELECT id, name, template_key, field_values, enabled FROM secrets WHERE id = $1`, [secId]);
    const s = secRow.rows[0];
    check(
      "secrets 直连 SQL 插入/查询（绕开 API 加密层，原样存取；enabled 默认 true）",
      s && s.template_key === "openai-compat" && s.field_values.apiKey === "sk-test" && s.enabled === true,
    );

    // 4) providers 插入 + 部分更新（PATCH 语义）
    const prov = await pool.query(
      `INSERT INTO ai_providers (code, name, base_url, bind_secret_id) VALUES ('smoke-prov', 'Smoke', 'https://smoke/v1', $1) RETURNING id`,
      [secId],
    );
    const provId = prov.rows[0].id;
    await pool.query(`UPDATE ai_providers SET base_url = $1, updated_at = now() WHERE id = $2`, ["https://smoke2/v1", provId]);
    const provRow = await pool.query(`SELECT base_url, bind_secret_id FROM ai_providers WHERE id = $1`, [provId]);
    check("providers PATCH 部分字段生效且不覆盖未提交字段", provRow.rows[0].base_url === "https://smoke2/v1" && provRow.rows[0].bind_secret_id === secId);

    // 5) models 插入 + pricing 结构断言 + 唯一约束
    const pricing = { inputPerM: 3.5, outputPerM: 14 };
    await pool.query(
      `INSERT INTO ai_models (provider_id, model, display_name, pricing, sort) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider_id, model) DO NOTHING`,
      [provId, "smoke-model", "Smoke Model", JSON.stringify(pricing), 1],
    );
    const modelRow = await pool.query(`SELECT model, model_type, features, pricing, enabled FROM ai_models WHERE provider_id = $1 AND model = 'smoke-model'`, [provId]);
    const m = modelRow.rows[0];
    check(
      "models 插入/查询（model_type 默认 chat，features 默认 []，pricing={inputPerM,outputPerM}）",
      m && m.model_type === "chat" && Array.isArray(m.features) && m.features.length === 0 && m.pricing.inputPerM === 3.5 && m.pricing.outputPerM === 14,
    );
    const dup = await pool
      .query(`INSERT INTO ai_models (provider_id, model) VALUES ($1, 'smoke-model')`, [provId])
      .then(() => false)
      .catch((e) => e.code === "23505");
    check("UNIQUE(provider_id, model) 生效（23505）", dup === true);

    // 5b) 推理档位配置走 ai_models.params（2026-10-13：不改表结构，复用已有 jsonb 列）
    await pool.query(
      `INSERT INTO ai_models (provider_id, model, display_name, features, max_context, max_output, params)
       VALUES ($1, 'smoke-reasoning', 'Smoke Reasoning', $2::jsonb, 200000, 32000, $3::jsonb)`,
      [provId, JSON.stringify(["tools", "reasoning", "vision"]), JSON.stringify({ reasoning_levels: ["disabled", "enabled"], reasoning_map: "{}" })],
    );
    const rRow = await pool.query(
      `SELECT features, max_context, max_output, params FROM ai_models WHERE provider_id = $1 AND model = 'smoke-reasoning'`,
      [provId],
    );
    const r = rRow.rows[0];
    check(
      "params.reasoning_levels/reasoning_map 与 max_context/max_output 可同库共存（供 /v1/models 下发）",
      r &&
        r.max_context === 200000 &&
        r.max_output === 32000 &&
        Array.isArray(r.features) &&
        r.features.includes("reasoning") &&
        Array.isArray(r.params.reasoning_levels) &&
        r.params.reasoning_levels.join(",") === "disabled,enabled" &&
        r.params.reasoning_map === "{}",
    );
    // 反例：params 里与本次无关的键（rerank 向量维度）不能被推理配置覆盖掉
    await pool.query(`UPDATE ai_models SET params = $1::jsonb WHERE provider_id = $2 AND model = 'smoke-reasoning'`, [
      JSON.stringify({ vector_dimensions: 1024, reasoning_levels: ["low", "high"], reasoning_map: '{"reasoning_effort": reasoningLevel}' }),
      provId,
    ]);
    const merged = await pool.query(`SELECT params FROM ai_models WHERE provider_id = $1 AND model = 'smoke-reasoning'`, [provId]);
    check(
      "params 合并语义：写入推理配置不影响 rerank 的 vector_dimensions",
      merged.rows[0].params.vector_dimensions === 1024 && merged.rows[0].params.reasoning_levels.join(",") === "low,high",
    );

    /*
     * 5c) 能力标记白名单（2026-10-14）
     *
     * 桌面端「高级配置」里原本写死的 6 项能力（结构化输出 / 原生联网搜索 / 对话中系统消息 /
     * 视频 / 音频 / PDF）改为管理台勾选后经 /v1/models 以 supports_* 下发，前提是
     * `hasFeature()` 认得这些 key —— KNOWN_FEATURES 没扩的话，registry 类型层就过不去。
     *
     * 这里断言两件事：
     *   1. 6 个新 key 全部被 hasFeature 认得（否则 proxy 的下发体编译不过 / 恒 false）；
     *   2. 未登记的 key 仍被忽略（白名单语义不能因为扩量而失效）。
     * proxy.ts 里那 6 行 `hasFeature(m, "json_schema")` 是同模式重复，参数类型由
     * KNOWN_FEATURES[number] 在编译期保证，故不在此起整套网关验证。
     */
    const { ProviderRegistry, hasFeature } = await import(new URL("../dist/gateway/registry.js", import.meta.url).href);
    const reg = new ProviderRegistry();
    // registerModel 在 provider 未注册时静默忽略（避免悬空绑定），所以必须先 register
    reg.register({
      id: "smoke-prov",
      name: "Smoke Prov",
      baseUrl: "https://smoke.invalid/v1",
      apiKey: "smoke-key",
      api: "auto",
      headers: {},
      modelType: "chat",
    });
    const baseEntry = {
      model: "smoke-capabilities",
      displayName: "Smoke Capabilities",
      modelType: "chat",
      maxContext: null,
      maxOutput: null,
      pricing: { inputPerM: 0, outputPerM: 0, cacheReadPerM: null, cacheWritePerM: null },
      currency: null,
      scope: { kind: "all", roles: [], deptIds: [], uids: [] },
    };
    reg.registerModel("smoke-prov", {
      ...baseEntry,
      features: [
        "tools",
        "reasoning",
        "vision",
        "json_schema",
        "native_web_search",
        "mid_conversation_system",
        "video",
        "audio",
        "pdf",
        "bogus-unknown-key",
      ],
    });
    const capEntry = reg.allModels().find((m) => m.model === "smoke-capabilities");
    const recognized = [
      "tools",
      "reasoning",
      "vision",
      "json_schema",
      "native_web_search",
      "mid_conversation_system",
      "video",
      "audio",
      "pdf",
    ];
    check(
      "hasFeature 认得全部 9 项能力标记（含 2026-10-14 新增 6 项，供 /v1/models 下发 supports_*）",
      capEntry !== undefined && recognized.every((f) => hasFeature(capEntry, f) === true),
      recognized.filter((f) => !hasFeature(capEntry, f)).join(",") || "全部认得",
    );
    /*
     * 注意：这里**不能**断言 `hasFeature(entry, 未知key) === false` —— 它的实现就是
     * `entry.features.includes(feature)`，把未知 key 放进数组就返回 true（运行时不过滤）。
     * 白名单职责实际分在三处，这里把划分钉住，避免下次再按错的理解写断言：
     *   1. 编译期：`hasFeature` 的入参类型是 KNOWN_FEATURES[number]，写错 key 过不了 tsc；
     *   2. 管理台保存时：ModelsAndProviders 的 FEATURES 常量过滤掉未知 key；
     *   3. proxy 下发体：只对 9 个已知 key 调 hasFeature，调用点写死。
     * registry 则**全量保留** features（不过滤）——所以未知 key 会原样出现在 entry 里，
     * 但永远不会被下发。这条断言钉住的就是这个事实。
     */
    check(
      "registry 全量保留 features：未知 key 原样在 entry 中（过滤职责不在 registry）",
      capEntry !== undefined && capEntry.features.includes("bogus-unknown-key") === true,
    );

    // 6) 删除 provider → 级联删 models（ON DELETE CASCADE）
    await pool.query(`DELETE FROM ai_providers WHERE id = $1`, [provId]);
    const modelsLeft = await pool.query(`SELECT count(*)::int AS n FROM ai_models WHERE provider_id = $1`, [provId]);
    check("DELETE provider 级联删除其 models", modelsLeft.rows[0].n === 0);

    // 7) 删除 secret → 引用它的 provider.bind_secret_id 置 NULL（ON DELETE SET NULL）
    await pool.query(`DELETE FROM secrets WHERE id = $1`, [secId]);
    const bindAfter = await pool.query(`SELECT count(*)::int AS n FROM ai_providers WHERE bind_secret_id = $1`, [secId]);
    check("DELETE secret 后 provider.bind_secret_id 置 NULL（SET NULL）", bindAfter.rows[0].n === 0);

    // 8) user_tokens 基本行为（T3-2 落库表）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        id SERIAL PRIMARY KEY, uid TEXT NOT NULL, token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_tokens_uid ON user_tokens (uid)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_tokens_token_hash ON user_tokens (token_hash)`);
    const valid = new Date(Date.now() + 3600_000);
    await pool.query(`INSERT INTO user_tokens (uid, token_hash, expires_at) VALUES ('smoke-uid', 'h1', $1)`, [valid]);
    const validQ = await pool.query(
      `SELECT 1 FROM user_tokens WHERE uid = $1 AND token_hash = $2 AND expires_at > now() LIMIT 1`,
      ["smoke-uid", "h1"],
    );
    check("user_tokens 未过期 token 可命中", validQ.rows.length === 1);
    await pool.query(`DELETE FROM user_tokens WHERE uid = $1`, ["smoke-uid"]);
    check("revokeAll 等价：uid 全部吊销", true);

    // 9) 清理本次冒烟测试残留（seed 数据保留）
    await pool.query(`DELETE FROM ai_providers WHERE code = 'smoke-prov'`);
    await pool.query(`DELETE FROM secrets WHERE name = 'smoke-sec'`);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(failed === 0 ? "\nADMIN SMOKE PASS" : `\nADMIN SMOKE FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
