/**
 * Skills 技能库 HTTP 路由（S-1 管理面 / S-2 下发面 / **技能市场**）。
 *
 * 鉴权：复用 identity authed 中间件注入的 claims。
 *  - /admin/skills* 仅 platform_admin（增删改查 + 元数据 + 套件）
 *  - /me/skills*    任意已登录用户（目录检索 / 安装 / 启停 / 下拉集）
 *
 * ## 本次行为变更（必须显式知道）
 * `GET /me/skills`（**落盘用**）从"全部可见"改为 **下发集 = 可见 ∩ (已安装 ∪ 默认安装)**。
 * 迁移由 repo 侧的一次性回填兜底（老用户"可见即已安装"），故用户侧不应感到技能突然消失。
 * 目录浏览走新的 `GET /me/skills/catalog`（不含正文，支持搜索/分类/排序/分页）。
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deptsExist, parseScope } from "../common/scope.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  SKILL_CATEGORIES,
  SKILL_FILE_LIMITS,
  SKILL_LIMITS,
  normalizeSkillFilePath,
  coerceSkillCategory,
  DEFAULT_SKILL_CATEGORY,
  parseSkillFrontmatter,
} from "@reactor/shared";
import {
  bundleMemberNames,
  bundleMembersFor,
  catalogFor,
  catalogItemFor,
  listSkillFiles,
  readSkillFile,
  replaceSkillFiles,
  skillCategories,
  updateSkillCategory,
  tagsInUse,
  clearWorkspaceOverride,
  createBundle,
  createSkill,
  deleteBundle,
  deleteSkill,
  deliverableSkillsFor,
  featuredFor,
  findBundleById,
  findSkillById,
  skillAudienceFor,
  findSkillByName,
  recordSkillUse,
  type SkillFileInput,
  setSkillFavorite,
  installBundle,
  installSkill,
  installedSkillsFor,
  listBundles,
  listSkills,
  refreshInstalledVersion,
  setSkillEnabled,
  skillStateFor,
  SKILL_NAME_MAX,
  SKILL_NAME_PATTERN,
  toSkillPayload,
  uninstallSkill,
  updateBundle,
  updateSkill,
  visibleBundlesFor,
  visibleSkillsFor,
  type SkillViewer,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

const MAX_CONTENT_CHARS = 200_000;
const MAX_TITLE_CHARS = 120;
const MAX_DESC_CHARS = 500;

/** 请求者视角（role/deptId/uid 三件套） */
const viewerOf = (c: Ctx): SkillViewer => {
  const claims = c.get("claims");
  return { uid: claims.sub, role: claims.role, deptId: claims.deptId ?? null };
};

const workspaceKeyOf = (c: Ctx): string => (c.req.query("workspaceKey") ?? "").trim();

/** 校验元数据字段（分类/标签/图标/权重），返回错误信息或 null */
function validateMeta(body: Record<string, unknown>): string | null {
  if (body.category !== undefined) {
    const raw = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
    // 别名（改造前的 11 类编码）也能通过，但会**归一后落库**：既不因历史脚本报 400，
    // 也不把 finance / news 这类旧值写进新库。真正的未知值仍然 400（不静默变「其他」）。
    if (raw && !coerceSkillCategory(raw)) {
      return `分类非法（允许：${SKILL_CATEGORIES.join(" / ")}）`;
    }
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return "tags 必须是数组";
    if (body.tags.length > SKILL_LIMITS.tags) return `标签最多 ${SKILL_LIMITS.tags} 个`;
    for (const t of body.tags) {
      if (typeof t !== "string") return "标签必须是字符串";
      if (t.trim().length > SKILL_LIMITS.tagChars) return `单个标签不超过 ${SKILL_LIMITS.tagChars} 字`;
    }
  }
  if (body.icon !== undefined && body.icon !== null) {
    if (typeof body.icon !== "string") return "图标必须是字符串";
    const icon = body.icon.trim();
    const isUrl = /^https?:\/\//i.test(icon);
    if (!isUrl && [...icon].length > SKILL_LIMITS.iconChars) return `图标（非 URL）不超过 ${SKILL_LIMITS.iconChars} 个字符`;
  }
  if (body.weight !== undefined) {
    if (!Number.isInteger(body.weight) || (body.weight as number) < 0 || (body.weight as number) > SKILL_LIMITS.weight) {
      return `权重必须是 0..${SKILL_LIMITS.weight} 的整数`;
    }
  }
  return null;
}

