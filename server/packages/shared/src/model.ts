/**
 * 模型类型契约（模型与供应商页重构，2026-09-19）—— 单一事实源。
 *
 * ## 为什么要有这个文件
 *
 * 管理员口径（用户拍板）：**模型按用途分成五个板块，每个板块有自己专属的供应商**。
 * 也就是说「同一个上游既服务对话、又服务向量」时，是**两条独立配置**（各自的密钥/Base URL/启停），
 * 而不是一条记录被两个板块引用 —— 这样任一板块改动不会串到别的板块。
 *
 * 这条口径要落到三处：DB（`ai_providers.model_type` / `ai_models.model_type`）、
 * 服务端路由（按类型解析上游）、管理台界面（五个板块）。**三处必须同一份词表**，
 * 否则会出现「界面能选、服务端不认」这类最难查的不一致。
 *
 * ## 为什么类型要同时挂在「供应商」和「模型」上
 *
 * - `ai_providers.model_type`：板块归属（本板块专属供应商）—— 决定左列表分到哪个板块；
 * - `ai_models.model_type`：模型用途（对话/向量/重排…）—— 决定网关按哪条链路调用。
 *
 * 两者在导入时**由服务端强制对齐**（见 admin-routes 的 import/discover）：模型落库时
 * 取其供应商的类型，避免出现「对话板块下的供应商挂了向量模型」这种错配。
 */

/** 模型与供应商板块（顺序 = 界面 tabs 顺序，勿随意调整） */
export const MODEL_TYPES = ["chat", "embedding", "rerank", "image", "audio"] as const;

export type ModelType = (typeof MODEL_TYPES)[number];

/** 板块中文名（界面 tabs / 徽标共用；改文案只改这里） */
export const MODEL_TYPE_LABEL: Record<ModelType, string> = {
  chat: "对话模型",
  embedding: "向量模型",
  rerank: "重排序模型",
  image: "生图模型",
  audio: "语音模型",
};

/**
 * 预留板块：网关**尚无**对应转发链路（无 `/v1/images/generations`、无 `/v1/audio/*`）。
 *
 * 界面照常渲染这两个 tab，但必须**如实标注「预留 · 本期未接入」并禁止配置** ——
 * 让用户配一个永远不会生效的东西，比不提供这个入口更坏（排查时会怀疑是自己配错了）。
 * 放开的那一刻：先实现网关转发 + 探针，再把这个集合里的项删掉。
 */
export const MODEL_TYPES_RESERVED: readonly ModelType[] = ["image", "audio"];

/** 该类型是否已接入（false = 界面只读占位，服务端拒绝写入） */
export function isModelTypeAvailable(t: ModelType): boolean {
  return !MODEL_TYPES_RESERVED.includes(t);
}

/**
 * 归一化：任意输入 → 合法 ModelType。
 *
 * 为什么给**宽松兜底**（不认识的返回 chat）而不是返回 null：`ai_models.model_type`
 * 是历史字段，线上可能存着 `text-embedding` / `llm` 之类来自上游目录的写法；
 * 兜底成 chat 至少让模型仍可在对话板块被选中，而不是整条记录消失。
 * 需要严格判定的地方（写入接口）另有 `isModelType` 校验。
 */
export function normalizeModelType(raw: unknown): ModelType {
  if (typeof raw !== "string") return "chat";
  const t = raw.trim().toLowerCase();
  if ((MODEL_TYPES as readonly string[]).includes(t)) return t as ModelType;
  // 历史/上游别名：embedding 系与 rerank 系各收几种常见写法
  if (t.includes("embed") || t === "text-embedding") return "embedding";
  if (t.includes("rerank") || t.includes("re-rank")) return "rerank";
  if (t.includes("image") || t.includes("diffusion") || t.includes("vision-gen")) return "image";
  if (t.includes("audio") || t.includes("speech") || t === "tts" || t === "asr") return "audio";
  return "chat";
}

/** 严格判定（写入接口用）：输入必须就是五个枚举之一，不接受别名 */
export function isModelType(raw: unknown): raw is ModelType {
  return typeof raw === "string" && (MODEL_TYPES as readonly string[]).includes(raw.trim().toLowerCase());
}
