/**
 * Agent 数字人数据域（A-1）：平台级 Agent 定义 = 身份形象 + 模型 + 技能组合 + 发布范围。
 *
 * 与 Skills 共用授权范围口径（common/scope.ts）；skills 为技能名白名单，
 * 空数组 = 不限制（该用户可见的全部技能）。
 *
 * v1 起再加**市场层**：市场卡片字段（tags/category/official/author/published_at）
 * + 两张账号级关系表（agent_installs / agent_favorites）。
 * 「可见」与「已安装」是两件事：scope 决定看得见，installs 决定收下了（见设计定稿 D1）。
 */

import type { IdentityDb } from "../identity/db.js";
import { visibilitySql, type ResourceScope, type ScopeKind } from "../common/scope.js";
import {
  isThinkingLevel,
  normalizeAuditPolicyMode,
  type AgentCategoryItem,
  type AgentDefinition,
  type AgentTagItem,
  type AgentTaxonomy,
} from "@reactor/shared";

export type AgentScopeKind = ScopeKind;
export type AgentScope = ResourceScope;

/** 预设包（D2）：建会话时下发给桌面端预置；null = 不指定 */
export interface AgentPresetRow {
  sessionType: string | null;
  policyMode: string | null;
  thinkingLevel: string | null;
  starters: string[];
}

