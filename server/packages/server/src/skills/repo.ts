import { createHash } from "node:crypto";
/**
 * Skills 技能库数据域（S-1）：SKILL.md 内容 + 版本 + 启停 + 授权范围。
 *
 * 授权范围（对齐 D3 双级下发）：
 *  - all  全公司
 *  - role 指定角色（platform_admin / dept_head / user）
 *  - dept 指定部门（按用户 department_id 精确匹配，不做子树——口径与 /users 的 deptIds 区分开）
 *  - user 指定账号（uid）
 * 多条授权条件按「并集」生效：命中任一即可见。
 */

import type { IdentityDb } from "../identity/db.js";
import type { Role } from "../identity/users.js";
import { visibilitySql, type ResourceScope, type ScopeKind } from "../common/scope.js";
import {
  DEFAULT_SKILL_CATEGORY,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_LABELS,
  SKILL_CATEGORY_SEED,
  SKILL_FILE_LIMITS,
  normalizeSkillFilePath,
  SKILL_LIMITS,
  normalizeSkillCategory,
  parseSkillFrontmatter,
  type SkillCatalogItem,
  type SkillCatalogPage,
  type SkillCategory,
  type SkillCategoryItem,
  type SkillFileContent,
  type SkillFileMeta,
  type SkillInstalledItem,
  type SkillStateEntry,
} from "@reactor/shared";

export type SkillScopeKind = ScopeKind;
export type SkillScope = ResourceScope;

/** （元数据字段清单定义在下方 SKILL_META_FIELDS：title 不参与 frontmatter 推导） */

export interface SkillRow {
  id: number;
  name: string;
  title: string;
  description: string | null;
  content: string;
  version: string;
  enabled: boolean;
  scope: SkillScope;
  icon: string | null;
  category: SkillCategory;
  tags: string[];
  author: string | null;
  featured: boolean;
  weight: number;
  /** 管理员标记「新用户默认安装」 */
  autoInstall: boolean;
  disableModelInvocation: boolean;
  /** 已被人工覆盖的字段（重解析 frontmatter 时不覆盖这些） */
  overriddenFields: string[];
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface DbRow {
  id: number;
  name: string;
  title: string;
  description: string | null;
  content: string;
  version: string;
  enabled: boolean;
  scope_kind: SkillScopeKind;
  scope_roles: string[] | null;
  scope_dept_ids: number[] | null;
  scope_uids: string[] | null;
  icon: string | null;
  category: string | null;
  tags: string[] | null;
  author: string | null;
  featured: boolean | null;
  weight: number | null;
  auto_install: boolean | null;
  disable_model_invocation: boolean | null;
  overridden_fields: string[] | null;
  created_by: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

/**
 * 建表 + **增量迁移** + **存量回填**（全幂等）。
 *
 * 两点历史包袱必须处理，否则上缰即事故：
 *  ① 新增列全部用 `ADD COLUMN IF NOT EXISTS` + 安全默认值：老技能 category='other'、
 *     auto_install=false ⇒ **不会被自动预装、也不会消失**。
 *  ② 下发语义本次从「可见即可用」改成「可见 ∩ (已安装 ∪ 默认安装)」。若不回填，
 *     现有用户会**突然失去全部技能**。回填用一把幂等锁（skill_migrations 抢标记位）
 *     把「存量可见技能」写成「已安装」，语义与改造前等价。
 */
export async function ensureSkillsSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skills (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      content TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      enabled BOOL NOT NULL DEFAULT true,
      scope_kind TEXT NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all','role','dept','user')),
      scope_roles TEXT[] NOT NULL DEFAULT '{}',
      scope_dept_ids INT[] NOT NULL DEFAULT '{}',
      scope_uids TEXT[] NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills (enabled);`);

  // —— 增量列（技能市场元数据）——
  await db.pool.query(`
    ALTER TABLE skills
      ADD COLUMN IF NOT EXISTS icon TEXT,
      ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '${DEFAULT_SKILL_CATEGORY}',
      ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS author TEXT,
      ADD COLUMN IF NOT EXISTS featured BOOL NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS weight INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS auto_install BOOL NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS disable_model_invocation BOOL NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS overridden_fields TEXT[] NOT NULL DEFAULT '{}';
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_skills_category ON skills (category);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_skills_featured ON skills (featured);`);

  // —— 用户级安装与启停（安装/全局开关/按工作区覆盖）——
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_installs (
      uid TEXT NOT NULL,
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (uid, skill_id)
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_prefs (
      uid TEXT NOT NULL,
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      enabled BOOL NOT NULL,
      PRIMARY KEY (uid, skill_id)
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_workspace_prefs (
      uid TEXT NOT NULL,
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      workspace_key TEXT NOT NULL,
      enabled BOOL NOT NULL,
      PRIMARY KEY (uid, skill_id, workspace_key)
    );
  `);

  // —— 套件（一等实体）——
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_bundles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      enabled BOOL NOT NULL DEFAULT true,
      scope_kind TEXT NOT NULL DEFAULT 'all' CHECK (scope_kind IN ('all','role','dept','user')),
      scope_roles TEXT[] NOT NULL DEFAULT '{}',
      scope_dept_ids INT[] NOT NULL DEFAULT '{}',
      scope_uids TEXT[] NOT NULL DEFAULT '{}',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_bundle_items (
      bundle_id INT NOT NULL REFERENCES skill_bundles(id) ON DELETE CASCADE,
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (bundle_id, skill_id)
    );
  `);

  // —— 一次性迁移标记（抢到标记才执行回填；ON CONFLICT DO NOTHING RETURNING 行数 = 是否抢到）——
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_migrations (
      kind TEXT PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  /**
   * 收藏表（对齐专家侧 `agent_favorites`：账号级、与安装相互独立）。
   *
   * 为什么收藏要独立于安装：安装 = "我想让它进我的会话"（有副作用：落盘 + 注入）；
   * 收藏 = "先记下，以后再说"（纯标记）。混在一起会让"我只是想留个记号"变成"装了它"。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_favorites (
      uid TEXT NOT NULL,
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (uid, skill_id)
    );
  `);

