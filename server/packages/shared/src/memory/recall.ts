/**
 * 混合召回（W4-②）—— 向量优先 / lexical 兜底 / 确定性 boost 重排。
 *
 * 设计来源：LeAgent `memory/recall.py`（Apache-2.0）。boosts 公式逐项照抄。
 *
 * **相对 LeAgent 的关键取舍**：LeAgent 的候选分来自 SQL/向量库（`entry.score`），
 * 本层不假设有 DB 或向量库 —— 所以自己提供一个**确定性 lexical 打分器**
 * （`lexicalScore`），让「零依赖可跑」成立。将来接入向量库时，把向量相似度
 * 一并塞进 `entry.score` 即可，下游 boost/去重/折叠逻辑完全不用改。
 *
 * 顺序即语义（照 LeAgent）：
 *   rerank（boost）→ deduplicate（id + 近重 + 已知文件过滤）→ collapse（semantic 折叠 episodic）→ 截断
 */

import {
  RECENCY_HALF_LIFE_DAYS,
  clamp01,
  successRate,
  textSignature,
  type Episode,
  type Fact,
  type Procedure,
  type RecallBundle,
  type RecallEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// lexical 打分（自研，替代 LeAgent 的 SQL ILIKE / tsvector）
// ---------------------------------------------------------------------------

/**
 * 分词：拉丁按词、CJK 按**字符二元组**（bigram）。
 *
 * 为什么 CJK 用 bigram 而不是单字：中文单字命中噪声极大（「的」「是」几乎每句都有），
 * bigram 能保留「工作区」「审批」这类真实词形，且**不需要词典**。
 * 这是零依赖条件下性价比最高的中文检索方案。
 */
export function tokenize(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const tokens: string[] = [];

  // 拉丁/数字：连续字母数字视为一个词
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) tokens.push(m[0]);

  // CJK：连续汉字段落内取 bigram（长度 1 的段落退化为单字）
  for (const m of lower.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
  }

  return tokens;
}

/**
 * 确定性 lexical 分（0–1）：查询词在文本中的**覆盖比例**，带长度归一。
 *
 * 公式：`matched / queryTokens.length`，其中「命中」= 该词出现在文档 token 集里。
 * 分母用查询长度而非文档长度是刻意的 —— 我们关心「查询被满足了没有」，
 * 不惩罚长文档（长文档有更多上下文，不该因长而掉分）。
 */
export function lexicalScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const docTokens = new Set(tokenize(text));
  if (docTokens.size === 0) return 0;
  const unique = [...new Set(queryTokens)];
  let matched = 0;
  for (const t of unique) if (docTokens.has(t)) matched += 1;
  return clamp01(matched / unique.length);
}

// ---------------------------------------------------------------------------
// boost 重排（照 LeAgent `_apply_boosts`）
// ---------------------------------------------------------------------------

export interface BoostContext {
  /** 当前时间（注入以保证可测；默认 `new Date()`） */
  readonly now?: Date;
}

/**
 * 确定性 boost：时间衰减 + 分类型的置信/成功率/重要度加权。
 *
 * 逐项（照 LeAgent）：
 * - 时间：`0.5 + 0.5*exp(-ageDays/14)`（14 天半衰期；取 `last_run_at` 优先于 `created_at`）
 * - semantic：`(0.5+0.5*confidence) * 1.15`（**1.15 是有意偏置**：事实比流水更该被想起）
 * - procedural：`(0.4+0.6*successRate)`，`runCount==0 ×0.8`、`>=3 ×1.1`
 * - episodic：`(1+0.3*importance) * (1+min(0.6, 0.04*recallCount))`
 *
 * 乘性叠加（而非加性）：任何一项接近 0 都能把它压下去，符合「不可信就别冒头」。
 */
