/**
 * Identity HTTP 路由（Hono，第 1 批）。
 * 结构：公开组(/auth/login|refresh|logout) + 鉴权组（Bearer access JWT，其余全部）。
 * 数据范围：platform_admin=全公司 / dept_head=本部门及子部门 / user=本人。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { decodeJwt } from "jose";
import { ADMIN_MOUNT_PREFIX, mountAdminSpa } from "./admin-static.js";
import { createAuditRoutes } from "../audit/routes.js";
import type { IdentityConfig } from "./config.js";
import type { IdentityDb } from "./db.js";
import { buildDeptTree, createDept, deleteDept, loadAllDepts, subtreeIds, updateDept } from "./depts.js";
import {
  AuthError,
  login,
  refreshTokens,
  signAccessToken,
  signGatewayTokenFor,
  verifyAccess,
  type TokenClaims,
} from "./auth.js";
import { hashPassword } from "./passwords.js";
import { revokeAll } from "./token-service.js";
import { listSyncLogs, previewSync, runSync } from "./sync.js";
import {
  createLocalUser,
  findUserById,
  findUserByUid,
  listUsers,
  toPublicUser,
  updateUser,
  type Role,
} from "./users.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;
type RouteHandler = (c: Ctx) => Promise<Response> | Response;

const err = (c: Ctx, status: 400 | 401 | 403 | 404 | 409 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

async function subtree(db: IdentityDb, deptId: number | null): Promise<Set<number>> {
  if (deptId === null) return new Set<number>();
  return subtreeIds(await loadAllDepts(db), deptId);
}

export interface IdentityAppOptions {
  /** 管理台 SPA 产物目录（配置则挂到 /admin）；见 admin-static.ts */
  adminDist?: string;
}

