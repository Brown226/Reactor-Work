/**
 * 规范库 SQL 层（RUL）：库 + 条文/审点条目。
 *
 * 与 standards/repo.ts 同一套写法（push 占位符、排序列白名单、批量 500）。
 * 单独要说明的是 `clause_hash`：它是导入幂等键，服务端按条文内容推导，
 * 因此**同一条文在同一库内只可能有一行**——重复导入返回 inserted=0 而不是报错。
 */
import { createHash } from "node:crypto";

import type { IdentityDb } from "../identity/db.js";
import type { RuleLibraryStatus, RuleMandatory, RuleSeverity } from "./schema.js";

export type RuleLibrarySortField = "name" | "createdAt" | "updatedAt";
export type RuleItemSortField = "ruleCode" | "category" | "createdAt";

export interface RuleLibraryRow {
  id: number;
  name: string;
  description: string | null;
  sourceFileName: string | null;
  status: RuleLibraryStatus;
  standardNo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuleLibraryWithCounts extends RuleLibraryRow {
  itemCount: number;
  enabledItemCount: number;
}

export interface RuleItemRow {
  id: number;
  libraryId: number;
  ruleCode: string | null;
  ruleName: string | null;
  category: string | null;
  clauseText: string | null;
  checkPrompt: string | null;
  severity: RuleSeverity;
  mandatory: RuleMandatory;
  sourceLocation: string | null;
  clauseHash: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuleItemInput {
  ruleCode?: string | null;
  ruleName?: string | null;
  category?: string | null;
  clauseText?: string | null;
  checkPrompt?: string | null;
  severity?: string | null;
  mandatory?: string | null;
  sourceLocation?: string | null;
  /** 显式给定则沿用（与核审通历史数据对齐）；缺省由服务端按条文推导。 */
  clauseHash?: string | null;
}

const LIB_SORT_COLUMN: Record<RuleLibrarySortField, string> = {
  name: "l.name",
  createdAt: "l.created_at",
  updatedAt: "l.updated_at",
};

const ITEM_SORT_COLUMN: Record<RuleItemSortField, string> = {
  ruleCode: "rule_code",
  category: "category",
  createdAt: "created_at",
};

const LIB_COLUMNS = `l.id, l.name, l.description, l.source_file_name, l.status,
  l.standard_no, l.created_by, l.created_at, l.updated_at`;

const ITEM_COLUMNS = `id, library_id, rule_code, rule_name, category, clause_text, check_prompt,
  severity, mandatory, source_location, clause_hash, enabled, created_at, updated_at`;

export function normalizeSeverity(raw: unknown): RuleSeverity {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "error" || text === "warning" || text === "info") return text;
  // 中文/其它写法统一落到 warning：severity 只影响展示优先级，不该让导入因它失败。
  if (/严重|error|高/.test(text)) return "error";
  if (/提示|info|低/.test(text)) return "info";
  return "warning";
}

export function normalizeMandatory(raw: unknown): RuleMandatory {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "mandatory" || text === "guidance") return text;
  return /推荐|guidance|建议/.test(text) ? "guidance" : "mandatory";
}

