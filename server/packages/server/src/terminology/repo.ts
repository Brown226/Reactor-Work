/**
 * 术语白名单 SQL 层（TRM）。
 *
 * 分层纪律同 standards/repo.ts：本文件只写 SQL，HTTP 与校验留在 routes.ts。
 * 三个容易写错的地方这里一次说清：
 *  ① `search` 走 ILIKE 模糊匹配 term 与 aliases（管理员要找「安注」得能搜到「安全注射」的别名）；
 *  ② 排序字段必须走白名单映射，camelCase 直接拼进 ORDER BY 会报 column does not exist；
 *  ③ 删除要**区分内置行**：内置术语拒绝删除，批量删除按实际删掉的数量回话，不能假装成功。
 */
import type { IdentityDb } from "../identity/db.js";

export type TerminologySortField = "term" | "category" | "createdAt";

export interface TerminologyRow {
  id: number;
  term: string;
  category: string;
  aliases: string | null;
  isBuiltin: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListTerminologyParams {
  page: number;
  pageSize: number;
  search?: string;
  category?: string;
  sortField?: TerminologySortField;
  sortOrder?: "asc" | "desc";
}

export interface TerminologyImportItem {
  term: string;
  category?: string;
  aliases?: string[] | string | null;
  createdBy?: string | null;
}

/** 排序字段白名单：key 是接口入参，value 是真实列名。 */
const SORT_COLUMN: Record<TerminologySortField, string> = {
  term: "term",
  category: "category",
  createdAt: "created_at",
};

const SELECT_COLUMNS = `id, term, category, aliases, is_builtin, created_by, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): TerminologyRow {
  return {
    id: Number(row["id"]),
    term: String(row["term"]),
    category: String(row["category"]),
    aliases: (row["aliases"] as string | null) ?? null,
    isBuiltin: row["is_builtin"] === true,
    createdBy: (row["created_by"] as string | null) ?? null,
    createdAt: new Date(row["created_at"] as string).toISOString(),
    updatedAt: new Date(row["updated_at"] as string).toISOString(),
  };
}

/** 逗号分隔字符串 ↔ 数组：只在出入口转换，库里保持单列。 */
export function parseAliases(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function joinAliases(value: TerminologyImportItem["aliases"]): string | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : String(value).split(",");
  const cleaned = list.map((part) => String(part).trim()).filter((part) => part.length > 0);
  return cleaned.length === 0 ? null : cleaned.join(",");
}

/** 动态 WHERE：占位符编号跟着 push 走，避免手工数字错位。 */
function buildWhere(params: ListTerminologyParams): { where: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const search = params.search?.trim();
  if (search) {
    values.push(`%${search}%`);
    // aliases 也要匹配：管理员记的是别名时，只搜 term 会"搜不到自己刚加的词"。
    clauses.push(`(term ILIKE $${values.length} OR aliases ILIKE $${values.length})`);
  }
  if (params.category?.trim()) {
    values.push(params.category.trim());
    clauses.push(`category = $${values.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

export async function listTerminology(
  db: IdentityDb,
  params: ListTerminologyParams,
): Promise<{ items: TerminologyRow[]; total: number }> {
  const { where, values } = buildWhere(params);
  const field = SORT_COLUMN[params.sortField ?? "term"] ?? "term";
  const dir = params.sortOrder === "desc" ? "DESC" : "ASC";
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const [rows, count] = await Promise.all([
    db.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM terminology ${where}
       ORDER BY ${field} ${dir}, id ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, params.pageSize, (params.page - 1) * params.pageSize],
    ),
    db.pool.query(`SELECT count(*)::int AS total FROM terminology ${where}`, values),
  ]);
  return {
    items: rows.rows.map(mapRow),
    // 与列表同一 WHERE：用全表数会让「共 N 条」在搜索时显示错误总数。
    total: Number(count.rows[0]?.["total"] ?? 0),
  };
}