export function applyBoosts(entry: RecallEntry, ctx: BoostContext = {}): number {
  const now = ctx.now ?? new Date();
  const base = Math.max(0, entry.score || 0);
  let boost = 1;

  const createdRaw = entry.metadata["last_run_at"] ?? entry.metadata["created_at"];
  if (typeof createdRaw === "string" && createdRaw !== "") {
    const timestamp = parseDate(createdRaw);
    if (timestamp !== null) {
      const ageDays = Math.max(0, (now.getTime() - timestamp.getTime()) / 86_400_000);
      boost *= 0.5 + 0.5 * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
    }
  }

  if (entry.kind === "semantic") {
    const confidence = toNumber(entry.metadata["confidence"]);
    boost *= 0.5 + 0.5 * clamp01(confidence);
    boost *= 1.15;
  }

  if (entry.kind === "procedural") {
    const rate = toNumber(entry.metadata["success_rate"]);
    const runCount = Math.trunc(toNumber(entry.metadata["run_count"]));
    boost *= 0.4 + 0.6 * rate;
    if (runCount === 0) boost *= 0.8;
    else if (runCount >= 3) boost *= 1.1;
  }

  if (entry.kind === "episodic") {
    const importance = toNumber(entry.metadata["importance"]);
    boost *= 1 + 0.3 * clamp01(importance);
    const recalls = Math.trunc(toNumber(entry.metadata["recall_count"]));
    boost *= 1 + Math.min(0.6, 0.04 * recalls);
  }

  return base * boost;
}

