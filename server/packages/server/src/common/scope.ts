/**
 * 资源授权范围（S-1 Skills / A-1 Agents 共用）。
 *
 * 四种口径，命中任一即可见（并集）：
 *  - all  全公司
 *  - role 指定角色（platform_admin / dept_head / user）
 *  - dept 指定部门（按用户 department_id 精确匹配，不做子树）
 *  - user 指定账号（uid）
 */

import type { IdentityDb } from "../identity/db.js";
import type { Role } from "../identity/users.js";

export type ScopeKind = "all" | "role" | "dept" | "user";

export interface ResourceScope {
  kind: ScopeKind;
  roles: Role[];
  deptIds: number[];
  uids: string[];
}

export type ScopeParse = { scope: ResourceScope } | { error: string };

/** 解析并校验请求体里的 scope（缺省 = 全公司） */
export function parseScope(raw: unknown): ScopeParse {
  const o = (raw ?? {}) as Record<string, unknown>;
  const kind: ScopeKind = o.kind === "role" || o.kind === "dept" || o.kind === "user" ? o.kind : "all";
  const roles = Array.isArray(o.roles)
    ? (o.roles.filter((r) => r === "platform_admin" || r === "dept_head" || r === "user") as Role[])
    : [];
  const deptIds = Array.isArray(o.deptIds) ? (o.deptIds.filter((n) => Number.isInteger(n)) as number[]) : [];
  const uids = Array.isArray(o.uids)
    ? o.uids.filter((u): u is string => typeof u === "string" && u.trim().length > 0).map((u) => u.trim())
    : [];
  if (kind === "role" && roles.length === 0) return { error: "按角色下发需至少选择一个角色" };
  if (kind === "dept" && deptIds.length === 0) return { error: "按部门下发需至少选择一个部门" };
  if (kind === "user" && uids.length === 0) return { error: "按账号下发需至少填写一个账号" };
  return { scope: { kind, roles, deptIds, uids } };
}

/** 授权部门必须真实存在（防悬空 id） */
export async function deptsExist(db: IdentityDb, ids: number[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { rows } = await db.pool.query<{ id: number }>("SELECT id FROM departments WHERE id = ANY($1::int[])", [ids]);
  return rows.length === ids.length;
}

/**
 * 可见性 SQL 谓词（参数固定为 $1=role, $2=deptId, $3=uid）。
 * 表列名由调用方给出，便于 skills / agents 等资源复用同一口径。
 */
export function visibilitySql(columns: {
  kind: string;
  roles: string;
  deptIds: string;
  uids: string;
}): string {
  const { kind, roles, deptIds, uids } = columns;
  return `(
    ${kind} = 'all'
    OR (${kind} = 'role' AND $1 = ANY(${roles}))
    OR (${kind} = 'dept' AND $2::int IS NOT NULL AND $2::int = ANY(${deptIds}))
    OR (${kind} = 'user' AND $3 = ANY(${uids}))
  )`;
}
