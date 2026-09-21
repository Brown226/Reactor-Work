/**
 * 上下文装配（W4-①）—— 契约类型与常量。
 *
 * 设计来源：LeAgent `context/` （Apache-2.0，Python）。本文件是**异源设计的 TS 重写**，
 * 不是逐行翻译：只保留「可测、纯函数、零外部依赖」的部分。
 *
 * 三条主张（这是 LeAgent 上下文层最值钱的地方）：
 *  1. **两道预算闸门**：单源硬顶（防一个 source 吃掉整窗）→ 全局 `score/cost` 贪心
 *     （低性价比的先出局）。见 `budget.ts`。
 *  2. **相关性门控**：重型域手册默认不注入，只有相关轮次或 harness 显式开闸才付费。
 *     见 `relevance.ts`。
 *  3. **三层排序保稳定前缀**：pinned（身份/政策）→ 普通 → 易变尾部。前缀稳 → provider
 *     prompt cache 命中；只变尾部不震整段 system hash。见 `assemble.ts`。
 */

/** 缓存生命周期：`process` 跨会话、`session` 跨 turn、`turn` 每轮重算 */
export type ContextScope = "process" | "session" | "turn";

/** 块的去向：system 前缀 vs user 附件（易变状态不该进 system 前缀） */
export type RenderTarget = "system" | "attachment_user";

/** 附件种类（仅用于渲染/统计，不影响排序） */
export type AttachmentKind = "recall" | "working_set" | "tool_history" | "recent_reads";

/** 块的性质：`identity` 是「我是谁」（政策/人设），`state` 是「现在怎样」 */
export type ContextBlockKind = "identity" | "state";

// ---------------------------------------------------------------------------
// 常量（照 LeAgent `context/budget.py` 取值）
// ---------------------------------------------------------------------------

/** 达到该优先级即视为 pinned：先占预算，且进稳定前缀 */
export const PINNED_THRESHOLD = 1000;

/** 超预算时的截断标记（在正文尾部追加） */
export const TRUNCATION_SUFFIX = "\n…[truncated by context budget]";

/** 单源默认硬顶（字符） */
export const DEFAULT_SOURCE_HARD_CAP_CHARS = 30_000;

/** 全局装配预算（字符） */
export const DEFAULT_ASSEMBLY_MAX_CHARS = 24_000;

/** 逐源硬顶表（照 LeAgent `SOURCE_HARD_CAPS`；未列出的走默认） */
export const SOURCE_HARD_CAPS: Readonly<Record<string, number>> = {
  tool_history: 12_000,
  recent_reads: 12_000,
  recall: 12_000,
  working_set: 12_000,
  session_attachments: 18_000,
  session_artifacts: 12_000,
  project_memory: 24_000,
  playbooks: 18_000,
  art_playbook: 18_000,
  document_generation: 18_000,
  structured_output_elicitation: 6_000,
  policies: 18_000,
};

/** 同 session 内附件签名去重表上限（超过按 FIFO 淘汰最旧） */
export const MAX_SEEN_ATTACHMENT_SIGNATURES = 256;

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

/**
 * 一个可装配的上下文块。
 *
 * 注意 `tokens` 与 `cost` **解耦**：有的 source 用 `body.length` 当 cost（真实算力成本），
 * 而 tokens 只是给用户看的窗口占比估算。混用会让「性价比排序」失真。
 */
export interface ContextBlock {
  readonly sourceId: string;
  readonly kind: ContextBlockKind;
  readonly renderTarget: RenderTarget;
  readonly body: string;
  /** 窗口占比估算 */
  readonly tokens: number;
  /** 装配成本（用于 score/cost 贪心） */
  readonly cost: number;
  /** 内容指纹（用于去重/漂移检测） */
  readonly signature: string;
  /** 越大越先保留；≥ PINNED_THRESHOLD 为 pinned */
  readonly priority: number;
  /** 权重乘子（0 表示可随时丢） */
  readonly weight: number;
  readonly attachmentKind?: AttachmentKind;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 一个上下文来源（resolve 由调用方实现，本层只定义契约） */
export interface ContextSource {
  readonly id: string;
  readonly kind: ContextBlockKind;
  readonly scope: ContextScope;
  readonly priority: number;
  readonly weight: number;
  readonly renderTarget: RenderTarget;
  /** 缓存键；**必须包含「本轮是否 relevant」**，否则会把跳过结果与命中结果缓存串味 */
  invalidationKey(ctx: ResolveContext): string;
  resolve(ctx: ResolveContext): Promise<ContextBlock | null>;
}

/** 交给每个 source 的运行时句柄 */
export interface ResolveContext {
  readonly sessionId: string;
  readonly query: string;
  readonly workflowHint?: string;
  readonly templateVars?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** recipe 条目：声明「本轮邀请哪些 source」+ 可选覆盖 */
export interface RecipeEntry {
  readonly sourceId: string;
  readonly priorityOverride?: number;
  readonly weightOverride?: number;
  readonly enabled?: boolean;
}

/** recipe：只决定**候选名单**，不决定保留（保留由预算闸门决定） */
export interface ContextRecipe {
  readonly name: string;
  readonly entries: readonly RecipeEntry[];
  readonly maxChars?: number;
}

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

/**
 * 粗略 token 估算（照 LeAgent：`max(1, len // 3)`）。
 *
 * 刻意保持「粗略且确定」——它只用于预算排序与 UI 展示，不用于计费。
 * 真正精确的计数在内核（Pi）侧，不要在这里试图对齐 provider 的 tokenizer。
 */
export function approxTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 3));
}

/** 内容指纹：`<sourceId>:<sha256 前 16 位>`（照 LeAgent `content_signature`） */
export function contentSignature(sourceId: string, body: string): string {
  return `${sourceId}:${shortHash(`${sourceId}:${body}`)}`;
}

/**
 * 确定性短哈希（FNV-1a 64 位，十六进制 16 字符）。
 *
 * 为什么不用 `node:crypto`：本模块要能在**渲染进程/浏览器**里跑（前端也要算 drift），
 * 且只需要「稳定、低碰撞、可测」，不需要密码学强度。
 */
export function shortHash(input: string): string {
  // FNV-1a 64 位（BigInt 保证跨平台一致，不依赖 32 位溢出）
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