export interface AgentRow {
  id: number;
  name: string;
  title: string;
  description: string | null;
  emoji: string | null;
  /** 追加到系统提示的 persona（appendSystemPrompt） */
  persona: string | null;
  provider: string | null;
  modelId: string | null;
  /** 技能名白名单（空 = 不限制） */
  skills: string[];
  /* ===== 市场字段 ===== */
  tags: string[];
  /** 分类 code（对应 agent_categories.code）；null = 未分类 */
  category: string | null;
  official: boolean;
  /** 卡片作者（展示名） */
  author: string | null;
  /** 未上架则不进市场（管理台仍可见） */
  publishedAt: string | null;
  /* ===== 预设包 ===== */
  preset: AgentPresetRow;
  scope: AgentScope;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 市场行 = 专家行 + 热度（安装量/使用量）+ 当前登录者的关系 */
export interface AgentMarketRow extends AgentRow {
  /** 安装量（agent_installs 计数） */
  hot: number;
  /** 使用量（agent_usage 会话计数；「最热」排序用它） */
  uses: number;
  installed: boolean;
  /** 已安装且启用（首页专家选择器只看这个） */
  installEnabled: boolean;
  favorited: boolean;
}

interface DbRow {
  id: number;
  name: string;
  title: string;
  description: string | null;
  emoji: string | null;
  persona: string | null;
  provider: string | null;
  model_id: string | null;
  skills: string[] | null;
  tags: string[] | null;
  category: string | null;
  official: boolean;
  author: string | null;
  published_at: Date | null;
  session_type: string | null;
  policy_mode: string | null;
  thinking_level: string | null;
  starters: string[] | null;
  scope_kind: AgentScopeKind;
  scope_roles: string[] | null;
  scope_dept_ids: number[] | null;
  scope_uids: string[] | null;
  enabled: boolean;
  created_by: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export async function ensureAgentsSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      emoji TEXT,
      persona TEXT,
      provider TEXT,
      model_id TEXT,
      skills TEXT[] NOT NULL DEFAULT '{}',
      scope_kind TEXT NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all','role','dept','user')),
      scope_roles TEXT[] NOT NULL DEFAULT '{}',
      scope_dept_ids INT[] NOT NULL DEFAULT '{}',
      scope_uids TEXT[] NOT NULL DEFAULT '{}',
      enabled BOOL NOT NULL DEFAULT true,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents (enabled);`);
  /**
   * 市场层扩列（幂等 ALTER；对齐 `audit/schema.ts` / `gateway/admin-schema.ts` 的既有做法）。
   * 全部可空或有默认值，存量行不需要回填。
   * 刻意**不建 install_count 冗余列**：热度由 agent_installs 计数得出，避免计数漂移。
   */
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS category TEXT`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS official BOOL NOT NULL DEFAULT false`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS author TEXT`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS session_type TEXT`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS policy_mode TEXT`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS thinking_level TEXT`);
  await db.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS starters TEXT[] NOT NULL DEFAULT '{}'`);
  // 市场排序需按上架时间倒序（「最新」），未上架行为 NULL 排最后
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agents_published ON agents (published_at DESC NULLS LAST)`);

  /**
   * 账号级安装关系（D1/D5）。
   * **不存 version**：安装 = 订阅「这个名字」的最新定义，管理员改人设后下次建会话即生效。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS agent_installs (
      uid TEXT NOT NULL,
      agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      enabled BOOL NOT NULL DEFAULT true,
      PRIMARY KEY (uid, agent_id)
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_installs_uid ON agent_installs (uid);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_installs_agent ON agent_installs (agent_id);`);

  /** 账号级收藏（「我的专家」= 已安装 ∪ 已收藏） */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS agent_favorites (
      uid TEXT NOT NULL,
      agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (uid, agent_id)
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_favorites_uid ON agent_favorites (uid);`);

  /**
   * 分类字典（用户 2026-09-14：**不写死在代码里**）。
   *
   * 设计取舍：
   *  - code 稳定、label 可改 —— 筛选条件（URL/SQL/存值）永远用 code，展示才查 label；
   *  - 没有外键约束到 agents.category：我们需要在删除前给出「有 N 个专家在用」的友好拒绝，
   *    而不是一句数据库外键报错。代价是引用完整性靠应用层保证（写入时校验 code 存在）。
   *  - 「下架一个分类」的正确姿势是 `enabled=false`（存量专家不受影响），
   *    删除仅在后无引用时允许。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS agent_categories (
      code TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort INT NOT NULL DEFAULT 100,
      enabled BOOL NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_categories_sort ON agent_categories (sort, code);`);

  /**
   * 标签库（受控词表：专家只能从库里选标签）。
   * 与分类同一套形态（name 稳定 / sort / enabled / 有引用只许停用）。
   * 为何要做受控：自由填写的标签会出现「周报 / 周报写作 / 写周报」同义变体，
   * 一旦用于筛选与统计就废了（用户 2026-09-14 拍板选受控词表）。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tags (
      name TEXT PRIMARY KEY,
      sort INT NOT NULL DEFAULT 100,
      enabled BOOL NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_tags_sort ON agent_tags (sort, name);`);

  /**
   * 使用量（真实热度）：一行 = 一个「专家 × 会话」。
   *
   * 为何不存计数器列：多次上报会重复计数（客户端重试、多设备、前后台各报一次），
   * 而 `(agent_id, session_id)` 主键天然幂等 —— 重复上报 ON CONFLICT DO NOTHING 即安全。
   * 反过来说：现在的口径是「使用量 = 用过该专家的会话数」。
   * 不含正文、不含提示词（只存 session_id 与 uid），符合 NFR-P-01。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS agent_usage (
      agent_id INT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, session_id)
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_usage_agent ON agent_usage (agent_id);`);

  /**
   * 初始分类（**只在表为空时种一次**）。
   *
   * 为何不用 `ON CONFLICT DO NOTHING`：那样每次启动都会把缺失的种子行补回来 ——
   * 管理员删掉一个种子分类，重启后它又出现，像是“删不掉”。
   * 现在只在表**完全为空**时种（首次部署/整表清空），之后分类表的走向完全由管理员掌握。
   *
   * 取值来源：参考图 chips 的 9 类 + 「其他」兜底（历史行里 category='other' 的仍可解释）。
   * 本平台真实需要的「办公协同 / 编码开发」由管理员在后台自建 —— 不在代码里预设。
   */
  await db.pool.query(
    `INSERT INTO agent_categories (code, label, sort)
     SELECT * FROM (VALUES
       ('product','产品设计',10), ('engineering','技术工程',20), ('finance','金融投资',30),
       ('global','全球发展',40), ('education','教育学习',50), ('gaming','游戏空间',60),
       ('data','数据智能',70), ('marketing','营销增长',80), ('content','内容创作',90),
       ('other','其他',999)
     ) AS v(code, label, sort)
     WHERE NOT EXISTS (SELECT 1 FROM agent_categories)`,
  );
}

