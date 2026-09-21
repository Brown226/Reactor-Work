/**
 * Agent 数字人 HTTP 路由（A-1 管理面 / A-2 下发面 / v1 市场面）。
 *
 *  - /admin/agents*                    仅 platform_admin（增删改查 + 上架/市场字段）
 *  - /admin/agent-categories*   /admin/agent-tags*   字典维护（分类/标签库）
 *  - /me/agent-taxonomy                 市场字典（启用的分类 + 标签，客户端渲染 chips）
 *  - /me/agents                         市场目录（可见且已上架 + 我的安装/收藏关系）
 *  - /me/agents/:name/install           安装 / 卸载 / 启停（账号级）
 *  - /me/agents/:name/favorite          收藏开关
 *  - /me/agents/:name/use               使用量上报（会话维度，幂等）
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deptsExist, parseScope } from "../common/scope.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  AGENT_CODE_PATTERN,
  AGENT_LIMITS,
  isThinkingLevel,
  type AgentMutationResult,
} from "@reactor/shared";
import {
  AGENT_NAME_MAX,
  AGENT_NAME_PATTERN,
  agentTaxonomy,
  createAgent,
  createCategory,
  createTag,
  deleteAgent,
  deleteCategory,
  deleteTag,
  findAgentById,
  findCategory,
  findTag,
  installAgent,
  listAgents,
  marketAgentByName,
  marketAgentsFor,
  modelRefStatus,
  recordAgentUse,
  setInstallEnabled,
  toAgentPayload,
  toggleFavorite,
  unknownSkillNames,
  unknownTagNames,
  uninstallAgent,
  updateAgent,
  updateCategory,
  updateTag,
  type AgentViewer,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

const MAX_TITLE_CHARS = AGENT_LIMITS.titleChars;
const MAX_DESC_CHARS = AGENT_LIMITS.descChars;
const MAX_PERSONA_CHARS = 8_000;

/** 技能白名单：小写字母/数字/连字符；去重 */
function parseSkillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0);
  return [...new Set(names)];
}

/** 标签：去空白、按词表上限截断、去重、限条数（合法性由标签库校验负责） */
function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().slice(0, AGENT_LIMITS.labelChars))
    .filter((t) => t.length > 0);
  return [...new Set(tags)].slice(0, AGENT_LIMITS.tags);
}

/** 推荐开场白（D2）：同上，但保留原文（不 lowercase） */
function parseStarters(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const list = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().slice(0, AGENT_LIMITS.starterChars))
    .filter((t) => t.length > 0);
  return [...new Set(list)].slice(0, AGENT_LIMITS.starters);
}

function parseSessionType(raw: unknown): "code" | "work" | "general" | null {
  return raw === "code" || raw === "work" || raw === "general" ? raw : null;
}

function parsePolicyMode(raw: unknown): "readonly" | "balanced" | "trust" | "strict" | null {
  return raw === "readonly" || raw === "balanced" || raw === "trust" || raw === "strict" ? raw : null;
}

function parseAuthor(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, AGENT_LIMITS.authorChars) : null;
}

/**
 * 上架时间：`published: boolean` 是管理台开关的便捷形式（true → now），
 * `publishedAt: ISO | null` 给定时精确控制（可回填历史）。
 * 两者都不传 → 返回 undefined（PATCH 时保持原值，不得静默下架）。
 */
