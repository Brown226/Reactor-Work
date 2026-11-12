/**
 * 记忆维护与巩固（W4 遗留）—— **纯函数规划层**。
 *
 * 设计来源：LeAgent `memory/maintenance.py` + `memory/compaction.py`（Apache-2.0）。
 * 常量与判定式逐项照抄（它们是产品语义，不是实现细节）；只把「算」与「落盘」分开：
 * 本模块**只产出计划**（要衰减谁、忘掉谁、合并谁、巩固出哪些事实），
 * 由 sidecar 的 `memory/maintenance.ts` 负责原子改写 JSONL。
 *
 * 为什么必须有这一层（否则记忆只能默认关）：
 * 我们的真源是 **append-only JSONL** —— 每轮 observe 追加一行，**永不回收**。
 * 没有维护任务时文件线性增长，且 `recalled` / `procedureRun` 这类「事件行」会无限堆积
 * （它们的**效果已烘进** `recallCount`/`runCount`，行本身没有保留价值）。
 *
 * 四件事（照 LeAgent）：
 *  ① **重要度衰减**：`old * 0.95`，被召回过则按次数补偿，下限 0.02；
 *  ② **低价值遗忘**：两段式过滤（先便宜的年龄/重要度/召回数谓词，再算 `retentionScore`）；
 *  ③ **事实置信衰减**：久未刷新的 semantic fact `* 0.97`，下限 0.10；
 *  ④ **巩固**：把「值得的」episode 提升为 semantic fact（确定性 key，可重复执行）；
 *     以及单个会话 episode 超限时把最旧的合并成一条（防单会话爆炸）。
 */

import { retentionScore } from "./formation.js";
import type { Episode, Fact, Procedure } from "./types.js";

// ---------------------------------------------------------------------------
// 常量（照 LeAgent 原值）
// ---------------------------------------------------------------------------

/** 相似度合并阈值（LeAgent 预留；我们的合并按会话数量触发，不做文本相似度） */
export const SIMILARITY_MERGE_THRESHOLD = 0.9;
/** 重要度衰减率 */
export const IMPORTANCE_DECAY_RATE = 0.95;
/**
 * `retentionScore` 的**理论下限**。
 *
 * 公式在未提供 `confidence` 时会加一个常数项 `0.075`（见 `formation.ts`），
 * 而 `importance=0, recallCount=0, ageDays→∞` 时前两项都趋于 0 —— 于是
 * 保留分**永远不会低于 0.075**。这条下限是本文件下面那个阈值必须越过的坎。
 */
export const RETENTION_FORMULA_FLOOR = 0.075;

/**
 * 遗忘的 `retentionScore` 阈值。
 *
 * ⚠️ **对 LeAgent 的刻意偏离（原值 0.05 是死代码）**：
 * LeAgent 的 `forget_low_value_episodes` / `prune_low_importance` 调用
 * `retention_score(importance=…, recall_count=…, age_days=…)` —— **不传 confidence**，
 * 于是拿到 `+0.075` 的常数项，而它的阈值写的是 `0.05`。0.05 < 0.075 ⇒
 * **任何条目都不可能低于阈值 ⇒ 遗忘任务从不删除任何东西**（实测：低价值条目
 * 的保留分随年龄单调趋近 0.075 而非 0，见探针 B 组的断言）。
 *
 * 我们的目的是「有界」，照抄一个永不触发的阈值等于没做这件事。因此把阈值抬到
 * 下限之上、并保留原意（「很久没被用过且价值极低 → 忘掉」）：
 * 实测行为 ≈ **早于约 120 天 + 零召回 + 低重要度** 才遗忘，与 LeAgent
 * 第一段谓词（`older_than_days=120`）的意图一致。
 */
