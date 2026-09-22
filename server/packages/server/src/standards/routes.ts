/**
 * 标准规范清单 HTTP 路由（STD）：管理面 `/admin/standards/*` + 消费面 `/v1/standards/*`。
 *
 * 为什么分两个工厂、三个前缀：
 *  - `createStandardsAdminRoutes` 由 identity/server.ts 挂在 authed 组**之后**，复用 Bearer 中间件，
 *    内部只再校验 platform_admin（写操作）；
 *  - `/v1/standards/index` 是**执行期只读**：桌面端审查要读标准库，但普通用户**不该有管理入口**，
 *    所以它不带 admin 前缀、不校验角色，只要 Bearer 能过即可（登录态 = 可读）。
 *    见 docs/审查板块-方案-v1.md §4.4.3：管理界面只在管理员端，消费接口不进任何用户可见导航。
 *
 * 导入走 JSON 而不是 multipart：标准库是**一次性迁移**的治理数据（3.6 万行 → 13,369 行筛选后），
 * 调用方是运维脚本而不是浏览器；JSON 让导入可以幂等重跑，也不用为它引入 exceljs 依赖。
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  clearStandards,
  deleteStandards,
  getStandard,
  insertStandards,
  listStandardCategories,
  listStandardIndex,
  listStandards,
  updateStandard,
  type StandardImportItem,
  type StandardSortField,
  type StandardStatus,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409, message: string): Response =>
  c.json({ error: { code: String(status), message }, msg: message }, status);

const VALID_STATUS = new Set<StandardStatus>(["current", "upcoming", "abolished", "unknown"]);

/** 管理面全部写操作都要 platform_admin；读操作同样限定（标准库是治理数据）。 */
const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可管理标准清单");
  await next();
};

/**
 * 拦截「替换字符」U+FFFD。
 *
 * 它是文本已被破坏的**确定信号**（编码不匹配、上传转码失败都会落成它），而标准编号与名称
 * 一旦写成 `????` 就再也无法从别处恢复，且自检时会把这类行当"库里的真标准"参与比对 ——
 * 悄悄污染比对结果。所以宁可 400 让调用方重传，也不要静默入库。
 *
 * 这不是假设：测试期间一条 PATCH 就把「钢制压力容器」写成了 11 个 U+FFFD，靠人工核对才发现。
 */
function hasReplacementChar(value: string): boolean {
  return value.includes("�");
}

function readPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/** 源清单里的中文状态 → 规范串。同义异形（废止/已废止）必须在入口归一，不能落到表里。 */
function normalizeStatus(raw: unknown): StandardStatus {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (/废止|abolish/i.test(text)) return "abolished";
  if (/即将实施|upcoming/i.test(text)) return "upcoming";
  if (/现行|current|有效/i.test(text)) return "current";
  if (text === "") return "unknown";
  return "unknown";
}

