/**
 * 权限点（U-2 / 迁移清单 T3-3）。
 *
 * 口径：从**实际挂载后的 Hono 路由表**扫描出权限点（method + path → 权限码），
 * 落 `permissions` 表；三角色到权限点的映射保持固定（不开放自由角色，见细化设计护栏），
 * 由 `permissionAllowed` 判定并对外输出矩阵。
 *
 * 好处：新增一条受保护路由后跑一次扫描，权限清单自动出现，无需手维护。
 */

import { ADMIN_MOUNT_PREFIX } from "./admin-static.js";
import type { IdentityDb } from "./db.js";
import type { Role } from "./users.js";

export interface RouteEntry {
  method: string;
  path: string;
}

export interface PermissionRow {
  code: string;
  method: string;
  path: string;
  description: string | null;
  updatedAt: string | null;
}

export interface RolePermissionView {
  key: Role;
  label: string;
  scope: string;
  permissions: string[];
}

export async function ensurePermissionsSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS permissions (
      code TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** 公开路由（无需登录）——不纳入权限点 */
const PUBLIC_PATHS = new Set(["/auth/login", "/auth/refresh"]);

/** 公开的根路径（不是权限实体）：`GET /` 是「浏览器开端口根就进管理台」的 302 跳转，见 routes.ts */
const PUBLIC_ROOT_PATHS = new Set(["/"]);

const AREA_LABELS: Record<string, string> = {
  auth: "身份认证",
  users: "用户管理",
  depts: "组织架构",
  admin: "管理台",
  me: "个人中心",
};

const METHOD_ACTIONS: Record<string, string> = {
  GET: "read",
  POST: "create",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
};

const ACTION_LABELS: Record<string, string> = {
  read: "查看",
  create: "创建/执行",
  update: "修改",
  delete: "删除",
};

/** 权限码：路径段（参数段归一为 *）+ 动作，如 GET /admin/skills/:id → admin:skills:*:read */
export function permissionCodeFor(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith(":")) return "*";
      if (/^\[.+\]$/.test(segment)) return "*";
      return segment.replace(/[^A-Za-z0-9_-]/g, "-");
    });
  const action = METHOD_ACTIONS[method.toUpperCase()] ?? method.toLowerCase();
  return [...segments, action].join(":");
}

export function permissionDescriptionFor(method: string, path: string): string {
  const area = path.split("/").filter(Boolean)[0] ?? "";
  const label = AREA_LABELS[area] ?? area;
  const action = ACTION_LABELS[METHOD_ACTIONS[method.toUpperCase()] ?? ""] ?? method.toUpperCase();
  return `${label} · ${action}（${method.toUpperCase()} ${path}）`;
}

/** 是否纳入权限点（公开路由排除；仅取有路径的 HTTP 方法） */
export function isPermissionRoute(route: RouteEntry): boolean {
  const method = route.method.toUpperCase();
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) return false;
  if (PUBLIC_PATHS.has(route.path)) return false;
  // 根路径：`GET /` 只是 302 跳转到管理台（公开），不该变成权限点（否则权限矩阵里多一条无意义的「read GET /」）
  if (PUBLIC_ROOT_PATHS.has(route.path)) return false;
  // 管理台 SPA 静态资源（/console/*）：公开可访问的静态文件，不是权限实体
  // —— 否则登录页都取不到，且权限矩阵里会多出一堆无意义的「console」权限码。
  if (route.path === ADMIN_MOUNT_PREFIX || route.path.startsWith(`${ADMIN_MOUNT_PREFIX}/`)) return false;
  return route.path.startsWith("/");
}

export interface ScanResult {
  total: number;
  added: number;
  removed: number;
}

/** 用实际路由表刷新权限点（幂等：新增/更新，清理已不存在的码） */
export async function syncPermissions(db: IdentityDb, routes: RouteEntry[]): Promise<ScanResult> {
  const wanted = new Map<string, RouteEntry>();
  for (const route of routes) {
    if (!isPermissionRoute(route)) continue;
    const code = permissionCodeFor(route.method, route.path);
    // 同码多路由（如 /users 与 /users/:id 的 GET）保留首个，避免覆盖
    if (!wanted.has(code)) wanted.set(code, route);
  }

  const existing = await db.pool.query<{ code: string }>("SELECT code FROM permissions");
  const existingCodes = new Set(existing.rows.map((row) => row.code));

  let added = 0;
  for (const [code, route] of wanted) {
    await db.pool.query(
      `INSERT INTO permissions (code, method, path, description, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (code) DO UPDATE SET method = EXCLUDED.method, path = EXCLUDED.path,
         description = EXCLUDED.description, updated_at = now()`,
      [code, route.method.toUpperCase(), route.path, permissionDescriptionFor(route.method, route.path)],
    );
    if (!existingCodes.has(code)) added += 1;
  }

  const stale = [...existingCodes].filter((code) => !wanted.has(code));
  if (stale.length > 0) {
    await db.pool.query("DELETE FROM permissions WHERE code = ANY($1::text[])", [stale]);
  }
  return { total: wanted.size, added, removed: stale.length };
}

export async function listPermissions(db: IdentityDb): Promise<PermissionRow[]> {
  const { rows } = await db.pool.query<{
    code: string;
    method: string;
    path: string;
    description: string | null;
    updated_at: Date | null;
  }>("SELECT code, method, path, description, updated_at FROM permissions ORDER BY path, method");
  return rows.map((row) => ({
    code: row.code,
    method: row.method,
    path: row.path,
    description: row.description,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }));
}

const ROLE_META: Array<{ key: Role; label: string; scope: string }> = [
  { key: "platform_admin", label: "平台管理员", scope: "全公司" },
  { key: "dept_head", label: "部门负责人", scope: "本部门及以下" },
  { key: "user", label: "普通用户", scope: "仅本人" },
];

/** 三角色固定策略（与 routes.ts 内的实际校验保持一致） */
export function permissionAllowed(role: Role, route: RouteEntry): boolean {
  const method = route.method.toUpperCase();
  const path = route.path;
  if (role === "platform_admin") return true;
  // 所有已登录角色都可用：个人中心 + 登出
  if (path === "/me" || path.startsWith("/me/") || path === "/auth/logout") return true;
  if (role === "dept_head") {
    if (method === "GET" && (path === "/users" || path === "/depts/tree")) return true;
    if (path.startsWith("/users") && (method === "PATCH" || path.endsWith("/disable"))) return true;
    return false;
  }
  // user：仅本人（服务端 /users 已按 scope 收敛为单条）
  return method === "GET" && path === "/users";
}

/** 角色 × 权限点矩阵（管理台「角色与权限」页数据源） */
export function roleMatrix(permissions: PermissionRow[]): RolePermissionView[] {
  return ROLE_META.map((role) => ({
    ...role,
    permissions: permissions
      .filter((permission) => permissionAllowed(role.key, { method: permission.method, path: permission.path }))
      .map((permission) => permission.code),
  }));
}