export const MIN_IMPORTANCE_THRESHOLD = 0.12;
/** 单会话 episode 数上限（超出则合并最旧的） */
export const MAX_EPISODES_PER_SESSION = 500;
/** 衰减下限（防止未回收前变成不可恢复的 0；由遗忘任务负责真正删除） */
export const IMPORTANCE_DECAY_FLOOR = 0.02;
/** 每被召回一次，补偿多少重要度（可完全抵消衰减） */
export const RECALL_PROTECTION_PER_COUNT = 0.01;
/** 事实置信衰减率 */
export const FACT_CONFIDENCE_DECAY_RATE = 0.97;
/** 事实置信下限 */
export const FACT_CONFIDENCE_FLOOR = 0.1;
/** 事实多久未刷新才衰减（天） */
export const FACT_DECAY_OLDER_THAN_DAYS = 90;
/** 遗忘的第一段谓词：早于多少天 */
export const FORGET_OLDER_THAN_DAYS = 120;
/** 遗忘的第一段谓词：重要度不高于 */
export const FORGET_MAX_IMPORTANCE = 0.07;
/** 遗忘的第一段谓词：召回次数不多于 */
export const FORGET_MAX_RECALLS = 0;
/** 变化小于该值就不落盘（照 LeAgent `abs(new-old) > 0.001`） */
export const DECAY_EPSILON = 0.001;
/** 巩固为事实时，置信上限 */
export const CONSOLIDATED_CONFIDENCE_CAP = 0.85;
/** 巩固为事实时，置信基数 */
export const CONSOLIDATED_CONFIDENCE_BASE = 0.45;
/** 巩固的最小摘要长度 */
export const CONSOLIDATE_MIN_SUMMARY_LEN = 40;
/** 巩固的最小重要度 */
export const CONSOLIDATE_MIN_IMPORTANCE = 0.2;
/** 合并进「已巩固」摘要时最多取几条 / 每条取多长 */
export const MERGED_SUMMARY_MAX_ITEMS = 10;
export const MERGED_SUMMARY_ITEM_CHARS = 200;
/** 合并出的 episode 用固定重要度（照 LeAgent） */
export const MERGED_EPISODE_IMPORTANCE = 0.3;
/** 合并摘要前缀（同时是「这是机器合并产物」的可 grep 标记） */
export const CONSOLIDATED_PREFIX = "[Consolidated memory] ";

/**
 * 全局硬上限（**我们的补充**，LeAgent 没有）。
 *
 * 为什么加：LeAgent 的遗忘依赖「年龄 > 120 天」这一时间条件 —— 在**短时间高频使用**
 * 的场景（一个下午几百轮）里，没有任何条目够老，于是文件仍会快速增长。
 * 全局上限是兜底：条数超限时**按 retentionScore 从低到高淘汰**，保证有界。
 */
export const GLOBAL_EPISODE_CAP = 2_000;

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

