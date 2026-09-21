/**
 * 网关配置（M0-E2）：全部来自环境变量（真实密钥只放本地 .env，已被 gitignore）。
 * M0 单机内网形态：127.0.0.1 监听，dev 令牌鉴权，单一上游（tokenrhythm）。
 */

import { randomUUID } from "node:crypto";

export interface GatewayConfig {
  host: string;
  port: number;
  /** M0 开发令牌：Reactor 各端（sidecar Pi 等）调用网关的唯一凭证 */
  devToken: string;
  /** 模型上游 baseURL（OpenAI 兼容 /v1）——T3-4 起仅作兜底：管理台有配置时以库为准 */
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  /** 管理台数据域 PG；配置后网关以库（ai_providers + secrets）为上游来源 */
  dbUrl?: string;
  /** provider 注册表热生效 TTL（毫秒）：管理台改动最多该时长后生效，无需重启 */
  registryTtlMs: number;
  /** B2：身份令牌验签密钥（REACTOR_JWT_SECRET，与 identity 同源）；未配置则只认 dev token */
  jwtSecret?: string;
  /** B2：是否接受 M0 静态 dev token（默认 true；生产可置 false 强制身份令牌） */
  allowDevToken: boolean;
}

export const DEFAULT_GATEWAY_PORT = 8787;

/** 加载 .env（node 20.12+）；文件缺失时忽略（随后 loadGatewayConfig 会因缺上游 key 报错） */
export function envFileLoader(): void {
  try {
    process.loadEnvFile?.();
  } catch {
    // .env 不存在 → 忽略
  }
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const upstreamApiKey = env.REACTOR_UPSTREAM_API_KEY ?? "";
  if (!upstreamApiKey) {
    throw new Error(
      "REACTOR_UPSTREAM_API_KEY 未配置——模型上游密钥存放于本地 .env（已 gitignore），请复制 .env.example 为 .env 并填写",
    );
  }
  return {
    host: env.REACTOR_GATEWAY_HOST ?? "127.0.0.1",
    port: Number(env.REACTOR_GATEWAY_PORT ?? String(DEFAULT_GATEWAY_PORT)),
    // 留空则启动时随机生成（冒烟/本地开发）；生产 M1 改为服务端签发的短期令牌
    devToken: env.REACTOR_DEV_TOKEN ?? `reactor-dev-${randomUUID()}`,
    upstreamBaseUrl: env.REACTOR_UPSTREAM_BASE_URL ?? "https://tokenrhythm.studio/v1",
    upstreamApiKey,
    dbUrl: env.REACTOR_DB_URL,
    registryTtlMs: Number(env.REACTOR_GATEWAY_REGISTRY_TTL_MS ?? 10_000),
    jwtSecret: env.REACTOR_JWT_SECRET,
    // 默认接受（e2e/sidecar 现网依赖）；生产置 false 即强制身份令牌
    allowDevToken: (env.REACTOR_GATEWAY_ALLOW_DEV_TOKEN ?? "true") !== "false",
  };
}
