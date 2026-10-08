/**
 * 管理操作审计兜底中间件（洞①，2026-10-08）。
 *
 * 背景：管理台写操作原先只有 7 处手写 `recordAdminAction` 埋点（feedback / gateway /
 * rule-libraries / standards / terminology / updates），skills、agents、组织用户、
 * KB 数据集、策略下发等其余管理面**零留痕**。逐路由补埋点既易漏又难维护，
 * 故改为「中间件统一兜底 + 手写埋点打标去重」：
 *   · 中间件只记骨架（方法 + 路由模式 + 实际路径 + 状态码），**不读 body**——
 *     请求体是流，中间件读走会破坏下游 handler；body 里可能有密钥/口令，读了就有泄漏面。
 *     改前/改后快照这类富信息仍由手写埋点提供（它是唯一写 details 的路径）。
 *   · 手写埋点在闭包第一行调 `markAdminAudited(c)` 打标，中间件 next() 之后见标即跳过，
 *     一个请求只落一条 `admin_action`。
 *
 * 挂载：`identity/routes.ts` 的 authed 组内、Bearer 中间件之后（claims 已就绪）。
 * Hono 按注册顺序组合：authed 的 `use("*")` 经 `app.route("/", authed)` 复制到根后，
 * 早于 `identity/server.ts` 里后挂的全部管理面路由，故 /admin/* 等路由天然被覆盖
 * （与 Bearer 鉴权覆盖管理面的既有机制同一原理）。
 *
 * 标记载体用模块级 `WeakSet` 而不是 `c.set`：各路由文件都有本地 `type AppEnv = {
 * Variables: { claims } }`，往 Variables 里加字段要改 6+ 个文件的类型；Hono 每请求
 * 只有一个 Context 实例贯穿整条链，WeakSet 语义正确且随请求回收。
 */
import type { MiddlewareHandler } from "hono";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import { recordAdminAction, resolveActorForClaims } from "./repo.js";

type AuditEnv = { Variables: { claims: TokenClaims } };

/** 本请求已由手写埋点记过审计（中间件据此跳过，防双写）。 */
const manualAuditDone = new WeakSet<object>();

/**
 * 手写埋点打标：在路由自己的 `audit()` 闭包第一行调用。
 * 参数收 `object` 是刻意的——调用方各自持有本地 `Ctx` 类型，不引入跨文件 env 依赖。
 */
export function markAdminAudited(c: object): void {
  manualAuditDone.add(c);
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** 白名单前缀：命中任一即属管理操作（方法过滤在调用方）。 */
const INCLUDE_PREFIXES = ["/admin/", "/users/", "/depts/", "/v1/kb/"];
/** 白名单精确路径（不含 `/` 结尾语义的项）。 */
const INCLUDE_EXACT = new Set(["/users", "/depts", "/auth/sync", "/desktop/policy"]);
/** 黑名单：白名单内的例外（查询面 / 自身入口 / 登录生命周期 / 个人动作）。 */
const EXCLUDE_PREFIXES = ["/me/"];
const EXCLUDE_EXACT = new Set([
  "/desktop/audit/batch",
  "/auth/logout",
  "/auth/gateway-token",
  "/v1/kb/search",
]);

/**
 * 是否该记一条兜底审计。写方法 + 白名单命中 + 黑名单未命中。
 * 纯函数（path 由调用方传 `c.req.path`），便于直接单测。
 */
export function shouldRecordAdminAudit(method: string, path: string): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  const clean = path.split("?")[0] ?? path;
  if (EXCLUDE_EXACT.has(clean)) return false;
  if (EXCLUDE_PREFIXES.some((p) => clean.startsWith(p))) return false;
  if (INCLUDE_EXACT.has(clean)) return true;
  return INCLUDE_PREFIXES.some((p) => clean.startsWith(p));
}

/** 状态码 → 审计 outcome（401/403 = 主动拒绝，其余非 2xx = 失败）。 */
function outcomeForStatus(status: number): "ok" | "denied" | "error" {
  if (status < 400) return "ok";
  if (status === 401 || status === 403) return "denied";
  return "error";
}

/**
 * 管理操作审计兜底中间件。
 *
 * 顺序约定：必须注册在 Bearer 鉴权之后（拿 claims）且在目标路由之前（Hono 注册序）。
 * 审计写失败不影响响应：`recordAdminAction` 自带 catch（只告警），此处再包一层兜住
 * `resolveActorForClaims` 等前置查询的异常——审计绝不能把管理操作打成 500。
 */
export function adminAuditMiddleware(db: IdentityDb): MiddlewareHandler<AuditEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (!shouldRecordAdminAudit(method, path)) {
      await next();
      return;
    }

    await next();

    // 手写埋点已记（details 快照那条），跳过兜底，避免一案两行。
    if (manualAuditDone.has(c)) return;

    const claims = c.get("claims");
    if (!claims?.sub) return;

    const status = c.res.status;
    const outcome = outcomeForStatus(status);
    // op 用路由模式（不带 :id 实参）防高基数；target 用实际路径保留对象标识。
    const routePattern = (c.req.routePath || path).split("?")[0] ?? path;
    try {
      const actor = await resolveActorForClaims(db, claims);
      await recordAdminAction(db, actor, {
        op: `${method} ${routePattern}`.slice(0, 128),
        target: path.split("?")[0]?.slice(0, 128),
        outcome,
        ...(outcome === "ok" ? {} : { errorCode: String(status) }),
      });
    } catch (err) {
      console.warn(
        `[audit] 管理操作兜底审计失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
