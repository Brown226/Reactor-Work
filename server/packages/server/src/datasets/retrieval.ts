/**
 * 公共知识库检索（KB-⑥ 服务端）——三模式 + **双重权限校验**。
 *
 * 依据：`docs/实施计划/个人知识库-实施方案-v1.md` §KB-⑥「2) 检索」。
 *
 * ## 三模式
 *
 * - `lexical`：复用 `@reactor/shared` 的 `tokenizeForSearch` / `lexicalScore`（中文二字组）。
 *   **刻意不做 zhparser** —— 镜像里没有，且端上个人库用的是同一套 bigram，两边口径天然一致。
 * - `vector`：pgvector 可用时走 SQL `<=>`；不可用时退化为 **Node 内余弦**（有扫描上限）。
 * - `hybrid`：两路各自取候选，再交 `fuseAndRank` 统一融合 —— **与端上同一个融合实现**，
 *   所以「同一份内容在个人库与公共库里的排序口径」不会漂移。
 *
 * ## ★ 双重校验（规格里的红线，两条都要）
 *
 * 1. **应用层**：请求带的 `datasetIds` 必须 ⊆ 调用者可读集合；不合法的**剔除并告警**，
 *    绝不静默忽略（静默忽略会让调用方以为"查了但没命中"，实际是"根本没查"）。
 * 2. **SQL 层**：查询语句里再套一层 `visibilitySql(...)`（见 `repo.ts` 各查询）——
 *    纵深防御：应用层若被绕过（或将来改坏），SQL 这层仍然拦得住。
 *
 * 探针 `kb-server-smoke` 对两条都有反证（去掉任一层 ⇒ 越权可见）。
 */

import { kb } from "@reactor/shared";
import type { IdentityDb } from "../identity/db.js";
import {
  loadSearchSegments,
  vectorSearchSql,
  visibleDatasetIds,
  type KbScoredSegment,
  type KbSearchSegment,
  type KbViewer,
} from "./repo.js";

export type KbSearchMode = "vector" | "lexical" | "hybrid";

export interface KbSearchRequest {
  readonly queries: readonly string[];
  /** 限定检索范围；缺省 = 调用者可见的全部库。越权 id 会被剔除并在 meta 里点名 */
  readonly datasetIds?: readonly number[];
  readonly topK?: number;
  readonly mode?: KbSearchMode;
}

export interface KbSearchDeps {
  /** 注入式向量化器。缺省 ⇒ 向量路不可用（如实标注，不假装） */
  readonly embedder?: kb.Embedder;
  /** `ensureDatasetsSchema()` 的探测结果 */
  readonly vectorReady: boolean;
}

export interface KbSearchMeta {
  /** 请求的模式 */
  readonly mode: KbSearchMode;
  /** **实际**跑的模式（降级后可能与请求不同 —— 调用方据此判断可信度） */
  readonly effectiveMode: KbSearchMode;
  readonly vectorUsed: boolean;
  readonly degraded: boolean;
  readonly degradeReason?: string;
  /** 被剔除的越权库 id（红线 ①：剔除要可见，不静默） */
  readonly droppedDatasetIds: readonly number[];
  /** 实际扫描的片段数（Node 回退时有上限，调用方据此判断是否被截断） */
  readonly scanned: number;
}

export interface KbSearchOutcome {
  readonly hits: kb.RetrievalHit[];
  readonly meta: KbSearchMeta;
}

/** 库的 scope → 对外来源标签（公共库只到「部门 + 全员」两级） */
export function sourceOfDataset(scopeKind: string): kb.KbSource {
  return scopeKind === "all" ? "org" : "department";
}

/**
 * 解析检索范围（红线 ①）。
 *
 * 返回 `ids` = 请求 ∩ 可见（缺省时 = 全部可见），`dropped` = 请求里不可见的那些。
 * 调用方必须把 `dropped` 透出（`meta.droppedDatasetIds`）并记告警。
 */
export async function resolveDatasetScope(
  db: IdentityDb,
  viewer: KbViewer,
  requested?: readonly number[],
): Promise<{ ids: number[]; dropped: number[] }> {
  const visible = await visibleDatasetIds(db, viewer);
  const { ids, dropped } = clipToVisible(requested, visible);
  if (dropped.length > 0) {
    // 告警而不是静默：调用方（或管理员）要能看出"我请求了但被拒了哪几个"
    console.warn(`kb: 检索请求含 ${dropped.length} 个不可见数据集，已剔除：${dropped.join(",")}（uid=${viewer.uid}）`);
  }
  return { ids, dropped };
}

/**
 * 把请求的库 id 裁到可见集合（**纯函数**，红线 ① 的核心逻辑）。
 *
 * 抽成纯函数是为了能在**无 PG** 的 `probes` 组里直接断言裁剪语义 ——
 * 否则这条红线只有跑得起 docker 的机器才验得了。
 * 返回 `dropped` 而不是静默丢弃：调用方必须把它透出（"我请求了但被拒了哪几个"要可见）。
 */
export function clipToVisible(
  requested: readonly (number | string)[] | undefined,
  visible: readonly number[],
): { ids: number[]; dropped: number[] } {
  const visibleSet = new Set(visible);
  if (requested === undefined || requested.length === 0) return { ids: [...visible], dropped: [] };
  const ids: number[] = [];
  const dropped: number[] = [];
  for (const raw of requested) {
    const id = Number(raw);
    if (!Number.isInteger(id)) continue;
    if (visibleSet.has(id)) {
      if (!ids.includes(id)) ids.push(id);
    } else if (!dropped.includes(id)) {
      dropped.push(id);
    }
  }
  return { ids, dropped };
}

