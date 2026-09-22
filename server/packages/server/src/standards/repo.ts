/**
 * 标准规范清单仓储（STD）：全部 SQL 收口在这里，路由只做 HTTP 形状。
 *
 * 三处刻意的取舍（改之前先看 docs/审查板块-方案-v1.md §4.4.3）：
 *  - 列表用 LIMIT/OFFSET + 同 WHERE 的 COUNT(*)：与 feedback/audit 的分页口径一致；
 *  - `listStandardIndex` 是**批量只读轻量索引**，只给自检消费端用，不带 created_at 等
 *    管理字段，也不分页 —— 它一次拉全量，端侧缓存后按 updated_at 判断是否过期；
 *  - 批量导入按批提交，用 ON CONFLICT DO NOTHING：源清单里同一编号存在多版本行，
 *    重跑导入必须幂等，而不是把库越灌越乱。
 */
import type { IdentityDb } from "../identity/db.js";

export type StandardStatus = "current" | "upcoming" | "abolished" | "unknown";

export interface StandardRow {
  id: number;
  standardNo: string;
  standardName: string;
  status: StandardStatus;
  category: string | null;
  publishDate: string | null;
  implementDate: string | null;
  abolishDate: string | null;
  replaceInfo: string | null;
  ident: string | null;
  updatedAt: string;
}

interface RawStandardRow {
  id: number;
  standard_no: string;
  standard_name: string;
  status: string;
  category: string | null;
  publish_date: Date | string | null;
  implement_date: Date | string | null;
  abolish_date: Date | string | null;
  replace_info: string | null;
  ident: string | null;
  updated_at: Date | string;
}

const toIsoDate = (value: Date | string | null): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
};

const toIsoTime = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function mapRow(raw: RawStandardRow): StandardRow {
  return {
    id: raw.id,
    standardNo: raw.standard_no,
    standardName: raw.standard_name,
    status: raw.status as StandardStatus,
    category: raw.category,
    publishDate: toIsoDate(raw.publish_date),
    implementDate: toIsoDate(raw.implement_date),
    abolishDate: toIsoDate(raw.abolish_date),
    replaceInfo: raw.replace_info,
    ident: raw.ident,
    updatedAt: toIsoTime(raw.updated_at),
  };
}

export type StandardSortField = "standardNo" | "standardName" | "status" | "publishDate" | "createdAt";

/**
 * 排序字段白名单。
 *
 * ORDER BY 不接受参数化占位符，字段名只能靠白名单拦 —— 即便有人绕过类型传进别的串，
 * 这里也会回落到默认字段，而不是把用户输入拼进 SQL。
 */
const SORTABLE = new Set<StandardSortField>([
  "standardNo",
  "standardName",
  "status",
  "publishDate",
  "createdAt",
]);

/** 允许排序的**数据库列名**（camelCase API 字段 → snake_case 列）。 */
const SORT_COLUMN: Record<StandardSortField, string> = {
  standardNo: "standard_no",
  standardName: "standard_name",
  status: "status",
  publishDate: "publish_date",
  createdAt: "created_at",
};

export interface ListStandardsParams {
  page: number;
  pageSize: number;
  search?: string | undefined;
  status?: StandardStatus | undefined;
  category?: string | undefined;
  sortField?: StandardSortField | undefined;
  sortOrder?: "asc" | "desc" | undefined;
}

