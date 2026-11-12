/**
 * 命中排序与融合（KB-①）—— 纯函数。
 *
 * ## 用户拍板的口径（照此实现，不要"顺手优化"）
 *
 * > **统一按相关度排序，不因来源改排序**；只在结果上**标注来源**。
 *
 * 所以本文件**没有**"个人库加成"这类逻辑 —— 那会污染相关性判断，且用户明确没选。
 * 若将来要加成，必须同时改这段注释与文件头的口径说明（免得后人以为漏了）。
 *
 * ## 三件必须做对的事
 *
 *  ① **来源必填校验**（红线 3）：任何命中缺 `source` 即实现错误 —— 宁可拒绝也不放行
 *     （放行就会让模型无法标注出处，合规上不可接受）；
 *  ② **去重**：同一 `docName + position` 可能被两路（如个人库与公共库收录了同一文档）
 *     或同一路的多 query 命中多次 —— 只保留最高分，避免同一条占满 topK；
 *  ③ **稳定排序**：同分时保持输入顺序（多 query 的先后是有意义的），否则结果会随实现抖动。
 */

import { MAX_HITS, KB_SOURCE_LABEL, type KbSource, type RetrievalHit } from "./types.js";

/** 输入校验结果：非法命中的原因（不回抛异常 —— 由调用方决定是丢弃还是报错） */
export interface HitValidation {
  readonly valid: RetrievalHit[];
  /** 被判为非法的条目及原因（用于告警，不静默） */
  readonly rejected: Array<{ hit: unknown; reason: string }>;
}

const VALID_SOURCES: ReadonlySet<string> = new Set(["personal", "department", "org"]);

/** 校验一批命中：来源必填且合法、chunk 非空、score 有限 */
export function validateHits(hits: readonly unknown[]): HitValidation {
  const valid: RetrievalHit[] = [];
  const rejected: Array<{ hit: unknown; reason: string }> = [];
  for (const raw of hits) {
    if (raw === null || typeof raw !== "object") {
      rejected.push({ hit: raw, reason: "不是对象" });
      continue;
    }
    const h = raw as Partial<RetrievalHit>;
    if (typeof h.source !== "string" || !VALID_SOURCES.has(h.source)) {
      rejected.push({ hit: raw, reason: `缺少或非法的 source（红线：出处必须可辨）` });
      continue;
    }
    if (typeof h.chunk !== "string" || h.chunk.trim().length === 0) {
      rejected.push({ hit: raw, reason: "chunk 为空" });
      continue;
    }
    if (typeof h.score !== "number" || !Number.isFinite(h.score)) {
      rejected.push({ hit: raw, reason: "score 非有限数" });
      continue;
    }
    valid.push({
      chunk: h.chunk,
      score: h.score,
      source: h.source as KbSource,
      datasetName: typeof h.datasetName === "string" ? h.datasetName : "",
      docName: typeof h.docName === "string" ? h.docName : "",
      position: typeof h.position === "number" && Number.isFinite(h.position) ? h.position : 0,
    });
  }
  return { valid, rejected };
}

/** 去重键：来源 + 库名 + 文档名 + 片段序号（同名文档在不同库中视为不同条目） */
function hitKey(h: RetrievalHit): string {
  return `${h.source}\u0000${h.datasetName}\u0000${h.docName}\u0000${h.position}`;
}

/**
 * 融合多路命中 → 排序 → 截断。
 *
 * @param hits 各路命中的并集（顺序即"同分时的稳定次序"）
 * @param opts.topK 返回上限（缺省 `MAX_HITS`）
 * @param opts.maxPerDocument 同一文档最多保留几条（缺省 3 —— 防止一篇长文档垄断 topK）
 */
export function fuseAndRank(
  hits: readonly RetrievalHit[],
  opts?: { topK?: number; maxPerDocument?: number },
): { hits: RetrievalHit[]; rejected: HitValidation["rejected"]; deduped: number } {
  const { valid, rejected } = validateHits(hits);

  // 去重（保留最高分；同分保留先出现的）
  const best = new Map<string, { hit: RetrievalHit; order: number }>();
  let deduped = 0;
  valid.forEach((hit, order) => {
    const key = hitKey(hit);
    const prev = best.get(key);
    if (prev === undefined) {
      best.set(key, { hit, order });
      return;
    }
    deduped += 1;
    if (hit.score > prev.hit.score) best.set(key, { hit, order: prev.order });
  });

  // 稳定排序：分数降序，同分按首次出现顺序
  const ordered = [...best.values()].sort((a, b) => (b.hit.score - a.hit.score) || (a.order - b.order)).map((e) => e.hit);

  // 单文档配额
  const perDoc = Math.max(1, Math.floor(opts?.maxPerDocument ?? 3));
  const countByDoc = new Map<string, number>();
  const capped: RetrievalHit[] = [];
  for (const hit of ordered) {
    const key = `${hit.source}\u0000${hit.datasetName}\u0000${hit.docName}`;
    const used = countByDoc.get(key) ?? 0;
    if (used >= perDoc) continue;
    countByDoc.set(key, used + 1);
    capped.push(hit);
    if (capped.length >= Math.max(1, Math.floor(opts?.topK ?? MAX_HITS))) break;
  }

  return { hits: capped, rejected, deduped };
}

