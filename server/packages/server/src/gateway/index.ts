/**
 * 网关 Hono 应用（M0-E2 / T3-4）：统一唯一模型出口（NFR-S-01 / M10-01）。
 * 参照 BuildingAI provider-registry + custom(OpenAI 兼容)、penguin 价目表/路由/窗口钳制。
 *
 * T3-4：上游由管理台（ai_providers + secrets）驱动——传入 db 即启用「库为准 + TTL 热生效」；
 *       不传 db 时保持 M0 的 env 单上游行为（可回滚）。
 */

import { Hono } from "hono";
import { createGatewayAuthenticator } from "../auth/token.js";
import { loadSecretKey } from "../common/secrets-crypto.js";
import type { IdentityDb } from "../identity/db.js";
import type { GatewayConfig } from "./config.js";
import { ModelCatalog } from "./models.js";
import { createGatewayHandlers } from "./proxy.js";
import {
  createDbProviderSource,
  createDefaultRegistry,
  createEnvProviderSource,
  type ProviderSource,
} from "./registry.js";

export interface GatewayDeps {
  /** 管理台数据域（缺省 → env 单上游，与 M0 行为一致）。 */
  db?: IdentityDb | null;
  /** 密钥落盘主密钥（解 secrets.field_values 的密）。 */
  secretKey?: Buffer | null;
}

export function createGatewayApp(config: GatewayConfig, deps: GatewayDeps = {}): Hono {
  const fallback = createDefaultRegistry(config);
  const source: ProviderSource = deps.db
    ? createDbProviderSource(deps.db, fallback, {
        secretKey: deps.secretKey ?? loadSecretKey(),
        ttlMs: config.registryTtlMs,
      })
    : createEnvProviderSource(fallback);

  // 目录兜底：仅当管理台未配置模型目录时才会走到上游拉取（见 proxy.listModels）
  const catalog = new ModelCatalog(async () => {
    const target = await source.resolve();
    return target.ok ? target.provider : undefined;
  });
  const handlers = createGatewayHandlers(config, source, catalog);

  // B2：鉴权方式可观测（/health + 启动日志）
  const authMode = createGatewayAuthenticator({
    devToken: config.devToken,
    jwtSecret: config.jwtSecret,
    allowDevToken: config.allowDevToken,
  }).describe();

  console.log(`[gateway] provider 来源=${source.describe()}`);
  console.log(`[gateway] 鉴权=${authMode}`);
  if (config.allowDevToken) {
    console.warn("[gateway] 仍接受 M0 静态 dev token（所有人同一身份，无法归属到人）；生产建议 REACTOR_GATEWAY_ALLOW_DEV_TOKEN=false");
  }
  if (!config.jwtSecret) {
    console.warn("[gateway] 未配置 REACTOR_JWT_SECRET：无法校验身份令牌，只能靠 dev token");
  }
  if (!deps.db) {
    console.warn("[gateway] 未接管理台数据域：上游固定取 env，管理台改动不生效（设置 REACTOR_DB_URL 启用 T3-4）");
  }

  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ ok: true, service: "reactor-gateway", providerSource: source.describe(), auth: authMode }),
  );
  app.post("/v1/messages", (c) => handlers.proxyAnthropic(c));
  app.post("/v1/chat/completions", (c) => handlers.proxyOpenAI(c));
  // KB-⑤：知识库的向量化与重排也走网关（同一鉴权 / 同一模型白名单 —— M10-01 唯一出口）
  app.post("/v1/embeddings", (c) => handlers.proxyEmbeddings(c));
  app.post("/v1/rerank", (c) => handlers.proxyRerank(c));
  app.get("/v1/models", (c) => handlers.listModels(c));
  return app;
}
