/**
 * 模型能力自动检测（2026-10-22）
 *
 * 为什么需要它：discover 的能力判定原本只有两级 ——
 *   ① 上游 `/models` 声明了任意 `supports_*`；
 *   ② 否则查内置快照（`model-presets.ts`，精确/归一化匹配）。
 * 聚合型上游（例如 magpie 这类二次分发的网关）这两级都命中不了：它不在 /models 里声明能力，
 * 模型名又是 `auto/dfmodel`、`group/never-stuck` 这种平台自定义别名。
 * 结果是 `ai_models.features = []` → 网关下发 `supportsTools:false`
 * → 桌面端在 `apps/zcode-cli/packages/adapters/src/model/model.ts:157` 本地直接抛
 *   "Model does not support tool calls"，请求根本到不了上游。
 *
 * 所以这里补两级：
 *   ③ 名字推断（离线、零请求）—— 按模型家族关键字给建议值；
 *   ④ 真实探测（显式触发）—— 带一个 noop tools 定义发极小请求，200 即为真支持。
 *
 * ⚠ 保守原则：③ 只对**能确认家族**的模型给结论。完全未知的 `dfmodel` / `never-stuck`
 * 一律返回空，交给 ④，绝不猜 `tools=true` —— 误标会把「本地明确报错」变成「上游 400」，
 * 排查成本更高（这是本模块最重要的约束）。
 */

/**
 * 与 `registry.ts` 的 KNOWN_FEATURES 保持同一套键；此处不 import 是为了避免 routes→registry→本模块的环状依赖。
 *
 * ⚠ 不含 `anthropic`（2026-10-29）：它是**协议标记**而不是模型能力 ——
 * 网关走哪套 API 由供应商的 `api` 字段决定，桌面端也没有对应字段。
 * 把它当作能力推断/落库，会出现「界面看不到但库里存在」的隐藏值。
 * 库里存量的 anthropic 保留，proxy 仍据此回显 `supports_anthropic`。
 */
export type FeatureKey =
  | "tools"
  | "reasoning"
  | "vision"
  | "json_schema"
  | "native_web_search"
  | "mid_conversation_system"
  | "video"
  | "audio"
  | "pdf";

export interface InferredFeatures {
  features: FeatureKey[];
  /** high = 家族明确命中；none = 未命中或非对话模型（此时不推断） */
  confidence: "high" | "none";
  /** 推断依据（UI 展示 + 排查用），未命中为空串 */
  basis: string;
}

interface FamilyRule {
  match: RegExp;
  features: FeatureKey[];
  /** 展示用家族名 */
  family: string;
}

/**
 * 家族能力基线。
 *
 * 取值依据：这些家族的主力对话模型普遍支持工具调用。
 * 不推断 `anthropic` —— 见 FeatureKey 的说明，它是协议标记，由供应商 `api` 决定。
 */
const FAMILY_RULES: FamilyRule[] = [
  { match: /^claude/, features: ["tools", "reasoning", "vision"], family: "claude" },
  { match: /^(?:gpt-|o1|o3|o4|chatgpt)/, features: ["tools", "reasoning", "vision"], family: "gpt" },
  { match: /^gemini/, features: ["tools", "reasoning", "vision"], family: "gemini" },
  { match: /^qwen/, features: ["tools", "reasoning"], family: "qwen" },
  { match: /^deepseek/, features: ["tools", "reasoning"], family: "deepseek" },
  { match: /^(?:glm|chatglm)/, features: ["tools", "reasoning"], family: "glm" },
  { match: /^(?:kimi|moonshot)/, features: ["tools", "reasoning"], family: "kimi" },
  { match: /^(?:minimax|abab)/, features: ["tools", "reasoning"], family: "minimax" },
  { match: /^llama/, features: ["tools"], family: "llama" },
  { match: /^(?:mistral|mixtral|codestral)/, features: ["tools"], family: "mistral" },
  { match: /^(?:doubao|seed-)/, features: ["tools", "reasoning", "vision"], family: "doubao" },
  { match: /^hunyuan/, features: ["tools", "reasoning"], family: "hunyuan" },
  { match: /^ernie/, features: ["tools", "reasoning"], family: "ernie" },
  { match: /^mimo/, features: ["tools", "reasoning"], family: "mimo" },
  { match: /^step-/, features: ["tools", "reasoning"], family: "step" },
  { match: /^longcat/, features: ["tools", "reasoning"], family: "longcat" },
];

/**
 * 非对话模型（向量 / 重排 / 素材编码）：不参与能力推断。
 * 反例：`qwen3-vl-embedding` 名字里同时有 `qwen` 和 `vl`，不先排除就会被标成
 * `tools+vision`，而它在网关里是给知识库检索用的，端侧根本不会走对话链路。
 */