/** 重排：对每个条目算 boost 后按分数降序（同分用 `kind:sourceId` 保确定性） */
export function rerank(candidates: readonly RecallEntry[], ctx: BoostContext = {}): RecallEntry[] {
  return candidates
    .map((entry) => ({ entry, score: applyBoosts(entry, ctx) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.entry.kind}:${a.entry.sourceId}`.localeCompare(`${b.entry.kind}:${b.entry.sourceId}`),
    )
    .map((x) => x.entry);
}

// ---------------------------------------------------------------------------
// 去重与折叠
// ---------------------------------------------------------------------------

export interface DedupeOptions {
  /** 已读过/本轮涉及的文件路径：命中则剔除该条目 */
  readonly knownFiles?: readonly string[];
}

/**
 * 去重（照 LeAgent `_deduplicate`）：
 *  ① `kind:sourceId` 相同 → 丢；
 *  ② 命中已知文件路径（字符串子串）→ 丢；
 *  ③ 近重文本（小写截断 300）→ 丢。
 *
 * ⚠️ 第 ② 条是**字符串子串**匹配（LeAgent 原样），路径巧合出现在摘要里会误杀。
 * 这是已知的过度过滤风险；保留原语义是因为它的收益（不把「你刚读过的文件」再喂回去）
 * 大于偶发误杀。若误杀可观测，再把子串改成路径分词匹配。
 */
export function deduplicate(ranked: readonly RecallEntry[], options: DedupeOptions = {}): RecallEntry[] {
  const seenIds = new Set<string>();
  const seenTexts = new Set<string>();
  const out: RecallEntry[] = [];
  const files = (options.knownFiles ?? []).filter((p) => p !== "");
  for (const entry of ranked) {
    const idKey = `${entry.kind}:${entry.sourceId}`;
    if (seenIds.has(idKey)) continue;
    seenIds.add(idKey);

    if (files.length > 0 && files.some((path) => (entry.text ?? "").includes(path))) continue;

    const sig = textSignature(entry.text);
    if (seenTexts.has(sig)) continue;
    seenTexts.add(sig);
    out.push(entry);
  }
  return out;
}

/**
 * 折叠：semantic 覆盖同内容的 episodic（照 LeAgent `_collapse_semantic_over_episodic`）。
 *
 * 理由：事实比流水稳定、置信更高。「你偏好中文」这条事实存在时，
 * 「某轮你说过喜欢中文」的 episode 就是冗余 —— 留着会白占 prompt 行数。
 */
export function collapseSemanticOverEpisodic(entries: readonly RecallEntry[]): RecallEntry[] {
  const semanticSignatures = new Set(
    entries.filter((e) => e.kind === "semantic").map((e) => textSignature(e.text)),
  );
  if (semanticSignatures.size === 0) return [...entries];
  return entries.filter(
    (e) => e.kind !== "episodic" || !semanticSignatures.has(textSignature(e.text)),
  );
}

// ---------------------------------------------------------------------------
// 一条龙排序
// ---------------------------------------------------------------------------

export interface RankOptions extends BoostContext, DedupeOptions {
  readonly limit?: number;
}

/** 完整排序链：rerank → dedupe → collapse → 截断 */
export function rankRecall(candidates: readonly RecallEntry[], options: RankOptions = {}): RecallEntry[] {
  const ranked = rerank(candidates, options);
  const deduped = deduplicate(ranked, options);
  const collapsed = collapseSemanticOverEpisodic(deduped);
  return options.limit === undefined ? collapsed : collapsed.slice(0, Math.max(0, options.limit));
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/**
 * 渲染成 prompt 附件文本（照 LeAgent `RecallBundle.to_prompt_block`）。
 *
 * 逐条 `- [kind] text`，最多 `maxLines` 行。**空结果返回空串**（不要渲染一个空标题
 * —— 那会白占 token 还暗示「有记忆但没内容」）。
 */
export function renderRecallBundle(bundle: RecallBundle, maxLines = 16): string {
  if (bundle.entries.length === 0) return "";
  const lines = bundle.entries.slice(0, maxLines).map((e) => `- [${e.kind}] ${oneLine(e.text)}`);
  return lines.join("\n");
}

/** 压成单行（记忆文本常含换行；换行会把 `-` 列表打断，破坏可读性） */
export function oneLine(text: string, maxLen = 240): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…`;
}

// ---------------------------------------------------------------------------
// 三库 → 统一条目
// ---------------------------------------------------------------------------

/** `Episode` → `RecallEntry`（metadata 带 importance/recall_count/created_at 供 boost 用） */
export function episodeToEntry(episode: {
  id: string;
  summary: string;
  importance: number;
  recallCount: number;
  createdAt: string;
  lastRecalledAt?: string;
}, score: number): RecallEntry {
  return {
    kind: "episodic",
    text: episode.summary,
    score,
    sourceId: episode.id,
    metadata: {
      importance: episode.importance,
      recall_count: episode.recallCount,
      created_at: episode.createdAt,
      ...(episode.lastRecalledAt !== undefined ? { last_recalled_at: episode.lastRecalledAt } : {}),
    },
  };
}

/** `Fact` → `RecallEntry` */
export function factToEntry(fact: { id: string; key: string; value: string; confidence: number; createdAt: string }, score: number): RecallEntry {
  return {
    kind: "semantic",
    text: `${fact.key}: ${fact.value}`,
    score,
    sourceId: fact.id,
    metadata: { confidence: fact.confidence, created_at: fact.createdAt },
  };
}

/** `Procedure` → `RecallEntry` */
export function procedureToEntry(procedure: {
  id: string;
  name: string;
  description: string;
  runCount: number;
  successCount: number;
  createdAt: string;
  lastRunAt?: string;
}, score: number): RecallEntry {
  return {
    kind: "procedural",
    text: `${procedure.name}: ${procedure.description}`,
    score,
    sourceId: procedure.id,
    metadata: {
      success_rate: successRate(procedure),
      run_count: procedure.runCount,
      created_at: procedure.createdAt,
      ...(procedure.lastRunAt !== undefined ? { last_run_at: procedure.lastRunAt } : {}),
    },
  };
}

/** 把三库检索结果与统一条目打包成 bundle */
export function buildBundle(input: {
  query: string;
  entries: readonly RecallEntry[];
  episodes: readonly Episode[];
  facts: readonly Fact[];
  procedures: readonly Procedure[];
}): RecallBundle {
  return {
    query: input.query,
    entries: input.entries,
    episodes: input.episodes,
    facts: input.facts,
    procedures: input.procedures,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 解析 ISO 时间；无时区视为 UTC（照 LeAgent） */
function parseDate(raw: string): Date | null {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const normalized = hasZone ? raw : `${raw}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
