/**
 * Identity 服务装配（第 1 批）：PG(schema+seed) + Hono 路由 + 监听。
 * 入口见 ../identity-entry.ts（与 gateway 各自独立入口，互不干扰）。
 */

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { loadSecretKey } from "../common/secrets-crypto.js";
import { ensureAuditSchema } from "../audit/schema.js";
import { resolveAdminDist } from "./admin-static.js";
import { ensureAdminSchema } from "../gateway/admin-schema.js";
import { createAdminRoutes, readKbRetrievalConfig } from "../gateway/admin-routes.js";
import { ensureAgentsSchema } from "../agents/repo.js";
import { createAgentsRoutes } from "../agents/routes.js";
import { ensureDatasetsSchema } from "../datasets/repo.js";
import { createDatasetsRoutes, createServerEmbedder, type KbRoutesDeps } from "../datasets/routes.js";
import { ensureSkillsSchema } from "../skills/repo.js";
import { createSkillsRoutes } from "../skills/routes.js";
import type { IdentityConfig } from "./config.js";
import { closeIdentityDb, createIdentityDb, ensureSchema, type IdentityDb } from "./db.js";
import { ensurePermissionsSchema } from "./permissions.js";
import { createPermissionsRoutes } from "./permissions-routes.js";
import { ensureBuiltinLocalAccounts } from "./seed.js";
import { createIdentityApp } from "./routes.js";

export interface IdentityRuntime {
  server: ServerType;
  db: IdentityDb;
  cfg: IdentityConfig;
}

/**
 * 知识库向量化器的装配（KB-⑥）。
 *
 * 经**网关** `/v1/embeddings`（KB-⑤ 已落地）而不是直连上游：模型调用在本仓只有一个出口，
 * 密钥解密与审计都在网关侧，绕过去等于开第二个出口。
 *
 * 未配置 `REACTOR_GATEWAY_TOKEN` 时**不造 embedder** —— 路由会据此把向量路降级为词法，
 * 并在 `/v1/kb/health` 与检索回执的 `meta` 里如实标注（不假装已启用向量）。
 */
/**
 * 装配向量化器。`model` 由调用方传入（**库配置优先、env 兜底**的解析结果），
 * 这样「哪个模型生效」只有一处判断，不会出现「日志说 A、装配用 B」。
 */