  /**
   * 技能附属文件（多文件技能）：`path` 是**相对技能目录**的 POSIX 路径。
   *
   * 与 `skills.content` 的关系：`content` 就是 `SKILL.md` 本体（保持既有列不动，
   * 因为它是目录/详情/编辑的核心展示面）；其它文件都进这张表。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_files (
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT,
      content_b64 TEXT,
      size INT NOT NULL,
      sha256 TEXT NOT NULL,
      executable BOOL NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (skill_id, path),
      CHECK (content IS NOT NULL OR content_b64 IS NOT NULL)
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_skill_files_skill ON skill_files (skill_id);`);

  /**
   * 分类字典（中间方案）：编码仍是编译期常量，这里只放「中文名 / 顺序 / 启用」。
   * 与专家侧 `agent_categories` 同形（code/label/sort/enabled），避免两边两套心智。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_categories (
      code TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort INT NOT NULL DEFAULT 100,
      enabled BOOL NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_skill_categories_sort ON skill_categories (sort, code);`);

  // 种子**只在表为空时**写一次：否则管理员停用/改名的分类会在重启后复活，像是"改不掉"
  const catCount = await db.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM skill_categories");
  if (Number(catCount.rows[0]?.n ?? 0) === 0) {
    for (const seed of SKILL_CATEGORY_SEED) {
      await db.pool.query(
        `INSERT INTO skill_categories (code, label, sort) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
        [seed.code, seed.label, seed.sort],
      );
    }
  }

  /**
   * 使用量表（对齐专家侧 `agent_usage` 的口径：**按会话去重**）。
   *
   * 为什么按 (skill_id, session_id) 做主键：同一次会话里用户可能反复调用同一个技能，
   * 那不该被算成多次"使用"；口径与专家侧保持一致，前端两个市场才能放在一起看。
   * 上报走 `POST /me/skills/:name/use`，由 sidecar 在检测到 `/skill:<name>` 调用时旁路发出
   *（fire-and-forget，不阻塞对话）。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (skill_id, session_id)
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage (skill_id);`);

  /**
   * 卸载留痕表（"我明确不要它"）。
   *
   * 为什么必须有这张表：下发集包含 `auto_install`（默认安装）分支，而卸载原本只是
   * `DELETE FROM skill_installs` —— **删行即失忆**，于是用户主动卸载过的默认安装技能
   * 会在下一次同步时被**塞回来**（用户视角：删不掉）。留一行 dismissed 才能区分
   * 「从没装过」与「明确不想要」。
   */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS skill_dismissals (
      uid TEXT NOT NULL,
      skill_id INT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (uid, skill_id)
    );
  `);

  const claimed = await db.pool.query<{ kind: string }>(
    `INSERT INTO skill_migrations (kind) VALUES ('installs_backfill_v1') ON CONFLICT (kind) DO NOTHING RETURNING kind`,
  );
  if (claimed.rowCount === 1) {
    await db.pool.query(`
      INSERT INTO skill_installs (uid, skill_id, version)
      SELECT u.uid, s.id, s.version FROM users u CROSS JOIN skills s
      ON CONFLICT (uid, skill_id) DO NOTHING
    `);
  }

  /**
   * 分类口径收敛（11 类 → 5 类，产品拍板）。
   *
   * 用同样的“抢标记位”模式只跑一次：虽然 UPDATE 本身幂等、重跑也不贵，
   * 但存量库里的旧编码可能来自**别的分支**（比如并行开发的专家市场），
   * 加标记能保证“只在首次升级时归位一次”，后续写入一律由 normalizeSkillCategory 把关。
   */
  const claimedCategory = await db.pool.query<{ kind: string }>(
    `INSERT INTO skill_migrations (kind) VALUES ('category_v2') ON CONFLICT (kind) DO NOTHING RETURNING kind`,
  );
  if (claimedCategory.rowCount === 1) {
    await db.pool.query(`
      UPDATE skills SET category = CASE category
        WHEN 'finance' THEN 'office'
        WHEN 'efficiency' THEN 'office'
        WHEN 'business' THEN 'office'
        WHEN 'news' THEN 'content'
        WHEN 'education' THEN 'content'
        WHEN 'life' THEN 'other'
        ELSE category END
      WHERE category NOT IN ('office','dev','data','content','other')
    `);
  }
}

const SELECT = `
  SELECT id, name, title, description, content, version, enabled,
         scope_kind, scope_roles, scope_dept_ids, scope_uids, created_by, created_at, updated_at,
         icon, category, tags, author, featured, weight, auto_install, disable_model_invocation, overridden_fields
  FROM skills
`;

const iso = (v: Date | null): string | null => (v ? new Date(v).toISOString() : null);

function mapRow(r: DbRow): SkillRow {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    description: r.description,
    content: r.content,
    version: r.version,
    enabled: r.enabled,
    scope: {
      kind: r.scope_kind,
      roles: (r.scope_roles ?? []) as Role[],
      deptIds: r.scope_dept_ids ?? [],
      uids: r.scope_uids ?? [],
    },
    icon: r.icon,
    category: normalizeSkillCategory(r.category),
    tags: r.tags ?? [],
    author: r.author,
    featured: r.featured === true,
    weight: r.weight ?? 0,
    autoInstall: r.auto_install === true,
    disableModelInvocation: r.disable_model_invocation === true,
    overriddenFields: r.overridden_fields ?? [],
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** 技能标识：目录名安全（Agent Skills 规范：小写字母/数字/连字符，不得连续连字符，2-64） */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;

/** 元数据字段名（= frontmatter 可推导、后台可覆盖的字段）。
 *  `title` 不列在内：frontmatter 的 `name` 是技能标识，不能当展示名用，故 title 只由后台维护。 */
export const SKILL_META_FIELDS = ["description", "version", "icon", "category", "tags"] as const;
export type SkillMetaField = (typeof SKILL_META_FIELDS)[number];

export interface SkillMetaInput {
  description?: string | null;
  version?: string;
  icon?: string | null;
  category?: string;
  tags?: string[];
}

export interface SkillInput extends SkillMetaInput {
  name: string;
  title: string;
  content: string;
  enabled?: boolean;
  scope: SkillScope;
  author?: string | null;
  featured?: boolean;
  weight?: number;
  autoInstall?: boolean;
  createdBy?: string | null;
}

export async function listSkills(db: IdentityDb): Promise<SkillRow[]> {
  const { rows } = await db.pool.query<DbRow>(`${SELECT} ORDER BY id DESC`);
  return rows.map(mapRow);
}

export async function findSkillById(db: IdentityDb, id: number): Promise<SkillRow | null> {
  const { rows } = await db.pool.query<DbRow>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * 把「人工明确给出」的元数据字段记入 overridden_fields。
 * 判据：字段值 !== undefined —— 管理台提交空字符串仍是"明确给出"（空描述也是作者意图）。
 */
function overrideFieldsOf(input: SkillMetaInput): string[] {
  return SKILL_META_FIELDS.filter((f) => (input as Record<string, unknown>)[f] !== undefined);
}

/**
 * 单个元数据字段的取值优先级（frontmatter 优先、后台覆盖）。
 *  1) 本次请求明确给了值 → 用它（调用方已把它记入 overridden_fields）；
 *  2) 该字段曾被人工覆盖 → 保持库里的现值；
 *  3) 否则 frontmatter 有值就用它；没值 → 退回库里的现值（绝不因缺字段而归零）。
 */
function resolveMeta(_field: SkillMetaField, patchValue: unknown, currentValue: unknown, fmValue: unknown, overridden: boolean): unknown {
  if (patchValue !== undefined) return patchValue;
  if (overridden) return currentValue;
  const fmUsable = fmValue !== undefined && fmValue !== null && fmValue !== ""
    && !(Array.isArray(fmValue) && fmValue.length === 0);
  return fmUsable ? fmValue : currentValue;
}

/**
 * 分类归一：**统一走 shared 的 `normalizeSkillCategory`**（内部分类别名映射 + 小写/去空格）。
 *
 * 早期这里自带一份实现（只做白名单校验）——分类从 11 类收敛到 5 类后，那样会让存量
 * `finance` 这类旧编码直接落成 `other`（信息丢失），而别名表能把它们归到 `office`。
 * frontmatter 里写错分类不阻断保存，但要用统一口径落库。
 */
const normalizeCategory = normalizeSkillCategory;

/** tags 清洗：去重 + 逐个截断 + 总量截断（与 SKILL_LIMITS 一致） */
function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, SKILL_LIMITS.tagChars);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= SKILL_LIMITS.tags) break;
  }
  return out;
}

export async function createSkill(db: IdentityDb, input: SkillInput): Promise<SkillRow> {
  const overridden = overrideFieldsOf(input);
  const fm = parseSkillFrontmatter(input.content).meta;
  const ov = (f: SkillMetaField): boolean => overridden.includes(f);
  const description = resolveMeta("description", input.description, null, fm.description, ov("description")) as string | null | undefined;
  const version = resolveMeta("version", input.version, null, fm.version, ov("version")) as string | undefined;
  const icon = resolveMeta("icon", input.icon, null, fm.icon, ov("icon")) as string | null | undefined;
  const category = resolveMeta("category", input.category, null, fm.category, ov("category")) as string | undefined;
  const tags = resolveMeta("tags", input.tags, null, fm.tags, ov("tags")) as string[] | undefined;
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO skills (name, title, description, content, version, enabled, scope_kind, scope_roles, scope_dept_ids, scope_uids,
                         created_by, icon, category, tags, author, featured, weight, auto_install, disable_model_invocation, overridden_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [
      input.name,
      input.title,
      description ?? null,
      input.content,
      version ?? "1.0.0",
      input.enabled ?? true,
      input.scope.kind,
      input.scope.roles,
      input.scope.deptIds,
      input.scope.uids,
      input.createdBy ?? null,
      icon ?? null,
      normalizeCategory(category),
      normalizeTags(tags),
      input.author ?? null,
      input.featured ?? false,
      Math.max(0, Math.min(SKILL_LIMITS.weight, input.weight ?? 0)),
      input.autoInstall ?? false,
      fm.disableModelInvocation ?? false,
      overridden,
    ],
  );
  return (await findSkillById(db, rows[0]!.id))!;
}

export interface SkillPatch extends SkillMetaInput {
  title?: string;
  content?: string;
  enabled?: boolean;
  scope?: SkillScope;
  author?: string | null;
  featured?: boolean;
  weight?: number;
  autoInstall?: boolean;
  /** 清除这些字段的人工覆盖（此后重解析 frontmatter 会重新生效） */
  clearOverride?: string[];
}

export async function updateSkill(db: IdentityDb, id: number, patch: SkillPatch): Promise<SkillRow | null> {
  const current = await findSkillById(db, id);
  if (!current) return null;

  // 覆盖集：原有 ∪ 本次明确给出 − 本次清除
  const cleared = new Set(patch.clearOverride ?? []);
  const overridden = new Set([
    ...current.overriddenFields.filter((f) => !cleared.has(f)),
    ...overrideFieldsOf(patch),
  ]);

  // 元数据取值：本次明确给出 > 人工覆盖的现值 > frontmatter > 现值
  const content = patch.content ?? current.content;
  const fm = parseSkillFrontmatter(content).meta;
  const ov = (f: SkillMetaField): boolean => overridden.has(f);
  const description = resolveMeta("description", patch.description, current.description, fm.description, ov("description")) as string | null | undefined;
  const version = resolveMeta("version", patch.version, current.version, fm.version, ov("version")) as string | undefined;
  const icon = resolveMeta("icon", patch.icon, current.icon, fm.icon, ov("icon")) as string | null | undefined;
  const category = resolveMeta("category", patch.category, current.category, fm.category, ov("category")) as string | undefined;
  const tags = resolveMeta("tags", patch.tags, current.tags, fm.tags, ov("tags")) as string[] | undefined;

  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.title !== undefined) push("title", patch.title);
  push("description", description ?? null);
  if (patch.content !== undefined) push("content", patch.content);
  push("version", version ?? current.version);
  push("icon", icon ?? null);
  push("category", normalizeCategory(category));
  push("tags", normalizeTags(tags));
  push("disable_model_invocation", fm.disableModelInvocation ?? current.disableModelInvocation);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.author !== undefined) push("author", patch.author);
  if (patch.featured !== undefined) push("featured", patch.featured);
  if (patch.weight !== undefined) push("weight", Math.max(0, Math.min(SKILL_LIMITS.weight, patch.weight)));
  if (patch.autoInstall !== undefined) push("auto_install", patch.autoInstall);
  if (patch.scope !== undefined) {
    push("scope_kind", patch.scope.kind);
    push("scope_roles", patch.scope.roles);
    push("scope_dept_ids", patch.scope.deptIds);
    push("scope_uids", patch.scope.uids);
  }
  push("overridden_fields", [...overridden]);
  params.push(id);
  await db.pool.query(`UPDATE skills SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  return findSkillById(db, id);
}

