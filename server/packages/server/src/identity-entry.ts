/**
 * Identity 服务独立入口（第 1 批）。gateway 走 src/index.ts，互不干扰。
 * 运行：pnpm --filter @reactor/server dev:identity
 */

import { envFileLoader } from "./gateway/config.js";
import { loadIdentityConfig } from "./identity/config.js";
import { startIdentityServer, stopIdentityServer } from "./identity/server.js";

envFileLoader();
const cfg = loadIdentityConfig();

let runtime: Awaited<ReturnType<typeof startIdentityServer>> | null = null;

startIdentityServer(cfg)
  .then((rt) => {
    runtime = rt;
  })
  .catch((err: unknown) => {
    console.error("[identity] 启动失败:", err);
    process.exit(1);
  });

const shutdown = async (sig: string): Promise<void> => {
  console.log(`[identity] ${sig} → closing`);
  if (runtime) {
    await stopIdentityServer(runtime).catch(() => undefined);
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