/** 幂等键：条目内容优先，其次名称。截 16 位与核审通历史数据同口径。 */
export function deriveClauseHash(item: RuleItemInput): string {
  const seed = (item.clauseText ?? "").trim() || (item.ruleName ?? "").trim();
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function mapLibrary(row: Record<string, unknown>): RuleLibraryRow {
  return {
    id: Number(row["id"]),
    name: String(row["name"]),
    description: (row["description"] as string | null) ?? null,
    sourceFileName: (row["source_file_name"] as string | null) ?? null,
    status: String(row["status"]) as RuleLibraryStatus,
    standardNo: (row["standard_no"] as string | null) ?? null,
    createdBy: (row["created_by"] as string | null) ?? null,
    createdAt: new Date(row["created_at"] as string).toISOString(),
    updatedAt: new Date(row["updated_at"] as string).toISOString(),
  };
}

function mapItem(row: Record<string, unknown>): RuleItemRow {
  return {
    id: Number(row["id"]),
    libraryId: Number(row["library_id"]),
    ruleCode: (row["rule_code"] as string | null) ?? null,
    ruleName: (row["rule_name"] as string | null) ?? null,
    category: (row["category"] as string | null) ?? null,
    clauseText: (row["clause_text"] as string | null) ?? null,
    checkPrompt: (row["check_prompt"] as string | null) ?? null,
    severity: String(row["severity"]) as RuleSeverity,
    mandatory: String(row["mandatory"]) as RuleMandatory,
    sourceLocation: (row["source_location"] as string | null) ?? null,
    clauseHash: String(row["clause_hash"]),
    enabled: row["enabled"] === true,
    createdAt: new Date(row["created_at"] as string).toISOString(),
    updatedAt: new Date(row["updated_at"] as string).toISOString(),
  };
}

/* ── 库 ───────────────────────────────────────────────────────────── */

export async function listRuleLibraries(
  db: IdentityDb,
  params: { search?: string; status?: string; sortField?: RuleLibrarySortField; sortOrder?: "asc" | "desc" },
): Promise<RuleLibraryWithCounts[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const search = params.search?.trim();
  if (search) {
    values.push(`%${search}%`);
    clauses.push(`(l.name ILIKE $${values.length} OR l.description ILIKE $${values.length})`);
  }
  if (params.status?.trim()) {
    values.push(params.status.trim());
    clauses.push(`l.status = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const field = LIB_SORT_COLUMN[params.sortField ?? "updatedAt"] ?? "l.updated_at";
  const dir = params.sortOrder === "asc" ? "ASC" : "DESC";
  // 计数走相关子查询而不是 LEFT JOIN + GROUP BY：条目多时 GROUP BY 要物化整表，
  // 而这里只需要两个标量；配合 idx_rule_library_item_library 是索引扫描。
  const { rows } = await db.pool.query(
    `SELECT ${LIB_COLUMNS},
       (SELECT count(*)::int FROM rule_library_item i WHERE i.library_id = l.id) AS item_count,
       (SELECT count(*)::int FROM rule_library_item i WHERE i.library_id = l.id AND i.enabled) AS enabled_item_count
     FROM rule_library l ${where}
     ORDER BY ${field} ${dir}, l.id ASC`,
    values,
  );
  return rows.map((row) => ({
    ...mapLibrary(row),
    itemCount: Number(row["item_count"] ?? 0),
    enabledItemCount: Number(row["enabled_item_count"] ?? 0),
  }));
}

export async function getRuleLibrary(db: IdentityDb, id: number): Promise<RuleLibraryWithCounts | null> {
  const { rows } = await db.pool.query(
    `SELECT ${LIB_COLUMNS},
       (SELECT count(*)::int FROM rule_library_item i WHERE i.library_id = l.id) AS item_count,
       (SELECT count(*)::int FROM rule_library_item i WHERE i.library_id = l.id AND i.enabled) AS enabled_item_count
     FROM rule_library l WHERE l.id = $1`,
    [id],
  );
  if (!rows.length) return null;
  return {
    ...mapLibrary(rows[0]),
    itemCount: Number(rows[0]["item_count"] ?? 0),
    enabledItemCount: Number(rows[0]["enabled_item_count"] ?? 0),
  };
}

export async function createRuleLibrary(
  db: IdentityDb,
  input: {
    name: string;
    description?: string | null;
    sourceFileName?: string | null;
    status?: string;
    standardNo?: string | null;
    createdBy?: string | null;
  },
): Promise<RuleLibraryRow | null> {
  const { rows } = await db.pool.query(
    `INSERT INTO rule_library (name, description, source_file_name, status, standard_no, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO NOTHING
     RETURNING id, name, description, source_file_name, status, standard_no, created_by, created_at, updated_at`,
    [
      input.name,
      input.description ?? null,
      input.sourceFileName ?? null,
      input.status ?? "draft",
      input.standardNo ?? null,
      input.createdBy ?? null,
    ],
  );
  return rows.length ? mapLibrary(rows[0]) : null;
}

export async function updateRuleLibrary(
  db: IdentityDb,
  id: number,
  patch: {
    name?: string;
    description?: string | null;
    status?: string;
    standardNo?: string | null;
  },
): Promise<RuleLibraryRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    values.push(patch.name);
    sets.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    values.push(patch.description);
    sets.push(`description = $${values.length}`);
  }
  if (patch.status !== undefined) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.standardNo !== undefined) {
    values.push(patch.standardNo);
    sets.push(`standard_no = $${values.length}`);
  }
  if (sets.length === 0) {
    const current = await getRuleLibrary(db, id);
    return current;
  }
  values.push(id);
  const { rows } = await db.pool.query(
    `UPDATE rule_library SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${values.length}
     RETURNING id, name, description, source_file_name, status, standard_no, created_by, created_at, updated_at`,
    values,
  );
  return rows.length ? mapLibrary(rows[0]) : null;
}

/** 删除库：条目靠 ON DELETE CASCADE 一起走，返回连带删除的条目数以便管理台如实提示。 */
export async function deleteRuleLibrary(
  db: IdentityDb,
  id: number,
): Promise<{ deleted: number; deletedItems: number }> {
  const counted = await db.pool.query(
    `SELECT count(*)::int AS n FROM rule_library_item WHERE library_id = $1`,
    [id],
  );
  const { rowCount } = await db.pool.query(`DELETE FROM rule_library WHERE id = $1`, [id]);
  return { deleted: rowCount ?? 0, deletedItems: Number(counted.rows[0]?.["n"] ?? 0) };
}

/* ── 条文/审点条目 ─────────────────────────────────────────────────── */

export async function listRuleItems(
  db: IdentityDb,
  libraryId: number,
  params: {
    page: number;
    pageSize: number;
    search?: string;
    category?: string;
    enabled?: boolean;
    sortField?: RuleItemSortField;
    sortOrder?: "asc" | "desc";
  },
): Promise<{ items: RuleItemRow[]; total: number }> {
  const clauses: string[] = ["library_id = $1"];
  const values: unknown[] = [libraryId];
  const search = params.search?.trim();
  if (search) {
    values.push(`%${search}%`);
    // 条文原文与 prompt 都要能搜：审问题时人记的是条文内容，不是 ruleCode。
    clauses.push(
      `(rule_code ILIKE $${values.length} OR rule_name ILIKE $${values.length}
        OR clause_text ILIKE $${values.length} OR check_prompt ILIKE $${values.length})`,
    );
  }
  if (params.category?.trim()) {
    values.push(params.category.trim());
    clauses.push(`category = $${values.length}`);
  }
  if (params.enabled !== undefined) {
    values.push(params.enabled);
    clauses.push(`enabled = $${values.length}`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const field = ITEM_SORT_COLUMN[params.sortField ?? "ruleCode"] ?? "rule_code";
  const dir = params.sortOrder === "desc" ? "DESC" : "ASC";
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const [rows, count] = await Promise.all([
    db.pool.query(
      `SELECT ${ITEM_COLUMNS} FROM rule_library_item ${where}
       ORDER BY ${field} ${dir} NULLS LAST, id ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, params.pageSize, (params.page - 1) * params.pageSize],
    ),
    db.pool.query(`SELECT count(*)::int AS total FROM rule_library_item ${where}`, values),
  ]);
  return { items: rows.rows.map(mapItem), total: Number(count.rows[0]?.["total"] ?? 0) };
}

