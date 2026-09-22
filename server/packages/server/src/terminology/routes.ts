/**
 * 术语白名单 HTTP 路由（TRM）：管理面 `/admin/terminology/*` + 消费面 `/v1/terminology/*`。
 *
 * 与 standards/routes.ts 同一套纪律（分面浏览 + 幂等导入 + U+FFFD 护栏 + 审计），
 * 差异只有两处，都是本子域的固有性质：
 *  - **内置词条不可删除**：删除接口返回 `skippedBuiltin`，管理台据此如实提示（见 repo.deleteTerminology）；
 *  - 消费面返回**全量**（112+ 条量级，端侧要一次性进内存 Set），不做分页。
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import { TERMINOLOGY_CATEGORIES } from "./builtin.js";
import {
  createTerminology,
  deleteTerminology,
  getTerminology,
  insertTerminology,
  listTerminology,
  listTerminologyCategories,
  listTerminologyIndex,
  updateTerminology,
  type TerminologyImportItem,
  type TerminologySortField,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409, message: string): Response =>
  c.json({ error: { code: String(status), message }, msg: message }, status);

const VALID_SORT = new Set<TerminologySortField>(["term", "category", "createdAt"]);

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可管理术语白名单");
  await next();
};

/** 同 standards：U+FFFD 是文本已损坏的确定信号，静默入库会污染比对结果。 */
function hasReplacementChar(value: string): boolean {
  return value.includes("�");
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** 别名接受数组或逗号分隔字符串；两种写法都归一成数组后交给 repo 存单列。 */
function readAliases(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

export function createTerminologyAdminRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/admin/terminology", requireAdmin);
  app.use("/admin/terminology/*", requireAdmin);

  const audit = async (c: Ctx, entry: Parameters<typeof recordAdminAction>[2]): Promise<void> => {
    const claims = c.get("claims");
    if (!claims?.sub) return;
    await recordAdminAction(db, await resolveActorForClaims(db, claims), entry);
  };

  app.get("/admin/terminology", async (c) => {
    const page = readPositiveInt(c.req.query("page"), 1, 100_000);
    const pageSize = readPositiveInt(c.req.query("pageSize"), 20, 200);
    const sortRaw = c.req.query("sortField");
    const result = await listTerminology(db, {
      page,
      pageSize,
      search: c.req.query("search"),
      category: c.req.query("category"),
      sortField: VALID_SORT.has(sortRaw as TerminologySortField)
        ? (sortRaw as TerminologySortField)
        : "term",
      sortOrder: c.req.query("sortOrder") === "desc" ? "desc" : "asc",
    });
    return c.json({ items: result.items, total: result.total, page, pageSize });
  });

  app.get("/admin/terminology/categories", async (c) =>
    c.json({
      items: await listTerminologyCategories(db),
      // 默认分类一并下发：新增对话框的分类下拉不能只列出「库里已有的」，
      // 否则空分类（如还没有任何"建筑术语"）永远选不出来。
      defaults: [...TERMINOLOGY_CATEGORIES],
    }),
  );

  app.get("/admin/terminology/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const row = await getTerminology(db, id);
    if (!row) return err(c, 404, "术语不存在");
    return c.json(row);
  });

  app.post("/admin/terminology", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const term = typeof body["term"] === "string" ? body["term"].trim() : "";
    if (!term) return err(c, 400, "term 不能为空");
    if (hasReplacementChar(term)) return err(c, 400, "term 含乱码字符，拒绝写入");
    const row = await createTerminology(db, {
      term,
      category: typeof body["category"] === "string" ? body["category"] : undefined,
      aliases: readAliases(body["aliases"]) ?? null,
      createdBy: c.get("claims")?.sub ?? null,
    });
    // 唯一键 (term, category) 撞了就返回 409 而不是静默当成功：
    // 否则管理员以为加上了，列表里却找不到（其实是已存在）。
    if (!row) return err(c, 409, "该分类下已存在同名术语");
    await audit(c, { op: "terminology.create", target: `term:${row.id}`, summary: row.term });
    return c.json(row, 201);
  });

  app.patch("/admin/terminology/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<typeof updateTerminology>[2] = {};
    if (typeof body["term"] === "string" && body["term"].trim()) {
      if (hasReplacementChar(body["term"])) return err(c, 400, "term 含乱码字符，拒绝写入");
      patch.term = body["term"].trim();
    }
    if (typeof body["category"] === "string" && body["category"].trim())
      patch.category = body["category"].trim();
    // undefined = 不改；null/空数组 = 清空别名（与 standards 的日期字段同口径）。
    const aliases = readAliases(body["aliases"]);
    if (aliases !== undefined || body["aliases"] === null) patch.aliases = aliases ?? null;
    const row = await updateTerminology(db, id, patch);
    if (!row) return err(c, 404, "术语不存在");
    await audit(c, { op: "terminology.update", target: `term:${id}` });
    return c.json(row);
  });

  app.delete("/admin/terminology/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const result = await deleteTerminology(db, [id]);
    if (result.deleted === 0 && result.skippedBuiltin > 0)
      return err(c, 403, "内置术语不可删除（可改分类或别名）");
    if (result.deleted === 0) return err(c, 404, "术语不存在");
    await audit(c, { op: "terminology.delete", target: `term:${id}` });
    return c.json(result);
  });

  app.post("/admin/terminology/bulk-delete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((value) => Number.isInteger(value))
      : [];
    if (ids.length === 0) return err(c, 400, "ids 不能为空");
    const result = await deleteTerminology(db, ids);
    await audit(c, {
      op: "terminology.bulk_delete",
      summary: `批量删除 ${result.deleted} 条，跳过内置 ${result.skippedBuiltin} 条`,
    });
    return c.json(result);
  });

  /** 批量导入：幂等（ON CONFLICT DO NOTHING），可重复跑。 */
  app.post("/admin/terminology/import", async (c) => {
    const body = (await c.req.json().catch(() => (null))) as { items?: unknown } | null;
    if (!body || !Array.isArray(body.items))
      return err(c, 400, "请求体必须是 { items: [...] }，且只接受 JSON");
    const items: TerminologyImportItem[] = [];
    for (const entry of body.items) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const term = typeof record["term"] === "string" ? record["term"].trim() : "";
      if (!term || hasReplacementChar(term)) continue;
      items.push({
        term,
        category: typeof record["category"] === "string" ? record["category"] : undefined,
        aliases: readAliases(record["aliases"]) ?? null,
      });
    }
    if (items.length === 0) return err(c, 400, "items 里没有可用条目");
    const inserted = await insertTerminology(db, items);
    await audit(c, {
      op: "terminology.import",
      summary: `导入 ${inserted} 条（收到 ${items.length}，跳过 ${items.length - inserted}）`,
    });
    return c.json({ received: items.length, inserted, skipped: items.length - inserted });
  });

  return app;
}

/**
 * 消费面 `/v1/terminology/*`：登录即可读，不进任何用户可见导航。
 * 端侧把它拉成内存 Set，用于**过滤**校对误报（命中即丢弃），不是检索。
 */
export function createTerminologyQueryRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/v1/terminology/index", async (c) => {
    const since = c.req.header("if-modified-since");
    const data = await listTerminologyIndex(db);
    if (since && data.maxUpdatedAt && data.maxUpdatedAt <= since) return c.body(null, 304);
    if (data.maxUpdatedAt) c.header("Last-Modified", data.maxUpdatedAt);
    return c.json(data);
  });
  return app;
}