/* ==================== 分类 / 标签字典 ==================== */

interface CategoryDbRow {
  code: string;
  label: string;
  sort: number;
  enabled: boolean;
}

interface TagDbRow {
  name: string;
  sort: number;
  enabled: boolean;
}

/**
 * 市场字典：**只带启用项**（停用的分类/标签不在界面出现），并按 sort 排好。
 * 带当前引用数：管理台展示，也用于“能不能删”的判断。
 */
export async function agentTaxonomy(db: IdentityDb): Promise<AgentTaxonomy> {
  const [cats, tags] = await Promise.all([
    db.pool.query<CategoryDbRow & { n: number }>(
      `SELECT c.code, c.label, c.sort, c.enabled,
              (SELECT count(*)::int FROM agents a WHERE a.category = c.code) AS n
       FROM agent_categories c ORDER BY c.sort, c.code`,
    ),
    db.pool.query<TagDbRow & { n: number }>(
      `SELECT t.name, t.sort, t.enabled,
              (SELECT count(*)::int FROM agents a WHERE t.name = ANY(a.tags)) AS n
       FROM agent_tags t ORDER BY t.sort, t.name`,
    ),
  ]);
  return {
    categories: cats.rows.map((r) => ({ code: r.code, label: r.label, sort: r.sort, enabled: r.enabled, agentCount: r.n })),
    tags: tags.rows.map((r) => ({ name: r.name, sort: r.sort, enabled: r.enabled, agentCount: r.n })),
  };
}

export async function findCategory(db: IdentityDb, code: string): Promise<AgentCategoryItem | null> {
  const { rows } = await db.pool.query<CategoryDbRow>(
    `SELECT code, label, sort, enabled FROM agent_categories WHERE code = $1`,
    [code],
  );
  const r = rows[0];
  return r ? { code: r.code, label: r.label, sort: r.sort, enabled: r.enabled } : null;
}

/** 分类引用数（删除前检查：> 0 则拒绝，返回给管理员看「谁在用」） */
export async function categoryUsage(db: IdentityDb, code: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agents WHERE category = $1`,
    [code],
  );
  return rows[0]?.n ?? 0;
}

export async function createCategory(db: IdentityDb, input: { code: string; label: string; sort: number; enabled: boolean }): Promise<AgentCategoryItem> {
  await db.pool.query(
    `INSERT INTO agent_categories (code, label, sort, enabled) VALUES ($1,$2,$3,$4)`,
    [input.code, input.label, input.sort, input.enabled],
  );
  return (await findCategory(db, input.code))!;
}

export async function updateCategory(
  db: IdentityDb,
  code: string,
  patch: { label?: string; sort?: number; enabled?: boolean },
): Promise<AgentCategoryItem | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.label !== undefined) push("label", patch.label);
  if (patch.sort !== undefined) push("sort", patch.sort);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (fields.length === 0) return findCategory(db, code);
  params.push(code);
  const { rowCount } = await db.pool.query(
    `UPDATE agent_categories SET ${fields.join(", ")}, updated_at = now() WHERE code = $${params.length}`,
    params,
  );
  return (rowCount ?? 0) > 0 ? findCategory(db, code) : null;
}

/** 删除分类；有引用时**不删**并返回引用数（由路由转为 409 + 中文提示） */
export async function deleteCategory(db: IdentityDb, code: string): Promise<{ deleted: boolean; used: number }> {
  const used = await categoryUsage(db, code);
  if (used > 0) return { deleted: false, used };
  const { rowCount } = await db.pool.query(`DELETE FROM agent_categories WHERE code = $1`, [code]);
  return { deleted: (rowCount ?? 0) > 0, used: 0 };
}

/* ---------- 标签库 ---------- */

export async function findTag(db: IdentityDb, name: string): Promise<AgentTagItem | null> {
  const { rows } = await db.pool.query<TagDbRow>(`SELECT name, sort, enabled FROM agent_tags WHERE name = $1`, [name]);
  const r = rows[0];
  return r ? { name: r.name, sort: r.sort, enabled: r.enabled } : null;
}

export async function tagUsage(db: IdentityDb, name: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agents WHERE $1 = ANY(tags)`,
    [name],
  );
  return rows[0]?.n ?? 0;
}

