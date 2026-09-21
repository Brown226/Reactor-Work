/**
 * 网关代理（M0-E2）：OpenAI/Anthropic 兼容的统一出口。
 *
 *  - 鉴权：Reactor 令牌（x-api-key 或 Authorization: Bearer，timing-safe 比对）——未授权 401。
 *  - /v1/messages        → 上游 anthropic（Pi 内核用，thinking/usage 完整）
 *  - /v1/chat/completions → 上游 openai（Web/其它客户端用，M10-02 契约）
 *  - /v1/models          → 模型目录下发（M10-03）
 *  - 请求体/响应流透传；上游密钥只存在于 server 侧，绝不落盘/外泄（密钥零落盘，M10-05 前置）。
 */

import type { Context } from "hono";
import type { GatewayConfig } from "./config.js";
import { createGatewayAuthenticator, type Principal } from "../auth/token.js";
import { joinUrl, type ModelCatalog } from "./models.js";
import { authHeadersFor, canServe, isScopeVisible, shapeFromPath, upstreamPathFor, type InboundShape } from "./provider-api.js";
import { hasFeature, type ProviderSource } from "./registry.js";

const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";

export function createGatewayHandlers(
  config: GatewayConfig,
  source: ProviderSource,
  catalog: ModelCatalog,
) {
  // B2：身份令牌（aud=gateway）优先，dev token 兜底（见 auth/token.ts）
  const authenticator = createGatewayAuthenticator({
    devToken: config.devToken,
    jwtSecret: config.jwtSecret,
    allowDevToken: config.allowDevToken,
  });

  const noUpstream = (c: Context): Response => {
    c.header("x-reactor-upstream", "none");
    return c.json(
      { error: { type: "config_error", message: "no upstream provider configured (admin console: providers/secrets)" } },
      503,
    );
  };

  /** 从请求取令牌：x-api-key 或 Authorization: Bearer。 */
  const readToken = (c: Context): string | undefined => {
    const xApiKey = c.req.header("x-api-key");
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    return xApiKey ?? bearer;
  };

  /**
   * B2：识别调用者。返回 null → 401。
   * dev token 只给 kind=dev（无主体）；身份令牌给出 sub/role/deptId（审计/计量归属）。
   */
  const authenticate = (c: Context): Promise<Principal | null> => authenticator.authenticate(readToken(c));

  /** 归属信息落到回执头，便于排查「这次是谁调的」。 */
  const markPrincipal = (c: Context, p: Principal): void => {
    c.header("x-reactor-auth", p.kind);
    if (p.sub) c.header("x-reactor-subject", p.sub);
  };

  const unauthorized = (c: Context): Response =>
    c.json(
      {
        error: {
          type: "authentication_error",
          message: "invalid reactor token",
          hint: config.jwtSecret
            ? "需要 aud=gateway 的身份令牌（POST /auth/gateway-token 换取），或有效的 dev token"
            : "需要有效的 dev token（未配置 REACTOR_JWT_SECRET，无法校验身份令牌）",
        },
      },
      401,
    );

  /** 透传上游响应并标记「本次由哪个 provider 服务、由谁调用」（流式安全：只带必要头）。 */
  const pipe = (upstream: Response, providerId: string, principal: Principal, clamped?: string): Response =>
    new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "x-reactor-upstream": providerId,
        "x-reactor-auth": principal.kind,
        ...(principal.sub ? { "x-reactor-subject": principal.sub } : {}),
        // 钳制过就明说改了哪个字段（不静默改请求）
        ...(clamped ? { "x-reactor-clamped": clamped } : {}),
      },
    });

  /**
   * T3-4b：从请求体读 model，据此解析目标上游（模型目录已配置时按 model 路由）。
   * 原样保留原始字节：**只有确实需要钳制输出窗口时才重写 body**（见 clampOutput），
   * 避免无谓的序列化损失。
   */
  const readBody = (raw: ArrayBuffer): { model?: string; parsed?: Record<string, unknown> } => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
      return { model, parsed };
    } catch {
      return {};
    }
  };

  /** Anthropic 用 max_tokens；OpenAI 新参数用 max_completion_tokens（旧参数 max_tokens）。 */
  const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_completion_tokens"] as const;

  /**
   * 输出窗口钳制：请求声明的输出上限超过该模型配置的 maxOutput 时，**下调到 maxOutput**。
   *
   * 为什么是「钳制」而不是「拒绝」：上游按模型校验 max_tokens，超限直接 400
   * （Pi 侧表现为空 assistant 消息）；钳到上限能正常出结果，且用回执头
   * `x-reactor-clamped` 明确告知调用方改了什么，不静默。
   *
   * 输入侧（上下文窗口）**不做**：进程内没有 tokenizer，按字符估算会误判；
   * 该侧靠 `/v1/models` 下发的 context_length 由端侧自律 + 上游兜底报错。
   */
  const clampOutput = (
    raw: ArrayBuffer,
    parsed: Record<string, unknown> | undefined,
    maxOutput: number | null | undefined,
  ): { body: ArrayBuffer | string; clamped?: string } => {
    if (!parsed || !maxOutput || maxOutput <= 0) return { body: raw };
    for (const key of OUTPUT_LIMIT_KEYS) {
      const v = parsed[key];
      if (typeof v === "number" && Number.isFinite(v) && v > maxOutput) {
        parsed[key] = maxOutput;
        return { body: JSON.stringify(parsed), clamped: `${key}:${maxOutput}` };
      }
    }
    return { body: raw };
  };

  const modelNotFound = (c: Context, available: string[]): Response => {
    c.header("x-reactor-upstream", "none");
    return c.json(
      {
        error: {
          type: "model_not_found",
          message: "该模型未在管理台配置（models）；请联系管理员在「模型」中添加后重试",
          available_models: available,
        },
      },
      404,
    );
  };

  /**
   * P2：协议错配/范围不可见时说清原因 —— 而不是发一个形态不对的请求过去、让上游报一个看不懂的错。
   */
  const protocolMismatch = (c: Context, providerId: string, reason: string): Response => {
    c.header("x-reactor-upstream", providerId);
    return c.json({ error: { type: "protocol_mismatch", message: reason } }, 400);
  };

  const modelForbidden = (c: Context, model: string): Response => {
    c.header("x-reactor-upstream", "none");
    return c.json(
      { error: { type: "model_forbidden", message: `模型「${model}」未授权给当前账号/部门（可见范围由管理员在「模型管理」里配置）` } },
      403,
    );
  };

  /** 范围判定用的 actor（身份令牌带 sub/role/deptId；dev token 无主体 → 不做限制） */
  const actorOf = (principal: { sub?: string; role?: string; deptId?: number | null }) => ({
    role: principal.role as never,
    deptId: principal.deptId ?? null,
    uid: principal.sub,
  });

  return {
    /** Anthropic Messages 协议透传（Pi 内核 → 上游 anthropic 端点） */
    async proxyAnthropic(c: Context): Promise<Response> {
      const principal = await authenticate(c);
      if (!principal) return unauthorized(c);
      const inbound: InboundShape = shapeFromPath(c.req.path);
      const raw = await c.req.arrayBuffer();
      const { model, parsed } = readBody(raw);
      // 对话链路：只解析对话板块的上游（模型与供应商的板块必须一致，见 shared/model.ts）
      const target = await source.resolve(model, "chat");
      if (!target.ok) {
        return target.reason === "model-not-found" ? modelNotFound(c, target.available) : noUpstream(c);
      }
      const provider = target.provider;
      // P2：可见范围拦截（仅对带主体的身份令牌生效；dev token 不限制，便于本地/e2e）
      if (target.model && principal.kind === "user" && !isScopeVisible(target.model.scope, actorOf(principal))) {
        return modelForbidden(c, target.model.model);
      }
      // P2：协议派发（auto 保持历史行为：入站什么形态就发什么形态）
      const serve = canServe(provider.api, inbound);
      if (!serve.ok) return protocolMismatch(c, provider.id, serve.reason);
      const { body, clamped } = clampOutput(raw, parsed, target.model?.maxOutput ?? null);
      const upstream = await fetch(joinUrl(provider.baseUrl, upstreamPathFor(serve.upstreamShape)), {
        method: c.req.method,
        headers: {
          // 自定义 headers 先铺底（协议/密钥相关的头后写；重叠项不可能出现 —— denylist 已拦）
          ...provider.headers,
          ...authHeadersFor(serve.upstreamShape, provider.apiKey, c.req.header("anthropic-version") ?? ANTHROPIC_DEFAULT_VERSION),
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body,
      });
      return pipe(upstream, provider.id, principal, clamped);
    },

    /** OpenAI Chat Completions 协议透传（Web/其它客户端 → 上游 openai 端点） */
    async proxyOpenAI(c: Context): Promise<Response> {
      const principal = await authenticate(c);
      if (!principal) return unauthorized(c);
      const inbound: InboundShape = shapeFromPath(c.req.path);
      const raw = await c.req.arrayBuffer();
      const { model, parsed } = readBody(raw);
      const target = await source.resolve(model, "chat");
      if (!target.ok) {
        return target.reason === "model-not-found" ? modelNotFound(c, target.available) : noUpstream(c);
      }
      const provider = target.provider;
      // P2：可见范围拦截（仅对带主体的身份令牌生效）
      if (target.model && principal.kind === "user" && !isScopeVisible(target.model.scope, actorOf(principal))) {
        return modelForbidden(c, target.model.model);
      }
      // P2：协议派发
      const serve = canServe(provider.api, inbound);
      if (!serve.ok) return protocolMismatch(c, provider.id, serve.reason);
      const { body, clamped } = clampOutput(raw, parsed, target.model?.maxOutput ?? null);
      const upstream = await fetch(joinUrl(provider.baseUrl, upstreamPathFor(serve.upstreamShape)), {
        method: c.req.method,
        headers: {
          ...provider.headers,
          ...authHeadersFor(serve.upstreamShape, provider.apiKey),
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body,
      });
      return pipe(upstream, provider.id, principal, clamped);
    },

    /**
     * 向量化（KB-⑤）：`POST /v1/embeddings` —— OpenAI 兼容。
     *
     * 为何必须走网关（BRD **M10-01**）：模型调用唯一出口。知识库的向量化也不例外，
     * 否则会出现“聊天走网关、向量直连供应商”的第二个出口 —— 密钥、配额、审计都绕过。
     *
     * 与聊天路由**同一套**治理：同一鉴权（401）→ 同一模型白名单与可见范围（404/403）
     * → 同一上游解析与回执头。不做输出窗口钳制（embeddings 没有 max_tokens）。
     */
    async proxyEmbeddings(c: Context): Promise<Response> {
      const principal = await authenticate(c);
      if (!principal) return unauthorized(c);
      const raw = await c.req.arrayBuffer();
      const { model } = readBody(raw);
      // 向量链路：只听向量板块。否则会把「对话供应商」当向量上游用，
      // 拿回一个上游 4xx（"this model does not support embeddings"），而真正的原因是没配向量供应商。
      const target = await source.resolve(model, "embedding");
      if (!target.ok) {
        return target.reason === "model-not-found"
          ? modelNotFound(c, target.available)
          : noUpstream(c);
      }
      const provider = target.provider;
      if (target.model && principal.kind === "user" && !isScopeVisible(target.model.scope, actorOf(principal))) {
        return modelForbidden(c, model ?? "");
      }
      const upstream = await fetch(joinUrl(provider.baseUrl, "embeddings"), {
        method: "POST",
        headers: {
          ...provider.headers,
          // embeddings 在各家都是 OpenAI 形态 ⇒ 一律用 Bearer（不用 anthropic 的 x-api-key）
          ...authHeadersFor("openai-chat", provider.apiKey),
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body: raw,
      });
      return pipe(upstream, provider.id, principal);
    },

    /**
     * 重排序（KB-⑤）：`POST /v1/rerank` —— Cohere/Jina 风格请求体
     *（`{model, query, documents, top_n}`），**原样透传**，不改写字段。
     *
     * 为何不在此做字段归一：各家 rerank 的字段名/回执形状不一（`top_n` vs `top_k`、
     * `results[].index` vs `relevance_score`）。网关的职责是「唯一出口 + 同一治理」，
     * 业务侧的归一放在 sidecar 适配器里（`kb/embedder.ts`）——在那里能同时兼容多种上游。
     */
    async proxyRerank(c: Context): Promise<Response> {
      const principal = await authenticate(c);
      if (!principal) return unauthorized(c);
      const raw = await c.req.arrayBuffer();
      const { model } = readBody(raw);
      // 重排链路：只听重排板块（理由同 embeddings）
      const target = await source.resolve(model, "rerank");
      if (!target.ok) {
        return target.reason === "model-not-found"
          ? modelNotFound(c, target.available)
          : noUpstream(c);
      }
      const provider = target.provider;
      if (target.model && principal.kind === "user" && !isScopeVisible(target.model.scope, actorOf(principal))) {
        return modelForbidden(c, model ?? "");
      }
      const upstream = await fetch(joinUrl(provider.baseUrl, "rerank"), {
        method: "POST",
        headers: {
          ...provider.headers,
          ...authHeadersFor("openai-chat", provider.apiKey),
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body: raw,
      });
      return pipe(upstream, provider.id, principal);
    },

    /**
     * 模型目录下发（M10-03）。
     * 管理台已配置模型目录时**以库为准**（不再打上游，价目/窗口/能力来自 ai_models）；
     * 未配置时保持 M0 行为：透传上游 /v1/models。
     */
    async listModels(c: Context): Promise<Response> {
      const principal = await authenticate(c);
      if (!principal) return unauthorized(c);
      markPrincipal(c, principal);
      const target = await source.resolve();
      if (!target.ok) return noUpstream(c);
      c.header("x-reactor-upstream", target.provider.id);

      const registryModels = await source.models();
      if (registryModels.curated) {
        c.header("x-reactor-catalog", "db");
        // P2：只下发「当前调用者可见」的模型（口径与 skills/agents 一致）；dev token 不做限制
        const visible = principal.kind === "user" ? registryModels.models.filter((m) => isScopeVisible(m.scope, actorOf(principal))) : registryModels.models;
        c.header("x-reactor-models", String(visible.length));
        return c.json({
          object: "list",
          data: visible.map((m) => ({
            id: m.model,
            object: "model",
            created: 0,
            owned_by: m.providerId,
            provider: m.providerId,
            display_name: m.displayName,
            model_type: m.modelType,
            context_length: m.maxContext,
            max_completion_tokens: m.maxOutput,
            supports_tools: hasFeature(m, "tools"),
            supports_reasoning: hasFeature(m, "reasoning"),
            supports_anthropic: hasFeature(m, "anthropic"),
            supports_vision: hasFeature(m, "vision"),
            features: m.features,
            input_price_per_million: m.pricing.inputPerM,
            output_price_per_million: m.pricing.outputPerM,
            cache_read_price_per_million: m.pricing.cacheReadPerM,
            cache_write_price_per_million: m.pricing.cacheWritePerM,
            currency: m.currency,
          })),
        });
      }

      c.header("x-reactor-catalog", "upstream");
      try {
        const models = await catalog.list();
        return c.json({
          object: "list",
          data: models.map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            // 与库目录路径保持一致：owned_by 一律是 provider code。
            // 桌面端 sidecar 会按它分组注册 Pi provider，从而让 agents.provider 生效。
            owned_by: target.provider.id,
            provider: target.provider.id,
            context_length: m.contextWindow,
            max_completion_tokens: m.maxTokens,
            supports_tools: m.supportsTools,
            supports_reasoning: m.supportsReasoning,
            supports_anthropic: m.supportsAnthropic,
            // 与「以库为准」路径对齐：目录里有 vision 就下发（否则两条路径的能力字段不一致）
            supports_vision: m.supportsVision ?? false,
            input_price_per_million: m.inputPricePer1M,
            output_price_per_million: m.outputPricePer1M,
            cache_read_price_per_million: m.cacheReadPricePer1M,
            cache_write_price_per_million: m.cacheWritePricePer1M,
            currency: m.currency,
          })),
        });
      } catch (err) {
        // 脱敏：上游错误信息可能含内部域名/凭据细节，不外泄（只记服务端日志）
        console.warn(`[gateway] /v1/models 上游目录拉取失败：${err instanceof Error ? err.message : String(err)}`);
        return c.json(
          { error: { type: "upstream_error", message: "上游模型目录暂时不可用，请稍后重试或联系管理员" } },
          502,
        );
      }
    },
  };
}
