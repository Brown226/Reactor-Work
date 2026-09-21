/**
 * 模型板块（对话/向量/重排/生图/语音）—— **镜像自 `packages/shared/src/model.ts`**。
 *
 * ## 为什么是镜像而不是 import
 *
 * 本仓约定：`packages/admin` **不依赖 `@reactor/shared`**（保持独立构建，见
 * `services/audit.ts` / `services/skills.ts` / `services/agents.ts` 的同款说明）。
 * 服务端则相反 —— 它运行时依赖 shared（Dockerfile 专门拷了一层）。
 *
 * 于是这里出现「同一个词表两处实现」的经典风险：改了一边忘另一边，
 * 表现是「界面能选、服务端不认」（最难查的一类不一致）。
 * 处置与 skills/agents 契约完全相同：**镜像 + 探针钉死一致**（t202 逐项比对
 * 本文件与 shared/model.ts 的字面量）。所以两个文件的词表**必须逐字一致**。
 */

/** 板块顺序 = 界面 tabs 顺序（勿随意调整） */
export const MODEL_TYPES = ["chat", "embedding", "rerank", "image", "audio"] as const;

export type ModelType = (typeof MODEL_TYPES)[number];

/** 板块中文名（与 shared 的 MODEL_TYPE_LABEL 逐字一致） */
export const MODEL_TYPE_LABEL: Record<ModelType, string> = {
  chat: "对话模型",
  embedding: "向量模型",
  rerank: "重排序模型",
  image: "生图模型",
  audio: "语音模型",
};

/**
 * 预留板块：网关尚无对应转发链路，界面只读占位、服务端拒绝写入。
 * 放开的那一刻：先实现网关转发 + 探针，再从这里删掉。
 */
export const MODEL_TYPES_RESERVED: readonly ModelType[] = ["image", "audio"];

/** 该板块是否已接入（false = 界面只读占位） */
export function isModelTypeAvailable(t: ModelType): boolean {
  return !MODEL_TYPES_RESERVED.includes(t);
}

/**
 * 归一化：任意输入 → 合法 ModelType（**与 shared/model.ts 的 normalizeModelType 同语义**）。
 *
 * ## 为什么前端也需要它（这不是重复代码，是必需的回退）
 *
 * 管理台与身份服务的**发布是两条独立的进程**：新界面 + 旧服务是常态（服务要重启才更新）。
 * 旧服务的 `/admin/providers` 不返回 `modelType` 字段 —— 如果界面直接按
 * `p.modelType === board` 过滤，**所有供应商都会被筛掉、列表变成空的**，
 * 用户会以为「我配的供应商丢了」（真实发生过，2026-09-19）。所以必须先归一：
 * 缺字段/未知值一律回退 `chat`，与库里的历史默认值一致。
 *
 * 宽松兜底（不认识的返回 chat）而不是返回 null 的理由同 shared：宁可让模型
 * 仍出现在对话板块，也不要让整条记录凭空消失。
 */
export function normalizeModelType(raw: unknown): ModelType {
  if (typeof raw !== "string") return "chat";
  const t = raw.trim().toLowerCase();
  if ((MODEL_TYPES as readonly string[]).includes(t)) return t as ModelType;
  if (t.includes("embed") || t === "text-embedding") return "embedding";
  if (t.includes("rerank") || t.includes("re-rank")) return "rerank";
  if (t.includes("image") || t.includes("diffusion") || t.includes("vision-gen")) return "image";
  if (t.includes("audio") || t.includes("speech") || t === "tts" || t === "asr") return "audio";
  return "chat";
}
