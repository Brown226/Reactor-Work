import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import { ServiceCollection } from "@zcode/services";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const sessionAuth = process.env["REACTOR_WEB_SESSION_AUTH"]?.trim() === "1";
  const webWorker = process.env["ZCODE_WEB_WORKER"]?.trim() === "1";
  const identityUrl = process.env["REACTOR_IDENTITY_URL"]?.trim() || undefined;
  const zcodeBuiltinProviderConfigFilePath = sessionAuth
    ? ""
    : await materializeBundledZCodeBuiltinProviderConfig({
        environmentConfigRoot: getAppConfigDir(),
        content: readBundledZCodeBuiltinProviderConfig(),
      });
  const authToken = sessionAuth
    ? undefined
    : process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  if (sessionAuth && !identityUrl) {
    console.error(
      "[zcode-server:http] REACTOR_WEB_SESSION_AUTH=1 但未配置 REACTOR_IDENTITY_URL，无法登录",
    );
    process.exitCode = 1;
    return;
  }
  const services = sessionAuth
    ? // 网关只做会话、静态资源与路由；企业凭据与 agent 服务属于各 uid 的 worker。
      // 这里刻意不创建本地 ServiceCollection，避免网关加载全局旧登录态/后台同步。
      new ServiceCollection()
    : createLocalServices({
        zcodeBuiltinProviderConfigFilePath,
        // Web worker 是单用户执行面，不应向浏览器暴露 Provisioning 写入面。
        providerProvisioningTargetEnabled: !webWorker && Boolean(authToken),
      });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(sessionAuth ? { sessionAuth: true } : {}),
    ...(identityUrl ? { identityUrl } : {}),
    ...(webWorker ? { webWorker: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