const NON_CHAT_RE = /(?:^|[-_/])(?:embed|embedding|rerank|reranker|bge|clip|vector)(?:$|[-_/])/;

const VISION_RE = /(?:^|[-_/])(?:vl|vision|omni|multimodal|4v)(?:[-_/.]|$)/;
const AUDIO_RE = /(?:^|[-_/])(?:audio|realtime|voice|speech)(?:[-_/.]|$)/;
const VIDEO_RE = /(?:^|[-_/])(?:video)(?:[-_/.]|$)/;
const REASONING_RE = /(?:^|[-_/])(?:reasoning|thinking|think|r1)(?:[-_/.]|$)/;

/** 归一化：小写 + 去 `vendor/` 前缀（与 `normalizeModelKey` 同口径，但**保留**版本号与点号） */
function normalizeForInfer(raw: string): string {
  const s = raw.trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  return slash >= 0 ? s.slice(slash + 1) : s;
}

/**
 * 按模型名推断能力。零网络开销，用于 discover 的第三级兜底。
 *
 * 只做「家族 + 修饰词」两件事，不做版本号级别的猜测：
 * `deepseek-v4.1-flash` 与 `deepseek-v4-flash` 版本不同但能力基线一致，按家族处理是正确的。
 */
export function inferFeatures(modelId: string): InferredFeatures {
  const name = normalizeForInfer(modelId ?? "");
  if (!name) return { features: [], confidence: "none", basis: "" };
  if (NON_CHAT_RE.test(name)) return { features: [], confidence: "none", basis: "非对话模型" };

  const rule = FAMILY_RULES.find((r) => r.match.test(name));
  if (!rule) return { features: [], confidence: "none", basis: "" };

  const set = new Set<FeatureKey>(rule.features);
  if (VISION_RE.test(name)) set.add("vision");
  if (AUDIO_RE.test(name)) set.add("audio");
  if (VIDEO_RE.test(name)) set.add("video");
  if (REASONING_RE.test(name)) set.add("reasoning");

  return { features: [...set], confidence: "high", basis: `家族:${rule.family}` };
}

export interface ProbeOutcome {
  model: string;
  /** true = 带 tools 能跑通；false = 上游明确拒绝；null = 无法判定（不改库） */
  tools: boolean | null;
  httpStatus: number | null;
  /** 脱敏后的结论，不回传上游响应体原文 */
  detail: string;
}

/** 探测用的最小函数定义：名字故意叫 noop，避免被上游当成真实业务调用 */
const NOOP_TOOL = {
  type: "function",
  function: {
    name: "noop",
    description: "noop",
    parameters: { type: "object", properties: {} },
  },
};

/**
 * 真实探测某个模型是否接受 `tools` 参数。
 *
 * 判定口径（必须是「功能性验证」，不是元数据猜测）：
 *  - HTTP 200             → 上游带着 tools 正常返回了，说明这条链路能跑工具调用；
 *  - 4xx 且响应提到 tool  → 上游明确拒绝，判 false；
 *  - 其余（超时/5xx/无关 4xx）→ null，**不写库**。
 *
 * 只有单次请求能确认 `tools`；vision/audio/video 需要不同形状的输入，不在此处探测。
 */
export async function probeToolsSupport(args: {
  /** 完整的 chat completions 端点（`.../v1/chat/completions`） */
  url: string;
  headers: Record<string, string>;
  model: string;
  timeoutMs?: number;
}): Promise<ProbeOutcome> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  try {
    const res = await fetch(args.url, {
      method: "POST",
      headers: { ...args.headers, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: args.model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        tools: [NOOP_TOOL],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.ok) {
      return { model: args.model, tools: true, httpStatus: res.status, detail: "带 tools 的请求成功返回" };
    }

    const text = (await res.text().catch(() => "")).toLowerCase().slice(0, 2000);
    // 鉴权失败要单独归类：401/403 的报文里常出现 "function calling" 之类的字样（权限清单），
    // 直接按关键词判 false 会得出「模型不支持工具」的错误结论，而真实原因是凭据失效。
    if (res.status === 401 || res.status === 403) {
      return {
        model: args.model,
        tools: null,
        httpStatus: res.status,
        detail: "上游鉴权失败（密钥无效或已过期），无法判定能力",
      };
    }
    const mentionsTools = text.includes("tool") || text.includes("function");
    return {
      model: args.model,
      tools: mentionsTools ? false : null,
      httpStatus: res.status,
      detail: mentionsTools ? `上游明确拒绝 tools（HTTP ${res.status}）` : `无法判定（HTTP ${res.status}，错误与 tools 无关）`,
    };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { model: args.model, tools: null, httpStatus: null, detail: timeout ? "探测超时" : "探测失败（网络/DNS/证书）" };
  }
}