export function createSkillsRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可操作");
    await next();
  };
  app.use("/admin/skills", requireAdmin);
  app.use("/admin/skills/*", requireAdmin);
  app.use("/admin/bundles", requireAdmin);
  app.use("/admin/bundles/*", requireAdmin);

  // ===== 管理面（S-1）：技能 CRUD + 元数据 =====
  app.get("/admin/skills", async (c) => {
    const skills = await listSkills(db);
    return c.json({ skills });
  });

  app.post("/admin/skills", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    if (!SKILL_NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX) {
      return err(c, 400, "技能标识仅允许小写字母/数字/连字符（不连续，2-64）");
    }
    if (!title || title.length > MAX_TITLE_CHARS) return err(c, 400, `名称必填且不超过 ${MAX_TITLE_CHARS} 字`);
    if (!content.trim()) return err(c, 400, "SKILL.md 内容不能为空");
    if (content.length > MAX_CONTENT_CHARS) return err(c, 400, `SKILL.md 超过 ${MAX_CONTENT_CHARS} 字符上限`);
    const metaError = validateMeta(body);
    if (metaError) return err(c, 400, metaError);
    const parsed = parseScope(body.scope);
    if ("error" in parsed) return err(c, 400, parsed.error);
    if (!(await deptsExist(db, parsed.scope.deptIds))) return err(c, 400, "授权部门不存在");
    try {
      const skill = await createSkill(db, {
        name,
        title,
        content,
        scope: parsed.scope,
        createdBy: c.get("claims").sub,
        ...(typeof body.description === "string" ? { description: body.description.trim() } : {}),
        ...(typeof body.version === "string" && body.version.trim() ? { version: body.version.trim().slice(0, 32) } : {}),
        ...(body.icon !== undefined ? { icon: typeof body.icon === "string" ? body.icon.trim() : null } : {}),
        ...(typeof body.category === "string" ? { category: coerceSkillCategory(body.category) ?? undefined } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
        ...(typeof body.author === "string" ? { author: body.author.trim() } : {}),
        ...(body.featured !== undefined ? { featured: body.featured === true } : {}),
        ...(typeof body.weight === "number" ? { weight: body.weight } : {}),
        ...(body.autoInstall !== undefined ? { autoInstall: body.autoInstall === true } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      });
      return c.json({ skill }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return err(c, 409, "技能标识已存在");
      throw e;
    }
  });

  app.patch("/admin/skills/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findSkillById(db, id) : null;
    if (!target) return err(c, 404, "技能不存在");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const metaError = validateMeta(body);
    if (metaError) return err(c, 400, metaError);

    const patch: Parameters<typeof updateSkill>[2] = {};
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
    if (body.content !== undefined) {
      const content = typeof body.content === "string" ? body.content : "";
      if (!content.trim()) return err(c, 400, "SKILL.md 内容不能为空");
      if (content.length > MAX_CONTENT_CHARS) return err(c, 400, `SKILL.md 超过 ${MAX_CONTENT_CHARS} 字符上限`);
      patch.content = content;
    }
    if (body.version !== undefined) {
      const version = typeof body.version === "string" ? body.version.trim().slice(0, 32) : "";
      if (!version) return err(c, 400, "版本不能为空");
      patch.version = version;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.icon !== undefined) patch.icon = typeof body.icon === "string" ? body.icon.trim() : null;
    if (body.category !== undefined) patch.category = coerceSkillCategory(body.category) ?? DEFAULT_SKILL_CATEGORY;
    if (body.tags !== undefined) patch.tags = body.tags as string[];
    if (body.author !== undefined) patch.author = typeof body.author === "string" ? body.author.trim() : null;
    if (body.featured !== undefined) patch.featured = body.featured === true;
    if (body.weight !== undefined) patch.weight = body.weight as number;
    if (body.autoInstall !== undefined) patch.autoInstall = body.autoInstall === true;
    if (Array.isArray(body.clearOverride)) {
      patch.clearOverride = body.clearOverride.filter((f): f is string => typeof f === "string");
    }
    if (body.scope !== undefined) {
      const parsed = parseScope(body.scope);
      if ("error" in parsed) return err(c, 400, parsed.error);
      if (!(await deptsExist(db, parsed.scope.deptIds))) return err(c, 400, "授权部门不存在");
      patch.scope = parsed.scope;
    }
    const skill = await updateSkill(db, id, patch);
    return c.json({ skill });
  });

  /**
   * 重新从 frontmatter 解析元数据。
   * 实现上就是"提交一个只带 clearOverride 的空补丁"：updateSkill 对**未被人工覆盖**的字段
   * 总会以 frontmatter 为准重算（见 repo.resolveMeta），因此这条路径与保存时那条完全同源，
   * 不会出现"保存能解析、点按钮不解析"的两套行为。
   */
  app.post("/admin/skills/:id/parse", async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findSkillById(db, id) : null;
    if (!target) return err(c, 404, "技能不存在");
    const skill = await updateSkill(db, id, {});
    return c.json({ skill });
  });

  app.post("/admin/skills/:id/clear-override", async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findSkillById(db, id) : null;
    if (!target) return err(c, 404, "技能不存在");
    const body = (await c.req.json().catch(() => null)) as { fields?: unknown } | null;
    const fields = Array.isArray(body?.fields) ? body!.fields.filter((f): f is string => typeof f === "string") : [];
    if (fields.length === 0) return err(c, 400, "fields 不能为空");
    const skill = await updateSkill(db, id, { clearOverride: fields });
    return c.json({ skill });
  });

  app.delete("/admin/skills/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const ok = await deleteSkill(db, id);
    return ok ? c.json({ ok: true }) : err(c, 404, "技能不存在");
  });

  // ===== 管理面：技能附属文件（多文件技能）=====
  app.get("/admin/skills/:id/files", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await findSkillById(db, id))) return err(c, 404, "技能不存在");
    return c.json({ files: await listSkillFiles(db, id) });
  });

  /**
   * 批量替换技能附件（管理台整目录导入用）。
   *
   * 校验顺序刻意做成"先全量校验、再落库"：任何一个文件越界/超限都整批拒绝，
   * 而不是写一半留一半 —— 半套脚本比没有脚本更难排查。
   */
  app.put("/admin/skills/:id/files", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await findSkillById(db, id))) return err(c, 404, "技能不存在");
    const body = (await c.req.json().catch(() => null)) as { files?: unknown } | null;
    const raw = Array.isArray(body?.files) ? body!.files : null;
    if (!raw) return err(c, 400, "files 必须是数组");
    if (raw.length > SKILL_FILE_LIMITS.maxFiles) return err(c, 400, `文件数超过上限 ${SKILL_FILE_LIMITS.maxFiles}`);

    const inputs: SkillFileInput[] = [];
    let total = 0;
    const seen = new Set<string>();
    for (const item of raw) {
      const f = item as { path?: unknown; content?: unknown; contentB64?: unknown; executable?: unknown };
      const path = normalizeSkillFilePath(f.path);
      if (!path) return err(c, 400, `路径非法：${String(f.path).slice(0, 60)}`);
      if (seen.has(path)) return err(c, 400, `路径重复：${path}`);
      seen.add(path);
      const content = typeof f.content === "string" ? f.content : undefined;
      const contentB64 = typeof f.contentB64 === "string" ? f.contentB64 : undefined;
      if (content === undefined && contentB64 === undefined) return err(c, 400, `缺少内容：${path}`);
      const size = contentB64 !== undefined ? Buffer.from(contentB64, "base64").length : Buffer.byteLength(content ?? "", "utf8");
      if (size > SKILL_FILE_LIMITS.maxFileBytes) {
        return err(c, 400, `${path} 超过单文件上限 ${Math.round(SKILL_FILE_LIMITS.maxFileBytes / 1024)}KB`);
      }
      total += size;
      if (total > SKILL_FILE_LIMITS.maxTotalBytes) {
        return err(c, 400, `附件总量超过上限 ${Math.round(SKILL_FILE_LIMITS.maxTotalBytes / 1024 / 1024)}MB`);
      }
      inputs.push({ path, ...(content !== undefined ? { content } : {}), ...(contentB64 !== undefined ? { contentB64 } : {}), executable: f.executable === true });
    }
    await replaceSkillFiles(db, id, inputs);
    return c.json({ ok: true, files: await listSkillFiles(db, id) });
  });

  // ===== 管理面：分类字典（只允许改 label/sort/enabled）=====
  app.get("/admin/skill-categories", async (c) => {
    return c.json({ categories: await skillCategories(db) });
  });

  app.patch("/admin/skill-categories/:code", async (c) => {
    const code = c.req.param("code");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const patch: { label?: string; sort?: number; enabled?: boolean } = {};
    if (body.label !== undefined) {
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label) return err(c, 400, "名称不能为空");
      if (label.length > 24) return err(c, 400, "名称不超过 24 字");
      patch.label = label;
    }
    if (body.sort !== undefined) {
      if (!Number.isInteger(body.sort)) return err(c, 400, "排序必须是整数");
      patch.sort = body.sort as number;
    }
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    // 编码不在代码常量里 = 越界值：允许管理员给它命名（否则界面只能显示原始 code）
    const updated = await updateSkillCategory(db, code, patch);
    return updated ? c.json({ category: updated }) : err(c, 404, "分类不存在");
  });

  // ===== 管理面：套件 CRUD =====
  app.get("/admin/bundles", async (c) => {
    const bundles = await listBundles(db);
    const withMembers = await Promise.all(
      bundles.map(async (b) => ({ ...b, members: await bundleMemberNames(db, b.id) })),
    );
    return c.json({ bundles: withMembers });
  });

  app.post("/admin/bundles", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!SKILL_NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX) return err(c, 400, "套件标识仅允许小写字母/数字/连字符");
    if (!title || title.length > MAX_TITLE_CHARS) return err(c, 400, `套件名称必填且不超过 ${MAX_TITLE_CHARS} 字`);
    const parsed = parseScope(body.scope);
    if ("error" in parsed) return err(c, 400, parsed.error);
    if (!(await deptsExist(db, parsed.scope.deptIds))) return err(c, 400, "授权部门不存在");
    const members = Array.isArray(body.members) ? body.members.filter((m): m is string => typeof m === "string") : [];
    if (members.length === 0) return err(c, 400, "套件至少需要 1 个成员技能");
    for (const m of members) {
      if (!(await findSkillByName(db, m))) return err(c, 400, `成员技能不存在：${m}`);
    }
    try {
      const bundle = await createBundle(db, {
        name,
        title,
        description: typeof body.description === "string" ? body.description.trim() : null,
        icon: typeof body.icon === "string" ? body.icon.trim() : null,
        enabled: body.enabled === undefined ? true : body.enabled === true,
        scope: parsed.scope,
        members,
        createdBy: c.get("claims").sub,
      });
      return c.json({ bundle, members: await bundleMemberNames(db, bundle.id) }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return err(c, 409, "套件标识已存在");
      throw e;
    }
  });

  app.patch("/admin/bundles/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findBundleById(db, id) : null;
    if (!target) return err(c, 404, "套件不存在");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    const patch: Parameters<typeof updateBundle>[2] = {};
    if (body.title !== undefined) {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > MAX_TITLE_CHARS) return err(c, 400, `套件名称必填且不超过 ${MAX_TITLE_CHARS} 字`);
      patch.title = title;
    }
    if (body.description !== undefined) patch.description = typeof body.description === "string" ? body.description.trim() : null;
    if (body.icon !== undefined) patch.icon = typeof body.icon === "string" ? body.icon.trim() : null;
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.members !== undefined) {
      const members = Array.isArray(body.members) ? body.members.filter((m): m is string => typeof m === "string") : [];
      if (members.length === 0) return err(c, 400, "套件至少需要 1 个成员技能");
      for (const m of members) {
        if (!(await findSkillByName(db, m))) return err(c, 400, `成员技能不存在：${m}`);
      }
      patch.members = members;
    }
    if (body.scope !== undefined) {
      const parsed = parseScope(body.scope);
      if ("error" in parsed) return err(c, 400, parsed.error);
      if (!(await deptsExist(db, parsed.scope.deptIds))) return err(c, 400, "授权部门不存在");
      patch.scope = parsed.scope;
    }
    const bundle = await updateBundle(db, id, patch);
    return c.json({ bundle, members: await bundleMemberNames(db, id) });
  });

  app.delete("/admin/bundles/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const ok = await deleteBundle(db, id);
    return ok ? c.json({ ok: true }) : err(c, 404, "套件不存在");
  });

  /** 管理面用：某技能当前可见者列表规模（排查"为什么他看不到"） */
  app.get("/admin/skills/:id/audience", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const audience = await skillAudienceFor(db, id);
    if (!audience) return err(c, 404, "技能不存在");
    return c.json(audience);
  });

  // ===== 下发面（S-2）：**落盘集** = 可见 ∩ (已安装 ∪ 默认安装) =====
  app.get("/me/skills", async (c) => {
    const rows = await deliverableSkillsFor(db, viewerOf(c));
    // 附件只下发**清单**（path/size/sha），内容由客户端按需拉 —— 否则每次同步都要传几 MB
    const files = await Promise.all(rows.map((r) => listSkillFiles(db, r.id)));
    return c.json({
      skills: rows.map((r, i) => ({ ...toSkillPayload(r), files: files[i] ?? [] })),
    });
  });

  /** 兼容面：该用户可见的全部技能（不含安装过滤）—— 供排查/后续复用 */
  app.get("/me/skills/visible", async (c) => {
    const rows = await visibleSkillsFor(db, viewerOf(c));
    return c.json({ skills: rows.map(toSkillPayload) });
  });

  // ===== 技能市场：目录 / 精选 / 已安装 / 状态 / 分类 =====
  // 注意路由顺序：具体路径必须排在 `/me/skills/:name` 之前，否则会被参数路由吃掉。
  app.get("/me/skills/catalog", async (c) => {
    const sort = c.req.query("sort");
    const page = await catalogFor(db, viewerOf(c), workspaceKeyOf(c), {
      q: c.req.query("q") ?? "",
      category: c.req.query("category") ?? "",
      tag: c.req.query("tag") ?? "",
      favoritedOnly: c.req.query("favorited") === "1",
      sort: sort === "hot" || sort === "new" || sort === "name" ? sort : "name",
      page: Number(c.req.query("page") ?? 1) || 1,
      pageSize: Number(c.req.query("pageSize") ?? 24) || 24,
    });
    return c.json(page);
  });

  app.get("/me/skills/featured", async (c) => {
    const nonce = (c.req.query("nonce") ?? "").slice(0, 64);
    const limit = Number(c.req.query("limit") ?? 4) || 4;
    const items = await featuredFor(db, viewerOf(c), workspaceKeyOf(c), nonce, limit);
    return c.json({ items, nonce });
  });

  app.get("/me/skills/installed", async (c) => {
    const items = await installedSkillsFor(db, viewerOf(c), workspaceKeyOf(c));
    return c.json({ items });
  });

  app.get("/me/skills/state", async (c) => {
    const skills = await skillStateFor(db, viewerOf(c), workspaceKeyOf(c));
    return c.json({ skills });
  });

  /**
   * 使用上报（sidecar 在检测到 `/skill:<name>` 调用时旁路发出）。
   * 按 (skill, session) 去重：重复上报返回 200 + created:false，不是错误。
   */
  /**
   * 收藏 / 取消收藏（幂等）。
   * 与安装分开：收藏不改下发集与注入集，纯标记 —— 用户"先记下"不该产生副作用。
   */
  app.put("/me/skills/:name/favorite", async (c) => {
    const name = c.req.param("name");
    const skill = await findSkillByName(db, name);
    if (!skill) return err(c, 404, "技能不存在");
    const viewer = viewerOf(c);
    const visible = await visibleSkillsFor(db, viewer);
    if (!visible.some((sk) => sk.id === skill.id)) return err(c, 404, "技能不存在或对你不可见");
    const r = await setSkillFavorite(db, viewer.uid, name, true);
    return c.json({ ok: r.ok, favorited: r.favorited });
  });

  app.delete("/me/skills/:name/favorite", async (c) => {
    const name = c.req.param("name");
    const viewer = viewerOf(c);
    const r = await setSkillFavorite(db, viewer.uid, name, false);
    return r.ok ? c.json({ ok: true, favorited: false }) : err(c, 404, "技能不存在");
  });

  app.post("/me/skills/:name/use", async (c) => {
    const name = c.req.param("name");
    const skill = await findSkillByName(db, name);
    if (!skill) return err(c, 404, "技能不存在");
    const viewer = viewerOf(c);
    // 与其它用户面接口同口径：不可见/未上架的技能不接受上报（否则等于允许越权刷量）
    const visible = await visibleSkillsFor(db, viewer);
    if (!visible.some((sk) => sk.id === skill.id)) return err(c, 404, "技能不存在或对你不可见");
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return err(c, 400, "sessionId 必填（使用量按会话去重）");
    const { created } = await recordSkillUse(db, skill.id, sessionId, viewer.uid);
    return c.json({ ok: true, created });
  });

  /**
   * 按需拉取单个附属文件（同步时只比清单，内容哈希不一致才拉）。
   * 路径经 `normalizeSkillFilePath` 校验，越界一律 404（绝不返回目录外的东西）。
   */
  app.get("/me/skills/:name/file", async (c) => {
    const name = c.req.param("name");
    const skill = await findSkillByName(db, name);
    if (!skill) return err(c, 404, "技能不存在");
    const viewer = viewerOf(c);
    const visible = await deliverableSkillsFor(db, viewer);
    if (!visible.some((sk) => sk.id === skill.id)) return err(c, 404, "技能不存在或对你不可见");
    const file = await readSkillFile(db, skill.id, c.req.query("path") ?? "");
    if (!file) return err(c, 404, "文件不存在");
    return c.json({ file });
  });

  /** 标签清单（自由词表 + 计数；供目录 chips） */
  app.get("/me/skills/tags", async (c) => {
    const tags = await tagsInUse(db, viewerOf(c));
    return c.json({ tags });
  });

  /**
   * 分类字典（中间方案）：`{ code, label, sort, enabled, skillCount }`。
   *
   * 兼容性：仍返回 `categories`（启用中的 code 数组）—— 老客户端只认它也能继续工作；
   * 新客户端用 `items` 拿文案与顺序（改名/排序不发版）。停用的分类不出现在 `categories` 里。
   */
  app.get("/me/skills/categories", async (c) => {
    const items = (await skillCategories(db)).filter((x) => x.enabled);
    return c.json({ categories: items.map((x) => x.code), items });
  });

  /** 详情：目录字段 + 正文（详情弹层与"装完预览"用） */
  app.get("/me/skills/:name", async (c) => {
    const name = c.req.param("name");
    const item = await catalogItemFor(db, viewerOf(c), workspaceKeyOf(c), name);
    if (!item) return err(c, 404, "技能不存在或对你不可见");
    const row = await findSkillByName(db, name);
    const files = row ? await listSkillFiles(db, row.id) : [];
    return c.json({
      skill: item,
      content: row ? toSkillPayload(row).content : "",
      allowedTools: row ? allowedToolsOf(row.content) : [],
      // 附件清单（详情弹层展示"这个技能带哪些文件"）；内容不在此处下发
      files,
      filesTotalBytes: files.reduce((sum, f) => sum + f.size, 0),
    });
  });

  app.post("/me/skills/:name/install", async (c) => {
    const name = c.req.param("name");
    const visible = await catalogItemFor(db, viewerOf(c), workspaceKeyOf(c), name);
    if (!visible) return err(c, 404, "技能不存在或对你不可见");
    const r = await installSkill(db, viewerOf(c).uid, name);
    if (!r.ok) return err(c, 404, "技能不存在");
    const item = await catalogItemFor(db, viewerOf(c), workspaceKeyOf(c), name);
    return c.json({ ok: true, affected: r.affected, skill: item });
  });

  app.delete("/me/skills/:name/install", async (c) => {
    const name = c.req.param("name");
    const r = await uninstallSkill(db, viewerOf(c).uid, name);
    if (!r.ok) return err(c, 404, "技能不存在");
    return c.json({ ok: true, affected: r.affected });
  });

  /** 标记"已更新到当前版本"（客户端拉完下发集后调用，hasUpdate 随之归位） */
  app.post("/me/skills/:name/refresh", async (c) => {
    const name = c.req.param("name");
    await refreshInstalledVersion(db, viewerOf(c).uid, name);
    return c.json({ ok: true });
  });

  /** 启停：无 workspaceKey = 全局；有 = 该工作区覆盖（优先于全局） */
  app.put("/me/skills/:name/enabled", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.enabled !== "boolean") return err(c, 400, "enabled 必须是布尔值");
    const workspaceKey = typeof body.workspaceKey === "string" ? body.workspaceKey.trim() : "";
    const r = await setSkillEnabled(db, viewerOf(c).uid, name, body.enabled, workspaceKey || undefined);
    if (!r.ok) return err(c, 404, "技能不存在");
    const item = await catalogItemFor(db, viewerOf(c), workspaceKeyOf(c), name);
    return c.json({ ok: true, skill: item });
  });

  /** 清除该工作区的覆盖 → 回到“跟随全局”（三态的第三档） */
  app.delete("/me/skills/:name/enabled", async (c) => {
    const name = c.req.param("name");
    const workspaceKey = workspaceKeyOf(c);
    if (!workspaceKey) return err(c, 400, "必须带 workspaceKey（清除全局开关无意义）");
    const r = await clearWorkspaceOverride(db, viewerOf(c).uid, name, workspaceKey);
    if (!r.ok) return err(c, 404, "技能不存在");
    const item = await catalogItemFor(db, viewerOf(c), workspaceKey, name);
    return c.json({ ok: true, skill: item });
  });

  // ===== 套件（用户面）=====
  app.get("/me/bundles", async (c) => {
    const rows = await visibleBundlesFor(db, viewerOf(c));
    return c.json({
      bundles: rows.map((b) => ({
        id: b.id,
        name: b.name,
        title: b.title,
        description: b.description,
        icon: b.icon,
        enabled: b.enabled,
        memberCount: b.memberCount,
        installedCount: b.installedCount,
        allInstalled: b.memberCount > 0 && b.installedCount >= b.memberCount,
      })),
    });
  });

  app.get("/me/bundles/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const rows = await visibleBundlesFor(db, viewerOf(c));
    const summary = rows.find((b) => b.id === id);
    if (!summary) return err(c, 404, "套件不存在或对你不可见");
    const members = await bundleMembersFor(db, viewerOf(c), workspaceKeyOf(c), id);
    return c.json({
      bundle: {
        id: summary.id,
        name: summary.name,
        title: summary.title,
        description: summary.description,
        icon: summary.icon,
        enabled: summary.enabled,
        memberCount: summary.memberCount,
        installedCount: summary.installedCount,
        allInstalled: summary.memberCount > 0 && summary.installedCount >= summary.memberCount,
        members,
      },
    });
  });

  app.post("/me/bundles/:id/install", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const visible = await visibleBundlesFor(db, viewerOf(c));
    if (!visible.some((b) => b.id === id)) return err(c, 404, "套件不存在或对你不可见");
    const r = await installBundle(db, viewerOf(c), id);
    if (!r.ok) return err(c, 404, "套件不存在");
    return c.json({ ok: true, affected: r.affected });
  });

  return app;
}

/** 从 SKILL.md 正文抽 allowed-tools（详情弹层展示"它能调用什么工具"）
 *  复用 shared 的 frontmatter 解析器：与元数据抽取同一份实现，不再写第二套正则。 */
function allowedToolsOf(content: string): string[] {
  return parseSkillFrontmatter(content).meta.allowedTools ?? [];
}
