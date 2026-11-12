/**
 * 界面模式权限 HTTP 路由（管理面）。
 *
 *  - GET /admin/interface-mode-policy   仅 platform_admin：读取编程模式受众
 *  - PUT /admin/interface-mode-policy   仅 platform_admin：写入编程模式受众
 *
 * 下发面（`GET /desktop/policy` 的 `allowedInterfaceModes`）**不在这里** —— 它要挂在既有策略
 * 响应上、且读接口对任意登录用户开放，所以由 `audit/routes.ts` 按 viewer 计算后一并返回。
 * 本模块只管「谁能配」与「配成什么」，不碰下发组装。
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { deptsExist, parseScope } from "../common/scope.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  getInterfaceModePolicy,
  putInterfaceModePolicy,
  type InterfaceModePolicy,
  type InterfaceModeScopeKind,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

const KINDS: InterfaceModeScopeKind[] = ["off", "all", "role", "dept", "user"];

/**
 * 解析请求体里的受众。
 * `off` 直接构造空受众；其余复用 `parseScope`（保证空角色/空部门/空账号的报错文案与 skills/agents 一致）。
 */
function parsePolicy(raw: unknown): { policy: InterfaceModePolicy } | { error: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.kind === "off") return { policy: { kind: "off", roles: [], deptIds: [], uids: [] } };
  const parsed = parseScope(raw);
  if ("error" in parsed) return { error: parsed.error };
  return {
    policy: {
      kind: parsed.scope.kind,
      roles: parsed.scope.roles,
      deptIds: parsed.scope.deptIds,
      uids: parsed.scope.uids,
    },
  };
}

export function createInterfaceModeRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可操作");
    await next();
  };
  app.use("/admin/interface-mode-policy", requireAdmin);

  app.get("/admin/interface-mode-policy", async (c) => c.json({ policy: await getInterfaceModePolicy(db) }));

  app.put("/admin/interface-mode-policy", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return err(c, 400, "请求体非法");
    if (!KINDS.includes(body.kind as InterfaceModeScopeKind)) {
      return err(c, 400, "kind 需为 off|all|role|dept|user");
    }
    const parsed = parsePolicy(body);
    if ("error" in parsed) return err(c, 400, parsed.error);
    if (!(await deptsExist(db, parsed.policy.deptIds))) return err(c, 400, "授权部门不存在");
    const policy = await putInterfaceModePolicy(db, parsed.policy, c.get("claims").sub);
    return c.json({ policy });
  });

  return app;
}
