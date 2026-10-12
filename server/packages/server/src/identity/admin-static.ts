/**
 * 管理台 SPA 静态托管（部署项）：把 `packages/admin/dist` 挂在 `/console` 下，
 * 使 Docker 单镜像即可同时提供 API 与管理台（原先只能靠 vite dev/preview）。
 *
 * ⚠ 为什么不是 `/admin`：管理台前端自身的路由就叫 `/models`、`/providers`…，
 *   而管理台 API 恰好在 `/admin/models`、`/admin/providers`…——挂到 `/admin` 会**路径冲突**，
 *   SPA 的 history 回退会把 API 请求返回成 index.html（实测报 `Unexpected token '<'`）。
 *   故用独立前缀 `/console`；SPA 内请求走同源根路径（见 admin/src/http/client.ts）。
 *
 * 约定：
 *  - `GET /` → 302 到 `/console/`（浏览器打开端口根就直接进管理台；仅在管理台真的挂上时才注册）
 *  - `/console` → 302 到 `/console/`；`/console/` → index.html
 *  - `/console/assets/*` 等带扩展名的路径 → 对应文件；不存在则 **404**（不回退 HTML，避免把资源缺失伪装成页面）
 *  - 其余「看起来像前端路由」的路径（无扩展名）→ index.html（SPA history 回退）
 *  - `/favicon.svg`、`/brand/*` → 根路径同送一份（管理台用绝对路径引用，见 ROOT_BRAND_PATHS）
 *  - 目录不存在时不挂载任何路由，仅告警（API 照常工作）
 *
 * 安全：交给 @hono/node-server 的 serveStatic（自带路径穿越防护），
 *       并在回退分支只接受「无扩展名」路径，避免 `..%2f` 之类被回退逻辑放大。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env, Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

/** 管理台挂载前缀（与 API 的 /admin 前缀隔离，避免前端路由与 API 路径冲突）。 */
export const ADMIN_MOUNT_PREFIX = "/console";

/**
 * 额外挂在**根路径**的品牌资源。
 *
 * 管理台侧栏/登录页写的是绝对路径 `/brand/logo-cube.jpg`，index.html 的 favicon 也是
 * `/favicon.svg`；dev 期 vite 把 `public/` serve 在根，所以这些绝对路径在 dev 下本来就能取到。
 * 反例（实测复现）：只挂 `/console` 前缀时，`/brand/logo-cube.jpg` 解析不到文件
 * ——8791 上 `/console/brand/logo-cube.jpg` 返回 200 image/jpeg，而 `/brand/logo-cube.jpg`
 * 被 authed 组的 `use("*")` 拦成 401，`<img>` 取不到图就退化成浏览器破图占位符。
 * 反例：把前端改成相对路径 `./brand/...` 也不能修——SPA 有 `/console/datasets/:id` 这类
 * 两级路由，相对基址会解析成 `/console/datasets/brand/...`，详情页反而坏。
 * 故在根路径显式挂一份，与 dev 行为对齐。
 *
 * 同时被 `permissions.ts` 消费：这些是公开文件，不该被扫成权限点。
 */
export const ROOT_BRAND_PATHS = ["/favicon.svg", "/brand/*"] as const;

/**
 * 默认产物目录：从编译产物 `packages/server/dist/identity/admin-static.js` 回到 `packages/admin/dist`。
 * ⚠ 必须用 fileURLToPath：`URL.pathname` 不做百分号解码，中文仓库路径（如 `E:\工作\...`）
 *   会变成 `%E5%B7%A5%E4%BD%9C` 从而 stat 不到；它同时正确处理 Windows 盘符。
 */
export const DEFAULT_ADMIN_DIST = fileURLToPath(new URL("../../../admin/dist/", import.meta.url));

/** 解析管理台产物目录（env 优先，便于容器内指向 COPY 进来的路径）。 */
export function resolveAdminDist(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.REACTOR_ADMIN_DIST?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_ADMIN_DIST;
}

/** 把 adminDist 挂到 /console；返回是否真的挂上了。 */
export function mountAdminSpa<E extends Env>(app: Hono<E>, adminDist: string = resolveAdminDist()): boolean {
  const indexHtml = `${adminDist.replace(/[\\/]+$/, "")}/index.html`;
  if (!existsSync(indexHtml)) {
    console.warn(`[identity] 管理台产物不存在，跳过静态托管：${indexHtml}（可用 REACTOR_ADMIN_DIST 指定）`);
    return false;
  }
  const prefix = ADMIN_MOUNT_PREFIX;

  // 0) 品牌资源挂到根路径（原因见 ROOT_BRAND_PATHS 注释）。
  //    ⚠ 必须在 authed 组之前注册：routes.ts 的 authed 用 use("*") 挂在根上，
  //       注册顺序在它之后的路由会被它拦成 401（静态资源也一样）。
  for (const brandPath of ROOT_BRAND_PATHS) {
    app.use(brandPath, serveStatic({ root: adminDist }));
  }

  // 1) 真实文件（含 assets/*.js|css）；rewrite 去掉前缀
  app.use(
    `${prefix}/*`,
    serveStatic({
      root: adminDist,
      rewriteRequestPath: (path) => path.replace(new RegExp(`^${prefix}`), "") || "/",
    }),
  );

  // 2) SPA 回退：仅对「无扩展名」的路径回 index.html（前端路由）；
  //    带扩展名却没命中文件的（少资源）保持 404，不被伪装成页面。
  app.get(prefix, (c) => c.redirect(`${prefix}/`));
  app.get(`${prefix}/`, serveStatic({ root: adminDist, rewriteRequestPath: () => "/index.html" }));
  app.get(`${prefix}/*`, async (c, next) => {
    const tail = c.req.path.replace(new RegExp(`^${prefix}`), "");
    if (/\.[a-zA-Z0-9]+$/.test(tail)) return c.notFound();
    await next();
  });
  app.get(
    `${prefix}/*`,
    serveStatic({ root: adminDist, rewriteRequestPath: () => "/index.html" }),
  );

  console.log(`[identity] 管理台静态托管：${prefix} → ${adminDist}`);
  return true;
}