/** 余弦相似度（Node 内回退用；两向量不等长或零模长时返回 0，不抛） */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toHit(seg: KbSearchSegment, score: number, scopeKind: string): kb.RetrievalHit {
  return {
    chunk: seg.content,
    score,
    source: sourceOfDataset(scopeKind),
    datasetName: seg.datasetName,
    docName: seg.docName,
    position: seg.position,
  };
}

/**
 * 检索主入口。
 *
 * 顺序刻意是「先定范围 → 再取候选 → 后融合」：范围裁决必须发生在任何数据读取之前，
 * 否则 SQL 层可见性就只是补救而不是前置闸门。
 */
export async function searchKb(
  db: IdentityDb,
  viewer: KbViewer,
  req: KbSearchRequest,
  deps: KbSearchDeps,
  /** 库 id → scope_kind（`loadSearchSegments` 不带 scope，这里补一份映射做来源标注） */
  scopeKinds: ReadonlyMap<number, string> = new Map(),
): Promise<KbSearchOutcome> {
  const queries = (req.queries ?? [])
    .map((q) => String(q ?? "").trim())
    .filter((q) => q.length > 0)
    .slice(0, kb.MAX_QUERIES_PER_CALL);
  const topK = clampInt(req.topK ?? 8, 1, kb.MAX_HITS);
  const mode: KbSearchMode = req.mode ?? "hybrid";

  const { ids, dropped } = await resolveDatasetScope(db, viewer, req.datasetIds);
  const baseMeta = { mode, droppedDatasetIds: dropped } as const;

  if (queries.length === 0 || ids.length === 0) {
    return {
      hits: [],
      meta: { ...baseMeta, effectiveMode: mode, vectorUsed: false, degraded: false, scanned: 0 },
    };
  }

  const wantVector = mode === "vector" || mode === "hybrid";
  const wantLexical = mode === "lexical" || mode === "hybrid";
  // SQL 向量路不需要全量片段；词法路与 Node 余弦回退需要
  const vectorViaSql = deps.vectorReady && deps.embedder !== undefined;
  const needAllSegments = wantLexical || (wantVector && !vectorViaSql);

  const segments = needAllSegments ? await loadSearchSegments(db, viewer, ids) : [];
  const collected: kb.RetrievalHit[] = [];
  let vectorUsed = false;
  let degradeReason: string | undefined;

  if (wantLexical) {
    for (const q of queries) {
      const scored = kb.lexicalSearch(q, segments.map((s) => ({ text: s.content, seg: s })), topK);
      for (const { segment, score } of scored) {
        collected.push(toHit(segment.seg, score, scopeKinds.get(segment.seg.datasetId) ?? "dept"));
      }
    }
  }

  if (wantVector) {
    if (deps.embedder === undefined) {
      degradeReason = "未配置向量化器（网关 embeddings 未接入）⇒ 本次降级为词法";
    } else {
      const vectors = await deps.embedder(queries).catch((err: unknown) => {
        degradeReason = `向量化调用失败 ⇒ 本次降级为词法（${err instanceof Error ? err.message : String(err)}）`;
        return null;
      });
      if (vectors !== null && vectors.length > 0) {
        for (let i = 0; i < queries.length; i++) {
          const v = vectors[i];
          if (v === undefined || v.length === 0) continue;
          if (deps.vectorReady) {
            const rows = await vectorSearchSql(db, viewer, ids, v, topK);
            if (rows.length > 0) vectorUsed = true;
            for (const r of rows) {
              collected.push(toHit(r, (r as KbScoredSegment).score ?? 0, scopeKinds.get(r.datasetId) ?? "dept"));
            }
          } else {
            // Node 内余弦回退：扫描有上限，且**只对带向量的片段**打分
            const withVec = segments.filter((s) => s.embedding !== undefined);
            if (withVec.length === 0) {
              degradeReason = "pgvector 不可用且库内片段没有向量 ⇒ 本次降级为词法";
              continue;
            }
            const scored = withVec
              .map((s) => ({ s, score: cosineSimilarity(v, s.embedding as readonly number[]) }))
              .filter((e) => e.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, topK);
            if (scored.length > 0) vectorUsed = true;
            for (const { s, score } of scored) {
              collected.push(toHit(s, score, scopeKinds.get(s.datasetId) ?? "dept"));
            }
            degradeReason = `pgvector 不可用 ⇒ 向量路走 Node 内余弦（扫描上限 ${segments.length} 片段）`;
          }
        }
      }
    }
  }

  // 降级兜底：请求了向量但一路都没跑成 ⇒ 用词法结果顶上（功能不消失，但如实标注）
  let effectiveMode: KbSearchMode = mode;
  if (wantVector && !vectorUsed) {
    effectiveMode = wantLexical ? "lexical" : "lexical";
    if (collected.length === 0) {
      for (const q of queries) {
        const scored = kb.lexicalSearch(q, segments.map((s) => ({ text: s.content, seg: s })), topK);
        for (const { segment, score } of scored) {
          collected.push(toHit(segment.seg, score, scopeKinds.get(segment.seg.datasetId) ?? "dept"));
        }
      }
    }
  }

  const fused = kb.fuseAndRank(collected, { topK });
  return {
    hits: fused.hits,
    meta: {
      ...baseMeta,
      effectiveMode,
      vectorUsed,
      degraded: degradeReason !== undefined,
      ...(degradeReason === undefined ? {} : { degradeReason }),
      scanned: segments.length,
    },
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