export async function listRuleItemCategories(
  db: IdentityDb,
  libraryId: number,
): Promise<{ value: string; count: number }[]> {
  const { rows } = await db.pool.query(
    `SELECT coalesce(category, '未分类') AS value, count(*)::int AS count
     FROM rule_library_item WHERE library_id = $1
     GROUP BY 1 ORDER BY count DESC, 1 ASC`,
    [libraryId],
  );
  return rows.map((row) => ({ value: String(row["value"]), count: Number(row["count"]) }));
}

export async function getRuleItem(db: IdentityDb, id: number): Promise<RuleItemRow | null> {
  const { rows } = await db.pool.query(`SELECT ${ITEM_COLUMNS} FROM rule_library_item WHERE id = $1`, [id]);
  return rows.length ? mapItem(rows[0]) : null;
}

export async function updateRuleItem(
  db: IdentityDb,
  id: number,
  patch: {
    ruleCode?: string | null;
    ruleName?: string | null;
    category?: string | null;
    clauseText?: string | null;
    checkPrompt?: string | null;
    severity?: string;
    mandatory?: string;
    sourceLocation?: string | null;
    enabled?: boolean;
  },
): Promise<RuleItemRow | null> {
  const columns: Record<string, string> = {
    ruleCode: "rule_code",
    ruleName: "rule_name",
    category: "category",
    clauseText: "clause_text",
    checkPrompt: "check_prompt",
    severity: "severity",
    mandatory: "mandatory",
    sourceLocation: "source_location",
    enabled: "enabled",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    const value = patch[key as keyof typeof patch];
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  // 条文变了要重算幂等键，否则「改完条文再导入同一份清单」会被旧键挡住、静默不更新。
  if (patch.clauseText !== undefined || patch.ruleName !== undefined) {
    const current = await getRuleItem(db, id);
    if (current) {
      const nextHash = deriveClauseHash({
        clauseText: patch.clauseText ?? current.clauseText,
        ruleName: patch.ruleName ?? current.ruleName,
      });
      if (nextHash !== current.clauseHash) {
        values.push(nextHash);
        sets.push(`clause_hash = $${values.length}`);
      }
    }
  }
  if (sets.length === 0) return getRuleItem(db, id);
  values.push(id);
  const { rows } = await db.pool.query(
    `UPDATE rule_library_item SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $${values.length} RETURNING ${ITEM_COLUMNS}`,
    values,
  );
  return rows.length ? mapItem(rows[0]) : null;
}

export async function deleteRuleItems(db: IdentityDb, libraryId: number, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rowCount } = await db.pool.query(
    `DELETE FROM rule_library_item WHERE library_id = $1 AND id = ANY($2::int[])`,
    [libraryId, ids],
  );
  return rowCount ?? 0;
}

