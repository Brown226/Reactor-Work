/**
 * Reactor TS 服务端入口：统一模型网关（M0-E2）+ T3-4 管理台配置生效。
 * M1+：auth（LDAP + 短期令牌）、策略/审计/计量/管理台在此扩展。
 *
 * 上游来源：配置 REACTOR_DB_URL 时以管理台（ai_providers + secrets）为准，env 仅兜底；
 * 未配置时保持 M0 的 env 单上游行为。
 */

import { serve } from "@hono/node-server";
import { envFileLoader, loadGatewayConfig, type GatewayConfig } from "./gateway/config.js";
import { createGatewayApp } from "./gateway/index.js";
import { closeIdentityDb, createIdentityDb, type IdentityDb } from "./identity/db.js";

export * from "./auth/index.js";
export * from "./auth/token.js";
export * from "./auth/ldap.js";
export * from "./common/secrets-crypto.js";
export * from "./gateway/config.js";
export * from "./gateway/index.js";
export * from "./gateway/models.js";
export * from "./gateway/registry.js";

export function main(): void {
  envFileLoader();
  const config: GatewayConfig = loadGatewayConfig();
  // T3-4：接管理台数据域（只读 provider/secret，不建表、不迁移）
  const db: IdentityDb | null = config.dbUrl ? createIdentityDb(config.dbUrl) : null;
  const app = createGatewayApp(config, { db });

  const server = serve(
    { fetch: app.fetch, port: config.port, hostname: config.host },
    (info) => {
      console.log(`[gateway] listening on http://${config.host}:${info.port}`);
      console.log(`[gateway] dev token: ${config.devToken}`);
      console.log(`[gateway] db: ${config.dbUrl ?? "(none, env-only)"}`);
    },
  );

  const shutdown = (sig: string): void => {
    console.log(`[gateway] ${sig} → closing`);
    server.close(() => {
      void (db ? closeIdentityDb(db) : Promise.resolve()).finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