export interface ValueChange {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

export interface MergeGroup {
  readonly sessionId: string;
  /** 被合并掉（将从库中移除）的 episode id */
  readonly removeIds: readonly string[];
  /** 合并产出的新 episode */
  readonly merged: Episode;
}

export interface MaintenancePlan {
  /** ① 重要度衰减（只含**变化超过阈值**的） */
  readonly episodeImportance: readonly ValueChange[];
  /** ② 要遗忘的 episode id */
  readonly forgetEpisodeIds: readonly string[];
  /** ③ 事实置信衰减（只含变化超过阈值的） */
  readonly factConfidence: readonly ValueChange[];
  /** ④ 要写入的新 semantic fact（巩固产物） */
  readonly consolidate: readonly Fact[];
  /** ④ 单会话超限时的合并组 */
  readonly mergeGroups: readonly MergeGroup[];
  /** ④c 全局上限兜底要淘汰的 episode id（按 retentionScore 从低到高） */
  readonly capEvictedEpisodeIds: readonly string[];
  readonly counts: {
    readonly episodesTotal: number;
    readonly decayed: number;
    readonly forgotten: number;
    readonly factsDecayed: number;
    readonly consolidated: number;
    readonly mergedSessions: number;
    readonly capEvicted: number;
  };
}

export interface MaintenancePlanInput {
  readonly episodes: readonly Episode[];
  readonly facts: readonly Fact[];
  /** 供实现判断是否会「巩固出重复事实」 */
  readonly procedures?: readonly Procedure[];
}

export interface MaintenancePlanOptions {
  /** 当前时间（注入以保证可测） */
  readonly now?: Date;
  readonly maxEpisodesPerSession?: number;
  readonly globalEpisodeCap?: number;
  readonly decayRate?: number;
  readonly decayFloor?: number;
  readonly recallProtectionPerCount?: number;
  readonly factDecayRate?: number;
  readonly factFloor?: number;
  readonly factOlderThanDays?: number;
  readonly forgetOlderThanDays?: number;
  readonly forgetMaxImportance?: number;
  readonly forgetMaxRecalls?: number;
  readonly retentionThreshold?: number;
}

/** 天数差（解析失败按「很旧」处理，照 LeAgent 的 999 兜底） */
export function ageInDays(createdAt: string | undefined, now: Date, fallback = 999): number {
  if (createdAt === undefined || createdAt === "") return fallback;
  const t = parseDate(createdAt);
  if (t === null) return fallback;
  return Math.max(0, (now.getTime() - t.getTime()) / 86_400_000);
}

/**
 * 规划一次记忆维护（**纯函数**，不改动入参）。
 *
 * 顺序与 LeAgent 一致：**先算衰减，再按衰减后的值决定遗忘** —— 顺序反了会导致
 * 「本该被衰减到阈值以下而忘掉的条目」因为用的是旧值而留存（LeAgent 的
 * `run_full_maintenance` 也是 decay → forget 这个次序）。
 */
export function planMaintenance(
  input: MaintenancePlanInput,
  options: MaintenancePlanOptions = {},
): MaintenancePlan {
  const now = options.now ?? new Date();
  const decayRate = options.decayRate ?? IMPORTANCE_DECAY_RATE;
  const decayFloor = options.decayFloor ?? IMPORTANCE_DECAY_FLOOR;
  const recallProtection = options.recallProtectionPerCount ?? RECALL_PROTECTION_PER_COUNT;
  const factDecayRate = options.factDecayRate ?? FACT_CONFIDENCE_DECAY_RATE;
  const factFloor = options.factFloor ?? FACT_CONFIDENCE_FLOOR;
  const factOlderThan = options.factOlderThanDays ?? FACT_DECAY_OLDER_THAN_DAYS;
  const forgetOlderThan = options.forgetOlderThanDays ?? FORGET_OLDER_THAN_DAYS;
  const forgetMaxImportance = options.forgetMaxImportance ?? FORGET_MAX_IMPORTANCE;
  const forgetMaxRecalls = options.forgetMaxRecalls ?? FORGET_MAX_RECALLS;
  const retentionThreshold = options.retentionThreshold ?? MIN_IMPORTANCE_THRESHOLD;
  const maxPerSession = options.maxEpisodesPerSession ?? MAX_EPISODES_PER_SESSION;
  const globalCap = options.globalEpisodeCap ?? GLOBAL_EPISODE_CAP;

  // ---- ① 重要度衰减 ----------------------------------------------------
  const decayedImportance = new Map<string, number>();
  const episodeImportance: ValueChange[] = [];
  for (const ep of input.episodes) {
    const old = clamp01(ep.importance);
    let next = old * decayRate;
    const recalls = Math.max(0, Math.trunc(ep.recallCount));
    // 召回保护：可完全抵消衰减（LeAgent 用 min(old, ...) 表达「不因召回而涨」）
    if (recalls > 0) next = Math.min(old, next + recalls * recallProtection);
    next = Math.max(decayFloor, next);
    decayedImportance.set(ep.id, next);
    if (Math.abs(next - old) > DECAY_EPSILON) {
      episodeImportance.push({ id: ep.id, from: old, to: round4(next) });
    }
  }

  // ---- ② 低价值遗忘（两段式：先便宜谓词，再 retentionScore）--------------
  const forgetEpisodeIds: string[] = [];
  for (const ep of input.episodes) {
    const ageDays = ageInDays(ep.createdAt, now);
    if (ageDays <= forgetOlderThan) continue;
    if (clamp01(ep.importance) > forgetMaxImportance) continue;
    if (Math.trunc(ep.recallCount) > forgetMaxRecalls) continue;
    // 用**衰减后**的重要度算保留分（顺序与 LeAgent 的 decay→forget 一致）
    const score = retentionScore({
      importance: decayedImportance.get(ep.id) ?? clamp01(ep.importance),
      recallCount: Math.trunc(ep.recallCount),
      ageDays,
    });
    // 阈值必须 > RETENTION_FORMULA_FLOOR，否则永不触发（见该常量注释）
    if (score < retentionThreshold) forgetEpisodeIds.push(ep.id);
  }

  // ---- ③ 事实置信衰减 --------------------------------------------------
  const decayedConfidence = new Map<string, number>();
  const factConfidence: ValueChange[] = [];
  for (const fact of input.facts) {
    const old = clamp01(fact.confidence);
    const ageDays = ageInDays(fact.updatedAt ?? fact.createdAt, now);
    let next = old;
    if (ageDays > factOlderThan) next = Math.max(factFloor, old * factDecayRate);
    decayedConfidence.set(fact.id, next);
    if (Math.abs(next - old) > DECAY_EPSILON) {
      factConfidence.push({ id: fact.id, from: old, to: round4(next) });
    }
  }

  // ---- ④ 巩固：值得的 episode → semantic fact --------------------------
  const consolidate: Fact[] = [];
  const existingKeys = new Map<string, number>();
  for (const f of input.facts) existingKeys.set(`${f.userId ?? ""}\u0000${f.workspaceId ?? ""}\u0000${f.key}`, clamp01(f.confidence));
  for (const ep of input.episodes) {
    // 无人属的 episode 不巩固（照 LeAgent：`if ep.user_id is None: continue`）
    if (ep.userId === undefined || ep.userId === "") continue;
    const summary = (ep.summary ?? "").trim();
    if (summary.length < CONSOLIDATE_MIN_SUMMARY_LEN) continue;
    if (clamp01(ep.importance) < CONSOLIDATE_MIN_IMPORTANCE) continue;
    if (forgetEpisodeIds.includes(ep.id)) continue;
    const key = `digest.episode.${ep.id}`;
    const confidence = Math.min(CONSOLIDATED_CONFIDENCE_CAP, CONSOLIDATED_CONFIDENCE_BASE + clamp01(ep.importance));
    const existing = existingKeys.get(`${ep.userId ?? ""}\u0000${ep.workspaceId ?? ""}\u0000${key}`);
    // 已有更高置信的同键事实 → 不降级覆盖（照 LeAgent `dedup_existing`）
    if (existing !== undefined && existing >= confidence) continue;
    existingKeys.set(`${ep.userId ?? ""}\u0000${ep.workspaceId ?? ""}\u0000${key}`, confidence);
    consolidate.push({
      id: `digest-${ep.id}`,
      key,
      value: summary.slice(0, 8_000),
      confidence,
      source: "memory.consolidation",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(ep.userId !== undefined ? { userId: ep.userId } : {}),
      ...(ep.workspaceId !== undefined ? { workspaceId: ep.workspaceId } : {}),
    });
  }

  // ---- ④b 单会话 episode 超限 → 合并最旧的 -------------------------------
  const mergeGroups: MergeGroup[] = [];
  const bySession = new Map<string, Episode[]>();
  for (const ep of input.episodes) {
    if (forgetEpisodeIds.includes(ep.id)) continue;
    const sid = ep.sessionId ?? "";
    const list = bySession.get(sid);
    if (list === undefined) bySession.set(sid, [ep]);
    else list.push(ep);
  }
  for (const [sessionId, list] of bySession) {
    if (list.length <= maxPerSession) continue;
    // 最旧的排在前面（先按 createdAt 升序，再按 id 兜底保证确定性）
    const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)));
    const excess = sorted.slice(0, sorted.length - maxPerSession);
    if (excess.length === 0) continue;
    const summaries = excess.map((e) => (e.summary ?? "").trim()).filter((s) => s !== "");
    const mergedSummary =
      CONSOLIDATED_PREFIX +
      summaries.slice(0, MERGED_SUMMARY_MAX_ITEMS).map((s) => s.slice(0, MERGED_SUMMARY_ITEM_CHARS)).join(" | ");
    const first = excess[0]!;
    mergeGroups.push({
      sessionId,
      removeIds: excess.map((e) => e.id),
      merged: {
        id: `merged-${first.id}`,
        sessionId,
        summary: mergedSummary.slice(0, 1_200),
        tags: ["consolidated"],
        importance: MERGED_EPISODE_IMPORTANCE,
        recallCount: 0,
        createdAt: now.toISOString(),
        ...(first.userId !== undefined ? { userId: first.userId } : {}),
        ...(first.workspaceId !== undefined ? { workspaceId: first.workspaceId } : {}),
      },
    });
  }

  // ---- ④c 全局硬上限兜底（我们的补充）--------------------------------
  const removedByForgetOrMerge = new Set<string>([
    ...forgetEpisodeIds,
    ...mergeGroups.flatMap((g) => g.removeIds),
  ]);
  const surviving = input.episodes.filter((e) => !removedByForgetOrMerge.has(e.id));
  // 合并会把 N 条换成 1 条，所以先算「合并后的条数」
  const afterMerge = surviving.length + mergeGroups.length;
  const extraCount = Math.max(0, afterMerge - globalCap);
  let capEvictedEpisodeIds: string[] = [];
  if (extraCount > 0) {
    const ranked = [...surviving].sort((a, b) => {
      const sa = retentionScore({
        importance: decayedImportance.get(a.id) ?? 0,
        recallCount: Math.trunc(a.recallCount),
        ageDays: ageInDays(a.createdAt, now),
      });
      const sb = retentionScore({
        importance: decayedImportance.get(b.id) ?? 0,
        recallCount: Math.trunc(b.recallCount),
        ageDays: ageInDays(b.createdAt, now),
      });
      // 分低者先淘汰；同分按 id 保证确定性
      return sa - sb || a.id.localeCompare(b.id);
    });
    capEvictedEpisodeIds = ranked.slice(0, Math.min(extraCount, ranked.length)).map((e) => e.id);
  }

  return {
    episodeImportance,
    forgetEpisodeIds,
    factConfidence,
    consolidate,
    mergeGroups,
    capEvictedEpisodeIds,
    counts: {
      episodesTotal: input.episodes.length,
      decayed: episodeImportance.length,
      forgotten: forgetEpisodeIds.length + capEvictedEpisodeIds.length,
      factsDecayed: factConfidence.length,
      consolidated: consolidate.length,
      mergedSessions: mergeGroups.length,
      capEvicted: capEvictedEpisodeIds.length,
    },
  };
}