export async function createTag(db: IdentityDb, input: { name: string; sort: number; enabled: boolean }): Promise<AgentTagItem> {
  await db.pool.query(`INSERT INTO agent_tags (name, sort, enabled) VALUES ($1,$2,$3)`, [
    input.name,
    input.sort,
    input.enabled,
  ]);
  return (await findTag(db, input.name))!;
}

export async function updateTag(
  db: IdentityDb,
  name: string,
  patch: { sort?: number; enabled?: boolean },
): Promise<AgentTagItem | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.sort !== undefined) push("sort", patch.sort);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (fields.length === 0) return findTag(db, name);
  params.push(name);
  const { rowCount } = await db.pool.query(
    `UPDATE agent_tags SET ${fields.join(", ")}, updated_at = now() WHERE name = $${params.length}`,
    params,
  );
  return (rowCount ?? 0) > 0 ? findTag(db, name) : null;
}

export async function deleteTag(db: IdentityDb, name: string): Promise<{ deleted: boolean; used: number }> {
  const used = await tagUsage(db, name);
  if (used > 0) return { deleted: false, used };
  const { rowCount } = await db.pool.query(`DELETE FROM agent_tags WHERE name = $1`, [name]);
  return { deleted: (rowCount ?? 0) > 0, used: 0 };
}

/**
 * 标签库校验：返回库里不存在的标签名（写入前拦）。
 * 只看存在性、不看启用态 —— 「停用」是给**新建**用的（不让新人再选），
 * 存量专家 PATCH 其它字段时不该因为某个标签被停用而整个保存失败。
 */
export async function unknownTagNames(db: IdentityDb, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await db.pool.query<{ name: string }>(
    `SELECT name FROM agent_tags WHERE name = ANY($1::text[])`,
    [names],
  );
  const known = new Set(rows.map((r) => r.name));
  return names.filter((n) => !known.has(n));
}

/* ---------- 使用量 ---------- */

/**
 * 记录一次使用（幂等：同一会话重复上报不会重复计数）。
 * 返回 `created` 区分「首次计入」，便于上层观察上报是否真的生效。
 */
export async function recordAgentUse(
  db: IdentityDb,
  agentId: number,
  sessionId: string,
  uid: string,
): Promise<{ created: boolean }> {
  const { rows } = await db.pool.query<{ inserted: boolean }>(
    `INSERT INTO agent_usage (agent_id, session_id, uid) VALUES ($1,$2,$3)
     ON CONFLICT (agent_id, session_id) DO NOTHING
     RETURNING true AS inserted`,
    [agentId, sessionId, uid],
  );
  return { created: rows.length > 0 };
}

const SELECT = `
  SELECT id, name, title, description, emoji, persona, provider, model_id, skills,
         tags, category, official, author, published_at,
         session_type, policy_mode, thinking_level, starters,
         scope_kind, scope_roles, scope_dept_ids, scope_uids, enabled, created_by, created_at, updated_at
  FROM agents
`;

const iso = (v: Date | null): string | null => (v ? new Date(v).toISOString() : null);

