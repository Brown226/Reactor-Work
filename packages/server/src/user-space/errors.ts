import type { Context } from "hono";
import { formatLogPrefix } from "@zcode/shared";

/**
 * 我的空间统一错误：handler 只负责 throw，HTTP 状态码随异常携带。
 *
 * 为什么用异常：路径校验要穿过 routes → repo → trash 多层调用，逐层返回
 * `{ok:false,...}` 会把「拒绝越界」写散成多处 if，漏一个就是目录穿越。
 */
/**
 * 我的空间统一错误码。
 *
 * 422/501/502/504 是给「外部解析组件」留的：DWG 预览要调用容器内的 .NET sidecar，
 * 它的失败分三种语义——没装（501）、图纸本身解析不了（422）、进程超时（504）。
 * 混用 500 会让前端无法区分「换个文件试试」和「找运维装组件」。
 */
export type SpaceErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 500 | 501 | 502 | 504;

export class SpaceError extends Error {
  readonly status: SpaceErrorStatus;

  constructor(message: string, status: SpaceErrorStatus = 400) {
    super(message);
    this.name = "SpaceError";
    this.status = status;
  }
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:user-space", process.pid), ...args);

export function toErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof SpaceError) {
    return c.json({ error: error.message }, error.status);
  }
  // 未知异常只落服务端日志，不把绝对路径 / 系统错误原文返回给客户端。
  log("请求处理失败:", error);
  return c.json({ error: "空间操作失败，请稍后重试" }, 500);
}

/**
 * 子应用经 `app.route()` 挂载后，Hono 的异常会回到父应用的 onError，
 * 子应用自己的 onError 不保证被调用；所以每个 handler 显式包一层，
 * 保证错误响应格式与状态码在任何挂载方式下都一致。
 */
export function spaceRoute(
  handler: (c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      return toErrorResponse(c, error);
    }
  };
}