export async function clearRuleItems(db: IdentityDb, libraryId: number): Promise<number> {
  const { rowCount } = await db.pool.query(`DELETE FROM rule_library_item WHERE library_id = $1`, [
    libraryId,
  ]);
  return rowCount ?? 0;
}

/** 批量导入条目：幂等（(library_id, clause_hash) 冲突即跳过）。 */
export async function insertRuleItems(
  db: IdentityDb,
  libraryId: number,
  items: RuleItemInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const item of batch) {
      params.push(
        libraryId,
        item.ruleCode ?? null,
        item.ruleName ?? null,
        item.category ?? null,
        item.clauseText ?? null,
        item.checkPrompt ?? null,
        normalizeSeverity(item.severity),
        normalizeMandatory(item.mandatory),
        item.sourceLocation ?? null,
        item.clauseHash?.trim() || deriveClauseHash(item),
      );
      const base = params.length;
      values.push(
        `($${base - 9}, $${base - 8}, $${base - 7}, $${base - 6}, $${base - 5}, $${base - 4}, $${base - 3}, $${base - 2}, $${base - 1}, $${base})`,
      );
    }
    const { rowCount } = await db.pool.query(
      `INSERT INTO rule_library_item
         (library_id, rule_code, rule_name, category, clause_text, check_prompt,
          severity, mandatory, source_location, clause_hash)
       VALUES ${values.join(", ")}
       ON CONFLICT (library_id, clause_hash) DO NOTHING`,
      params,
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}

/**
 * 消费面：一个库的**启用中**条目 + 库元信息，供端侧按库缓存（方案 §4.4.3）。
 * 只发 `published` 库的条目；draft 库还在编辑，端侧拿到半成品会让审查结论不可复现。
 */
export async function listRuleItemsForConsumer(
  db: IdentityDb,
  libraryId: number,
): Promise<{
  library: RuleLibraryRow;
  items: RuleItemRow[];
  maxUpdatedAt: string | null;
} | null> {
  const library = await getRuleLibrary(db, libraryId);
  if (!library || library.status !== "published") return null;
  const { rows } = await db.pool.query(
    `SELECT ${ITEM_COLUMNS} FROM rule_library_item
     WHERE library_id = $1 AND enabled = true
     ORDER BY rule_code ASC NULLS LAST, id ASC`,
    [libraryId],
  );
  const maxUpdatedAt = rows.reduce<string | null>((acc, row) => {
    const value = new Date(row["updated_at"] as string).toISOString();
    return acc === null || value > acc ? value : acc;
  }, null);
  return { library, items: rows.map(mapItem), maxUpdatedAt };
}

/** 消费面：可下发的库清单（published），端侧据此决定拉哪个库。 */
export async function listPublishedRuleLibraries(db: IdentityDb): Promise<RuleLibraryWithCounts[]> {
  return listRuleLibraries(db, { status: "published", sortField: "name", sortOrder: "asc" });
}