export function createIdentityApp(cfg: IdentityConfig, db: IdentityDb, opts: IdentityAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ⚠ 必须在 authed 组之前挂载：authed 用 use("*") 挂在根上（"未登录即 401"），
  //    注册顺序在它之后的路由会被它拦掉（含静态资源）。
  const consoleMounted = opts.adminDist ? mountAdminSpa(app, opts.adminDist) : false;

  // 根路径：浏览器直接打开 http://<host>:<port>/ 应看到管理台，而不是 API 的 401 JSON。
  // ⚠ 用 302 跳转而不是在 `/` 就地返回 index.html：SPA 产物是**相对基址**（vite `base: "./"`），
  //    它的 assets 只在 /console/ 前缀下才能解析；就地返回 index.html 会让页面去请求 /assets/*（404）。
  // ⚠ 仅当管理台真的挂上了才跳；没挂（缺 dist）时保持原 API 语义，不把人送到 404。
  // 注：只拦 GET —— POST / 等仍落到 authed 组（401），不影响 API 客户端。
  if (consoleMounted) app.get("/", (c) => c.redirect(`${ADMIN_MOUNT_PREFIX}/`, 302));

  app.onError((e, c) => {
    if (e instanceof AuthError) return c.json({ error: { code: String(e.status), message: e.message } }, e.status);
    console.error("[identity] unhandled:", e);
    return c.json({ error: { code: "internal", message: "服务异常" } }, 500);
  });

  // ===== 公开 =====
  app.post("/auth/login", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { username?: string; password?: string } | null;
    if (!body?.username || !body.password) throw new AuthError(400, "请输入账号与密码");
    return c.json(await login(cfg, db, body.username, body.password));
  });

  app.post("/auth/refresh", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { refreshToken?: string } | null;
    if (!body?.refreshToken) throw new AuthError(400, "缺少 refreshToken");
    return c.json(await refreshTokens(cfg, db, body.refreshToken));
  });

  // ===== 鉴权组 =====
  const authed = new Hono<AppEnv>();
  authed.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) return c.json({ error: { code: "unauthorized", message: "未登录" } }, 401);
    const claims = await verifyAccess(cfg, token);
    if (!claims) return c.json({ error: { code: "unauthorized", message: "令牌无效或已过期" } }, 401);
    c.set("claims", claims);
    // 滑动续签（T3-2）：access 剩余有效期 < 5 分钟 → 同 claims 签发新 token 放入 x-new-token。
    let renewed: string | null = null;
    try {
      const payload = decodeJwt(token);
      const exp = typeof payload.exp === "number" ? payload.exp : 0;
      if (exp - Math.floor(Date.now() / 1000) < 5 * 60) renewed = await signAccessToken(cfg, claims);
    } catch {
      renewed = null;
    }
    await next();
    if (renewed) c.res.headers.set("x-new-token", renewed);
  });

  // 登出（鉴权）：服务端吊销该用户全部 refresh token。
  authed.post("/auth/logout", async (c) => {
    await revokeAll(db, c.get("claims").sub);
    return c.json({ ok: true });
  });

  /**
   * B2：以 access 令牌换取**网关令牌**（aud=gateway）。
   * 桌面端/sidecar 拿它去调模型网关，网关据此识别调用者（审计/计量归属）。
   * 不做服务端存储：短生命周期、与 access 同 claims，过期即失效。
   */
  authed.post("/auth/gateway-token", async (c) => {
    const claims = c.get("claims");
    const token = await signGatewayTokenFor(cfg, claims);
    return c.json({
      token,
      audience: "gateway",
      expiresIn: cfg.gatewayTokenTtlSeconds,
      subject: { sub: claims.sub, name: claims.name, role: claims.role, deptId: claims.deptId },
    });
  });

  authed.get("/me", async (c) => {
    const me = await findUserByUid(db, c.get("claims").sub);
    if (!me) return err(c, 404, "用户不存在");
    const scope =
      me.role === "platform_admin"
        ? { kind: "all" as const }
        : me.role === "dept_head"
          ? { kind: "dept" as const, path: me.deptPath }
          : { kind: "self" as const };
    return c.json({ user: toPublicUser(me), scope });
  });

  authed.get("/me/nav", (c) => {
    // 管理台菜单授权（迁移清单 T1-3）：服务端下发当前角色可见的导航 key，
    // 前端 menu.tsx 仅据此过滤渲染（标题/图标/分组仍归前端）。
    const role = c.get("claims").role;
    // D1（合并页）：用户管理（表）与组织管理（树）已并为一页，导航 key 两行合一。
    // ⚠ 本段会被 t187 按**源码字面量**扫描（不看注释），所以这里刻意不写旧的 key 字面量。
    // 页面内再按 `blocksFor(role)` 分左右两块渲染（看用户 ≠ 能改组织）。
    const keys =
      role === "platform_admin"
        ? [
            // 2026-09-19：模型供应商与模型管理合并为一页「模型与供应商」（/providers），
            // 因此这里只剩一个模型相关 key。
            // ⚠ 本段被 t187 按**源码字面量**扫描（它读的是原始文件、**不剥注释**），
            //   所以注释里绝对不能出现已删除的 key 字面量（写了就会被判成多发了一个 key）。
            // 2026-09-19：密钥管理页已下线（不要再下发它的 key —— 前端已无菜单项，
            // 多发一个 key 会被 t187 的「没有多余 key」断言抓住）。
            "overview", "org-users", "roles", "providers", "usage",
            // 导航 key 必须与 packages/admin/src/menu.tsx 逐项对齐：此处漏一个 key，
            // 对应页面即使写好了也**永远不会出现在菜单里**（t186 会断言这条）。
            "kb", "skills", "skill-bundles", "agents", "tools", "mcp", "apps", "synclogs", "audit", "account",
          ]
        : role === "dept_head"
          ? ["overview", "org-users", "roles", "audit", "account"]
          : ["account"];
    return c.json({ keys });
  });

  authed.get("/depts/tree", async (c) => {
    const claims = c.get("claims");
    if (claims.role === "user") return err(c, 403, "无权查看组织");
    const all = await loadAllDepts(db);
    if (claims.role === "dept_head") return c.json({ tree: buildDeptTree(all, claims.deptId ?? undefined) });
    return c.json({ tree: buildDeptTree(all) });
  });

  authed.get("/users", async (c) => {
    const claims = c.get("claims");
    if (claims.role === "user") {
      const me = await findUserByUid(db, claims.sub);
      return c.json({ users: me ? [toPublicUser(me)] : [], total: me ? 1 : 0 });
    }
    const q = c.req.query("q")?.trim() || undefined;
    // 部门筛选（合并页「组织与用户」用：左树选节点 → 右表只列该部门的人）。
    // 「含下级成员」由**前端**用已加载的树算出子树 id 列表传进来，服务端不重复查树。
    const deptRaw = c.req.query("deptIds");
    // ⚠ 三态，别把 `deptIds=`（空值）当成「没传筛选」：显式传了筛选就必须 fail-closed，
    //   否则「子树为空」会被悄悄放大成全公司 —— 那就是越权展示。空字符串 ⇒ `[""]` ⇒ 剔干净 ⇒ 空集。
    const requested = deptRaw !== undefined
      ? deptRaw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      : undefined;
    // 注：`listUsers` 的 deptIds 是 **Set<number>** 而不是数组 —— 第一版按数组写，服务端 tsc 当场报了。
    let deptIds: Set<number> | undefined;
    if (claims.role === "dept_head") {
      // 幂级不放大：请求的部门必须落在**自己**的范围内才生效（求交）；越界则交集为空 ⇒ 返回空，不报错也不放行。
      const allowed = await subtree(db, claims.deptId);
      deptIds = requested !== undefined ? new Set([...allowed].filter((id) => requested.includes(id))) : allowed;
    } else {
      deptIds = requested !== undefined ? new Set(requested) : undefined;
    }
    const roleRaw = c.req.query("role");
    const role: Role | undefined = roleRaw === "platform_admin" || roleRaw === "dept_head" || roleRaw === "user" ? roleRaw : undefined;
    const statusRaw = c.req.query("status");
    const status = statusRaw === "active" || statusRaw === "disabled" ? statusRaw : undefined;
    const rows = await listUsers(db, { deptIds, role, status, q });
    return c.json({ users: rows.map(toPublicUser), total: rows.length });
  });

  const createUser: RouteHandler = async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      uid?: string;
      name?: string;
      email?: string;
      password?: string;
      role?: Role;
      departmentId?: number | null;
    } | null;
    if (!body?.uid || !body.name || !body.password) throw new AuthError(400, "uid/name/password 必填");
    if (!/^[a-zA-Z0-9._-]{2,64}$/.test(body.uid)) throw new AuthError(400, "uid 仅允许字母数字._-（2-64）");
    if (body.password.length < 8) throw new AuthError(400, "密码至少 8 位");
    const role: Role = body.role ?? "user";
    if (role !== "user" && role !== "dept_head" && role !== "platform_admin") throw new AuthError(400, "role 非法");
    try {
      const u = await createLocalUser(db, {
        uid: body.uid,
        name: body.name,
        email: body.email ?? null,
        role,
        departmentId: body.departmentId ?? null,
        passwordHash: hashPassword(body.password),
      });
      return c.json({ user: toPublicUser(u) }, 201);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AuthError(409, "登录账号已存在");
      throw e;
    }
  };

  const patchUser: RouteHandler = async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findUserById(db, id) : null;
    if (!target) return err(c, 404, "用户不存在");
    const claims = c.get("claims");
    const body = (await c.req.json().catch(() => null)) as {
      role?: Role;
      status?: "active" | "disabled";
      departmentId?: number | null;
      name?: string;
      email?: string | null;
      password?: string;
    } | null;
    if (!body) throw new AuthError(400, "请求体非法");

    if (claims.role === "user") return err(c, 403, "无权修改用户");
    if (claims.role === "dept_head") {
      const ids = await subtree(db, claims.deptId);
      if (!ids.has(target.id)) return err(c, 403, "只能管理本部门及以下用户");
      if (target.role === "platform_admin" || body.role || body.departmentId !== undefined || body.password) {
        return err(c, 403, "部门负责人不能改角色/部门/密码或处理管理员");
      }
    }
    const updated = await updateUser(db, target.id, {
      role: body.role,
      status: body.status,
      departmentId: body.departmentId,
      name: body.name,
      email: body.email,
      passwordHash: body.password ? hashPassword(body.password) : undefined,
    });
    return c.json({ user: updated ? toPublicUser(updated) : null });
  };

  const disableUser: RouteHandler = async (c) => {
    const id = Number(c.req.param("id"));
    const target = Number.isInteger(id) ? await findUserById(db, id) : null;
    if (!target) return err(c, 404, "用户不存在");
    const claims = c.get("claims");
    if (claims.role === "user") return err(c, 403, "无权停用用户");
    if (claims.role === "dept_head") {
      const ids = await subtree(db, claims.deptId);
      if (!ids.has(target.id) || target.role === "platform_admin") return err(c, 403, "无权停用该用户");
    }
    const updated = await updateUser(db, target.id, { status: "disabled" });
    return c.json({ user: updated ? toPublicUser(updated) : null });
  };

  const sync: RouteHandler = async (c) => {
    if (c.get("claims").role !== "platform_admin") return err(c, 403, "仅平台管理员可触发同步");
    if (c.req.query("preview") === "1") return c.json({ diff: await previewSync(db, cfg) });
    return c.json({ result: await runSync(db, cfg) });
  };

  const syncLogs: RouteHandler = async (c) => {
    if (c.get("claims").role !== "platform_admin") return err(c, 403, "仅平台管理员可查看");
    return c.json({ logs: await listSyncLogs(db) });
  };

  // ---- U-1 部门 CRUD（仅平台管理员；结构变更不写回 AD） ----
  /** 仓储层抛的是可读业务错误 → 统一转 400，便于前端直接展示 */
  const deptOp = async (c: Ctx, fn: () => Promise<unknown>): Promise<Response> => {
    if (c.get("claims").role !== "platform_admin") return err(c, 403, "仅平台管理员可调整组织");
    try {
      return c.json((await fn()) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(400, e instanceof Error ? e.message : String(e));
    }
  };

  authed.post("/depts", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { parentId?: number | null; name?: string } | null;
    if (!body || typeof body.name !== "string") throw new AuthError(400, "name 必填");
    const parentId = body.parentId === undefined || body.parentId === null ? null : Number(body.parentId);
    if (parentId !== null && !Number.isInteger(parentId)) throw new AuthError(400, "parentId 非法");
    return deptOp(c, async () => ({ dept: await createDept(db, { parentId, name: body.name! }) }));
  });

  authed.patch("/depts/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new AuthError(400, "id 非法");
    const body = (await c.req.json().catch(() => null)) as { name?: string; parentId?: number | null } | null;
    if (!body) throw new AuthError(400, "请求体非法");
    const patch: { name?: string; parentId?: number | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string") throw new AuthError(400, "name 非法");
      patch.name = body.name;
    }
    if (body.parentId !== undefined) {
      if (body.parentId !== null && !Number.isInteger(Number(body.parentId))) throw new AuthError(400, "parentId 非法");
      patch.parentId = body.parentId === null ? null : Number(body.parentId);
    }
    return deptOp(c, async () => ({ dept: await updateDept(db, id, patch) }));
  });

  authed.delete("/depts/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new AuthError(400, "id 非法");
    return deptOp(c, async () => {
      await deleteDept(db, id);
      return { ok: true };
    });
  });

  authed.post("/users", createUser);
  authed.patch("/users/:id", patchUser);
  authed.post("/users/:id/disable", disableUser);
  authed.post("/auth/sync", sync);
  authed.get("/auth/sync/logs", syncLogs);

  // G0 数据面（审计上报/查询、用量聚合、策略下发）：挂进 authed 组，
  // 复用其 Bearer 中间件，因此 audit 路由内部不再自带 use("*")（避免拦掉后续挂载的路由）。
  authed.route("/", createAuditRoutes(db));

  app.route("/", authed);
  return app;
}
