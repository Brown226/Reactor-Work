/**
 * 两道预算闸门（W4-①，照 LeAgent `context/budget.py`）。
 *
 * 顺序**不可颠倒**（LeAgent `manager.py:181` 先硬顶、`:188` 后全局）：
 *  ① `enforceSourceHardBudgets` —— 单源硬顶。防一个 source 吃掉整窗；
 *  ② `minimise` —— 全局 `score/cost` 贪心。低性价比的先出局，pinned 优先保。
 *
 * 三道「手册没出现」的原因要分清（LeAgent 的排障坑）：
 *   没进 recipe（候选名单）/ gate 未开（resolve 前）/ 被 minimise 丢掉（预算）。
 * 本模块只管第 3 道，返回值里逐块标注 kept/truncated/dropped 便于定位。
 *
 * 为什么是纯函数：装配发生在**每轮请求前**（Pi 的 `context` 事件），必须零 IO、
 * 零异步、可单测；任何不确定性都会让 KV cache 前缀漂移。
 */

import {
  DEFAULT_SOURCE_HARD_CAP_CHARS,
  PINNED_THRESHOLD,
  SOURCE_HARD_CAPS,
  TRUNCATION_SUFFIX,
  type ContextBlock,
  type ContextScope,
} from "./types.js";

/** 逐块处置结果（审计用） */
export interface BudgetRow {
  readonly sourceId: string;
  readonly priority: number;
  readonly weight: number;
  /** `score = priority * weight * freshnessDecay` */
  readonly score: number;
  /** `ratio = score / max(cost,1)`，贪心排序键 */
  readonly ratio: number;
  readonly originalChars: number;
  readonly keptChars: number;
  readonly action: "kept" | "truncated" | "dropped" | "pinned";
}

export interface MinimiseResult {
  readonly kept: readonly ContextBlock[];
  readonly truncated: readonly ContextBlock[];
  readonly dropped: readonly ContextBlock[];
  readonly rows: readonly BudgetRow[];
  /** 实际保留的字符数 */
  readonly usedChars: number;
}

// ---------------------------------------------------------------------------
// ① 单源硬顶
// ---------------------------------------------------------------------------

/**
 * 逐源硬顶（纯函数，保序）。
 *
 * 超顶的块裁到 `cap - suffix.length` 再追加截断标记 —— 保证**结果总长不超过 cap**
 * （LeAgent 原文如此；先加标记再算长度会溢出，这是常见实现错误）。
 */
export function enforceSourceHardBudgets(
  blocks: readonly ContextBlock[],
  caps: Readonly<Record<string, number>> = SOURCE_HARD_CAPS,
  defaultCap = DEFAULT_SOURCE_HARD_CAP_CHARS,
): ContextBlock[] {
  return blocks.map((block) => {
    const cap = caps[block.sourceId] ?? defaultCap;
    if (block.body.length <= cap) return block;
    const keep = Math.max(0, cap - TRUNCATION_SUFFIX.length);
    const body = block.body.slice(0, keep) + TRUNCATION_SUFFIX;
    return { ...block, body, tokens: Math.max(1, Math.floor(body.length / 3)) };
  });
}

// ---------------------------------------------------------------------------
// ② 全局 cost 最小化
// ---------------------------------------------------------------------------

/**
 * 新鲜度衰减：`process`/`session` 视为不过期，`turn` 轻微折价。
 *
 * 照 LeAgent `budget.py:101-105`。语义是「本轮现算的内容优先于缓存的旧内容」——
 * 折价只有 5%，所以它只在 score 接近时才改变顺序（不会喧宾夺主）。
 */
export function freshnessDecay(scope: ContextScope | undefined): number {
  return scope === "turn" ? 0.95 : 1;
}

/**
 * 全局预算最小化（贪心，确定性）。
 *
 * 算法（照 LeAgent `budget.py:119`）：
 *  1. 按 `priority >= PINNED_THRESHOLD` 拆 pinned / candidates；
 *  2. pinned 按 `(-priority, sourceId)` 排序**先塞**；塞不下的 pinned 截断，仍塞不下则丢弃；
 *  3. candidates 按 `ratio = score / max(cost,1)` 降序贪心塞，超预算即截断，`留不下一个字符`则丢弃；
 *  4. `sourceId` 作 tie-break —— **保证同输入同输出**（否则 hash 前缀会漂）。
 */
export function minimise(
  blocks: readonly ContextBlock[],
  maxChars = 24_000,
  scopes: Readonly<Record<string, ContextScope>> = {},
): MinimiseResult {
  const rows: BudgetRow[] = [];
  const kept: ContextBlock[] = [];
  const truncated: ContextBlock[] = [];
  const dropped: ContextBlock[] = [];

  const scored = blocks.map((block) => {
    const score = block.priority * block.weight * freshnessDecay(scopes[block.sourceId]);
    const ratio = score / Math.max(block.cost, 1);
    return { block, score, ratio };
  });

  // 步骤 1：拆 pinned / 普通
  const pinned = scored
    .filter((s) => s.block.priority >= PINNED_THRESHOLD)
    .sort((a, b) => b.block.priority - a.block.priority || a.block.sourceId.localeCompare(b.block.sourceId));
  const candidates = scored
    .filter((s) => s.block.priority < PINNED_THRESHOLD)
    .sort((a, b) => b.ratio - a.ratio || a.block.sourceId.localeCompare(b.block.sourceId));

  let remaining = maxChars;

  /** 统一的「塞一块」逻辑：能整塞则塞，否则截断，仍不行则丢 */
  const place = (entry: (typeof scored)[number], isPinned: boolean): void => {
    const { block, score, ratio } = entry;
    const len = block.body.length;
    const base = {
      sourceId: block.sourceId,
      priority: block.priority,
      weight: block.weight,
      score,
      ratio,
      originalChars: len,
    };

    if (len <= remaining) {
      kept.push(block);
      remaining -= len;
      rows.push({ ...base, keptChars: len, action: isPinned ? "pinned" : "kept" });
      return;
    }

    // 留得下「内容 + 截断标记」才有意义；否则纯浪费预算
    const keep = remaining - TRUNCATION_SUFFIX.length;
    if (keep > 0) {
      const body = block.body.slice(0, keep) + TRUNCATION_SUFFIX;
      const cut: ContextBlock = { ...block, body, tokens: Math.max(1, Math.floor(body.length / 3)) };
      kept.push(cut);
      truncated.push(cut);
      rows.push({ ...base, keptChars: body.length, action: "truncated" });
      remaining -= body.length;
      return;
    }

    dropped.push(block);
    rows.push({ ...base, keptChars: 0, action: "dropped" });
  };

  for (const entry of pinned) place(entry, true);
  for (const entry of candidates) place(entry, false);

  // 注意：被截断的块**同时**出现在 `kept`（实际内容）与 `truncated`（告警名单）里 ——
  // 前者用于拼消息，后者用于审计/UI 提示。保序由调用方用 `sortBlocks` 统一做。
  return { kept, truncated, dropped, rows, usedChars: maxChars - remaining };
}
