/**
 * 知识库网关（独立模式）—— 给桌面端用的极简 HTTP server。
 *
 * ## 为什么桌面端需要这个
 *
 * Web 端的链路是 `renderer → fetch(/api/knowledge/owned/*) → Hono → sidecar`，
 * 那条 Hono 由 `entry-http.ts` 启动。**桌面端不启动 HTTP server**：它走
 * `renderer → IPC → main → stdio → agent`，根本没有 HTTP 层。
 *
 * 于是前端那 11,000 行知识库 UI（`packages/ui/src/knowledge/`）里的
 * `fetch("/api/knowledge/owned/...")` 在桌面端没有落点。
 *
 * ## 为什么不改成 IPC
 *
 * 46 个方法逐个写 IPC 通道要改前端 + preload + main 三处，且以后每加一个
 * 后端方法都要动三处。而知识库 UI 本来就按 HTTP 契约写（EvoFlow 的 Web 模式），
 * 起一个只服务知识库的本地 HTTP server 是最小改动面 —— **前端一行不改**，
 * 只把 BASE 从相对路径换成注入的绝对地址。
 *
 * ## 绑定策略
 *
 * 只监听 `127.0.0.1`，端口用 0（让操作系统分配）。这样：
 * - 不占固定端口，不与 Web 端的 3030 冲突；
 * - 不暴露到局域网（知识库是用户私有数据）；
 * - 端口随进程生命周期结束自动释放。
 *
 * 实际端口在 `listening` 回调里拿到，再注入 renderer。
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { registerKnowledgeRoutes } from "./routes.js";

export interface KnowledgeGatewayHandle {
  /** 形如 `http://127.0.0.1:54321`，直接拼到前端 BASE 前。 */
  readonly baseUrl: string;
  readonly port: number;
  /** 关停。幂等；进程退出时必须调用，否则 sidecar 常驻进程会残留。 */
  close(): Promise<void>;
}

export interface StartKnowledgeGatewayOptions {
  /** 知识库数据根目录（sidecar 的 --data-root）。 */
  dataRoot: string;
  /** 指定端口；默认 0 = 系统分配。测试时可传固定端口。 */
  port?: number;
}

/**
 * 启动知识库网关。只挂 `/api/knowledge/owned/*`，没有静态资源、
 * 没有 Agent 管理、没有 WebSocket —— 与 entry-http 的完整 server 完全独立。
 */
export function startKnowledgeGateway(
  options: StartKnowledgeGatewayOptions,
): Promise<KnowledgeGatewayHandle> {
  const app = new Hono();

  // 桌面端是单用户本地进程，不做鉴权：监听地址已限制在 127.0.0.1，
  // 且数据根本身就在本机用户目录下。加 token 只会让 preload 注入更复杂。
  registerKnowledgeRoutes(app, { dataRoot: options.dataRoot });

  // 健康检查：renderer 启动时可以确认网关就绪，避免第一屏请求打空。
  app.get("/healthz", (c) => c.json({ ok: true }));

  return new Promise((resolve, reject) => {
    let settled = false;
    const server: Server = serve(
      {
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: options.port ?? 0,
      },
      (info: AddressInfo) => {
        settled = true;
        resolve({
          baseUrl: `http://127.0.0.1:${info.port}`,
          port: info.port,
          close: () =>
            new Promise<void>((done) => {
              // 已关闭时 close() 会回调 error；统一按完成处理，保证幂等。
              server.close(() => done());
            }),
        });
      },
    ) as unknown as Server;

    // 端口被占用等启动失败会走 error 事件，必须转成 reject，
    // 否则调用方会一直等一个永远不来的回调。
    server.once("error", (error: Error) => {
      if (!settled) reject(error);
    });
  });
}
