/**
 * 权限点 HTTP 路由（U-2）：扫描 / 列表 / 角色矩阵。
 * 鉴权复用 identity authed 中间件注入的 claims；仅 platform_admin 可扫描与管理。
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { TokenClaims } from "./auth.js";
import type { IdentityDb } from "./db.js";
import { listPermissions, roleMatrix, syncPermissions, type RouteEntry } from "./permissions.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

export function createPermissionsRoutes(db: IdentityDb, routes: () => RouteEntry[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可操作");
    await next();
  };
  app.use("/admin/permissions", requireAdmin);
  app.use("/admin/permissions/*", requireAdmin);
  app.use("/admin/roles", requireAdmin);

  /** 权限点清单 + 三角色矩阵 */
  app.get("/admin/permissions", async (c) => {
    const permissions = await listPermissions(db);
    return c.json({ permissions, roles: roleMatrix(permissions) });
  });

  /** 扫描当前路由表刷新权限点（幂等；返回新增/清理数量） */
  app.post("/admin/permissions/scan", async (c) => {
    const result = await syncPermissions(db, routes());
    const permissions = await listPermissions(db);
    return c.json({ result, permissions, roles: roleMatrix(permissions) });
  });

  app.get("/admin/roles", async (c) => {
    const permissions = await listPermissions(db);
    return c.json({ roles: roleMatrix(permissions), scanned: permissions.length > 0 });
  });

  return app;
}