function mapRow(r: DbRow): AgentRow {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    description: r.description,
    emoji: r.emoji,
    persona: r.persona,
    provider: r.provider,
    modelId: r.model_id,
    skills: r.skills ?? [],
    tags: r.tags ?? [],
    // 分类不再有代码层默认值：库里是什么就是什么（null = 未分类），
    // 有效性由写入侧校验（必须存在于 agent_categories）
    category: r.category,
    official: r.official === true,
    author: r.author,
    publishedAt: iso(r.published_at),
    preset: {
      sessionType: r.session_type,
      policyMode: r.policy_mode,
      thinkingLevel: r.thinking_level,
      starters: r.starters ?? [],
    },
    scope: {
      kind: r.scope_kind,
      roles: (r.scope_roles ?? []) as AgentScope["roles"],
      deptIds: r.scope_dept_ids ?? [],
      uids: r.scope_uids ?? [],
    },
    enabled: r.enabled,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Agent 标识：与技能目录名同规范（小写字母/数字/连字符，不连续） */
export const AGENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const AGENT_NAME_MAX = 64;

export interface AgentInput {
  name: string;
  title: string;
  description?: string | null;
  emoji?: string | null;
  persona?: string | null;
  provider?: string | null;
  modelId?: string | null;
  skills?: string[];
  /** 市场字段（v1） */
  tags?: string[];
  /** 分类 code；null = 未分类 */
  category?: string | null;
  official?: boolean;
  author?: string | null;
  /** 传值即上架（写 published_at）；缺省 = 未上架，不进市场 */
  publishedAt?: string | null;
  preset?: Partial<AgentPresetRow>;
  scope: AgentScope;
  enabled?: boolean;
  createdBy?: string | null;
}

export async function listAgents(db: IdentityDb): Promise<AgentRow[]> {
  const { rows } = await db.pool.query<DbRow>(`${SELECT} ORDER BY id DESC`);
  return rows.map(mapRow);
}

export async function findAgentById(db: IdentityDb, id: number): Promise<AgentRow | null> {
  const { rows } = await db.pool.query<DbRow>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createAgent(db: IdentityDb, input: AgentInput): Promise<AgentRow> {
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO agents (name, title, description, emoji, persona, provider, model_id, skills,
                         tags, category, official, author, published_at,
                         session_type, policy_mode, thinking_level, starters,
                         scope_kind, scope_roles, scope_dept_ids, scope_uids, enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
    [
      input.name,
      input.title,
      input.description ?? null,
      input.emoji ?? null,
      input.persona ?? null,
      input.provider ?? null,
      input.modelId ?? null,
      input.skills ?? [],
      input.tags ?? [],
      input.category ?? null,
      input.official === true,
      input.author ?? null,
      input.publishedAt ?? null,
      input.preset?.sessionType ?? null,
      input.preset?.policyMode ?? null,
      input.preset?.thinkingLevel ?? null,
      input.preset?.starters ?? [],
      input.scope.kind,
      input.scope.roles,
      input.scope.deptIds,
      input.scope.uids,
      input.enabled ?? true,
      input.createdBy ?? null,
    ],
  );
  return (await findAgentById(db, rows[0]!.id))!;
}

export interface AgentPatch {
  title?: string;
  description?: string | null;
  emoji?: string | null;
  persona?: string | null;
  provider?: string | null;
  modelId?: string | null;
  skills?: string[];
  tags?: string[];
  /** 分类 code；null = 未分类 */
  category?: string | null;
  official?: boolean;
  author?: string | null;
  /** 传 null = 下架（不进市场）；传 ISO 串 = 上架 */
  publishedAt?: string | null;
  preset?: Partial<AgentPresetRow>;
  scope?: AgentScope;
  enabled?: boolean;
}

export async function updateAgent(db: IdentityDb, id: number, patch: AgentPatch): Promise<AgentRow | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.description !== undefined) push("description", patch.description);
  if (patch.emoji !== undefined) push("emoji", patch.emoji);
  if (patch.persona !== undefined) push("persona", patch.persona);
  if (patch.provider !== undefined) push("provider", patch.provider);
  if (patch.modelId !== undefined) push("model_id", patch.modelId);
  if (patch.skills !== undefined) push("skills", patch.skills);
  if (patch.tags !== undefined) push("tags", patch.tags);
  if (patch.category !== undefined) push("category", patch.category);
  if (patch.official !== undefined) push("official", patch.official);
  if (patch.author !== undefined) push("author", patch.author);
  if (patch.publishedAt !== undefined) push("published_at", patch.publishedAt);
  // 预设包：逐字段 merge（只传一个字段不能把其余三个冲成 null）
  if (patch.preset !== undefined) {
    if (patch.preset.sessionType !== undefined) push("session_type", patch.preset.sessionType);
    if (patch.preset.policyMode !== undefined) push("policy_mode", patch.preset.policyMode);
    if (patch.preset.thinkingLevel !== undefined) push("thinking_level", patch.preset.thinkingLevel);
    if (patch.preset.starters !== undefined) push("starters", patch.preset.starters);
  }
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.scope !== undefined) {
    push("scope_kind", patch.scope.kind);
    push("scope_roles", patch.scope.roles);
    push("scope_dept_ids", patch.scope.deptIds);
    push("scope_uids", patch.scope.uids);
  }
  if (fields.length === 0) return findAgentById(db, id);
  params.push(id);
  await db.pool.query(`UPDATE agents SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  return findAgentById(db, id);
}

export async function deleteAgent(db: IdentityDb, id: number): Promise<boolean> {
  const { rowCount } = await db.pool.query("DELETE FROM agents WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export interface AgentViewer {
  uid: string;
  role: AgentScope["roles"][number];
  deptId: number | null;
}

/** 当前用户可见 Agent（enabled 且命中任一授权条件）。**管理/内部用**，不过滤上架态。 */
export async function visibleAgentsFor(db: IdentityDb, viewer: AgentViewer): Promise<AgentRow[]> {
  const { rows } = await db.pool.query<DbRow>(
    `${SELECT}
     WHERE enabled = true AND ${visibilitySql({
       kind: "scope_kind",
       roles: "scope_roles",
       deptIds: "scope_dept_ids",
       uids: "scope_uids",
     })}
     ORDER BY name`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows.map(mapRow);
}

/** 市场行（DbRow + 热度 + 登录者关系） */
interface MarketDbRow extends DbRow {
  hot: number;
  uses: number;
  installed: boolean;
  install_enabled: boolean;
  favorited: boolean;
}

/**
 * 专家市场目录（`GET /me/agents` 的数据源，D1）。
 *
 * 与 `visibleAgentsFor` 的两点差别：
 *  1. 多一个 `published_at IS NOT NULL` —— 未上架的定义只出现在管理台；
 *  2. 带 `hot` / `installed` / `favorited`（安装量与当前登录者的关系）。
 *
 * 排序 = 界面默认的「综合」档：官方/特邀优先 → 安装量 → 上架时间 → 名称。
 * 参数顺序固定为 $1=role, $2=deptId, $3=uid（与 `visibilitySql` 契约一致），
 * 两个 LEFT JOIN 复用 $3。
 */
export async function marketAgentsFor(db: IdentityDb, viewer: AgentViewer): Promise<AgentMarketRow[]> {
  const { rows } = await db.pool.query<MarketDbRow>(
    `SELECT a.id, a.name, a.title, a.description, a.emoji, a.persona, a.provider, a.model_id, a.skills,
            a.tags, a.category, a.official, a.author, a.published_at,
            a.session_type, a.policy_mode, a.thinking_level, a.starters,
            a.scope_kind, a.scope_roles, a.scope_dept_ids, a.scope_uids,
            a.enabled, a.created_by, a.created_at, a.updated_at,
            (SELECT count(*)::int FROM agent_installs x WHERE x.agent_id = a.id) AS hot,
            (SELECT count(*)::int FROM agent_usage u WHERE u.agent_id = a.id) AS uses,
            (i.uid IS NOT NULL) AS installed,
            (i.enabled IS TRUE) AS install_enabled,
            (f.uid IS NOT NULL) AS favorited
     FROM agents a
     LEFT JOIN agent_installs i ON i.agent_id = a.id AND i.uid = $3
     LEFT JOIN agent_favorites f ON f.agent_id = a.id AND f.uid = $3
     WHERE a.enabled = true AND a.published_at IS NOT NULL AND ${visibilitySql({
       kind: "a.scope_kind",
       roles: "a.scope_roles",
       deptIds: "a.scope_dept_ids",
       uids: "a.scope_uids",
     })}
     /*
      * 排序 = 界面默认「综合」档，与 lib/agent-market.ts 的 compareRecommend **必须一致**：
      *   官方/特邀 → 真实使用量 → 安装量 → 上架时间 → 名称
      * 「使用量优先于安装量」是用户 2026-09-14 的选择：装而不用的专家不应凌驾于真在用的之上。
      * 两处改一处忘另一处 = 首屏顺序与服务端顺序不一致（t182 探针盯这条口径）。
      */
     ORDER BY a.official DESC, uses DESC, hot DESC, a.published_at DESC, a.name ASC`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows.map((r) => ({
    ...mapRow(r),
    hot: r.hot ?? 0,
    uses: r.uses ?? 0,
    installed: r.installed === true,
    installEnabled: r.install_enabled === true,
    favorited: r.favorited === true,
  }));
}

/**
 * 按名取市场内的单个专家（写操作前的作用域门禁）：
 * 取不到 = 不存在 / 未上架 / 已停用 / 不在我的授权范围内 —— 四种情况一律 404，
 * 不区分返回，避免向外暴露「这个专家存在但你看不到」。
 */
export async function marketAgentByName(
  db: IdentityDb,
  viewer: AgentViewer,
  name: string,
): Promise<AgentMarketRow | null> {
  const all = await marketAgentsFor(db, viewer);
  return all.find((a) => a.name === name) ?? null;
}

/**
 * 安装（幂等）：已存在则**重新启用**而不重复插入。
 * 返回 `created` 区分首次安装（前端据此决定要不要提示）。
 */
export async function installAgent(db: IdentityDb, uid: string, agentId: number): Promise<{ created: boolean }> {
  const { rows } = await db.pool.query<{ inserted: boolean }>(
    `INSERT INTO agent_installs (uid, agent_id, enabled)
     VALUES ($1, $2, true)
     ON CONFLICT (uid, agent_id) DO UPDATE SET enabled = true
     RETURNING (xmax = 0) AS inserted`,
    [uid, agentId],
  );
  return { created: rows[0]?.inserted === true };
}

/** 卸载（幂等）：删关系；重新安装后安装时间会刷新 */
export async function uninstallAgent(db: IdentityDb, uid: string, agentId: number): Promise<boolean> {
  const { rowCount } = await db.pool.query("DELETE FROM agent_installs WHERE uid = $1 AND agent_id = $2", [uid, agentId]);
  return (rowCount ?? 0) > 0;
}

/** 已安装专家的启停（不影响安装关系；首页选择器只看已启用） */
export async function setInstallEnabled(
  db: IdentityDb,
  uid: string,
  agentId: number,
  enabled: boolean,
): Promise<boolean> {
  const { rowCount } = await db.pool.query(
    "UPDATE agent_installs SET enabled = $3 WHERE uid = $1 AND agent_id = $2",
    [uid, agentId, enabled],
  );
  return (rowCount ?? 0) > 0;
}

export async function isInstalled(db: IdentityDb, uid: string, agentId: number): Promise<boolean> {
  const { rows } = await db.pool.query("SELECT 1 FROM agent_installs WHERE uid = $1 AND agent_id = $2", [uid, agentId]);
  return rows.length > 0;
}

/** 收藏开关（无则建、有则删），返回最终态 */
export async function toggleFavorite(db: IdentityDb, uid: string, agentId: number): Promise<boolean> {
  const { rowCount } = await db.pool.query(
    "DELETE FROM agent_favorites WHERE uid = $1 AND agent_id = $2",
    [uid, agentId],
  );
  if ((rowCount ?? 0) > 0) return false;
  await db.pool.query(
    `INSERT INTO agent_favorites (uid, agent_id) VALUES ($1, $2) ON CONFLICT (uid, agent_id) DO NOTHING`,
    [uid, agentId],
  );
  return true;
}

/** 校验技能名存在（防悬空引用）；返回不存在的名字 */
export async function unknownSkillNames(db: IdentityDb, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await db.pool.query<{ name: string }>("SELECT name FROM skills WHERE name = ANY($1::text[])", [names]);
  const known = new Set(rows.map((r) => r.name));
  return names.filter((name) => !known.has(name));
}

/**
 * 校验 Agent 的 provider/modelId 引用（T3-4b）。
 *
 * 语义：**模型目录已配置时（ai_models 有启用行）才校验**——此时目录是权威白名单，
 * 引用不存在的模型会被网关 404，所以配置期就拦住；目录为空时保持原有宽松行为
 * （本地/兼容期可自由填写），避免把历史配置一次性判死。
 */
export async function modelRefStatus(
  db: IdentityDb,
  provider: string | null,
  modelId: string | null,
): Promise<{ curated: boolean; ok: boolean }> {
  const { rows: anyModel } = await db.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
     WHERE m.enabled AND p.enabled`,
  );
  const curated = (anyModel[0]?.n ?? 0) > 0;
  if (!curated) return { curated, ok: true };
  if (!modelId) return { curated, ok: false };
  const { rows } = await db.pool.query(
    `SELECT 1 FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
     WHERE m.enabled AND p.enabled AND m.model = $1 AND ($2::text IS NULL OR p.code = $2)
     LIMIT 1`,
    [modelId, provider],
  );
  return { curated, ok: rows.length > 0 };
}