function kbEmbedderDeps(
  model: string | undefined,
  source: "admin" | "env" | null,
): Pick<KbRoutesDeps, "embedder" | "embeddingModel" | "embeddingModelSource"> {
  /**
   * 令牌取两个名字（都要认）：
   *  - `REACTOR_GATEWAY_TOKEN` 是**调用方**约定（launch.mjs 给 sidecar 设的就是它）；
   *  - `REACTOR_DEV_TOKEN` 是**网关侧**约定（`gateway/config.ts` 用它做 dev token 校验）。
   * 本服务（identity）既是被调用方也是调用方，且容器只挂 `.env`（里面是后者）——
   * 只认前者会导致「明明配了令牌却永远降级为词法」。实测踩到过。
   */
  const token = (process.env["REACTOR_GATEWAY_TOKEN"] ?? process.env["REACTOR_DEV_TOKEN"])?.trim();
  if (token === undefined || token.length === 0) {
    // 没有网关令牌 ⇒ 造不出 embedder（向量路会如实降级为词法），但仍回报模型名与来源
    return model === undefined || model.length === 0
      ? {}
      : { embeddingModel: model, ...(source !== null ? { embeddingModelSource: source } : {}) };
  }
  /**
   * 网关地址：容器内**必须用 compose 服务名**（`gateway`），用 127.0.0.1 会打到自己身上。
   * compose 的 identity 服务已注入 `REACTOR_GATEWAY_HOST: gateway`；宿主进程场景缺省仍是回环。
   */
  const host = process.env["REACTOR_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const port = process.env["REACTOR_GATEWAY_PORT"]?.trim() || "8790";
  const effective = model === undefined || model.length === 0 ? "bge-m3" : model;
  return {
    embeddingModel: effective,
    // 兜底成 bge-m3 时来源按 env 口径（部署默认），不是管理台选的
    embeddingModelSource: model === undefined || model.length === 0 ? "env" : source ?? "env",
    embedder: createServerEmbedder({
      baseUrl: `http://${host}:${port}`,
      token,
      ...(model === undefined || model.length === 0 ? {} : { model }),
    }),
  };
}

export async function startIdentityServer(cfg: IdentityConfig): Promise<IdentityRuntime> {
  const db = createIdentityDb(cfg.dbUrl);
  // 密钥落盘主密钥（未配置则降级明文，见 secrets-crypto.ts）
  const secretKey = loadSecretKey();
  if (!secretKey) {
    console.warn("[identity] ⚠ REACTOR_SECRET_KEY 未配置：管理台密钥将以明文落库（生产必须配置 32 字节主密钥）");
  }
  await ensureSchema(db);
  await ensureAdminSchema(db, { secretKey }); // 管理台数据域（T3-1/T3-4），与 identity schema 同批初始化
  await ensureSkillsSchema(db); // Skills 技能库（S-1）
  await ensureAgentsSchema(db); // Agent 数字人（A-1）
  await ensurePermissionsSchema(db); // 权限点（U-2）
  await ensureAuditSchema(db); // 审计与用量数据域（G0）
  // 公共知识库（KB-⑥）：建表会顺带探测 pgvector 可用性 —— 不可用不阻断启动，
  // 由路由把它如实透出到 /v1/kb/health（与端上「未配置即纯词法」同口径）。
  const kbSchema = await ensureDatasetsSchema(db);
  if (!kbSchema.vectorReady) {
    console.warn("[kb] ⚠ pgvector 不可用：向量检索将降级为词法 + Node 内余弦（/v1/kb/health 会如实标注）");
  }
  await ensureBuiltinLocalAccounts(db, cfg);
  /**
   * 知识库检索配置（2026-09-19）：**库配置优先，env 兜底**。
   *
   * 为什么要有这个顺序：在此之前向量化模型只认 env（REACTOR_KB_EMBED_MODEL），
   * 管理台上配了向量模型也不生效 —— 界面成了假旋钮。现在库里选了模型就用库里的，
   * 没选才回落到 env（保持既有部署行为不被打破）。
   *
   * ⚠ 装配发生在**启动时**（embedder 是构造出来的闭包），所以改配置后需要重启 identity。
   *   管理台接口会如实返回 requiresRestart，不假装热生效。
   */
  const kbCfg = await readKbRetrievalConfig(db);
  const envEmbedModel = process.env["REACTOR_KB_EMBED_MODEL"]?.trim();
  const effectiveEmbedModel = kbCfg.embeddingEnabled && kbCfg.embeddingModel ? kbCfg.embeddingModel : envEmbedModel;
  if (kbCfg.embeddingEnabled && kbCfg.embeddingModel) {
    console.log(`[kb] 向量化模型来自管理台配置：${kbCfg.embeddingModel}`);
  } else if (envEmbedModel) {
    console.log(`[kb] 向量化模型来自环境变量（管理台未启用）：${envEmbedModel}`);
  }
  const app = createIdentityApp(cfg, db, { adminDist: resolveAdminDist() });
  // 管理台 API（T3-1/T3-4）：挂在 authed 组之后，鉴权复用 authed 的 Bearer 中间件，
  // 路由内部仅再校验 claims.role=platform_admin。
  app.route("/", createAdminRoutes(db, { secretKey }));
  // Skills（S-1 管理面 /admin/skills + S-2 下发面 /me/skills）
  app.route("/", createSkillsRoutes(db));
  // Agents（A-1 管理面 /admin/agents + A-2 下发面 /me/agents）
  app.route("/", createAgentsRoutes(db));
  // 公共知识库（KB-⑥）：/v1/kb/* —— 鉴权与 skills/agents 同一套 claims；
  // 向量化器经网关 /v1/embeddings（KB-⑤），未配置则向量路降级为词法。
  const embedSource: "admin" | "env" | null =
    kbCfg.embeddingEnabled && kbCfg.embeddingModel ? "admin" : envEmbedModel ? "env" : null;
  app.route("/", createDatasetsRoutes(db, { schema: kbSchema, ...kbEmbedderDeps(effectiveEmbedModel, embedSource) }));
  // 权限点（U-2）：挂载在最后 —— 扫描时读的就是「已挂载完整路由表」
  app.route(
    "/",
    createPermissionsRoutes(db, () => app.routes.map((route) => ({ method: route.method, path: route.path }))),
  );
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(`[identity] listening on http://${cfg.host}:${info.port} (authMode=${cfg.authMode})`);
    console.log(`[identity] pg=${cfg.dbUrl}`);
    console.log(`[identity] ldap=${cfg.ldap.url} base=${cfg.ldap.baseDn} loginAttr=${cfg.ldap.loginAttr}`);
  });
  return { server, db, cfg };
}

export async function stopIdentityServer(rt: IdentityRuntime): Promise<void> {
  await closeIdentityDb(rt.db);
  await new Promise<void>((resolve) => rt.server.close(() => resolve()));
}
