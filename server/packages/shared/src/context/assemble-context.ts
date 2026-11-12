/**
 * 上下文装配总入口（W4-①）。
 *
 * 把三道机制串成**一条确定性管线**（顺序即语义，不可重排）：
 *
 * ```
 *   sources（按 recipe 候选名单）
 *     → 并发 resolve（单源异常吞掉返回 null）
 *     → ① enforceSourceHardBudgets   单源硬顶
 *     → ② minimise                   全局 score/cost 贪心
 *     → ③ sortBlocks                 三层排序（pinned 固定位 → 普通 → 易变尾）
 *     → splitByRenderTarget          system 前缀 / user 附件
 *     → dedupeAttachments            附件签名去重
 *     → { system, attachments, ledger }
 * ```
 *
 * 为什么「并发 resolve + 单源 try/catch」：任一 source 挂掉（读文件失败、DB 超时）
 * 不应让整轮装配失败。LeAgent 每个 source 的 `resolve` 都是 try/except 返回 None，
 * 这里保持同一语义（**失败 = 这一轮没有这块内容**，而不是报错）。
 */

import { enforceSourceHardBudgets, minimise, type MinimiseResult } from "./budget.js";
import { dedupeAttachments, detectDrift, fullHash, sortBlocks, splitByRenderTarget, stablePrefixHash } from "./assemble.js";
import {
  DEFAULT_ASSEMBLY_MAX_CHARS,
  approxTokens,
  contentSignature,
  type ContextBlock,
  type ContextRecipe,
  type ContextSource,
  type ResolveContext,
} from "./types.js";

export interface AssembleOptions {
  readonly sources: readonly ContextSource[];
  readonly recipe: ContextRecipe;
  readonly ctx: ResolveContext;
  readonly maxChars?: number;
  /** per-session 的附件去重表（跨轮累积；不传则不做去重） */
  readonly seenAttachments?: Map<string, true>;
  /** 上一次装配的块（用于指纹漂移诊断） */
  readonly previous?: readonly ContextBlock[];
}

export interface AssembleLedger {
  /** 候选 source id（recipe 决定） */
  readonly candidates: readonly string[];
  /** 真正 resolve 出内容的 source id */
  readonly resolved: readonly string[];
  /** resolve 抛错被吞掉的 source id（**静默降级**，但留痕） */
  readonly failed: readonly string[];
  readonly budget: MinimiseResult;
  readonly stableHash: string;
  readonly fullHash: string;
  readonly stableChanged: boolean;
  readonly volatileChanged: boolean;
  readonly totalTokens: number;
}

export interface AssembleResult {
  /** 走 system 前缀的块（已三层排序） */
  readonly system: readonly ContextBlock[];
  /** 走 user 附件的块（已签名去重） */
  readonly attachments: readonly ContextBlock[];
  readonly ledger: AssembleLedger;
}

/** recipe → 启用且存在的 source 列表（保 recipe 声明序） */
export function selectSources(
  sources: readonly ContextSource[],
  recipe: ContextRecipe,
): Array<{ source: ContextSource; priority: number; weight: number }> {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: Array<{ source: ContextSource; priority: number; weight: number }> = [];
  for (const entry of recipe.entries) {
    if (entry.enabled === false) continue;
    const source = byId.get(entry.sourceId);
    // recipe 里写了但没注册 → 跳过（照 LeAgent：`source_classes.get` 取不到就忽略）
    if (!source) continue;
    out.push({
      source,
      priority: entry.priorityOverride ?? source.priority,
      weight: entry.weightOverride ?? source.weight,
    });
  }
  return out;
}

/**
 * 装配一轮上下文。
 *
 * 确定性保证：同 `(sources, recipe, ctx, previous)` → 同输出（含 hash）。
 * 唯一的非确定性来源是 `resolve` 自身的并发，但结果按 recipe 声明序回填，
 * 且最终经 `sortBlocks`（带 `sourceId` tie-break），因此顺序稳定。
 */
export async function assembleContext(options: AssembleOptions): Promise<AssembleResult> {
  const { sources, recipe, ctx } = options;
  const maxChars = options.maxChars ?? recipe.maxChars ?? DEFAULT_ASSEMBLY_MAX_CHARS;
  const selected = selectSources(sources, recipe);

  const failed: string[] = [];
  const resolved: string[] = [];

  // 并发 resolve；单源异常吞掉（失败 = 本轮无此块）
  const settled = await Promise.all(
    selected.map(async ({ source, priority, weight }) => {
      try {
        const block = await source.resolve(ctx);
        if (block === null) return null;
        resolved.push(source.id);
        /**
         * **source 声明为准**（`kind`/`renderTarget`），不从 resolve 产物里读。
         *
         * 理由：这两个字段是「这个 source 是什么 / 该去哪」的**静态声明**（LeAgent 的
         * `ContextSource` Protocol 也把它们放在 source 上）。若改从 block 读，每个 source
         * 都得记得在 resolve 里再传一遍，漏传就静默走错通道 —— 这正是 F4 抓住的 bug。
         *
         * 而 recipe 覆盖优先于 source 自报 priority/weight（recipe 表达的是「本轮」的意图）。
         */
        return {
          ...block,
          sourceId: source.id,
          kind: source.kind,
          renderTarget: source.renderTarget,
          priority,
          weight,
        };
      } catch {
        failed.push(source.id);
        return null;
      }
    }),
  );

  const raw = settled.filter((b): b is ContextBlock => b !== null);

  // ① 单源硬顶 → ② 全局贪心
  const capped = enforceSourceHardBudgets(raw);
  const budget = minimise(capped, maxChars);
  // ③ 三层排序（pinned 固定前缀）
  const ordered = sortBlocks(budget.kept);
  // ④ 分流 + ⑤ 附件去重
  const split = splitByRenderTarget(ordered);
  const attachments = options.seenAttachments
    ? dedupeAttachments(split.attachments, options.seenAttachments)
    : split.attachments;

  const all = [...split.system, ...attachments];
  const stableHash = stablePrefixHash(all);
  const fullHashValue = fullHash(all);
  const drift = options.previous ? detectDrift(options.previous, all) : null;

  return {
    system: split.system,
    attachments,
    ledger: {
      candidates: selected.map((s) => s.source.id),
      resolved,
      failed,
      budget,
      stableHash,
      fullHash: fullHashValue,
      stableChanged: drift?.stableChanged ?? false,
      volatileChanged: drift?.volatileChanged ?? false,
      totalTokens: all.reduce((sum, b) => sum + b.tokens, 0),
    },
  };
}

/** 便捷构造：从纯文本产一个块（自动算 signature/tokens） */
export function makeBlock(input: {
  sourceId: string;
  body: string;
  priority: number;
  weight?: number;
  kind?: ContextBlock["kind"];
  renderTarget?: ContextBlock["renderTarget"];
  cost?: number;
}): ContextBlock {
  const body = input.body;
  return {
    sourceId: input.sourceId,
    kind: input.kind ?? "state",
    renderTarget: input.renderTarget ?? "system",
    body,
    tokens: approxTokens(body),
    // cost 默认 = body 长度：真实字符成本，比 tokens 更贴近「预算占用」
    cost: input.cost ?? body.length,
    signature: contentSignature(input.sourceId, body),
    priority: input.priority,
    weight: input.weight ?? 1,
  };
}
