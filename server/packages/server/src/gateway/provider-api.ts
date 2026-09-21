/**
 * 上游协议类型与自定义请求头（P2）—— 单一事实源。
 *
 * ## 为什么需要「协议类型」
 * 网关有两个入站端点，形态是固定的：
 *   · `POST /v1/messages`          → Anthropic Messages 形态（Pi 内核在用）
 *   · `POST /v1/chat/completions`  → OpenAI Chat 形态（管理台/其它客户端在用）
 * 而**上游**说哪种形态，是每个供应商自己的事。此前网关把两者当成一回事（入站路径直接决定
 * 上游路径），于是「上游只支持 Anthropic 形态」的供应商在 OpenAI 入站下会拿到上游的 4xx，
 * 排查时只看到一句上游报错 —— 典型的「静默错配」。
 *
 * `ai_providers.api` 就是显式声明：
 *   · `auto`（默认，**与历史行为逐字一致**）：入站什么形态就按什么形态发上游
 *   · `openai-chat`：上游只支持 OpenAI Chat
 *   · `anthropic-messages`：上游只支持 Anthropic Messages
 *   · `openai-responses` / `google-generative-ai`：上游是另两种形态 → 入站两个端点都无法直接透传，
 *     网关会**明确报错**（需要协议转换，暂未实现），而不是发一个形态不对的请求过去
 * 另外协议还会影响**模型发现 / 连通性测试**的上游 URL 与鉴权头（Google 用 `x-goog-api-key`，
 * Anthropic 用 `x-api-key` + `anthropic-version`）——这是本字段最实用的地方。
 *
 * ## 自定义 headers
 * 有些自建网关需要额外头（租户号、Referer 等）。`ai_providers.headers` 存 JSON 对象，
 * 会在**所有**出站请求（透传 / 发现 / 测试）上生效。
 * ⚠ 两条硬约束：① 不许覆盖鉴权与传输类头（见 HEADER_DENYLIST）；
 *              ② 这里**不加密**，别把密钥写进来 —— 密钥请走「密钥托管」。
 */

import type { Role } from "../identity/users.js";

export type ProviderApi = "auto" | "openai-chat" | "anthropic-messages" | "openai-responses" | "google-generative-ai";

/**
 * **校验全集**（normalizeApi 用它判定合法值）。
 *
 * ⚠ 不要为了「界面上少几个选项」而删这里的值：删了之后 `normalizeApi("google-generative-ai")`
 * 会静默回退成 `auto`（= 入站什么形态就发什么形态），把一条已配置的供应商**悄悄改掉语义**。
 * 界面要控制的选项面请改 `PROVIDER_APIS_COMMON`。
 */
export const PROVIDER_APIS: ProviderApi[] = ["auto", "openai-chat", "anthropic-messages", "openai-responses", "google-generative-ai"];

/**
 * **界面上提供的协议**（2026-09-19 用户口径：「优先兼容这常见的三种就行」）。
 *
 * 就是「OpenAI 兼容 / OpenAI Responses / Anthropic Messages」三种 + `auto`：
 *   · `auto` 置顶且为默认 —— 它对所有上游都能跑（入站什么形态就发什么形态），
 *     是「不确定该选哪个」时的正确选项；
 *   · `google-generative-ai` **不再在界面提供**（本仓从未接它的请求体转换，选它只会得到明确报错），
 *     但枚举值与相关分支都保留 —— 历史上有这个值的行仍能正常读写。
 */
export const PROVIDER_APIS_COMMON: ProviderApi[] = ["auto", "openai-chat", "openai-responses", "anthropic-messages"];

/** 入站形态（由请求路径决定，只有这两种） */
export type InboundShape = "anthropic-messages" | "openai-chat";

export const PROVIDER_API_LABELS: Record<ProviderApi, string> = {
  auto: "自动（按入站形态透传 · 不确认时选它）",
  "openai-chat": "OpenAI 兼容（/chat/completions）",
  "anthropic-messages": "Anthropic Messages（/messages）",
  "openai-responses": "OpenAI Responses（/responses）",
  "google-generative-ai": "Google Generative AI（暂不支持透传）",
};

