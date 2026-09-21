/**
 * 管理台数据域（T3-1/T3-4）：模板化密钥 + Provider/Model 双层管理。
 * ensureAdminSchema 幂等建表（与 identity ensureSchema 同风格，无迁移框架）并内置 seed。
 */

import type { IdentityDb } from "../identity/db.js";
import { sealFields } from "../common/secrets-crypto.js";

export interface AdminSchemaOptions {
  /**
   * 密钥落盘主密钥。配置时：seed 写入的 apiKey 与历史明文密钥会被加密；
   * 未配置时保持明文（本地开发降级，生产必须配置）。
   */
  secretKey?: Buffer | null;
}

/** 建表 + 幂等 seed（openai-compat 模板 / tokenrhythm 上游）+ 历史明文密钥就地加密。 */
export async function ensureAdminSchema(db: IdentityDb, opts: AdminSchemaOptions = {}): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS secret_templates (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE,
      name TEXT,
      fields JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // 密钥模板启用开关（管理端移植：BuildingAI secret 页的模板卡有启停 Switch）。
  // 既有库走幂等加列（与下方 ai_models.currency 同一手法，本仓无迁移框架）。
  await db.pool.query(`ALTER TABLE secret_templates ADD COLUMN IF NOT EXISTS enabled BOOL DEFAULT true`);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS secrets (
      id SERIAL PRIMARY KEY,
      name TEXT,
      template_key TEXT REFERENCES secret_templates(key),
      field_values JSONB,
      enabled BOOL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE,
      name TEXT,
      base_url TEXT,
      bind_secret_id INT REFERENCES secrets(id) ON DELETE SET NULL,
      enabled BOOL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS ai_models (
      id SERIAL PRIMARY KEY,
      provider_id INT REFERENCES ai_providers(id) ON DELETE CASCADE,
      model TEXT,
      display_name TEXT,
      model_type TEXT DEFAULT 'chat',
      features JSONB DEFAULT '[]',
      max_context INT,
      max_output INT,
      pricing JSONB,
      enabled BOOL DEFAULT true,
      sort INT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (provider_id, model)
    );
  `);
  // 币种（P0 模型发现）：上游 /models 会带 currency，导入后要能原样下发
  // （否则一旦切到「以库为准」路径，下游就丢了币种 → 与「导入不得让下游变差」相饽）
  await db.pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS currency TEXT`);

  // ---- 模型板块（2026-09-19 管理台重构）----
  // 用户口径：五个板块（对话/向量/重排/生图/语音），**每个板块有专属供应商**。
  // 所以类型要同时挂在供应商（板块归属）与模型（用途）上；导入时由服务端强制对齐。
  // 历史行一律落在 chat：不猜、不改写既有配置的语义。
  await db.pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS model_type TEXT NOT NULL DEFAULT 'chat'`);
  // 板块内排序（界面左列表顺序）；与 ai_models.sort 同理，小在前
  await db.pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS sort INT NOT NULL DEFAULT 0`);
  // 板块查询是主路径（左列表按 tab 过滤）→ 建索引，避免每次全表扫
  await db.pool.query(`CREATE INDEX IF NOT EXISTS ai_providers_model_type_idx ON ai_providers (model_type)`);

  // ---- P2：上游协议类型 / 自定义 headers / 模型可见范围 ----
  // 协议类型：auto = 入站什么形态就按什么形态发上游（与历史行为逐字一致），其余为显式声明
  await db.pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS api TEXT NOT NULL DEFAULT 'auto'`);
  // 自定义出站头（JSON 对象）。⚠ 不加密，别放密钥（密钥走密钥托管）
  await db.pool.query(`ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS headers JSONB NOT NULL DEFAULT '{}'::jsonb`);
  // 模型可见范围：**与 skills/agents 完全同口径**（all / role / dept / user，命中任一即可见）
  await db.pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS scope_kind TEXT NOT NULL DEFAULT 'all'`);
  await db.pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS scope_roles TEXT[] NOT NULL DEFAULT '{}'`);
  await db.pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS scope_dept_ids INT[] NOT NULL DEFAULT '{}'`);
  await db.pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS scope_uids TEXT[] NOT NULL DEFAULT '{}'`);
  // 建库时钉死的模型参数（JSONB）。当前唯一使用者：rerank 的**向量维度**。
  // 为什么要落库而不每次探测：维度不一致会让整个向量库作废（混维检索结果错），
  // 所以它是「一次性确认、之后只读」的事实，界面只读展示、不提供编辑入口。
  await db.pool.query(`ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb`);

  // ---- 知识库检索配置（单例，2026-09-19 打通）----
  //
  // 背景：在此之前，向量化器/重排器由**部署侧 env** 决定（REACTOR_KB_EMBED_MODEL 等），
  // 管理台配了向量模型也不生效 —— 界面上是个假旋钮。本表把它落库。
  //
  // 为什么用**单例行**而不是键值表：只有一份配置，键值表会让「读取时缺键」成为常态
  // （缺键 → 回退 env → 行为随部署漂移，正是要消除的东西）。单例行 id=1，读取即完整快照。
  //
  // 安全默认：两个开关都 **false**（= 保持纯词法/融合顺序，与升级前行为一致）。
  // 一旦有人配错模型，不该让线上检索**静默**改变结果。
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS kb_retrieval_config (
      id INT PRIMARY KEY CHECK (id = 1),
      embedding_enabled BOOL NOT NULL DEFAULT false,
      embedding_model TEXT,
      rerank_enabled BOOL NOT NULL DEFAULT false,
      rerank_model TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
  `);
  await db.pool.query(`INSERT INTO kb_retrieval_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await seedAdminDefaults(db);
  // 加密必须在 seed 之后：先补齐空值，再就地加密历史明文
  const sealedCount = await sealLegacySecretFields(db, opts.secretKey ?? null);
  if (sealedCount > 0) {
    console.log(`[admin-schema] 已加密 ${sealedCount} 条历史明文密钥（field_values 敏感字段）`);
  }
}

/**
 * 历史明文密钥就地加密（幂等）：对每条 secrets 按其模板定义加密敏感字段。
 * 已是密文的跳过；无主密钥时不做任何事（保持可读）。
 */
export async function sealLegacySecretFields(db: IdentityDb, key: Buffer | null): Promise<number> {
  if (!key) return 0;
  const { rows } = await db.pool.query<{
    id: number;
    field_values: Record<string, unknown> | null;
    template_fields: unknown;
  }>(
    `SELECT s.id, s.field_values, t.fields AS template_fields
     FROM secrets s LEFT JOIN secret_templates t ON t.key = s.template_key
     ORDER BY s.id`,
  );
  let sealed = 0;
  for (const r of rows) {
    const values = r.field_values ?? {};
    const next = sealFields(values, r.template_fields, key);
    if (JSON.stringify(next) === JSON.stringify(values)) continue;
    await db.pool.query(`UPDATE secrets SET field_values = $1, updated_at = now() WHERE id = $2`, [
      JSON.stringify(next),
      r.id,
    ]);
    sealed += 1;
  }
  return sealed;
}

/** 幂等 seed：模板/密钥/上游 provider 均存在则跳过（不覆盖运营态修改）。 */
async function seedAdminDefaults(db: IdentityDb): Promise<void> {
  // 兼容仓库 .env 的 REACTOR_ 前缀与任务约定的裸变量名。
  const baseUrl = process.env.UPSTREAM_BASE_URL || process.env.REACTOR_UPSTREAM_BASE_URL || "https://api.tokenrhythm.com/v1";
  const apiKey = process.env.UPSTREAM_API_KEY ?? process.env.REACTOR_UPSTREAM_API_KEY ?? "";

  await db.pool.query(
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

  const existing = await db.pool.query<{ id: number; field_values: Record<string, unknown> | null }>(
    `SELECT id, field_values FROM secrets WHERE name = $1 LIMIT 1`,
    ["TokenRhythm 默认密钥"],
  );
  let secretId = existing.rows[0]?.id;
  if (!secretId) {
    const inserted = await db.pool.query<{ id: number }>(
      `INSERT INTO secrets (name, template_key, field_values) VALUES ($1, 'openai-compat', $2) RETURNING id`,
      ["TokenRhythm 默认密钥", JSON.stringify({ baseUrl, apiKey })],
    );
    secretId = inserted.rows[0]!.id;
  } else {
    // 自愈：仅补空值（历史 seed 在无 .env 的进程里跑过 → apiKey 落成空串，网关将无法鉴权）。
    // 绝不覆盖已有非空值，遵守「不覆盖运营态修改」契约。
    const cur = existing.rows[0]!.field_values ?? {};
    const healed: Record<string, unknown> = { ...cur };
    let changed = false;
    if ((cur.apiKey === "" || cur.apiKey == null) && apiKey) {
      healed.apiKey = apiKey;
      changed = true;
    }
    if ((cur.baseUrl === "" || cur.baseUrl == null) && baseUrl) {
      healed.baseUrl = baseUrl;
      changed = true;
    }
    if (changed) {
      await db.pool.query(`UPDATE secrets SET field_values = $1, updated_at = now() WHERE id = $2`, [
        JSON.stringify(healed),
        secretId,
      ]);
      console.log(`[admin-schema] seed 自愈：补齐密钥 #${secretId} 的空字段`);
    }
  }

  await db.pool.query(
    `INSERT INTO ai_providers (code, name, base_url, bind_secret_id) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING`,
    ["tokenrhythm", "TokenRhythm", baseUrl, secretId],
  );
  // 同上：仅补 base_url 的空值
  if (baseUrl) {
    await db.pool.query(
      `UPDATE ai_providers SET base_url = $1, updated_at = now()
       WHERE code = 'tokenrhythm' AND (base_url IS NULL OR base_url = '')`,
      [baseUrl],
    );
  }
}
