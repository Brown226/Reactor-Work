import { Hono } from "hono";
import { registerDwgRoutes } from "./dwg.js";
import { registerExtraRoutes } from "./extras.js";
import { registerFileRoutes } from "./routes-files.js";
import { registerShareRoutes } from "./routes-shares.js";
import { registerTrashRoutes } from "./routes-trash.js";

/**
 * 我的空间后端（方案 §4）。返回挂载到 `/api/space` 的子应用。
 *
 * 路由分四组注册：
 * - 文件区：entries/mkdir/upload/download/preview/rename/move/delete/usage
 * - 回收站：trash/restore/purge
 * - 分享：share/shares/revoke，以及公开的 shared/:token
 * - 增量能力：分片上传（begin/chunk/commit/status）、搜索、打包下载、版本历史
 *
 * 身份统一由每个 handler 自己调用 requireRequestUid()：公开路由不能复用
 * 一个「先解析 uid 再分发」的中间件，否则无登录的分享链接会被 401 拦住。
 */
export function createUserSpaceRoutes(): Hono {
  const app = new Hono();
  registerFileRoutes(app);
  registerTrashRoutes(app);
  registerShareRoutes(app);
  registerExtraRoutes(app);
  // 图形预览：复用容器内 dwg-sidecar 的 graph 输出（前端画 SVG）
  registerDwgRoutes(app);
  return app;
}
