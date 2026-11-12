/**
 * 标准规范清单 HTTP 路由（STD）：管理面 `/admin/standards/*` + 消费面 `/v1/standards/*`。
 *
 * 为什么分两个工厂、三个前缀：
 *  - `createStandardsAdminRoutes` 由 identity/server.ts 挂在 authed 组**之后**，复用 Bearer 中间件，
 *    内部只再校验 platform_admin（写操作）；
 *  - `/v1/standards/index` 是**执行期只读**：桌面端审查要读标准库，但普通用户**不该有管理入口**，
 *    所以它不带 admin 前缀、不校验角色，只要 Bearer 能过即可（登录态 = 可读）。
 *    见 docs/未完成-审查板块-方案-v1.md §4.4.3：管理界面只在管理员端，消费接口不进任何用户可见导航。
 *
 * 导入为什么有两条路径（2026-10-19 起）：
 *  - `POST /import` 收 JSON，保留给运维脚本（一次性迁移、幂等重跑）；
 *  - `POST /import-excel` 收 multipart xlsx，给管理台浏览器操作，做**两段式预检**：
 *    先解析 + 筛重并返回明细，管理员确认后才真正写库。
 *  确认那一步仍走 `/import`，不为 Excel 另开一条写入路径——否则同一张表会有两套
 *  去重与幂等语义，迟早漂移。契约见 docs/standards-excel-io-spec.md。
 */
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { markAdminAudited } from "../audit/adminAudit.js";
import { recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  buildExportWorkbook,
  buildTemplateWorkbook,
  normalizeStatus,
  parseStandardsWorkbook,
} from "./excel.js";
import {
  clearStandards,
  deleteStandards,
  findExistingStandardKeys,
  standardKey,
  getStandard,
  insertStandards,
  listStandardCategories,
  listStandardIndex,
  listStandards,
  listStandardsForExport,
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

export function createStandardsAdminRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/admin/standards", requireAdmin);
  app.use("/admin/standards/*", requireAdmin);

  const audit = async (c: Ctx, entry: Parameters<typeof recordAdminAction>[2]): Promise<void> => {
    // 洞①：先打标再落库——兜底中间件见标即跳过，一个请求只落一条 admin_action。
    markAdminAudited(c);
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

  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  /** 下载导入模板：空表头 + 填写说明 sheet（spec §4.3）。 */
  app.get("/admin/standards/template", async () => {
    const buffer = await buildTemplateWorkbook();
    // 返回原生 Response 而不是 c.body()：本仓 Hono 版本的 c.body 对非 string 入参
    // 会落到 null 重载上（feedback/updates 路由都是靠 as unknown as 绕过的），
    // 而 Uint8Array 本身就是合法 BodyInit，构造 Response 类型天然正确、不用断言。
    // 文件名固定英文：中文文件名在 Content-Disposition 里要 RFC 5987 编码，
    // 各家浏览器/wget 解析不一，运维场景下稳定比好看重要。
    return new Response(buffer, {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": 'attachment; filename="standard-template.xlsx"',
      },
    });
  });

  /**
   * 导出当前筛选结果为 xlsx（spec §4.4）。
   * Query 与列表页一致但不带分页参数；上限 5 万行，超出截断并在响应头标注。
   */
  app.get("/admin/standards/export", async (c) => {
    const EXPORT_LIMIT = 50_000;
    const statusRaw = c.req.query("status");
    const sortRaw = c.req.query("sortField");
    const rows = await listStandardsForExport(
      db,
      {
        search: c.req.query("search"),
        status: statusRaw && VALID_STATUS.has(statusRaw as StandardStatus)
          ? (statusRaw as StandardStatus)
          : undefined,
        category: c.req.query("category"),
        sortField: (sortRaw as StandardSortField | undefined) ?? "standardNo",
        sortOrder: c.req.query("sortOrder") === "desc" ? "desc" : "asc",
      },
      // 多取一行用于判断是否触顶，避免为了一个布尔值先 COUNT(*) 一遍。
      EXPORT_LIMIT + 1,
    );
    const truncated = rows.length > EXPORT_LIMIT;
    const buffer = await buildExportWorkbook(truncated ? rows.slice(0, EXPORT_LIMIT) : rows);
    // 同 template：原生 Response 承载二进制，不用 as unknown as 绕 Hono 的 c.body 重载。
    const headers: Record<string, string> = {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": 'attachment; filename="standards-export.xlsx"',
    };
    if (truncated) headers["X-Standards-Truncated"] = "true";
    return new Response(buffer, { headers });
  });

  /**
   * Excel 导入预检（两段式第一步）：解析 + 筛重，**不写库**。
   *
   * 为什么预检和入库分开：13445 条的治理数据一旦误覆盖/误去重，回滚只能靠
   * 事前备份。让管理员先在页面上看到「将新增 N / 将跳过 M（重复明细）」再确认，
   * 把不可逆操作变成可确认操作。确认走已有的 POST /import，不另开写入路径。
   */
  app.post("/admin/standards/import-excel", async (c) => {
    const form = await c.req.formData().catch(() => null);
    if (!form) return err(c, 400, "请求必须是 multipart/form-data");
    const file = form.get("file");
    // duck-typing 而不是 instanceof File：Node 18/20 的全局 File 与 undici 的
    // File 不是同一个构造器，instanceof 在某些版本上会误判为 false。
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
      return err(c, 400, "缺少 file 字段（应为 .xlsx 文件）");
    }
    const blob = file as Blob & { name?: string };
    const fileName = typeof blob.name === "string" ? blob.name : "";
    if (!fileName.toLowerCase().endsWith(".xlsx")) {
      return err(c, 400, "只接受 .xlsx 文件；.xls/.csv 请先用 Excel 另存为 .xlsx");
    }
    if (blob.size > 10 * 1024 * 1024) return err(c, 400, "文件超过 10MB 上限");

    let parsed;
    try {
      parsed = await parseStandardsWorkbook(new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
      // 解析失败（表头不对、不是合法 xlsx）一律 400 并带上具体原因，
      // 不要让 exceljs 的异常裸奔成 500。
      return err(c, 400, (error as Error).message || "Excel 解析失败");
    }
    if (parsed.received === 0) return err(c, 400, "Excel 里没有数据行");

    const existing = await findExistingStandardKeys(db, parsed.valid);
    const duplicates: Array<{
      row: number;
      standardNo: string;
      standardName: string;
      source: "file" | "db";
    }> = [];
    const items: StandardImportItem[] = [];
    for (const row of parsed.valid) {
      if (existing.has(standardKey(row.standardNo, row.standardName))) {
        duplicates.push({
          row: row.row,
          standardNo: row.standardNo,
          standardName: row.standardName,
          source: "db",
        });
        continue;
      }
      items.push({
        standardNo: row.standardNo,
        standardName: row.standardName,
        status: row.status,
        category: row.category,
        publishDate: row.publishDate,
        implementDate: row.implementDate,
        abolishDate: row.abolishDate,
        replaceInfo: row.replaceInfo,
      });
    }
    for (const dup of parsed.fileDuplicates) {
      duplicates.push({ ...dup, source: "file" });
    }
    // 按 Excel 行号排序：用户看着明细回去改文件时，顺序和表格一致才找得到位置。
    duplicates.sort((a, b) => a.row - b.row);

    return c.json({
      received: parsed.received,
      valid: parsed.valid.length,
      willInsert: items.length,
      willSkip: duplicates.length,
      invalid: parsed.invalid,
      // 明细截断到 100 条：全部重复时（比如整份重传）响应体会大到没意义，
      // 总数看 willSkip，明细只帮用户定位前几个。
      duplicates: duplicates.slice(0, 100),
      duplicatesTruncated: duplicates.length > 100,
      items,
    });
  });

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
      if (value === null || value === "") {
        patch[key] = null;
        continue;
      }
      // 编辑语义（§7-10.2）：日期无法解析要返 400，而不是把任意字符串塞给 PG 换一个 500。
      // 只收 ISO 日期 / 日期时间；「2024-13-45」这类格式对但取值非法的也要挡掉。
      const text = String(value).trim();
      const dateLike =
        /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text) !==
        null;
      if (!dateLike || Number.isNaN(new Date(text).getTime())) {
        return err(c, 400, `${key} 不是可解析的日期（期望 YYYY-MM-DD 或 ISO 日期时间）`);
      }
      patch[key] = text;
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
 * 桌面端自检用它同步标准库索引（缺口 2，见 docs/未完成-审查板块-方案-v1.md §5）。
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
