/**
 * 三层排序 + 稳定前缀 + 分流去重（W4-①，照 LeAgent `context/manager.py`）。
 *
 * 核心动机：**provider prompt cache 只在前缀完全一致时命中**。所以：
 *  - pinned（身份/政策）**固定顺序**排最前 → 这部分跨 turn 逐字节不变；
 *  - 普通块按优先级；
 *  - 易变块（环境/召回/工作集/工具历史…）**全部扔到尾部** → 抖动只影响尾巴。
 *
 * 于是 `stableHash`（只算 pinned）跨 turn 恒定，而 `fullHash` 会变 —— 两个 hash 分开，
 * 才能把「前缀漂移」（贵）与「尾部变化」（便宜）区分开做告警。
 */

import {
  MAX_SEEN_ATTACHMENT_SIGNATURES,
  PINNED_THRESHOLD,
  shortHash,
  type ContextBlock,
} from "./types.js";

/**
 * Tier0 固定顺序（照 LeAgent `_PINNED_ORDER`）。
 *
 * **顺序即契约**：改这里等于让所有会话的缓存前缀失效一次。新增项一律追加到尾部，
 * 不要插队。
 */
export const PINNED_ORDER: readonly string[] = [
  "identity",
  "persona",
  "mode",
  "user_instructions",
  "policies",
  "project_memory",
  "workspace",
];

/**
 * Tier2 易变尾部（照 LeAgent `_VOLATILE_SOURCES`）。
 *
 * 这些内容**必须**排在 system 前缀之后或走附件 —— 它们每轮都变，
 * 一旦混进前缀就会让 prompt cache 全量失效。
 */
export const VOLATILE_SOURCES: readonly string[] = [
  "environment",
  "recall",
  "working_set",
  "tool_history",
  "recent_reads",
  "session_artifacts",
  "artifact_regeneration",
];

/** 三个 tier：0=pinned 固定位，1=普通，2=易变尾 */
export function tierOf(block: ContextBlock): 0 | 1 | 2 {
  if (block.priority >= PINNED_THRESHOLD) return 0;
  if (VOLATILE_SOURCES.includes(block.sourceId)) return 2;
  return 1;
}

/**
 * 排序键：`[tier, order, -priority, sourceId]`。
 *
 * `sourceId` 兜底是**必需**的 —— 没有它，同 priority 的块在 V8 排序里顺序不定，
 * 前缀 hash 会随机漂移（这是最难查的一类 cache 穿透）。
 */
export function blockSortKey(block: ContextBlock): [number, number, number, string] {
  const tier = tierOf(block);
  let order = 0;
  if (tier === 0) {
    const idx = PINNED_ORDER.indexOf(block.sourceId);
    // 未登记的 pinned 排在已登记之后（保序，不抛错 —— 让新 source 平滑接入）
    order = idx === -1 ? PINNED_ORDER.length : idx;
  } else if (tier === 2) {
    const idx = VOLATILE_SOURCES.indexOf(block.sourceId);
    order = idx === -1 ? VOLATILE_SOURCES.length : idx;
  }
  return [tier, order, -block.priority, block.sourceId];
}

/** 三层排序（stable，纯函数） */
export function sortBlocks(blocks: readonly ContextBlock[]): ContextBlock[] {
  return [...blocks].sort((a, b) => {
    const ka = blockSortKey(a);
    const kb = blockSortKey(b);
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
    }
    return ka[3].localeCompare(kb[3]);
  });
}

// ---------------------------------------------------------------------------
// 指纹
// ---------------------------------------------------------------------------

/** 稳定前缀指纹：只取 tier0（pinned）的 `sourceId:signature` 串接 */
export function stablePrefixHash(blocks: readonly ContextBlock[]): string {
  const pinned = blocks.filter((b) => tierOf(b) === 0);
  const sorted = sortBlocks(pinned);
  return shortHash(sorted.map((b) => `${b.sourceId}:${b.signature}`).join("\u0000"));
}

/** 全量指纹（含易变尾部） */
export function fullHash(blocks: readonly ContextBlock[]): string {
  const sorted = sortBlocks(blocks);
  return shortHash(sorted.map((b) => `${b.sourceId}:${b.signature}`).join("\u0000"));
}

/** 指纹对比结果（供告警/审计打点） */
export interface DriftReport {
  readonly stableChanged: boolean;
  readonly volatileChanged: boolean;
  readonly prevStable: string;
  readonly nextStable: string;
  readonly prevFull: string;
  readonly nextFull: string;
}

/**
 * 对比两次装配的指纹，区分「前缀漂移」（贵，要告警）与「尾部变化」（便宜，正常）。
 *
 * ⚠️ 指纹**不是 ACL** —— 只用于 cache 命中率诊断，不要拿它做鉴权或一致性校验。
 */
export function detectDrift(prev: readonly ContextBlock[], next: readonly ContextBlock[]): DriftReport {
  const prevStable = stablePrefixHash(prev);
  const nextStable = stablePrefixHash(next);
  const prevFull = fullHash(prev);
  const nextFull = fullHash(next);
  return {
    stableChanged: prevStable !== nextStable,
    volatileChanged: prevFull !== nextFull && prevStable === nextStable,
    prevStable,
    nextStable,
    prevFull,
    nextFull,
  };
}

// ---------------------------------------------------------------------------
// 分流 + 附件签名去重
// ---------------------------------------------------------------------------

export interface SplitResult {
  readonly system: readonly ContextBlock[];
  readonly attachments: readonly ContextBlock[];
}

/** 按 `renderTarget` 分流（各自保序：system 走三层排序，附件按原序） */
export function splitByRenderTarget(blocks: readonly ContextBlock[]): SplitResult {
  const system: ContextBlock[] = [];
  const attachments: ContextBlock[] = [];
  for (const block of blocks) {
    if (block.renderTarget === "system") system.push(block);
    else attachments.push(block);
  }
  return { system: sortBlocks(system), attachments };
}

/**
 * 附件签名去重（FIFO 淘汰，容量上限 256）。
 *
 * 动机：`recall`/`working_set` 这类附件在连续 turn 里内容常常没变，
 * 重复灌入既浪费窗口又污染注意力。用 `(sourceId, signature)` 记「本 session 已注入过」。
 *
 * `seen` 由调用方持有（per-session 状态），本函数**就地修改**它以跨轮累积。
 */
export function dedupeAttachments(
  attachments: readonly ContextBlock[],
  seen: Map<string, true>,
  capacity = MAX_SEEN_ATTACHMENT_SIGNATURES,
): ContextBlock[] {
  const out: ContextBlock[] = [];
  for (const block of attachments) {
    const key = `${block.sourceId}\u0000${block.signature}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    // FIFO：Map 保插入序，超容删最旧
    while (seen.size > capacity) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    out.push(block);
  }
  return out;
}
