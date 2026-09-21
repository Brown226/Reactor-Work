/**
 * 用户仓储。角色三档：platform_admin / dept_head / user（单值，第一期）。
 * source: ad(LDAP 同步/登录自动供给) | local(内置测试号/后台建号)。
 */

import type { IdentityDb } from "./db.js";
import { revokeAll } from "./token-service.js";

export const ROLES = ["platform_admin", "dept_head", "user"] as const;
export type Role = (typeof ROLES)[number];

export interface UserRow {
  id: number;
  uid: string;
  name: string;
  email: string | null;
  source: "ad" | "local";
  role: Role;
  status: "active" | "disabled";
  departmentId: number | null;
  deptPath: string | null;
  adDn: string | null;
  lastSyncAt: Date | null;
  passwordHash: string | null;
}

interface UserDbRow {
  id: number;
  uid: string;
  name: string;
  email: string | null;
  source: "ad" | "local";
  role: string;
  status: string;
  department_id: number | null;
  dept_path: string | null;
  ad_dn: string | null;
  last_sync_at: Date | null;
  password_hash: string | null;
}

function mapRow(r: UserDbRow): UserRow {
  return {
    id: r.id,
    uid: r.uid,
    name: r.name,
    email: r.email,
    source: r.source as UserRow["source"],
    role: r.role as Role,
    status: r.status as UserRow["status"],
    departmentId: r.department_id,
    deptPath: r.dept_path,
    adDn: r.ad_dn,
    lastSyncAt: r.last_sync_at,
    passwordHash: r.password_hash,
  };
}

export const USER_SELECT = `
  SELECT u.id, u.uid, u.name, u.email, u.source, u.role, u.status,
         u.department_id, u.ad_dn, u.last_sync_at, u.password_hash,
         d.path AS dept_path
  FROM users u LEFT JOIN departments d ON d.id = u.department_id
`;

export async function findUserByUid(db: IdentityDb, uid: string): Promise<UserRow | null> {
  const { rows } = await db.pool.query<UserDbRow>(`${USER_SELECT} WHERE u.uid = $1`, [uid]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findUserById(db: IdentityDb, id: number): Promise<UserRow | null> {
  const { rows } = await db.pool.query<UserDbRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface UserFilter {
  deptIds?: Set<number>;
  role?: Role;
  status?: UserRow["status"];
  q?: string;
}

export async function listUsers(db: IdentityDb, opts: UserFilter = {}): Promise<UserRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.deptIds) {
    conds.push(`u.department_id = ANY($${params.length + 1}::int[])`);
    params.push([...opts.deptIds]);
  }
  if (opts.role) {
    conds.push(`u.role = $${params.length + 1}`);
    params.push(opts.role);
  }
  if (opts.status) {
    conds.push(`u.status = $${params.length + 1}`);
    params.push(opts.status);
  }
  if (opts.q) {
    conds.push(`(u.uid ILIKE $${params.length + 1} OR u.name ILIKE $${params.length + 1})`);
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { rows } = await db.pool.query<UserDbRow>(`${USER_SELECT} ${where} ORDER BY u.uid LIMIT 2000`, params);
  return rows.map(mapRow);
}

/** AD 用户 upsert（同步 / 登录自动供给共用）：存在→刷新可刷新字段；缺→插入(role=user, active)。 */
export async function upsertAdUser(
  db: IdentityDb,
  input: { uid: string; name: string; email: string | null; adDn: string; departmentId: number | null },
): Promise<UserRow> {
  const existing = await findUserByUid(db, input.uid);
  if (existing) {
    await db.pool.query(
      `UPDATE users SET name = $1, email = $2, ad_dn = $3, department_id = $4,
              status = 'active', last_sync_at = now(), updated_at = now()
       WHERE id = $5`,
      [input.name, input.email, input.adDn, input.departmentId, existing.id],
    );
    return (await findUserById(db, existing.id))!;
  }
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO users (uid, name, email, source, role, status, department_id, ad_dn, last_sync_at)
     VALUES ($1, $2, $3, 'ad', 'user', 'active', $4, $5, now())
     RETURNING id`,
    [input.uid, input.name, input.email, input.departmentId, input.adDn],
  );
  return (await findUserById(db, rows[0]!.id))!;
}

export async function createLocalUser(
  db: IdentityDb,
  input: { uid: string; name: string; email?: string | null; role: Role; departmentId: number | null; passwordHash: string },
): Promise<UserRow> {
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO users (uid, name, email, source, role, status, department_id, password_hash)
     VALUES ($1, $2, $3, 'local', $4, 'active', $5, $6)
     ON CONFLICT (uid) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role,
       department_id = EXCLUDED.department_id, password_hash = EXCLUDED.password_hash,
       status = 'active', updated_at = now()
     RETURNING id`,
    [input.uid, input.name, input.email ?? null, input.role, input.departmentId, input.passwordHash],
  );
  return (await findUserById(db, rows[0]!.id))!;
}

export interface UserPatch {
  role?: Role;
  status?: UserRow["status"];
  departmentId?: number | null;
  name?: string;
  email?: string | null;
  passwordHash?: string;
}

export async function updateUser(db: IdentityDb, id: number, patch: UserPatch): Promise<UserRow | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, v: unknown): void => {
    params.push(v);
    fields.push(`${sql} = $${params.length}`);
  };
  if (patch.role !== undefined) push("role", patch.role);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.departmentId !== undefined) push("department_id", patch.departmentId);
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.email !== undefined) push("email", patch.email);
  if (patch.passwordHash !== undefined) push("password_hash", patch.passwordHash);
  if (fields.length === 0) return findUserById(db, id);
  params.push(id);
  await db.pool.query(`UPDATE users SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
  const updated = await findUserById(db, id);
  // 停用即吊销该用户全部 refresh token（T3-2；覆盖 PATCH 与 disableUser 两条路径）。
  if (patch.status === "disabled" && updated) await revokeAll(db, updated.uid);
  return updated;
}

/** 列出所有 source=ad 用户 uid（同步 disabled 判定用）。 */
export async function listAdUserUids(db: IdentityDb): Promise<Set<string>> {
  const { rows } = await db.pool.query<{ uid: string }>("SELECT uid FROM users WHERE source = 'ad'");
  return new Set(rows.map((r) => r.uid));
}

/** 将指定 uid 集合之外的 ad 用户停用（仅更新本批涉及源）。 */
export async function disableMissingAdUsers(db: IdentityDb, activeUids: Set<string>): Promise<number> {
  const all = await listAdUserUids(db);
  const missing = [...all].filter((u) => !activeUids.has(u));
  if (missing.length === 0) return 0;
  const { rowCount } = await db.pool.query(
    "UPDATE users SET status = 'disabled', updated_at = now() WHERE source = 'ad' AND uid = ANY($1::text[])",
    [missing],
  );
  return rowCount ?? 0;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    uid: u.uid,
    name: u.name,
    email: u.email,
    role: u.role,
    source: u.source,
    status: u.status,
    dept: u.departmentId === null || u.deptPath === null ? null : { id: u.departmentId, path: u.deptPath },
    syncedAt: u.lastSyncAt ? u.lastSyncAt.toISOString() : null,
  };
}

export interface PublicUser {
  id: number;
  uid: string;
  name: string;
  email: string | null;
  role: Role;
  source: "ad" | "local";
  status: "active" | "disabled";
  dept: { id: number; path: string } | null;
  syncedAt: string | null;
}