/**
 * 词法打分与检索（lexical）—— 纯函数。
 *
 * ## 为什么个人库要先有它
 *
 * 向量化要经网关（embeddings 路由尚未补，见方案 §4），而"知识库能用"不该被那条路由堵住。
 * 词法检索**零外部依赖**、立刻可用；向量/重排只是在它之上再叠一层召回与精排
 * （与我们在 D3 记忆层定的"lexical 先行"同一口径）。
 *
 * ## 与记忆层的关系（刻意不耦合）
 *
 * `shared/src/memory/recall.ts` 里已有中文 bigram 打分的**同类实现**。这里没有 import 它：
 * 记忆域的实现细节（boost、时间衰减、成功率）与知识库无关，耦合过去会把两边的
 * 参数调优绑死。所以这里是一份**自足的小实现**，只保证同一件事：**中文按二字组切**
 * （工具区不折不扣的老问题：中文没空格，按空格切等于不切）。
 * 若将来两边都要改分词口径，应抽到更底层的共享模块，而不是互相 import。
 */

/** 把文本切成检索单元：拉丁词 + 单个汉字 + 中文二字组（bigram） */
export function tokenizeForSearch(text: string): string[] {
  const s = String(text ?? "").toLowerCase();
  const tokens: string[] = [];
  const latin = s.match(/[a-z0-9_]{2,}/g) ?? [];
  tokens.push(...latin);
  const cjk = s.match(/[\u4e00-\u9fff]/g) ?? [];
  tokens.push(...cjk);
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(`${cjk[i]}${cjk[i + 1]}`);
  return tokens;
}

/**
 * 查询侧切分：**只取拉丁词 + 中文二字组**（单字仅在“整串就是一个汉字”时兜底）。
 *
 * 为什么查询侧不收单字：单字命中率过高（“量子计算”里的「量」会和“容量”蹭上），
 * 会让无关查询也拿到正分 —— 探针里“检索无关词返回空”那条抓的就是这个。
 */
export function queryTokens(query: string): string[] {
  const s = String(query ?? "").toLowerCase();
  const latin = s.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjk = s.match(/[\u4e00-\u9fff]/g) ?? [];
  if (latin.length === 0 && cjk.length === 1) return [cjk[0]!]; // 单字查询兜底
  const tokens: string[] = [...latin];
  for (let i = 0; i + 1 < cjk.length; i++) tokens.push(`${cjk[i]}${cjk[i + 1]}`);
  return tokens;
}

/**
 * 词法相关度：查询词在片段中的命中比例（0~1，越大越相关）。
 *
 * 归一化的分母用**查询侧**词数 —— 这样不同长度的查询之间可比；
 * 长文档不会因为"词多"而白拿高分（这是纯词频打分最常见的偏置）。
 */
export function lexicalScore(query: string, chunk: string): number {
  const q = queryTokens(query);
  if (q.length === 0) return 0;
  const hay = new Set(tokenizeForSearch(chunk));
  let hit = 0;
  const unique = new Set(q);
  for (const t of unique) if (hay.has(t)) hit += 1;
  return hit / unique.size;
}

/** 词法检索：对片段打分并取前 K（返回形状直接就是 `RetrievalHit` 的原料） */
export function lexicalSearch<T extends { text: string }>(
  query: string,
  segments: readonly T[],
  topK: number,
): Array<{ segment: T; score: number }> {
  const scored: Array<{ segment: T; score: number; order: number }> = [];
  segments.forEach((segment, order) => {
    const score = lexicalScore(query, segment.text);
    if (score > 0) scored.push({ segment, score, order });
  });
  // 分数降序、同分保持原顺序（与 fuseAndRank 的稳定排序口径一致）
  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.slice(0, Math.max(1, Math.floor(topK))).map(({ segment, score }) => ({ segment, score }));
}

/**
 * 把命中渲染成给模型看的回执行（**出处与来源必须出现**）。
 *
 * 格式刻意简短：`[1] (我的/《笔记》) 文档名#3 · 0.82` + 正文缩进。
 * —— 模型要靠这个在回答里写出处，所以来源标签用的是 `KB_SOURCE_LABEL` 同一份文案。
 */
export function renderHits(hits: readonly RetrievalHit[], opts?: { maxChunkChars?: number }): string {
  if (hits.length === 0) return "（没有检索到相关片段）";
  const maxChars = Math.max(80, Math.floor(opts?.maxChunkChars ?? 600));
  return hits
    .map((h, i) => {
      const label = KB_SOURCE_LABEL[h.source] ?? h.source;
      const score = Math.round(h.score * 1000) / 1000;
      const body = h.chunk.length > maxChars ? `${h.chunk.slice(0, maxChars)}…` : h.chunk;
      return `[${i + 1}] (${label}/《${h.datasetName}》) ${h.docName}#${h.position} · ${score}\n${body}`;
    })
    .join("\n\n");
}