export async function deleteSkill(db: IdentityDb, id: number): Promise<boolean> {
  const { rowCount } = await db.pool.query("DELETE FROM skills WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export interface SkillViewer {
  uid: string;
  role: Role;
  deptId: number | null;
}

/** 当前用户可见技能（enabled 且命中任一授权条件）。 */
export async function visibleSkillsFor(db: IdentityDb, viewer: SkillViewer): Promise<SkillRow[]> {
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

/**
 * 对外下发载荷：只给桌面端渲染/落盘需要的字段（不含授权细节）。
 *
 * 关键：Pi 资源加载器按 Agent Skills 规范解析 SKILL.md，必须有 YAML frontmatter
 * （name/description）；管理台只填「正文」也能用——此处按需合成 frontmatter。
 * 正文若已自带 frontmatter（`---` 开头）则原样保留，尊重作者。
 */
export interface SkillFileInput {
  path: string;
  /** 文本内容（与 contentB64 二选一） */
  content?: string;
  contentB64?: string;
  executable?: boolean;
}

/** 写入/覆盖技能附属文件（批量；调用方已做单文件与总量校验） */
export async function replaceSkillFiles(db: IdentityDb, skillId: number, files: SkillFileInput[]): Promise<void> {
  await db.pool.query("DELETE FROM skill_files WHERE skill_id = $1", [skillId]);
  for (const f of files) {
    const path = normalizeSkillFilePath(f.path);
    if (!path) continue;
    const body = typeof f.content === "string" ? f.content : "";
    const b64 = typeof f.contentB64 === "string" ? f.contentB64 : null;
    // 二进制要按 base64 **解码后**的字节取哈希 —— 见下方 sha 的注释
    const bytes = b64 ? Buffer.from(b64, "base64") : Buffer.from(body, "utf8");
    const size = bytes.length;
    if (size > SKILL_FILE_LIMITS.maxFileBytes) continue;
    // 哈希必须与**客户端落盘字节**同源：客户端比的是磁盘上 Buffer 的哈希（skills-sync.ts 的 sha256hex）。
    // 早先这里对 base64 文本取哈希，于是二进制附件的清单 sha 与客户端永远对不上 —— 后果有两层：
    // ①「本地已是最新」的短路永不命中，每次同步都重下；②下载后的守卫
    // （sha256hex(body) !== meta.sha256）判为不符而 continue，**文件根本不写盘**。
    // 文本附件两侧都是 UTF-8 字节，故只踩二进制这一条（theme-factory 的 PDF 展示稿就是这么丢的）。
    const sha = createHash("sha256").update(bytes).digest("hex");
    await db.pool.query(
      `INSERT INTO skill_files (skill_id, path, content, content_b64, size, sha256, executable)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [skillId, path, b64 ? null : body, b64, size, sha, f.executable === true],
    );
  }
}

/** 附属文件清单（**不含内容** —— 同步时只传清单，内容按需拉） */
export async function listSkillFiles(db: IdentityDb, skillId: number): Promise<SkillFileMeta[]> {
  const { rows } = await db.pool.query<{ path: string; size: number; sha256: string; executable: boolean }>(
    "SELECT path, size, sha256, executable FROM skill_files WHERE skill_id = $1 ORDER BY path",
    [skillId],
  );
  return rows.map((r) => ({ path: r.path, size: Number(r.size), sha256: r.sha256, executable: r.executable }));
}

/** 单个附属文件内容（按需拉取；越界路径一律 null） */
export async function readSkillFile(db: IdentityDb, skillId: number, path: string): Promise<SkillFileContent | null> {
  const safe = normalizeSkillFilePath(path);
  if (!safe) return null;
  const { rows } = await db.pool.query<{ path: string; content: string | null; content_b64: string | null; size: number; sha256: string; executable: boolean }>(
    "SELECT path, content, content_b64, size, sha256, executable FROM skill_files WHERE skill_id = $1 AND path = $2",
    [skillId, safe],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    path: row.path,
    size: Number(row.size),
    sha256: row.sha256,
    executable: row.executable,
    ...(row.content_b64 ? { contentB64: row.content_b64 } : { content: row.content ?? "" }),
  };
}

export function toSkillPayload(row: SkillRow): {
  name: string;
  title: string;
  description: string | null;
  content: string;
  version: string;
  disableModelInvocation: boolean;
} {
  const body = row.content.replace(/^\uFEFF/, "");
  const content = body.startsWith("---\n") || body.startsWith("---\r\n")
    ? body
    : frontmatter(row.name, row.description ?? row.title) + body;
  return {
    name: row.name,
    title: row.title,
    description: row.description,
    content,
    version: row.version,
    disableModelInvocation: row.disableModelInvocation,
  };
}

/** 合成 Agent Skills frontmatter（description 单行化并截断到 1024） */
function frontmatter(name: string, description: string): string {
  const safeDescription = description.replace(/\s+/g, " ").trim().slice(0, 1024);
  return `---\nname: ${name}\ndescription: ${safeDescription}\n---\n\n`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   技能市场：安装记录 / 启停状态 / 目录检索 / 精选 / 套件
   ═════════════════════════════════════════════════════════════════════════ */

/** 目录/列表查询的过滤条件（空串=不筛） */
export interface CatalogQuery {
  q?: string;
  category?: string;
  /** 标签筛选（精确匹配单个标签；标签是数组列，用 `= ANY(s.tags)`） */
  tag?: string;
  /** 只看我收藏的（与「我安装的」抽屉并列的另一种视图） */
  favoritedOnly?: boolean;
  sort?: "name" | "hot" | "new";
  page?: number;
  pageSize?: number;
}

/**
 * 目录行 = 技能基础字段 + 该请求者的安装/启用态 + 热度。
 *
 * 一处细节：**列表不返回 content**（正文可能很大，目录页不需要），
 * 详情/下发才带 —— 否则一页 24 张卡就能拉下几 Mb。
 */
interface CatalogRow extends DbRow {
  hot: string | number;
  uses: string | number;
  installed: boolean;
  enabled: boolean;
  /** 管理员开关（与上面的 enabled 不同：那个是用户的启停偏好） */
  skill_enabled: boolean;
  favorited: boolean;
  installed_version: string | null;
}

/**
 * 目录 SELECT 片段。**workspaceKey 的占位序号由调用点决定**（`wsIndex`）：
 * 固定成 $4 会让"不引用 workspaceKey 的查询"（如 COUNT）出现
 * `could not determine data type of parameter $4`（42P18）——PG 要求每个占位符都能推断类型。
 */
function catalogSelectSql(wsIndex: number): string {
  return `
  SELECT s.id, s.name, s.title, s.description, ''::text AS content, s.version, s.enabled,
         -- 管理员开关的别名：下方的 enabled 列被用户启停偏好占用了（同名时后一个赢），
         -- 「我安装的」需要区分“管理员已下架”与“用户自己关了”，所以另取一列。
         s.enabled AS skill_enabled,
         s.scope_kind, s.scope_roles, s.scope_dept_ids, s.scope_uids, s.created_by, s.created_at, s.updated_at,
         s.icon, s.category, s.tags, s.author, s.featured, s.weight, s.auto_install,
         s.disable_model_invocation, s.overridden_fields,
         (SELECT COUNT(*) FROM skill_installs si WHERE si.skill_id = s.id) AS hot,
         (SELECT COUNT(*) FROM skill_usage su WHERE su.skill_id = s.id) AS uses,
         EXISTS (SELECT 1 FROM skill_installs i WHERE i.skill_id = s.id AND i.uid = $3) AS installed,
         EXISTS (SELECT 1 FROM skill_favorites f WHERE f.skill_id = s.id AND f.uid = $3) AS favorited,
         COALESCE(
           (SELECT w.enabled FROM skill_workspace_prefs w WHERE w.skill_id = s.id AND w.uid = $3 AND w.workspace_key = $${wsIndex}),
           (SELECT p.enabled FROM skill_prefs p WHERE p.skill_id = s.id AND p.uid = $3),
           true
         ) AS enabled,
         (SELECT i2.version FROM skill_installs i2 WHERE i2.skill_id = s.id AND i2.uid = $3) AS installed_version
  FROM skills s
`;
}

/**
 * 目录过滤条件：q 在 base、category 在 base+1、tag 在 base+2
 *（调用点保证这三个参数连续且都被引用 —— PG 要求每个占位符都能推断类型，否则 42P18）。
 */
function catalogWhere(base: number, favoritedOnly = false): string {
  return [
    CATALOG_VISIBLE,
    `($${base}::text IS NULL OR s.name ILIKE $${base} OR s.title ILIKE $${base} OR COALESCE(s.description,'') ILIKE $${base})`,
    `($${base + 1}::text IS NULL OR s.category = $${base + 1})`,
    `($${base + 2}::text IS NULL OR $${base + 2} = ANY(s.tags))`,
  ].join(" AND ") + (base === 4 && favoritedOnly ? ` AND EXISTS (SELECT 1 FROM skill_favorites f2 WHERE f2.skill_id = s.id AND f2.uid = $3)` : "");
}


/** 可见性谓词（$1=role, $2=deptId, $3=uid —— 与 visibilitySql 的参数位对齐） */
const CATALOG_VISIBLE = `s.enabled = true AND ${visibilitySql({
  kind: "s.scope_kind",
  roles: "s.scope_roles",
  deptIds: "s.scope_dept_ids",
  uids: "s.scope_uids",
})}`;

function mapCatalogRow(r: CatalogRow): SkillCatalogItem {
  const base = mapRow(r);
  return {
    id: base.id,
    name: base.name,
    title: base.title,
    description: base.description,
    icon: base.icon,
    category: base.category,
    tags: base.tags,
    author: base.author,
    version: base.version,
    featured: base.featured,
    hot: Number(r.hot ?? 0),
    uses: Number(r.uses ?? 0),
    autoInstall: base.autoInstall,
    disableModelInvocation: base.disableModelInvocation,
    updatedAt: base.updatedAt,
    installed: r.installed === true,
    favorited: r.favorited === true,
    enabled: r.enabled !== false,
    hasUpdate: r.installed_version != null && r.installed_version !== base.version,
  };
}

/** 目录检索（搜索/分类/排序/分页）；只返回该用户可见的技能 */
export async function catalogFor(
  db: IdentityDb,
  viewer: SkillViewer,
  workspaceKey: string,
  query: CatalogQuery,
): Promise<SkillCatalogPage> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.max(1, Math.min(60, query.pageSize ?? 24));
  const q = (query.q ?? "").trim();
  const category = (query.category ?? "").trim();
  const sort = query.sort ?? "name";
  const tag = (query.tag ?? "").trim();
  // 参数位约定：$1=role $2=deptId $3=uid $4=q $5=category $6=tag $7=workspaceKey $8=limit $9=offset
  const filterParams = [viewer.role, viewer.deptId, viewer.uid, q ? `%${q}%` : null, category || null, tag || null];
  const where = catalogWhere(4, query.favoritedOnly === true);
  // 「最热」= 使用量优先、安装量次之（与专家市场同口径；两个市场放一起看才不打架）
  const order = sort === "hot"
    ? "uses DESC, hot DESC, s.title ASC"
    : sort === "new"
      ? "s.updated_at DESC, s.title ASC"
      : "s.title ASC";

  const totalRes = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM skills s WHERE ${where}`,
    filterParams,
  );
  const { rows } = await db.pool.query<CatalogRow>(
    `${catalogSelectSql(7)} WHERE ${where} ORDER BY ${order} LIMIT $8 OFFSET $9`,
    [...filterParams, workspaceKey, pageSize, (page - 1) * pageSize],
  );
  return {
    items: rows.map(mapCatalogRow),
    total: Number(totalRes.rows[0]?.count ?? 0),
    page,
    pageSize,
  };
}

/** 单技能目录项（详情弹层/安装后局部刷新用；仍不含 content） */
export async function catalogItemFor(
  db: IdentityDb,
  viewer: SkillViewer,
  workspaceKey: string,
  name: string,
): Promise<SkillCatalogItem | null> {
  const { rows } = await db.pool.query<CatalogRow>(
    `${catalogSelectSql(4)} WHERE ${CATALOG_VISIBLE} AND s.name = $5 LIMIT 1`,
    [viewer.role, viewer.deptId, viewer.uid, workspaceKey, name],
  );
  return rows[0] ? mapCatalogRow(rows[0]) : null;
}

/**
 * 精选（「换一换」）。
 *
 * 用 `hashtext(name || nonce)` 做**可复现的伪随机**而非 `random()`：
 *  - 同一个 nonce 必得同一批 → 可写断言、刷新页面不会跳；
 *  - nonce 一变就是另一批 → 就是「换一换」的语义；
 *  - 乘 weight 做加权（weight=0 也有基础权重 1，不会被永久雪藏）。
 */
export async function featuredFor(
  db: IdentityDb,
  viewer: SkillViewer,
  workspaceKey: string,
  nonce: string,
  limit: number,
): Promise<SkillCatalogItem[]> {
  const { rows } = await db.pool.query<CatalogRow>(
    `${catalogSelectSql(4)}
     WHERE ${CATALOG_VISIBLE} AND s.featured = true
     ORDER BY (abs(hashtext(s.name || $5)) % 100000) * GREATEST(s.weight, 1) DESC
     LIMIT $6`,
    [viewer.role, viewer.deptId, viewer.uid, workspaceKey, nonce, Math.max(1, Math.min(24, limit))],
  );
  return rows.map(mapCatalogRow);
}

/** 「我安装的」列表（含安装时间与 hasUpdate） */
/**
 * 「我安装的」列表：**含已下架的**（软下架要能在界面上看到并标出来）。
 * `available=false` 表示已下架：卡片置灰、开关禁用，但仍在列表里。
 */
export async function installedSkillsFor(
  db: IdentityDb,
  viewer: SkillViewer,
  workspaceKey: string,
): Promise<SkillInstalledItem[]> {
  const { rows } = await db.pool.query<CatalogRow & { installed_at: Date | null }>(
    `${catalogSelectSql(4)}
     WHERE EXISTS (SELECT 1 FROM skill_installs i3 WHERE i3.skill_id = s.id AND i3.uid = $3)
       AND ${visibilitySql({ kind: "s.scope_kind", roles: "s.scope_roles", deptIds: "s.scope_dept_ids", uids: "s.scope_uids" })}
     ORDER BY s.title ASC`,
    [viewer.role, viewer.deptId, viewer.uid, workspaceKey],
  );
  const installedAt = new Map<string, Date | null>();
  const atRows = await db.pool.query<{ name: string; installed_at: Date | null }>(
    `SELECT s.name, i.installed_at FROM skill_installs i JOIN skills s ON s.id = i.skill_id WHERE i.uid = $1`,
    [viewer.uid],
  );
  for (const r of atRows.rows) installedAt.set(r.name, r.installed_at);
  return rows.map((r) => ({
    ...mapCatalogRow(r),
    installedAt: iso(installedAt.get(r.name) ?? null),
    available: r.skill_enabled !== false,
  }));
}

/**
 * 下发集 = **可见 ∩ (已安装 ∪ 默认安装)**。
 * 启停不参与此处：停用不改文件（文件在=已安装），只在会话创建时做内核过滤。
 */
/**
 * 下发集（决定**磁盘上留哪些文件**）。
 *
 * 语义（产品拍板）：
 *  - 用户装过的 → **无条件保留下发**，即使管理员已停用。停用只是“软下架”：不注入会话、界面上标
 *    「已下架」，但**不静默删用户的文件**（否则用户会报障“技能莫名消失”，且他之前装的记录也跟着脏了）。
 *  - 默认安装（auto_install）→ 仅在仍上架时下发。
 *  - 授权范围被撤销（不在可见集）→ **硬收回**，文件会被 sync 删除（这是权限变更，不是软下架）。
 *
 * 注意：注入会话与否**不在这里**决定 —— 注入集走 `/me/skills/state`（恒过滤 enabled），
 * 保证下架技能“文件在、但内核看不到”。
 */
export async function deliverableSkillsFor(db: IdentityDb, viewer: SkillViewer): Promise<SkillRow[]> {
  const { rows } = await db.pool.query<DbRow>(
    `${SELECT} s
     WHERE ${visibilitySql({ kind: "s.scope_kind", roles: "s.scope_roles", deptIds: "s.scope_dept_ids", uids: "s.scope_uids" })}
       AND (EXISTS (SELECT 1 FROM skill_installs i WHERE i.skill_id = s.id AND i.uid = $3)
            -- 默认安装也要尊重"用户主动卸载过"：dismissal 一旦存在，除非用户自己再装回来，
            -- 否则不再自动下发（否则就是"删不掉的技能"）。
            OR (s.enabled = true AND s.auto_install = true
                AND NOT EXISTS (SELECT 1 FROM skill_dismissals d WHERE d.skill_id = s.id AND d.uid = $3)))
     ORDER BY s.name`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows.map(mapRow);
}

/** 每技能的解析后状态（替代死链 `/api/skills`；斜杠面板据此标注/排序） */
export async function skillStateFor(
  db: IdentityDb,
  viewer: SkillViewer,
  workspaceKey: string,
): Promise<SkillStateEntry[]> {
  const { rows } = await db.pool.query<{ name: string; enabled: boolean; disable_model_invocation: boolean }>(
    `SELECT s.name,
            COALESCE(
              (SELECT w.enabled FROM skill_workspace_prefs w WHERE w.skill_id = s.id AND w.uid = $3 AND w.workspace_key = $4),
              (SELECT p.enabled FROM skill_prefs p WHERE p.skill_id = s.id AND p.uid = $3),
              true
            ) AS enabled,
            s.disable_model_invocation
     FROM skills s
     WHERE s.enabled = true AND ${visibilitySql({ kind: "s.scope_kind", roles: "s.scope_roles", deptIds: "s.scope_dept_ids", uids: "s.scope_uids" })}
       AND (EXISTS (SELECT 1 FROM skill_installs i WHERE i.skill_id = s.id AND i.uid = $3)
            OR (s.auto_install = true
                AND NOT EXISTS (SELECT 1 FROM skill_dismissals d WHERE d.skill_id = s.id AND d.uid = $3)))
     ORDER BY s.name`,
    [viewer.role, viewer.deptId, viewer.uid, workspaceKey],
  );
  return rows.map((r) => ({ name: r.name, enabled: r.enabled !== false, disableModelInvocation: r.disable_model_invocation === true }));
}

/**
 * 标签清单（可见技能里实际出现的标签 + 计数）。
 *
 * 与 `categoriesInUse` 的区别：分类是**受控白名单**（5 类），标签是**自由词表** ——
 * 所以这里不做白名单，只统计"当前用户看得到的技能上真实存在的标签"，
 * 并且按使用频次降序（冷门到没人用的标签不该排在前面）。
 */
export async function tagsInUse(
  db: IdentityDb,
  viewer: SkillViewer,
): Promise<Array<{ tag: string; count: number }>> {
  const { rows } = await db.pool.query<{ tag: string; count: string }>(
    `SELECT t.tag, COUNT(*)::text AS count
     FROM skills s, unnest(s.tags) AS t(tag)
     WHERE ${CATALOG_VISIBLE}
     GROUP BY t.tag
     ORDER BY COUNT(*) DESC, t.tag ASC`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  return rows
    .map((r) => ({ tag: r.tag, count: Number(r.count ?? 0) }))
    .filter((r) => typeof r.tag === "string" && r.tag.length > 0);
}

/**
 * 受众预估（管理台排查"为什么他看不到/到底发给谁"）。
 *
 * 口径必须与可见性判据**逐条对齐**（`visibilitySql`）：all=全员、role=角色命中、
 * dept=**部门精确匹配（不展开子树）**、user=账号命中。两处口径不一致的话，
 * 管理台给出的数字会骗人 —— 比不显示更糟。
 */
export interface SkillAudience {
  scope: ResourceScope;
  enabled: boolean;
  autoInstall: boolean;
  /** 预计可见人数 */
  visibleUsers: number;
  /** 已安装人数 */
  installedUsers: number;
}

export async function skillAudienceFor(db: IdentityDb, skillId: number): Promise<SkillAudience | null> {
  const skill = await findSkillById(db, skillId);
  if (!skill) return null;
  const scope = skill.scope;
  const countUsers = async (): Promise<number> => {
    if (scope.kind === "all") {
      const r = await db.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
      return Number(r.rows[0]?.n ?? 0);
    }
    if (scope.kind === "role") {
      if (scope.roles.length === 0) return 0;
      const r = await db.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users WHERE role = ANY($1)", [scope.roles]);
      return Number(r.rows[0]?.n ?? 0);
    }
    if (scope.kind === "dept") {
      if (scope.deptIds.length === 0) return 0;
      const r = await db.pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM users WHERE department_id = ANY($1)",
        [scope.deptIds],
      );
      return Number(r.rows[0]?.n ?? 0);
    }
    if (scope.uids.length === 0) return 0;
    const r = await db.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users WHERE uid = ANY($1)", [scope.uids]);
    return Number(r.rows[0]?.n ?? 0);
  };
  const installed = await db.pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM skill_installs WHERE skill_id = $1",
    [skillId],
  );
  return {
    scope,
    enabled: skill.enabled,
    autoInstall: skill.autoInstall,
    visibleUsers: await countUsers(),
    installedUsers: Number(installed.rows[0]?.n ?? 0),
  };
}

/**
 * 分类清单（字典 + 计数）。
 *
 * 返回**代码常量里存在的编码**（字典缺行时用常量兜底 label/sort，避免"新加的编码界面没标签"），
 * 外加库中出现过的编码（历史/越界值也要能解释）。`enabled=false` 的原样返回，
 * 由调用方决定是否展示（客户端 chips 会过滤掉，但管理台要能看到并改回来）。
 */
export async function skillCategories(db: IdentityDb): Promise<SkillCategoryItem[]> {
  const { rows } = await db.pool.query<{ code: string; label: string; sort: number; enabled: boolean; n: number }>(
    `SELECT c.code, c.label, c.sort, c.enabled,
            (SELECT count(*)::int FROM skills s WHERE s.category = c.code) AS n
     FROM skill_categories c ORDER BY c.sort, c.code`,
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const used = await categoriesInUse(db);
  // 候选 = 代码常量 ∪ 库中在用 ∪ **字典里已有的行**
  // 最后一类的意义：管理员可能给一个越界编码（历史数据/手工插库）命名，之后它必须能被读回来，
  // 否则"改成功了但列表里看不到"，看起来像没生效。
  const codes: string[] = [...SKILL_CATEGORIES];
  for (const c of [...used, ...byCode.keys()]) if (!codes.includes(c)) codes.push(c);
  return codes.map((code, index) => {
    const row = byCode.get(code);
    return {
      code,
      label: row?.label ?? SKILL_CATEGORY_LABELS[code as SkillCategory] ?? code,
      sort: row?.sort ?? (index + 1) * 10,
      enabled: row?.enabled !== false,
      skillCount: row ? Number(row.n ?? 0) : 0,
    };
  });
}

/** 改字典（只允许改 label/sort/enabled —— 编码是编译期常量，这里刻意不支持新增/删除） */
export async function updateSkillCategory(
  db: IdentityDb,
  code: string,
  patch: { label?: string; sort?: number; enabled?: boolean },
): Promise<SkillCategoryItem | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.label !== undefined) push("label", patch.label);
  if (patch.sort !== undefined) push("sort", patch.sort);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (fields.length === 0) return (await skillCategories(db)).find((c) => c.code === code) ?? null;
  // 字典缺行时（例如库里有越界编码）先补一行，否则 UPDATE 影响 0 行、管理员以为"改了没生效"
  await db.pool.query(
    `INSERT INTO skill_categories (code, label, sort) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
    [code, SKILL_CATEGORY_LABELS[code as SkillCategory] ?? code, 999],
  );
  params.push(code);
  await db.pool.query(
    `UPDATE skill_categories SET ${fields.join(", ")}, updated_at = now() WHERE code = $${params.length}`,
    params,
  );
  return (await skillCategories(db)).find((c) => c.code === code) ?? null;
}

/** 分类清单：白名单 ∪ 库中实际出现的值（保证空库时前端 chips 不空） */
export async function categoriesInUse(db: IdentityDb): Promise<string[]> {
  const { rows } = await db.pool.query<{ category: string }>("SELECT DISTINCT category FROM skills");
  const present = rows.map((r) => r.category).filter((c) => typeof c === "string" && c.length > 0);
  // 归一后再并集：残留旧编码不会在前端冒出一个没有标签的空 chip
  return [...new Set([...SKILL_CATEGORIES, ...present.map((c) => normalizeSkillCategory(c))])];
}

/** 收藏 / 取消收藏（幂等：重复设置同一状态不报错） */
export async function setSkillFavorite(
  db: IdentityDb,
  uid: string,
  name: string,
  on: boolean,
): Promise<{ ok: boolean; favorited: boolean }> {
  const skill = await findSkillByName(db, name);
  if (!skill) return { ok: false, favorited: false };
  if (on) {
    await db.pool.query(
      `INSERT INTO skill_favorites (uid, skill_id) VALUES ($1, $2) ON CONFLICT (uid, skill_id) DO NOTHING`,
      [uid, skill.id],
    );
  } else {
    await db.pool.query("DELETE FROM skill_favorites WHERE uid = $1 AND skill_id = $2", [uid, skill.id]);
  }
  return { ok: true, favorited: on };
}

/**
 * 记录一次技能使用（**幂等**：同一会话重复调用只算一次）。
 * 返回 created 以便接口区分"首次上报"与"重复上报"（后者不是错误）。
 */
export async function recordSkillUse(
  db: IdentityDb,
  skillId: number,
  sessionId: string,
  uid: string,
): Promise<{ created: boolean }> {
  const r = await db.pool.query(
    `INSERT INTO skill_usage (skill_id, session_id, uid) VALUES ($1, $2, $3)
     ON CONFLICT (skill_id, session_id) DO NOTHING RETURNING skill_id`,
    [skillId, sessionId, uid],
  );
  return { created: (r.rowCount ?? 0) > 0 };
}

/** 安装（幂等；同时记录"安装时看到的版本"，用于 hasUpdate） */
export async function installSkill(db: IdentityDb, uid: string, name: string): Promise<{ ok: boolean; affected: string[] }> {
  const skill = await findSkillByName(db, name);
  if (!skill) return { ok: false, affected: [] };
  await db.pool.query(
    `INSERT INTO skill_installs (uid, skill_id, version) VALUES ($1, $2, $3)
     ON CONFLICT (uid, skill_id) DO UPDATE SET version = EXCLUDED.version, installed_at = now()`,
    [uid, skill.id, skill.version],
  );
  // 重新安装 = 撤销「我不要它」的意图，否则下一次同步又会因 dismissal 被踢掉（装了却不生效）。
  await db.pool.query("DELETE FROM skill_dismissals WHERE uid = $1 AND skill_id = $2", [uid, skill.id]);
  return { ok: true, affected: [skill.name] };
}

/** 卸载（连带清掉全局与各工作区开关：否则重装会莫名继承旧的停用态） */
export async function uninstallSkill(db: IdentityDb, uid: string, name: string): Promise<{ ok: boolean; affected: string[] }> {
  const skill = await findSkillByName(db, name);
  if (!skill) return { ok: false, affected: [] };
  await db.pool.query("DELETE FROM skill_installs WHERE uid = $1 AND skill_id = $2", [uid, skill.id]);
  await db.pool.query("DELETE FROM skill_prefs WHERE uid = $1 AND skill_id = $2", [uid, skill.id]);
  await db.pool.query("DELETE FROM skill_workspace_prefs WHERE uid = $1 AND skill_id = $2", [uid, skill.id]);
  // 留痕：区分「从没装过」与「主动卸载」（前者会被 auto_install 自动下发，后者不会）。
  // ON CONFLICT DO NOTHING：重复卸载不该刷新时间戳（否则“什么时候不要的”会被改掉）。
  await db.pool.query(
    `INSERT INTO skill_dismissals (uid, skill_id) VALUES ($1, $2) ON CONFLICT (uid, skill_id) DO NOTHING`,
    [uid, skill.id],
  );
  return { ok: true, affected: [skill.name] };
}

/** 仅更新安装记录里的版本（「更新」动作：重拉下发即可，但记录要对齐） */
export async function refreshInstalledVersion(db: IdentityDb, uid: string, name: string): Promise<void> {
  const skill = await findSkillByName(db, name);
  if (!skill) return;
  await db.pool.query(
    "UPDATE skill_installs SET version = $3, installed_at = now() WHERE uid = $1 AND skill_id = $2",
    [uid, skill.id, skill.version],
  );
}

/** 启停：无 workspaceKey = 全局；有 = 该工作区覆盖（优先于全局） */
export async function setSkillEnabled(
  db: IdentityDb,
  uid: string,
  name: string,
  enabled: boolean,
  workspaceKey?: string,
): Promise<{ ok: boolean }> {
  const skill = await findSkillByName(db, name);
  if (!skill) return { ok: false };
  if (workspaceKey && workspaceKey.trim()) {
    await db.pool.query(
      `INSERT INTO skill_workspace_prefs (uid, skill_id, workspace_key, enabled) VALUES ($1,$2,$3,$4)
       ON CONFLICT (uid, skill_id, workspace_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [uid, skill.id, workspaceKey.trim(), enabled],
    );
  } else {
    await db.pool.query(
      `INSERT INTO skill_prefs (uid, skill_id, enabled) VALUES ($1,$2,$3)
       ON CONFLICT (uid, skill_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [uid, skill.id, enabled],
    );
  }
  return { ok: true };
}

export async function findSkillByName(db: IdentityDb, name: string): Promise<SkillRow | null> {
  const { rows } = await db.pool.query<DbRow>(`${SELECT} WHERE name = $1`, [name]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** 清除某工作区的启停覆盖（回到“跟随全局”） */
export async function clearWorkspaceOverride(
  db: IdentityDb,
  uid: string,
  name: string,
  workspaceKey: string,
): Promise<{ ok: boolean }> {
  const skill = await findSkillByName(db, name);
  if (!skill) return { ok: false };
  await db.pool.query(
    "DELETE FROM skill_workspace_prefs WHERE uid = $1 AND skill_id = $2 AND workspace_key = $3",
    [uid, skill.id, workspaceKey],
  );
  return { ok: true };
}

/* ── 套件（一等实体）──────────────────────────────────────────────────── */

interface BundleRow {
  id: number;
  name: string;
  title: string;
  description: string | null;
  icon: string | null;
  enabled: boolean;
  scope_kind: SkillScopeKind;
  scope_roles: string[] | null;
  scope_dept_ids: number[] | null;
  scope_uids: string[] | null;
  created_by: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface SkillBundleRow {
  id: number;
  name: string;
  title: string;
  description: string | null;
  icon: string | null;
  enabled: boolean;
  scope: SkillScope;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const BUNDLE_SELECT = `
  SELECT id, name, title, description, icon, enabled, scope_kind, scope_roles, scope_dept_ids, scope_uids, created_by, created_at, updated_at
  FROM skill_bundles
`;

function mapBundle(r: BundleRow): SkillBundleRow {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    description: r.description,
    icon: r.icon,
    enabled: r.enabled,
    scope: {
      kind: r.scope_kind,
      roles: (r.scope_roles ?? []) as Role[],
      deptIds: r.scope_dept_ids ?? [],
      uids: r.scope_uids ?? [],
    },
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function listBundles(db: IdentityDb): Promise<SkillBundleRow[]> {
  const { rows } = await db.pool.query<BundleRow>(`${BUNDLE_SELECT} ORDER BY id DESC`);
  return rows.map(mapBundle);
}

export async function findBundleById(db: IdentityDb, id: number): Promise<SkillBundleRow | null> {
  const { rows } = await db.pool.query<BundleRow>(`${BUNDLE_SELECT} WHERE id = $1`, [id]);
  return rows[0] ? mapBundle(rows[0]) : null;
}

export interface BundleInput {
  name: string;
  title: string;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean;
  scope: SkillScope;
  /** 成员技能名（至少 1 个；服务端校验存在性） */
  members: string[];
  createdBy?: string | null;
}

export async function createBundle(db: IdentityDb, input: BundleInput): Promise<SkillBundleRow> {
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO skill_bundles (name, title, description, icon, enabled, scope_kind, scope_roles, scope_dept_ids, scope_uids, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [input.name, input.title, input.description ?? null, input.icon ?? null, input.enabled ?? true,
     input.scope.kind, input.scope.roles, input.scope.deptIds, input.scope.uids, input.createdBy ?? null],
  );
  await setBundleMembers(db, rows[0]!.id, input.members);
  return (await findBundleById(db, rows[0]!.id))!;
}

export interface BundlePatch {
  title?: string;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean;
  scope?: SkillScope;
  members?: string[];
}

export async function updateBundle(db: IdentityDb, id: number, patch: BundlePatch): Promise<SkillBundleRow | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown): void => {
    params.push(value);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.description !== undefined) push("description", patch.description);
  if (patch.icon !== undefined) push("icon", patch.icon);
  if (patch.enabled !== undefined) push("enabled", patch.enabled);
  if (patch.scope !== undefined) {
    push("scope_kind", patch.scope.kind);
    push("scope_roles", patch.scope.roles);
    push("scope_dept_ids", patch.scope.deptIds);
    push("scope_uids", patch.scope.uids);
  }
  if (fields.length > 0) {
    params.push(id);
    await db.pool.query(`UPDATE skill_bundles SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  }
  if (patch.members !== undefined) await setBundleMembers(db, id, patch.members);
  return findBundleById(db, id);
}

export async function deleteBundle(db: IdentityDb, id: number): Promise<boolean> {
  const { rowCount } = await db.pool.query("DELETE FROM skill_bundles WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

/** 覆盖式设置成员（事务：先清后插，避免半成品成员集） */
export async function setBundleMembers(db: IdentityDb, bundleId: number, names: string[]): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM skill_bundle_items WHERE bundle_id = $1", [bundleId]);
    if (names.length > 0) {
      await client.query(
        `INSERT INTO skill_bundle_items (bundle_id, skill_id)
         SELECT $1, s.id FROM skills s WHERE s.name = ANY($2::text[]) ON CONFLICT DO NOTHING`,
        [bundleId, names],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 套件成员名（校验与测试用） */
export async function bundleMemberNames(db: IdentityDb, bundleId: number): Promise<string[]> {
  const { rows } = await db.pool.query<{ name: string }>(
    "SELECT s.name FROM skill_bundle_items i JOIN skills s ON s.id = i.skill_id WHERE i.bundle_id = $1 ORDER BY s.name",
    [bundleId],
  );
  return rows.map((r) => r.name);
}

/** 用户可见套件（scope 命中且 enabled），带"可见成员数/已装数" */
export async function visibleBundlesFor(db: IdentityDb, viewer: SkillViewer): Promise<Array<SkillBundleRow & { memberCount: number; installedCount: number }>> {
  const { rows } = await db.pool.query<BundleRow & { member_count: string; installed_count: string }>(
    `${BUNDLE_SELECT.replace("FROM skill_bundles", "FROM skill_bundles b")}
     WHERE b.enabled = true AND ${visibilitySql({ kind: "b.scope_kind", roles: "b.scope_roles", deptIds: "b.scope_dept_ids", uids: "b.scope_uids" })}
     ORDER BY b.id DESC`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  // 成员计数按"对该用户可见"算（不可见的成员既不由套件装，也不该出现在数字里）
  const counts = await db.pool.query<{ bundle_id: number; member_count: string; installed_count: string }>(
    `SELECT i.bundle_id,
            COUNT(*) AS member_count,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM skill_installs si WHERE si.skill_id = s.id AND si.uid = $3)) AS installed_count
     FROM skill_bundle_items i JOIN skills s ON s.id = i.skill_id
     WHERE s.enabled = true AND ${visibilitySql({ kind: "s.scope_kind", roles: "s.scope_roles", deptIds: "s.scope_dept_ids", uids: "s.scope_uids" })}
     GROUP BY i.bundle_id`,
    [viewer.role, viewer.deptId, viewer.uid],
  );
  const byId = new Map(counts.rows.map((r) => [r.bundle_id, r]));
  return rows.map((r) => {
    const c = byId.get(r.id);
    return {
      ...mapBundle(r),
      memberCount: Number(c?.member_count ?? 0),
      installedCount: Number(c?.installed_count ?? 0),
    };
  });
}

/** 套件成员（按该用户可见性过滤后的目录项） */
export async function bundleMembersFor(db: IdentityDb, viewer: SkillViewer, workspaceKey: string, bundleId: number): Promise<SkillCatalogItem[]> {
  const { rows } = await db.pool.query<CatalogRow>(
    `${catalogSelectSql(4)}
     JOIN skill_bundle_items bi ON bi.skill_id = s.id AND bi.bundle_id = $5
     WHERE ${CATALOG_VISIBLE}
     ORDER BY s.title ASC`,
    [viewer.role, viewer.deptId, viewer.uid, workspaceKey, bundleId],
  );
  return rows.map(mapCatalogRow);
}

/** 批量安装套件里"该用户可见且 enabled"的成员（幂等） */
export async function installBundle(db: IdentityDb, viewer: SkillViewer, bundleId: number): Promise<{ ok: boolean; affected: string[] }> {
  const bundle = await findBundleById(db, bundleId);
  if (!bundle || !bundle.enabled) return { ok: false, affected: [] };
  const { rows } = await db.pool.query<{ name: string; version: string; id: number }>(
    `SELECT s.id, s.name, s.version FROM skill_bundle_items i JOIN skills s ON s.id = i.skill_id
     WHERE i.bundle_id = $4 AND s.enabled = true
       AND ${visibilitySql({ kind: "s.scope_kind", roles: "s.scope_roles", deptIds: "s.scope_dept_ids", uids: "s.scope_uids" })}`,
    [viewer.role, viewer.deptId, viewer.uid, bundleId],
  );
  for (const r of rows) {
    await db.pool.query(
      `INSERT INTO skill_installs (uid, skill_id, version) VALUES ($1,$2,$3)
       ON CONFLICT (uid, skill_id) DO UPDATE SET version = EXCLUDED.version, installed_at = now()`,
      [viewer.uid, r.id, r.version],
    );
    // 与单技能安装同口径：显式装套件也是“我要它”，必须撤销 dismissal，
    // 否则套件装完了成员却因旧 dismissal 仍不下发（用户看到“点了装但没装上”）。
    await db.pool.query("DELETE FROM skill_dismissals WHERE uid = $1 AND skill_id = $2", [viewer.uid, r.id]);
  }
  return { ok: true, affected: rows.map((r) => r.name) };
}