/**
 * 对外下发载荷（桌面端专家市场卡片 + 新建会话时应用）。
 *
 * 返回类型刻意标为 `AgentDefinition`：这是与桌面端的真契约，
 * 字段改名/漏字段必须在编译期暴露，而不是等 agents.json 解析方静默丢弃。
 * `sessionType` / `policyMode` / `thinkingLevel` 写入侧已校验，但库里可能有历史脏值，
 * 读取侧再做一次白名单收敛（宁可不预置，不可把非法值带进引擎）。
 */
export function toAgentPayload(row: AgentRow | AgentMarketRow): AgentDefinition {
  const market = row as Partial<AgentMarketRow>;
  const sessionType = row.preset.sessionType;
  const policyMode = row.preset.policyMode;
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    emoji: row.emoji,
    persona: row.persona,
    provider: row.provider,
    modelId: row.modelId,
    skills: row.skills,
    /* 市场字段 */
    tags: row.tags,
    category: row.category,
    official: row.official,
    author: row.author,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    enabled: row.enabled,
    /* 关系与热度（仅市场源有；管理面调用时缺省 0/false） */
    hot: market.hot ?? 0,
    uses: market.uses ?? 0,
    installed: market.installed === true,
    installEnabled: market.installEnabled === true,
    favorited: market.favorited === true,
    /* 预设包（D2） */
    sessionType:
      sessionType === "code" || sessionType === "work" || sessionType === "general" ? sessionType : null,
    // 旧词表（readonly/balanced/trust/strict）在这里也被映射到新词表：库里可能残留改造前的预设。
    policyMode: normalizeAuditPolicyMode(policyMode),
    thinkingLevel: isThinkingLevel(row.preset.thinkingLevel) ? row.preset.thinkingLevel : null,
    starters: row.preset.starters,
  };
}