export function normalizeApi(raw: unknown): ProviderApi {
  return typeof raw === "string" && (PROVIDER_APIS as string[]).includes(raw) ? (raw as ProviderApi) : "auto";
}

/** 入站路径 → 形态（未知路径按 OpenAI 处理，与历史一致） */
export function shapeFromPath(path: string): InboundShape {
  return path.replace(/\/+$/, "").endsWith("/v1/messages") ? "anthropic-messages" : "openai-chat";
}

/** 形态 → 上游相对路径 */
export function upstreamPathFor(shape: "anthropic-messages" | "openai-chat"): string {
  return shape === "anthropic-messages" ? "messages" : "chat/completions";
}

/**
 * 该 provider 对某个入站形态是否可直通。
 * 返回 `{ ok:true }` 或 `{ ok:false, reason }`（reason 直接给用户看，要说清「为什么不行」）。
 */
export function canServe(
  api: ProviderApi,
  inbound: InboundShape,
): { ok: true; upstreamShape: InboundShape } | { ok: false; reason: string } {
  if (api === "auto") return { ok: true, upstreamShape: inbound };
  if (api === inbound) return { ok: true, upstreamShape: inbound };
  if (api === "openai-responses" || api === "google-generative-ai") {
    return {
      ok: false,
      reason: `该供应商声明的上游协议是「${PROVIDER_API_LABELS[api]}」，与入站请求的形态（${PROVIDER_API_LABELS[inbound]}）不同；跨协议转换暂未实现。请改用与该协议匹配的客户端，或把供应商协议改回「自动」。`,
    };
  }
  return {
    ok: false,
    reason: `该供应商声明只支持「${PROVIDER_API_LABELS[api]}」，收到的是「${PROVIDER_API_LABELS[inbound]}」形态的请求；把供应商协议改成「自动」即可按入站形态透传。`,
  };
}

/* ---------------- 出站请求头 ---------------- */

/** 不允许通过自定义 headers 覆盖的头（鉴权与传输语义，覆盖了只会让人困惑或破坏请求） */
export const HEADER_DENYLIST = [
  "authorization",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-api-key",
  "anthropic-version",
  "x-goog-api-key",
];

const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
const MAX_HEADERS = 20;
const MAX_VALUE_LEN = 512;

/** 校验并归一化自定义 headers（返回错误信息而不是静默丢弃） */
export function parseHeaders(raw: unknown): { headers: Record<string, string> } | { error: string } {
  if (raw == null) return { headers: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "headers 必须是对象（键=头名，值=字符串）" };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) return { error: `headers 最多 ${MAX_HEADERS} 条` };
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const name = k.trim();
    if (!HEADER_NAME_RE.test(name)) return { error: `header 名不合法：${name}（只允许字母/数字/连字符）` };
    if (HEADER_DENYLIST.includes(name.toLowerCase())) return { error: `header「${name}」不允许自定义（鉴权/传输类头由网关自己设置）` };
    if (typeof v !== "string") return { error: `header「${name}」的值必须是字符串` };
    if (v.length > MAX_VALUE_LEN) return { error: `header「${name}」的值过长（>${MAX_VALUE_LEN}）` };
    out[name] = v;
  }
  return { headers: out };
}

/**
 * 按协议构造上游**鉴权头**（自定义 headers 由调用方先铺底，这里后写以覆盖协议相关项）。
 * ⚠ 这里的 apiKey 是解密后的真密钥，绝不写日志。
 */
export function authHeadersFor(api: ProviderApi, apiKey: string, anthropicVersion = "2023-06-01"): Record<string, string> {
  if (api === "anthropic-messages") {
    return { "x-api-key": apiKey, "anthropic-version": anthropicVersion };
  }
  if (api === "google-generative-ai") {
    // 用 header 而不是 `?key=`：URL 会进日志/审计，密钥不该出现在那里
    return { "x-goog-api-key": apiKey };
  }
  // openai-chat / openai-responses / auto 都按 Bearer（auto 的发现与测试按 OpenAI 口径）
  return { authorization: `Bearer ${apiKey}` };
}