export function createStandardsAdminRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/admin/standards", requireAdmin);
  app.use("/admin/standards/*", requireAdmin);

  const audit = async (c: Ctx, entry: Parameters<typeof recordAdminAction>[2]): Promise<void> => {
    const claims = c.get("claims");
    if (!claims?.sub) return;
    await recordAdminAction(db, await resolveActorForClaims(db, claims), entry);
  };

  app.get("/admin/standards", async (c) => {
    const page = readPositiveInt(c.req.query("page"), 1, 100_000);
    const pageSize = readPositiveInt(c.req.query("pageSize"), 20, 200);
    const statusRaw = c.req.query("status");
    const sortRaw = c.req.query("sortField");
    const result = await listStandards(db, {
      page,
      pageSize,
      search: c.req.query("search"),
      status: statusRaw && VALID_STATUS.has(statusRaw as StandardStatus)
        ? (statusRaw as StandardStatus)
        : undefined,
      category: c.req.query("category"),
      sortField: (sortRaw as StandardSortField | undefined) ?? "standardNo",
      sortOrder: c.req.query("sortOrder") === "desc" ? "desc" : "asc",
    });
    // total 必须是**同一 WHERE 条件下的计数**：用全表数会让分页器和「共 N 条」
    // 在搜索/筛选时显示错误的总数（搜索 10 行却显示 13368 条）。
    return c.json({ items: result.items, total: result.total, page, pageSize });
  });

  app.get("/admin/standards/categories", async (c) =>
    c.json({ items: await listStandardCategories(db) }),
  );

  app.get("/admin/standards/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const row = await getStandard(db, id);
    if (!row) return err(c, 404, "标准不存在");
    return c.json(row);
  });

  app.patch("/admin/standards/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Parameters<typeof updateStandard>[2] = {};
    if (typeof body["standardNo"] === "string" && body["standardNo"].trim())
      patch.standardNo = body["standardNo"].trim();
    if (typeof body["standardName"] === "string" && body["standardName"].trim())
      patch.standardName = body["standardName"].trim();
    for (const key of ["standardNo", "standardName"] as const) {
      const value = patch[key];
      if (value && hasReplacementChar(value)) return err(c, 400, `${key} 含乱码字符，拒绝写入`);
    }
    if (typeof body["status"] === "string") {
      if (!VALID_STATUS.has(body["status"] as StandardStatus))
        return err(c, 400, `status 必须是 ${[...VALID_STATUS].join(" / ")} 之一`);
      patch.status = body["status"] as StandardStatus;
    }
    for (const key of ["publishDate", "implementDate", "abolishDate"] as const) {
      const value = body[key];
      // undefined = 请求体里没这个字段 = **不改**；null/空串 = 清空日期。
      // 漏掉 undefined 分支会把 String(undefined) = "undefined" 写进 SQL，
      // PG 报 DateTimeParseError（接口直接 500）。
      if (value === undefined) continue;
      patch[key] = value === null || value === "" ? null : String(value);
    }
    const row = await updateStandard(db, id, patch);
    if (!row) return err(c, 404, "标准不存在");
    await audit(c, { op: "standards.update", target: `standard:${id}` });
    return c.json(row);
  });

  app.delete("/admin/standards/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const deleted = await deleteStandards(db, [id]);
    if (deleted === 0) return err(c, 404, "标准不存在");
    await audit(c, { op: "standards.delete", target: `standard:${id}` });
    return c.json({ deleted });
  });

  app.post("/admin/standards/bulk-delete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.map(Number).filter((value) => Number.isInteger(value))
      : [];
    if (ids.length === 0) return err(c, 400, "ids 不能为空");
    const deleted = await deleteStandards(db, ids);
    await audit(c, { op: "standards.bulk_delete", summary: `批量删除 ${deleted} 条` });
    return c.json({ deleted });
  });

  app.delete("/admin/standards", async (c) => {
    const cleared = await clearStandards(db);
    await audit(c, { op: "standards.clear", summary: `清空标准清单，删除 ${cleared} 条` });
    return c.json({ cleared });
  });

  /** 批量导入：幂等（ON CONFLICT DO NOTHING），可重复跑。 */
  app.post("/admin/standards/import", async (c) => {
    const body = (await c.req.json().catch(() => (null))) as {
      items?: unknown;
    } | null;
    if (!body || !Array.isArray(body.items))
      return err(c, 400, "请求体必须是 { items: [...] }，且只接受 JSON");
    const items: StandardImportItem[] = [];
    for (const entry of body.items) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const standardNo = typeof record["standardNo"] === "string" ? record["standardNo"].trim() : "";
      const standardName =
        typeof record["standardName"] === "string" ? record["standardName"].trim() : "";
      if (!standardNo || !standardName) continue;
      // 乱码条目直接丢弃并在响应里体现，而不是把坏行写进库（见 hasReplacementChar 注释）。
      if (hasReplacementChar(standardNo) || hasReplacementChar(standardName)) continue;
      const statusRaw = record["status"];
      items.push({
        standardNo,
        standardName,
        status: VALID_STATUS.has(statusRaw as StandardStatus)
          ? (statusRaw as StandardStatus)
          : normalizeStatus(statusRaw),
        category: typeof record["category"] === "string" ? record["category"] : null,
        publishDate: typeof record["publishDate"] === "string" ? record["publishDate"] : null,
        implementDate: typeof record["implementDate"] === "string" ? record["implementDate"] : null,
        abolishDate: typeof record["abolishDate"] === "string" ? record["abolishDate"] : null,
        replaceInfo: typeof record["replaceInfo"] === "string" ? record["replaceInfo"] : null,
      });
    }
    if (items.length === 0) return err(c, 400, "items 里没有可用条目");
    const inserted = await insertStandards(db, items);
    await audit(c, {
      op: "standards.import",
      summary: `导入 ${inserted} 条（收到 ${items.length}，跳过 ${items.length - inserted}）`,
    });
    return c.json({ received: items.length, inserted, skipped: items.length - inserted });
  });

  return app;
}

/**
 * 消费面 `/v1/standards/*`：登录即可读，没有管理入口。
 * 桌面端自检用它同步标准库索引（缺口 2，见 docs/审查板块-方案-v1.md §5）。
 */
export function createStandardsQueryRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/v1/standards/index", async (c) => {
    const since = c.req.header("if-modified-since");
    const data = await listStandardIndex(db);
    if (since && data.maxUpdatedAt && data.maxUpdatedAt <= since) return c.body(null, 304);
    if (data.maxUpdatedAt) c.header("Last-Modified", data.maxUpdatedAt);
    return c.json(data);
  });
  return app;
}