function parsePublished(body: Record<string, unknown>): string | null | undefined {
  if (typeof body.published === "boolean") return body.published ? new Date().toISOString() : null;
  if (body.publishedAt === null) return null;
  if (typeof body.publishedAt === "string" && body.publishedAt.trim()) {
    const t = Date.parse(body.publishedAt);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return undefined;
}

/** 请求者视角（与 /me/agents 同一口径，避免两处各拼一份 viewer） */
const viewerOf = (c: Ctx): AgentViewer => ({
  uid: c.get("claims").sub,
  role: c.get("claims").role,
  deptId: c.get("claims").deptId ?? null,
});

export function createAgentsRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可操作");
    await next();
  };
  app.use("/admin/agents", requireAdmin);
  app.use("/admin/agents/*", requireAdmin);

  // ===== 管理面（A-1）=====
  app.get("/admin/agents", async (c) => c.json({ agents: await listAgents(db) }));

  app.post("/admin/agents", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!AGENT_NAME_PATTERN.test(name) || name.length > AGENT_NAME_MAX) {
      return err(c, 400, "Agent 标识仅允许小写字母/数字/连字符（不连续，2-64）");
    }
    if (!title || title.length > MAX_TITLE_CHARS) return err(c, 400, `名称必填且不超过 ${MAX_TITLE_CHARS} 字`);
    const description = typeof body.description === "string" ? body.description.trim() : null;
    if (description && description.length > MAX_DESC_CHARS) return err(c, 400, `描述不超过 ${MAX_DESC_CHARS} 字`);
    const persona = typeof body.persona === "string" ? body.persona.trim() : null;
    if (persona && persona.length > MAX_PERSONA_CHARS) return err(c, 400, `人设不超过 ${MAX_PERSONA_CHARS} 字`);
    const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim().slice(0, 8) : null;
    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim().slice(0, 64) : null;
    const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim().slice(0, 128) : null;
    const skills = parseSkillNames(body.skills);
    const missing = await unknownSkillNames(db, skills);
    if (missing.length > 0) return err(c, 400, `技能不存在：${missing.join("、")}`);
    /*
     * 分类与标签（v1）：都是后台可维护的字典，写入时必须先存在。
     * 分类额外要求**启用**（停用 = 不再允许新指派）；标签只看存在性（见 repo.unknownTagNames 注释）。
     */
    if (body.category !== undefined && body.category !== null) {
      if (typeof body.category !== "string" || !AGENT_CODE_PATTERN.test(body.category)) {
        return err(c, 400, "分类标识不合法（小写字母/数字/连字符）");
      }
      const cat = await findCategory(db, body.category);
      if (!cat) return err(c, 400, `分类不存在：${body.category}（请先在管理后台创建）`);
      if (!cat.enabled) return err(c, 400, `分类已停用：${cat.label}`);
    }
    const tags = parseTags(body.tags);
    const unknownTags = await unknownTagNames(db, tags);
    if (unknownTags.length > 0) return err(c, 400, `标签不在标签库中：${unknownTags.join("、")}`);
    // T3-4b：模型目录已配置时，provider/modelId 必须是目录内条目（否则网关会 404）
    if (provider || modelId) {
      const ref = await modelRefStatus(db, provider, modelId);
      if (!ref.ok) return err(c, 400, `模型不存在或未启用：${provider ? `${provider}/` : ""}${modelId ?? "(未指定)"}`);
    }
    const parsed = parseScope(body.scope);
    if ("error" in parsed) return err(c, 400, parsed.error);
    if (!(await deptsExist(db, parsed.scope.deptIds))) return err(c, 400, "授权部门不存在");
    try {
      const agent = await createAgent(db, {
        name,
        title,
        description,
        emoji,
        persona,
        provider,
        modelId,
        skills,
        tags,
        category: typeof body.category === "string" ? body.category : null,
        official: body.official === true,
        author: parseAuthor(body.author),
        // 新建时可一并上架；不传 = 草稿（不进市场，符合「不确定就先不发」的默认）
        publishedAt: parsePublished(body) ?? null,
        preset: {
          sessionType: parseSessionType(body.sessionType),
          policyMode: parsePolicyMode(body.policyMode),
          thinkingLevel: isThinkingLevel(body.thinkingLevel) ? body.thinkingLevel : null,
          starters: parseStarters(body.starters),
        },
        scope: parsed.scope,
        enabled: body.enabled === undefined ? true : body.enabled === true,
        createdBy: c.get("claims").sub,
      });
      return c.json({ agent }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return err(c, 409, "Agent 标识已存在");
      throw e;
    }
  });

  app.patch("/admin/agents/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findAgentById(db, id) : null;
    if (!target) return err(c, 404, "Agent 不存在");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");

    const patch: Parameters<typeof updateAgent>[2] = {};
    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > MAX_TITLE_CHARS) return err(c, 400, `名称必填且不超过 ${MAX_TITLE_CHARS} 字`);
      patch.title = title;
    }
    if (body.description !== undefined) {
      const description = typeof body.description === "string" ? body.description.trim() : null;
      if (description && description.length > MAX_DESC_CHARS) return err(c, 400, `描述不超过 ${MAX_DESC_CHARS} 字`);
      patch.description = description;
    }
    if (body.persona !== undefined) {
      const persona = typeof body.persona === "string" ? body.persona.trim() : null;
      if (persona && persona.length > MAX_PERSONA_CHARS) return err(c, 400, `人设不超过 ${MAX_PERSONA_CHARS} 字`);
      patch.persona = persona;
    }
    if (body.emoji !== undefined) {
      patch.emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim().slice(0, 8) : null;
    }
    if (body.provider !== undefined) {
      patch.provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim().slice(0, 64) : null;
    }
    if (body.modelId !== undefined) {
      patch.modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim().slice(0, 128) : null;
    }
    if (body.skills !== undefined) {
      const skills = parseSkillNames(body.skills);
      const missing = await unknownSkillNames(db, skills);
      if (missing.length > 0) return err(c, 400, `技能不存在：${missing.join("、")}`);
      patch.skills = skills;
    }
    /* ===== v1 市场字段与预设包（与 POST 同口径；未传的字段不动）===== */
    if (body.tags !== undefined) {
      const tags = parseTags(body.tags);
      const unknownTags = await unknownTagNames(db, tags);
      if (unknownTags.length > 0) return err(c, 400, `标签不在标签库中：${unknownTags.join("、")}`);
      patch.tags = tags;
    }
    if (body.category !== undefined) {
      // null = 明确置为「未分类」；空串同样按未分类处理（管理台下拉的清空项）
      if (body.category === null || body.category === "") {
        patch.category = null;
      } else {
        if (typeof body.category !== "string" || !AGENT_CODE_PATTERN.test(body.category)) {
          return err(c, 400, "分类标识不合法（小写字母/数字/连字符）");
        }
        const cat = await findCategory(db, body.category);
        if (!cat) return err(c, 400, `分类不存在：${body.category}（请先在管理后台创建）`);
        /*
         * 注意：这里**不校验 cat.enabled**。
         * 停用的语义是「不再允许新指派」，而 PATCH 一个分类未变的专家（改描述/改标签）
         * 会因为该分类已被停用而整个保存失败 —— 那是运维事故。
         * 所以只拦「从无→有 / 换到另一个」停用分类的情况（见下）。
         */
        if (!cat.enabled && body.category !== target.category) {
          return err(c, 400, `分类已停用：${cat.label}`);
        }
        patch.category = body.category;
      }
    }
    if (body.official !== undefined) patch.official = body.official === true;
    if (body.author !== undefined) patch.author = parseAuthor(body.author);
    const published = parsePublished(body);
    if (published !== undefined) patch.publishedAt = published;
    const presetPatch: NonNullable<Parameters<typeof updateAgent>[2]["preset"]> = {};
    if (body.sessionType !== undefined) presetPatch.sessionType = parseSessionType(body.sessionType);
    if (body.policyMode !== undefined) presetPatch.policyMode = parsePolicyMode(body.policyMode);
    if (body.thinkingLevel !== undefined) {
      presetPatch.thinkingLevel = isThinkingLevel(body.thinkingLevel) ? body.thinkingLevel : null;
    }
    if (body.starters !== undefined) presetPatch.starters = parseStarters(body.starters);
    if (Object.keys(presetPatch).length > 0) patch.preset = presetPatch;
    // T3-4b：按「生效后」的取值校验模型引用（PATCH 可能只改其中一项）
    const effProvider = patch.provider !== undefined ? patch.provider : target.provider;
    const effModelId = patch.modelId !== undefined ? patch.modelId : target.modelId;
    if (patch.provider !== undefined || patch.modelId !== undefined) {
      const ref = await modelRefStatus(db, effProvider, effModelId);
      if (!ref.ok) {
        return err(c, 400, `模型不存在或未启用：${effProvider ? `${effProvider}/` : ""}${effModelId ?? "(未指定)"}`);
      }
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.scope !== undefined) {
      const parsed = parseScope(body.scope);
      if ("error" in parsed) return err(c, 400, parsed.error);
      if (!(await deptsExist(db, parsed.scope.deptIds))) return err(c, 400, "授权部门不存在");
      patch.scope = parsed.scope;
    }
    return c.json({ agent: await updateAgent(db, id, patch) });
  });

  app.delete("/admin/agents/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const ok = await deleteAgent(db, id);
    return ok ? c.json({ ok: true }) : err(c, 404, "Agent 不存在");
  });

  // ===== 字典维护（分类 / 标签库，v1）=====
  /** 分类与标签全量（含停用项 + 引用数）——管理台专用 */
  app.get("/admin/agent-taxonomy", async (c) => c.json(await agentTaxonomy(db)));

  /**
   * 新增分类。code 一旦创建不可改（存值靠它），label 才是可改的展示名。
   * 允许自由添加 —— 这正是「分类不写死在代码里」的目的。
   */
  app.post("/admin/agent-categories", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const code = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!AGENT_CODE_PATTERN.test(code) || code.length > AGENT_LIMITS.codeChars) {
      return err(c, 400, `分类标识仅允许小写字母/数字/连字符（不超过 ${AGENT_LIMITS.codeChars}）`);
    }
    if (!label || label.length > AGENT_LIMITS.labelChars) {
      return err(c, 400, `分类名称必填且不超过 ${AGENT_LIMITS.labelChars} 字`);
    }
    const sort = typeof body.sort === "number" && Number.isFinite(body.sort) ? Math.trunc(body.sort) : 100;
    try {
      const category = await createCategory(db, { code, label, sort, enabled: body.enabled !== false });
      return c.json({ category }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return err(c, 409, "分类标识已存在");
      throw e;
    }
  });

  app.patch("/admin/agent-categories/:code", async (c) => {
    const code = c.req.param("code");
    if (!(await findCategory(db, code))) return err(c, 404, "分类不存在");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const patch: { label?: string; sort?: number; enabled?: boolean } = {};
    if (body.label !== undefined) {
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label || label.length > AGENT_LIMITS.labelChars) {
        return err(c, 400, `分类名称必填且不超过 ${AGENT_LIMITS.labelChars} 字`);
      }
      patch.label = label;
    }
    if (body.sort !== undefined) {
      if (typeof body.sort !== "number" || !Number.isFinite(body.sort)) return err(c, 400, "sort 必须是数字");
      patch.sort = Math.trunc(body.sort);
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    return c.json({ category: await updateCategory(db, code, patch) });
  });

  /**
   * 删除分类：**有引用就拒绝**（409 + 引用数）。
   * 想下掉一个正在用的分类，正确姿势是 `enabled=false`（存量专家不受影响）。
   * 为什么不静默把专家改成「未分类」：那会让管理员的列表里凭空多出一批分类变了的专家。
   */
  app.delete("/admin/agent-categories/:code", async (c) => {
    const code = c.req.param("code");
    if (!(await findCategory(db, code))) return err(c, 404, "分类不存在");
    const res = await deleteCategory(db, code);
    if (!res.deleted) {
      return c.json(
        { error: { code: "409", message: `还有 ${res.used} 个专家在使用该分类，请先改为其它分类或将它停用` } },
        409,
      );
    }
    return c.json({ ok: true });
  });

  /**
   * 新增标签。name 就是展示值（受控词表），允许中文与空格。
   * 为何不做 code/label 分离：标签本身就是给人看的词组，不存在“改名不动存值”的需求；
   * 真要改名就是合并同义词，应当重建标签。
   */
  app.post("/admin/agent-tags", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > AGENT_LIMITS.labelChars) {
      return err(c, 400, `标签必填且不超过 ${AGENT_LIMITS.labelChars} 字`);
    }
    const sort = typeof body.sort === "number" && Number.isFinite(body.sort) ? Math.trunc(body.sort) : 100;
    try {
      const tag = await createTag(db, { name, sort, enabled: body.enabled !== false });
      return c.json({ tag }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return err(c, 409, "标签已存在");
      throw e;
    }
  });

  app.patch("/admin/agent-tags/:name", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const patch: { sort?: number; enabled?: boolean } = {};
    if (body.sort !== undefined) {
      if (typeof body.sort !== "number" || !Number.isFinite(body.sort)) return err(c, 400, "sort 必须是数字");
      patch.sort = Math.trunc(body.sort);
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    const tag = await updateTag(db, name, patch);
    return tag ? c.json({ tag }) : err(c, 404, "标签不存在");
  });

  app.delete("/admin/agent-tags/:name", async (c) => {
    const name = c.req.param("name");
    if (!(await findTag(db, name))) return err(c, 404, "标签不存在");
    const res = await deleteTag(db, name);
    if (!res.deleted) {
      return c.json(
        { error: { code: "409", message: `还有 ${res.used} 个专家在使用该标签，请先移除或将它停用` } },
        409,
      );
    }
    return c.json({ ok: true });
  });

  // ===== 市场面（v1）=====
  /**
   * 市场字典（客户端渲染 chips 用）：**只下发启用项**。
   * 停用的分类/标签不应在筛选栏出现（否则筛了必然是空列表，是假入口）。
   */
  app.get("/me/agent-taxonomy", async (c) => {
    const all = await agentTaxonomy(db);
    return c.json({ categories: all.categories.filter((x) => x.enabled), tags: all.tags.filter((x) => x.enabled) });
  });
  /**
   * 专家市场目录（D1）：可见且已上架 + 我的安装/收藏关系。
   * 分类/搜索/排序由客户端在本地做（专家量级为几十条，无需分页；见设计定稿第五节）。
   */
  app.get("/me/agents", async (c) => {
    const rows = await marketAgentsFor(db, viewerOf(c));
    return c.json({ agents: rows.map(toAgentPayload) });
  });

  /**
   * 写操作统一前置：取市场内专家（不在我的可见范围/未上架 → 404）。
   * 注意先取后写之间存在极小的 TOCTOU 窗口（并发下架）——
   * 代价只是多插一条安装关系，且下次同步即从市场消失，不值得为此上事务。
   */
  const marketTarget = async (c: Ctx, name: string) => marketAgentByName(db, viewerOf(c), name);

  /** 市场写操作统一返回（形状对齐 `SkillMutationResult`） */
  const ok = (c: Ctx, name: string, extra: Record<string, unknown> = {}): Response => {
    const payload: AgentMutationResult & Record<string, unknown> = { ok: true, affected: [name], ...extra };
    return c.json(payload);
  };

  // 安装（幂等；重复安装 = 重新启用，不报错）
  app.post("/me/agents/:name/install", async (c) => {
    const name = c.req.param("name");
    const target = await marketTarget(c, name);
    if (!target) return err(c, 404, "专家不存在或不可用");
    const { created } = await installAgent(db, c.get("claims").sub, target.id);
    return ok(c, name, { created });
  });

  // 卸载（幂等）
  app.delete("/me/agents/:name/install", async (c) => {
    const name = c.req.param("name");
    const target = await marketTarget(c, name);
    if (!target) return err(c, 404, "专家不存在或不可用");
    await uninstallAgent(db, c.get("claims").sub, target.id);
    return ok(c, name);
  });

  // 已安装专家的启停（不影响安装关系；首页选择器只看已启用）
  app.patch("/me/agents/:name/install", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.enabled !== "boolean") return err(c, 400, "enabled 必须是布尔值");
    const target = await marketTarget(c, name);
    if (!target) return err(c, 404, "专家不存在或不可用");
    const hit = await setInstallEnabled(db, c.get("claims").sub, target.id, body.enabled);
    // 未安装却想启停 → 409（语义冲突，比默默返回 ok 更诚实）
    if (!hit) return err(c, 409, "尚未安装该专家");
    return ok(c, name, { enabled: body.enabled });
  });

  // 收藏开关（返回最终态）
  app.post("/me/agents/:name/favorite", async (c) => {
    const name = c.req.param("name");
    const target = await marketTarget(c, name);
    if (!target) return err(c, 404, "专家不存在或不可用");
    const favorited = await toggleFavorite(db, c.get("claims").sub, target.id);
    return ok(c, name, { favorited });
  });

  /**
   * 使用量上报（真实热度，用户 2026-09-14）：桌面端在**用某个专家建出会话后**调一次。
   *
   *  - 幂等靠 `(agent_id, session_id)` 主键，重试/多设备重复上报不会虚高；
   *  - `sessionId` 必填：没有它就无法去重，宁可不计也不能错计；
   *  - 不校验是否已安装：使用量考的是“真在用”，与「装没装」是两件事
   *    （例如管理员自测、或从会话派生出来的新会话都可能没走安装入口）。
   */
  app.post("/me/agents/:name/use", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return err(c, 400, "sessionId 必填（使用量按会话去重）");
    const target = await marketTarget(c, name);
    if (!target) return err(c, 404, "专家不存在或不可用");
    const { created } = await recordAgentUse(db, target.id, sessionId, c.get("claims").sub);
    return ok(c, name, { created });
  });

  return app;
}
