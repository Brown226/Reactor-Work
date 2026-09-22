/**
 * 规范库 HTTP 路由（RUL）：管理面 `/admin/rule-libraries/*` + 消费面 `/v1/rule-libraries/*`。
 *
 * 与另两个子域的差别：它是**两层资源**（库 + 库里的条文条目），所以路由带一层嵌套。
 * 嵌套路由的注册顺序在这里是有意义的：`/items/categories` 必须排在 `/items/:itemId` 之前，
 * 否则 "categories" 会被当成 itemId 命中（Hono 按注册顺序匹配）。
 *
 * 消费面只下发 `published` 库的**启用中**条目（见 repo.listRuleItemsForConsumer）：
 * draft 库还在编辑，端侧拿到半成品会让"同一文件 + 同一库 = 同一结论"这条纪律失效。
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import type { RuleLibraryStatus } from "./schema.js";
import {
  clearRuleItems,
  createRuleLibrary,
  deleteRuleItems,
  deleteRuleLibrary,
  getRuleItem,
  getRuleLibrary,
  insertRuleItems,
  listPublishedRuleLibraries,
  listRuleItemCategories,
  listRuleItems,
  listRuleItemsForConsumer,
  listRuleLibraries,
  updateRuleItem,
  updateRuleLibrary,
  type RuleItemInput,
  type RuleItemSortField,
  type RuleLibrarySortField,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409, message: string): Response =>
  c.json({ error: { code: String(status), message }, msg: message }, status);

const VALID_LIB_STATUS = new Set<RuleLibraryStatus>(["draft", "published", "archived"]);
const VALID_LIB_SORT = new Set<RuleLibrarySortField>(["name", "createdAt", "updatedAt"]);
const VALID_ITEM_SORT = new Set<RuleItemSortField>(["ruleCode", "category", "createdAt"]);

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可管理规范库");
  await next();
};

/** 同 standards/terminology：U+FFFD 是文本已损坏的确定信号。条文一旦写坏，
 *  以库审文会拿它去比对原文，产出无法解释的结论。 */