export async function getTerminology(db: IdentityDb, id: number): Promise<TerminologyRow | null> {
  const { rows } = await db.pool.query(`SELECT ${SELECT_COLUMNS} FROM terminology WHERE id = $1`, [id]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listTerminologyCategories(
  db: IdentityDb,
): Promise<{ value: string; count: number }[]> {
  const { rows } = await db.pool.query(
    `SELECT category AS value, count(*)::int AS count FROM terminology
     GROUP BY category ORDER BY count DESC, category ASC`,
  );
  return rows.map((row) => ({ value: String(row["value"]), count: Number(row["count"]) }));
}

/**
 * 消费面索引：全量、轻量、只读。
 *
 * `aliases` 在这里就拆成数组下发 —— 端侧要的是「term + aliases 一起进 Set」，
 * 让每个消费端各自 split(',') 等于把拆分口径复制到 N 处，迟早出现某端漏拆。
 */
export async function listTerminologyIndex(db: IdentityDb): Promise<{
  items: { term: string; category: string; aliases: string[] }[];
  total: number;
  maxUpdatedAt: string | null;
}> {
  const { rows } = await db.pool.query(
    `SELECT term, category, aliases FROM terminology ORDER BY category ASC, term ASC`,
  );
  const meta = await db.pool.query(`SELECT max(updated_at) AS max_updated_at FROM terminology`);
  const raw = meta.rows[0]?.["max_updated_at"] as string | null;
  return {
    items: rows.map((row) => ({
      term: String(row["term"]),
      category: String(row["category"]),
      aliases: parseAliases(row["aliases"] as string | null),
    })),
    total: rows.length,
    maxUpdatedAt: raw ? new Date(raw).toISOString() : null,
  };
}

export async function createTerminology(
  db: IdentityDb,
  item: TerminologyImportItem,
): Promise<TerminologyRow | null> {
  const { rows } = await db.pool.query(
    `INSERT INTO terminology (term, category, aliases, is_builtin, created_by)
     VALUES ($1, $2, $3, false, $4)
     ON CONFLICT (term, category) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      item.term,
      item.category?.trim() || "自定义",
      joinAliases(item.aliases),
      item.createdBy ?? null,
    ],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function updateTerminology(
  db: IdentityDb,
  id: number,
  patch: { term?: string; category?: string; aliases?: string[] | string | null },
): Promise<TerminologyRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.term !== undefined) {
    values.push(patch.term);
    sets.push(`term = $${values.length}`);
  }
  if (patch.category !== undefined) {
    values.push(patch.category);
    sets.push(`category = $${values.length}`);
  }
  if (patch.aliases !== undefined) {
    values.push(joinAliases(patch.aliases));
    sets.push(`aliases = $${values.length}`);
  }
  if (sets.length === 0) return getTerminology(db, id);
  values.push(id);
  const { rows } = await db.pool.query(
    `UPDATE terminology SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${values.length} RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * 删除术语。**内置行不删**，返回实际删除数量与拒绝数量。
 *
 * 不做「内置行忽略后静默成功」：管理员勾了 5 条、实际只删掉 3 条却看到"已删除"，
 * 会以为数据没了；把拒绝的条数回话出去，管理台才能如实提示。
 */
export async function deleteTerminology(
  db: IdentityDb,
  ids: number[],
): Promise<{ deleted: number; skippedBuiltin: number }> {
  if (ids.length === 0) return { deleted: 0, skippedBuiltin: 0 };
  const builtin = await db.pool.query(
    `SELECT count(*)::int AS n FROM terminology WHERE id = ANY($1::int[]) AND is_builtin = true`,
    [ids],
  );
  const { rowCount } = await db.pool.query(
    `DELETE FROM terminology WHERE id = ANY($1::int[]) AND is_builtin = false`,
    [ids],
  );
  return { deleted: rowCount ?? 0, skippedBuiltin: Number(builtin.rows[0]?.["n"] ?? 0) };
}

/** 导入：幂等（(term, category) 冲突即跳过），可重复跑。 */
export async function insertTerminology(
  db: IdentityDb,
  items: TerminologyImportItem[],
): Promise<number> {
  if (items.length === 0) return 0;
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const item of batch) {
      params.push(item.term, item.category?.trim() || "自定义", joinAliases(item.aliases), false);
      const base = params.length;
      values.push(`($${base - 3}, $${base - 2}, $${base - 1}, $${base})`);
    }
    const { rowCount } = await db.pool.query(
      `INSERT INTO terminology (term, category, aliases, is_builtin)
       VALUES ${values.join(", ")}
       ON CONFLICT (term, category) DO NOTHING`,
      params,
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}