/** 上游「模型列表」端点（两条协议路径相同，Google 走 /models 也一样；保留函数以便将来分叉） */
export function modelsEndpoint(baseUrl: string, _api: ProviderApi): URL {
  return new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

/**
 * 连通性测试的目标请求：按协议给端点与最小 body。
 *  - anthropic-messages → `/messages`，body 用 Anthropic 形态（model + max_tokens + messages）
 *  - 其它 → `/chat/completions`，OpenAI 形态
 */
export function testRequestFor(
  api: ProviderApi,
  baseUrl: string,
  model: string,
): { ok: true; endpoint: URL; shape: "anthropic-messages" | "openai-chat"; body: unknown } | { ok: false; reason: string } {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  if (api === "google-generative-ai" || api === "openai-responses") {
    // 这两种形态的请求体我们还没实现 → 宁可明说，也不发一个形态不对的请求过去（那只会得到一个误导性的上游报错）
    return {
      ok: false,
      reason: `该供应商声明的协议是「${PROVIDER_API_LABELS[api]}」，单模型测试尚未支持该形态（需先实现请求体转换）；可先用供应商级「测试连接」验证密钥与 /models 可达性`,
    };
  }
  if (api === "anthropic-messages") {
    return {
      ok: true,
      endpoint: new URL("messages", base),
      shape: "anthropic-messages",
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    };
  }
  return {
    ok: true,
    endpoint: new URL("chat/completions", base),
    shape: "openai-chat",
    body: { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
  };
}

/**
 * 板块专用的测试请求（模型与供应商页的「测试」按钮）。
 *
 * 为什么不能复用 chat 的 testRequestFor：向量/重排**不是** chat 形态，
 * 拿 `{messages:[{role:"user",content:"ping"}]}` 去请求 `/embeddings` 只会拿到上游 400，
 * 界面上看起来像「模型配错了」，实际是测试方法用错了 —— 这种误导比不测更坏。
 *
 * 返回的 `probe` 用于让调用方从回执里取「只能实测才知道的事实」：
 * 向量维度就是典型的例子（模型卡写 4096、实测端点可能给 1024）。
 */
export function boardTestRequestFor(
  type: "embedding" | "rerank",
  baseUrl: string,
  model: string,
): { ok: true; endpoint: URL; body: unknown } | { ok: false; reason: string } {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  if (type === "embedding") {
    return {
      ok: true,
      endpoint: new URL("embeddings", base),
      body: { model, input: ["ping"], encoding_format: "float" },
    };
  }
  return {
    ok: true,
    endpoint: new URL("rerank", base),
    // rerank 各家字段不一（Cohere/Jina 用 query+documents），这里用最通用的那份；
    // 字段归一不在这里做（见 kb/embedder.ts 的头注）。
    body: { model, query: "ping", documents: ["ping", "pong"], top_n: 1 },
  };
}

/** 从 embeddings 回执里取向量维度（拿不到返回 null）。 */
export function embeddingDimFromReply(payload: unknown): number | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { embedding?: unknown } | undefined;
  return Array.isArray(first?.embedding) ? first.embedding.length : null;
}

/** 从 rerank 回执里取结果条数（拿不到返回 null）——用于判断「上游真的按 rerank 语义回了」。 */
export function rerankCountFromReply(payload: unknown): number | null {
  const p = payload as { results?: unknown; data?: unknown } | null;
  if (Array.isArray(p?.results)) return p.results.length;
  if (Array.isArray(p?.data)) return p.data.length;
  return null;
}

/* ---------------- 可见范围（与 skills/agents 同口径） ---------------- */

export interface ScopeActor {
  role?: Role;
  deptId?: number | null;
  uid?: string;
}

/**
 * 纯函数版的可见性判定（与 common/scope.ts 的 visibilitySql 同语义：
 * all 全公司 / role 命中角色 / dept **精确匹配**（不做子树）/ user 命中账号；命中任一即可见）。
 */
export function isScopeVisible(
  scope: { kind: string; roles: string[]; deptIds: number[]; uids: string[] },
  actor: ScopeActor,
): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "role":
      return Boolean(actor.role) && scope.roles.includes(actor.role as string);
    case "dept":
      return actor.deptId != null && scope.deptIds.includes(actor.deptId);
    case "user":
      return Boolean(actor.uid) && scope.uids.includes(actor.uid as string);
    default:
      return true; // 未知口径按“可见”处理，避免因为脏数据把模型全藏了
  }
}