function buildWhere(
  params: Pick<ListStandardsParams, "search" | "status" | "category">,
  params_: unknown[],
): string {
  const clauses: string[] = [];
  const kw = params.search?.trim();
  if (kw) {
    params_.push(`%${kw}%`);
    clauses.push(`(standard_no ILIKE $${params_.length} OR standard_name ILIKE $${params_.length})`);
  }
  if (params.status) {
    params_.push(params.status);
    clauses.push(`status = $${params_.length}`);
  }
  if (params.category) {
    params_.push(params.category);
    clauses.push(`category = $${params_.length}`);
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export async function listStandards(
  db: IdentityDb,
  params: ListStandardsParams,
): Promise<{ items: StandardRow[]; total: number }> {
  const values: unknown[] = [];
  const where = buildWhere(params, values);
  const requested = params.sortField;
  const sort: StandardSortField = requested && SORTABLE.has(requested) ? requested : "standardNo";
  // 排序键要落到真实列名：API 面是 camelCase，表列是 snake_case（直接拿 sortField 拼会报
  // "column standardNo does not exist"）。
  const field = SORT_COLUMN[sort];
  // 日期列可能为 NULL，固定 nulls 最后，否则 asc/desc 在不同页之间顺序不稳。
  const nullsLast = sort === "publishDate" || sort === "createdAt" ? " NULLS LAST" : "";
  const dir = params.sortOrder === "desc" ? "DESC" : "ASC";
  values.push(params.pageSize, (params.page - 1) * params.pageSize);
  const list = await db.pool.query<RawStandardRow>(
    `SELECT id, standard_no, standard_name, status, category, publish_date, implement_date,
            abolish_date, replace_info, ident, updated_at
       FROM standard
       ${where}
      ORDER BY ${field} ${dir}${nullsLast}, id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  const countValues: unknown[] = [];
  const countWhere = buildWhere(params, countValues);
  const count = await db.pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM standard ${countWhere}`,
    countValues,
  );

  return { items: list.rows.map(mapRow), total: Number(count.rows[0]?.n ?? 0) };
}

/** 分面取值：管理台的分类筛选下拉从这里拿，避免把 13k 行拉到前端去 distinct。 */
export async function listStandardCategories(
  db: IdentityDb,
): Promise<{ value: string; count: number }[]> {
  const rows = await db.pool.query<{ category: string | null; n: string }>(
    `SELECT category, COUNT(*)::text AS n FROM standard
      WHERE category IS NOT NULL AND category <> ''
      GROUP BY category ORDER BY COUNT(*) DESC`,
  );
  return rows.rows.map((row) => ({ value: row.category ?? "", count: Number(row.n) }));
}

export async function getStandard(db: IdentityDb, id: number): Promise<StandardRow | null> {
  const rows = await db.pool.query<RawStandardRow>(
    `SELECT id, standard_no, standard_name, status, category, publish_date, implement_date,
            abolish_date, replace_info, ident, updated_at
       FROM standard WHERE id = $1`,
    [id],
  );
  return rows.rows[0] ? mapRow(rows.rows[0]) : null;
}

export interface StandardImportItem {
  standardNo: string;
  standardName: string;
  status: StandardStatus;
  category: string | null;
  publishDate?: string | null;
  implementDate?: string | null;
  abolishDate?: string | null;
  replaceInfo?: string | null;
}

/** 由标准号取前缀，如 "GB/T 50001-2017" → "GB/T"。与自检侧的 ident 口径一致。 */
export function resolveIdent(standardNo: string): string | null {
  const match = /^([A-Za-z/]+)/.exec(standardNo.trim());
  return match?.[1] ?? null;
}

/** 分批插入，返回成功条数。源清单 13k+ 行，单次插值有上限（Postgres 65535 个参数）。 */
export async function insertStandards(
  db: IdentityDb,
  items: readonly StandardImportItem[],
): Promise<number> {
  const BATCH = 500;
  let inserted = 0;
  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const item of chunk) {
      const base = values.length;
      values.push(
        item.standardNo,
        item.standardName,
        item.status,
        item.category,
        item.publishDate ?? null,
        item.implementDate ?? null,
        item.abolishDate ?? null,
        item.replaceInfo ?? null,
        resolveIdent(item.standardNo),
      );
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},
          $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
      );
    }
    const result = await db.pool.query(
      `INSERT INTO standard
         (standard_no, standard_name, status, category, publish_date,
          implement_date, abolish_date, replace_info, ident)
       VALUES ${tuples.join(",\n")}
       ON CONFLICT (standard_no, standard_name) DO NOTHING`,
      values,
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

export async function updateStandard(
  db: IdentityDb,
  id: number,
  patch: Partial<Omit<StandardImportItem, "category" | "replaceInfo">>,
): Promise<StandardRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.standardNo !== undefined) {
    push("standard_no", patch.standardNo);
    push("ident", resolveIdent(patch.standardNo));
  }
  if (patch.standardName !== undefined) push("standard_name", patch.standardName);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.publishDate !== undefined) push("publish_date", patch.publishDate);
  if (patch.implementDate !== undefined) push("implement_date", patch.implementDate);
  if (patch.abolishDate !== undefined) push("abolish_date", patch.abolishDate);
  if (sets.length === 0) return getStandard(db, id);

  values.push(id);
  await db.pool.query(
    `UPDATE standard SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length}`,
    values,
  );
  return getStandard(db, id);
}

export async function deleteStandards(db: IdentityDb, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.pool.query(`DELETE FROM standard WHERE id = ANY($1::int[])`, [
    [...ids],
  ]);
  return result.rowCount ?? 0;
}

export async function clearStandards(db: IdentityDb): Promise<number> {
  const result = await db.pool.query(`DELETE FROM standard`);
  return result.rowCount ?? 0;
}

/**
 * 全量轻量索引：自检消费端一次拉走，端侧缓存后比对 `updatedAt` 判定是否需要重拉。
 * 刻意**不带** content 类长文本（本表目前也没有），保持响应体稳定在几十 KB 量级。
 */
export async function listStandardIndex(db: IdentityDb): Promise<{
  items: {
    id: number;
    standardNo: string;
    standardName: string;
    status: StandardStatus;
    ident: string | null;
    publishDate: string | null;
  }[];
  maxUpdatedAt: string | null;
  total: number;
}> {
  const rows = await db.pool.query<RawStandardRow>(
    `SELECT id, standard_no, standard_name, status, ident, publish_date, updated_at
       FROM standard
      ORDER BY standard_no ASC`,
  );
  let maxUpdatedAt: string | null = null;
  for (const row of rows.rows) {
    const iso = toIsoTime(row.updated_at);
    if (!maxUpdatedAt || iso > maxUpdatedAt) maxUpdatedAt = iso;
  }
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      standardNo: row.standard_no,
      standardName: row.standard_name,
      status: row.status as StandardStatus,
      ident: row.ident,
      publishDate: toIsoDate(row.publish_date),
    })),
    maxUpdatedAt,
    total: rows.rows.length,
  };
}