/** 计划是否无事可做（用于跳过无谓的文件重写） */
export function isNoopPlan(plan: MaintenancePlan): boolean {
  return (
    plan.episodeImportance.length === 0 &&
    plan.forgetEpisodeIds.length === 0 &&
    plan.factConfidence.length === 0 &&
    plan.consolidate.length === 0 &&
    plan.mergeGroups.length === 0 &&
    plan.capEvictedEpisodeIds.length === 0
  );
}

// ---------------------------------------------------------------------------
// 应用计划（纯：产出「压缩后的记录集」，不碰 IO）
// ---------------------------------------------------------------------------

export interface CompactedState {
  readonly episodes: readonly Episode[];
  readonly facts: readonly Fact[];
  readonly procedures: readonly Procedure[];
  /** 本次维护淘汰的 episode id（含遗忘、合并、全局上限） */
  readonly removedEpisodeIds: readonly string[];
}

/**
 * 把计划套用到当前索引，产出**压缩后的完整状态**。
 *
 * 由调用方（sidecar）原子写回磁盘 —— 这样「算什么」与「怎么写」严格分离，
 * 前者可以纯函数测试，后者只有一处实现。
 */
export function applyMaintenancePlan(
  input: MaintenancePlanInput,
  plan: MaintenancePlan,
): CompactedState {
  const importance = new Map(plan.episodeImportance.map((c) => [c.id, c.to]));
  const confidence = new Map(plan.factConfidence.map((c) => [c.id, c.to]));
  const removed = new Set<string>([
    ...plan.forgetEpisodeIds,
    ...plan.mergeGroups.flatMap((g) => g.removeIds),
    ...plan.capEvictedEpisodeIds,
  ]);

  const episodes: Episode[] = [];
  for (const ep of input.episodes) {
    if (removed.has(ep.id)) continue;
    // 被合并掉的会话，其成员已在 removed 里；合并产物在下面统一追加
    const nextImportance = importance.get(ep.id);
    episodes.push(nextImportance === undefined ? ep : { ...ep, importance: nextImportance });
  }
  for (const group of plan.mergeGroups) episodes.push(group.merged);

  const facts: Fact[] = [];
  const seenFactKeys = new Set<string>();
  for (const fact of input.facts) {
    const nextConfidence = confidence.get(fact.id);
    const updated = nextConfidence === undefined ? fact : { ...fact, confidence: nextConfidence };
    facts.push(updated);
    seenFactKeys.add(`${fact.userId ?? ""}\u0000${fact.workspaceId ?? ""}\u0000${fact.key}`);
  }
  // 巩固产物：同键**覆盖**（后写覆盖语义与 store 回放一致）
  for (const fact of plan.consolidate) {
    const key = `${fact.userId ?? ""}\u0000${fact.workspaceId ?? ""}\u0000${fact.key}`;
    if (seenFactKeys.has(key)) {
      const idx = facts.findIndex((f) => `${f.userId ?? ""}\u0000${f.workspaceId ?? ""}\u0000${f.key}` === key);
      if (idx >= 0) facts[idx] = fact;
      continue;
    }
    seenFactKeys.add(key);
    facts.push(fact);
  }

  return {
    episodes,
    facts,
    // 流程不衰减（照 LeAgent），只随压缩被折叠成当前状态
    procedures: [...(input.procedures ?? [])],
    removedEpisodeIds: [...removed],
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 解析 ISO（无时区视为 UTC，照 LeAgent） */
function parseDate(raw: string): Date | null {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const d = new Date(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