function hasReplacementChar(value: string): boolean {
  return value.includes("�");
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** 可空文本字段的统一读法：undefined = 不改；null 或空串 = 清空。 */
function readNullableText(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const text = String(raw).trim();
  return text === "" ? null : text;
}

function readRuleItemInput(record: Record<string, unknown>): RuleItemInput | null {
  const clauseText = readNullableText(record["clauseText"]) ?? null;
  const ruleName = readNullableText(record["ruleName"]) ?? null;
  // 条文与名称都空的行无法参与审查，也没有幂等键可算，直接丢弃。
  if (!clauseText && !ruleName) return null;
  for (const value of [clauseText, ruleName, record["checkPrompt"], record["sourceLocation"]]) {
    if (typeof value === "string" && hasReplacementChar(value)) return null;
  }
  return {
    ruleCode: readNullableText(record["ruleCode"]) ?? null,
    ruleName,
    category: readNullableText(record["category"]) ?? null,
    clauseText,
    checkPrompt: readNullableText(record["checkPrompt"]) ?? null,
    severity: typeof record["severity"] === "string" ? record["severity"] : null,
    mandatory: typeof record["mandatory"] === "string" ? record["mandatory"] : null,
    sourceLocation: readNullableText(record["sourceLocation"]) ?? null,
    clauseHash: typeof record["clauseHash"] === "string" ? record["clauseHash"] : null,
  };
}

export function createRuleLibraryAdminRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/admin/rule-libraries", requireAdmin);
  app.use("/admin/rule-libraries/*", requireAdmin);

  const audit = async (c: Ctx, entry: Parameters<typeof recordAdminAction>[2]): Promise<void> => {
    const claims = c.get("claims");
    if (!claims?.sub) return;
    await recordAdminAction(db, await resolveActorForClaims(db, claims), entry);
  };

  /* ── 库 ── */

  app.get("/admin/rule-libraries", async (c) => {
    const statusRaw = c.req.query("status");
    const sortRaw = c.req.query("sortField");
    const items = await listRuleLibraries(db, {
      search: c.req.query("search"),
      status: statusRaw && VALID_LIB_STATUS.has(statusRaw as RuleLibraryStatus) ? statusRaw : undefined,
      sortField: VALID_LIB_SORT.has(sortRaw as RuleLibrarySortField)
        ? (sortRaw as RuleLibrarySortField)
        : "updatedAt",
      sortOrder: c.req.query("sortOrder") === "asc" ? "asc" : "desc",
    });
    return c.json({ items, total: items.length });
  });

  app.post("/admin/rule-libraries", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!name) return err(c, 400, "name 不能为空");
    if (hasReplacementChar(name)) return err(c, 400, "name 含乱码字符，拒绝写入");
    const statusRaw = typeof body["status"] === "string" ? body["status"] : "draft";
    if (!VALID_LIB_STATUS.has(statusRaw as RuleLibraryStatus))
      return err(c, 400, `status 必须是 ${[...VALID_LIB_STATUS].join(" / ")} 之一`);
    const row = await createRuleLibrary(db, {
      name,
      description: readNullableText(body["description"]) ?? null,
      sourceFileName: readNullableText(body["sourceFileName"]) ?? null,
      status: statusRaw,
      standardNo: readNullableText(body["standardNo"]) ?? null,
      createdBy: c.get("claims")?.sub ?? null,
    });
    if (!row) return err(c, 409, "同名规范库已存在");
    await audit(c, { op: "rule-libraries.create", target: `library:${row.id}`, summary: row.name });
    return c.json(row, 201);
  });

  app.get("/admin/rule-libraries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const row = await getRuleLibrary(db, id);
    if (!row) return err(c, 404, "规范库不存在");
    return c.json(row);
  });

  app.patch("/admin/rule-libraries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<typeof updateRuleLibrary>[2] = {};
    if (typeof body["name"] === "string" && body["name"].trim()) {
      if (hasReplacementChar(body["name"])) return err(c, 400, "name 含乱码字符，拒绝写入");
      patch.name = body["name"].trim();
    }
    const description = readNullableText(body["description"]);
    if (description !== undefined) patch.description = description;
    const standardNo = readNullableText(body["standardNo"]);
    if (standardNo !== undefined) patch.standardNo = standardNo;
    if (typeof body["status"] === "string") {
      if (!VALID_LIB_STATUS.has(body["status"] as RuleLibraryStatus))
        return err(c, 400, `status 必须是 ${[...VALID_LIB_STATUS].join(" / ")} 之一`);
      patch.status = body["status"];
    }
    const row = await updateRuleLibrary(db, id, patch);
    if (!row) return err(c, 404, "规范库不存在");
    await audit(c, { op: "rule-libraries.update", target: `library:${id}` });
    return c.json(row);
  });

  app.delete("/admin/rule-libraries/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const result = await deleteRuleLibrary(db, id);
    if (result.deleted === 0) return err(c, 404, "规范库不存在");
    await audit(c, {
      op: "rule-libraries.delete",
      target: `library:${id}`,
      summary: `删除规范库，连带 ${result.deletedItems} 条条文`,
    });
    return c.json(result);
  });

  /* ── 条文/审点条目 ── */
  // 注册顺序：静态段 `/items/categories` 与 `/items/import` 必须早于 `/items/:itemId`。

  app.get("/admin/rule-libraries/:id/items/categories", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    return c.json({ items: await listRuleItemCategories(db, id) });
  });

  app.post("/admin/rule-libraries/:id/items/import", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await getRuleLibrary(db, id))) return err(c, 404, "规范库不存在");
    const body = (await c.req.json().catch(() => (null))) as { items?: unknown } | null;
    if (!body || !Array.isArray(body.items))
      return err(c, 400, "请求体必须是 { items: [...] }，且只接受 JSON");
    const items: RuleItemInput[] = [];
    for (const entry of body.items) {
      if (typeof entry !== "object" || entry === null) continue;
      const input = readRuleItemInput(entry as Record<string, unknown>);
      if (input) items.push(input);
    }
    if (items.length === 0) return err(c, 400, "items 里没有可用条目");
    const inserted = await insertRuleItems(db, id, items);
    await audit(c, {
      op: "rule-libraries.import_items",
      target: `library:${id}`,
      summary: `导入条文 ${inserted} 条（收到 ${items.length}，跳过 ${items.length - inserted}）`,
    });
    return c.json({ received: items.length, inserted, skipped: items.length - inserted });
  });

  app.post("/admin/rule-libraries/:id/items/bulk-delete", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((value) => Number.isInteger(value))
      : [];
    if (ids.length === 0) return err(c, 400, "ids 不能为空");
    const deleted = await deleteRuleItems(db, id, ids);
    await audit(c, {
      op: "rule-libraries.bulk_delete_items",
      target: `library:${id}`,
      summary: `批量删除条文 ${deleted} 条`,
    });
    return c.json({ deleted });
  });

  app.get("/admin/rule-libraries/:id/items", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const page = readPositiveInt(c.req.query("page"), 1, 100_000);
    const pageSize = readPositiveInt(c.req.query("pageSize"), 20, 200);
    const enabledRaw = c.req.query("enabled");
    const sortRaw = c.req.query("sortField");
    const result = await listRuleItems(db, id, {
      page,
      pageSize,
      search: c.req.query("search"),
      category: c.req.query("category"),
      enabled: enabledRaw === undefined ? undefined : enabledRaw === "true",
      sortField: VALID_ITEM_SORT.has(sortRaw as RuleItemSortField)
        ? (sortRaw as RuleItemSortField)
        : "ruleCode",
      sortOrder: c.req.query("sortOrder") === "desc" ? "desc" : "asc",
    });
    return c.json({ items: result.items, total: result.total, page, pageSize });
  });

  app.post("/admin/rule-libraries/:id/items", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await getRuleLibrary(db, id))) return err(c, 404, "规范库不存在");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const input = readRuleItemInput(body);
    if (!input) return err(c, 400, "clauseText 与 ruleName 至少要有一个（且不能含乱码字符）");
    const inserted = await insertRuleItems(db, id, [input]);
    // 幂等键命中 = 这条条文已经在了。返回 409 而不是 201，管理台才会提示"已存在"，
    // 而不是刷新后"新加的那条不见了"。
    if (inserted === 0) return err(c, 409, "该条文已存在于本库（内容相同）");
    const items = await listRuleItems(db, id, { page: 1, pageSize: 1, search: input.ruleCode ?? undefined });
    await audit(c, { op: "rule-libraries.create_item", target: `library:${id}` });
    return c.json(items.items[0] ?? null, 201);
  });

  app.delete("/admin/rule-libraries/:id/items", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const cleared = await clearRuleItems(db, id);
    await audit(c, {
      op: "rule-libraries.clear_items",
      target: `library:${id}`,
      summary: `清空条文 ${cleared} 条`,
    });
    return c.json({ cleared });
  });

  app.get("/admin/rule-libraries/:id/items/:itemId", async (c) => {
    const itemId = Number(c.req.param("itemId"));
    if (!Number.isInteger(itemId)) return err(c, 400, "itemId 非法");
    const row = await getRuleItem(db, itemId);
    if (!row) return err(c, 404, "条文不存在");
    return c.json(row);
  });

  app.patch("/admin/rule-libraries/:id/items/:itemId", async (c) => {
    const libraryId = Number(c.req.param("id"));
    const itemId = Number(c.req.param("itemId"));
    if (!Number.isInteger(libraryId) || !Number.isInteger(itemId)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<typeof updateRuleItem>[2] = {};
    for (const key of ["ruleCode", "ruleName", "category", "clauseText", "checkPrompt", "sourceLocation"] as const) {
      const value = readNullableText(body[key]);
      if (value === undefined) continue;
      if (value && hasReplacementChar(value)) return err(c, 400, `${key} 含乱码字符，拒绝写入`);
      patch[key] = value;
    }
    if (typeof body["severity"] === "string") patch.severity = body["severity"];
    if (typeof body["mandatory"] === "string") patch.mandatory = body["mandatory"];
    if (typeof body["enabled"] === "boolean") patch.enabled = body["enabled"];
    const row = await updateRuleItem(db, itemId, patch);
    if (!row) return err(c, 404, "条文不存在");
    await audit(c, { op: "rule-libraries.update_item", target: `item:${itemId}` });
    return c.json(row);
  });

  app.delete("/admin/rule-libraries/:id/items/:itemId", async (c) => {
    const libraryId = Number(c.req.param("id"));
    const itemId = Number(c.req.param("itemId"));
    if (!Number.isInteger(libraryId) || !Number.isInteger(itemId)) return err(c, 400, "id 非法");
    const deleted = await deleteRuleItems(db, libraryId, [itemId]);
    if (deleted === 0) return err(c, 404, "条文不存在");
    await audit(c, { op: "rule-libraries.delete_item", target: `item:${itemId}` });
    return c.json({ deleted });
  });

  return app;
}

/**
 * 消费面 `/v1/rule-libraries/*`：登录即可读，不进任何用户可见导航。
 * 契约见 docs/审查板块-方案-v1.md §4.4.3：先列可下发的库，再按库拉条文（按库缓存）。
 */
export function createRuleLibraryQueryRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/v1/rule-libraries", async (c) => {
    const items = await listPublishedRuleLibraries(db);
    return c.json({ items, total: items.length });
  });
  app.get("/v1/rule-libraries/:id/items", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const data = await listRuleItemsForConsumer(db, id);
    // 一样返回 404 而不区分"库不存在"与"库未发布"：消费端不需要知道草稿库的存在，
    // 区分开等于把管理侧的状态泄露给普通登录用户。
    if (!data) return err(c, 404, "规范库不存在或未发布");
    const since = c.req.header("if-modified-since");
    if (since && data.maxUpdatedAt && data.maxUpdatedAt <= since) return c.body(null, 304);
    if (data.maxUpdatedAt) c.header("Last-Modified", data.maxUpdatedAt);
    return c.json(data);
  });
  return app;
}
