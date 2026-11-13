"""混合检索：FTS5 关键词 + 向量语义 + 标题匹配 → RRF 融合 → 模型重排。

> **来源**：本文件移植自 EvoFlow `backend/packages/harness/evoflow/knowledge/owned/retrieve.py`
> （公司自有项目，已获书面授权）。移植时改了三处，算法逻辑本身未改：
> ① SQL 去掉 `kb_id = ?` 过滤 —— 本仓每个知识库一个独立 SQLite，kb_id 是隐含的；
> ② 去掉 `d.deleted_at IS NULL` —— 本仓删文档是硬删，没有软删列；
> ③ 重排从「词面启发式」升级为「模型 cross-encoder」，降级时回退到 EvoFlow 的
>    `rerank_by_query_match` 启发式（spec §6.2 [5] 相对 EvoFlow 的升级点）。

## 为什么用 RRF 而不是加权求和

三路召回的分数尺度完全不同：BM25 是无界负分、余弦相似度是 0–1、标题命中是固定分。
加权求和要先归一化，而归一化本身又要调参。RRF 只看「排名」不看「分值」，
天然免疫尺度差异 —— 这也是 EvoFlow 选它的原因。

## 中文检索的两个坑

1. **FTS5 不切中文**：写入时用 jieba 切好（见 pipeline._index_fts），查询侧同样切；
2. **分词不一致会漏召回**：jieba 对同义词可能切不同词，所以关键词召回**必须**
   补一路 `LIKE %query%` 兜底（EvoFlow 的 CORE-KB-01 修的就是这个）。
"""

from __future__ import annotations

import heapq
import logging
import math
import struct
from typing import Any

from .tokenize import query_tokens

logger = logging.getLogger("knowledge_sidecar.search")

# RRF 常数：60 是原论文经验值，越大越平滑（排名靠后的差距被压缩得越厉害）。
RRF_K = 60


# ── 向量编解码 ────────────────────────────────────────────────────────────


def pack_embedding(values: list[float]) -> bytes:
    """float32 小端打包。用 float32 而非 float64 省一半空间，精度足够。"""
    return struct.pack(f"{len(values)}f", *values)


def unpack_embedding(blob: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"{dim}f", blob))


def cosine(a: list[float], b: list[float]) -> float:
    """纯 Python 余弦相似度。

    没有 numpy，也不用 numpy —— 本仓刻意不打包原生依赖（spec §2.2）。
    P0 量级（单库几千块 × 1024 维）纯 Python 约几十毫秒，可接受。
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


# ── 关键词相关性打分 ──────────────────────────────────────────────────────


def _cjk_overlap(query: str, text: str) -> float:
    """中文 bigram 重叠率。用于「工作流怎么发布」命中「工作流发布」这类变体。"""
    q = str(query or "").strip()
    t = str(text or "")
    if len(q) < 2 or not t:
        return 0.0
    grams = {q[i : i + 2] for i in range(len(q) - 1)}
    if not grams:
        return 0.0
    hit = sum(1 for g in grams if g in t)
    return hit / len(grams)


def _keyword_relevance(content: str, query: str, *, bm25_raw: float, order_i: int) -> float:
    """把 BM25 负分转成「越大越好」的相关度（EvoFlow CORE-KB-01）。

    BM25 原始分是无界负数（越负越相关），直接进 RRF 会被尺度污染。
    这里揉进「词频密度」和「短语是否原样出现」，让精确短语压倒弱 FTS 命中。
    """
    text = str(content or "")
    q = str(query or "").strip()
    q_cf = q.casefold()
    text_cf = text.casefold()
    density = (text_cf.count(q_cf) / max(len(text_cf), 1)) if q_cf else 0.0
    # Phrase / substring boost — critical for CJK queries with no whitespace tokens.
    phrase = 0.0
    if q_cf and q_cf in text_cf:
        phrase = 0.55 + min(0.35, density * 50.0)
    else:
        overlap = _cjk_overlap(q_cf, text_cf)
        if overlap >= 0.35:
            phrase = 0.25 + 0.45 * overlap
    try:
        bm25_abs = abs(float(bm25_raw))
    except (TypeError, ValueError):
        bm25_abs = 0.0
    # No lexical evidence → tiny tie-breaker only (must stay below any phrase hit).
    if bm25_abs == 0.0 and phrase == 0.0 and density == 0.0:
        return 0.01 / (order_i + 2)
    bm25_term = 1.0 / (1.0 + bm25_abs + order_i * 0.001) if bm25_abs else 0.0
    return phrase + density * 8.0 + bm25_term


# ── 三路召回 ──────────────────────────────────────────────────────────────


def search_keyword(conn: Any, query: str, *, top_k: int = 20) -> list[dict[str, Any]]:
    """FTS5 关键词召回 + LIKE 兜底。"""
    q = (query or "").strip()
    if not q:
        return []

    by_id: dict[str, dict[str, Any]] = {}

    # ① FTS5：查询侧必须用与写入侧**同一套**分词（tokenize.py），
    #    否则「材料复验不合格」和索引里的「材料 复验 不合格」对不上。
    tokens = query_tokens(q)
    match = " OR ".join(f'"{t}"' for t in tokens) if tokens else ""

    if match:
        try:
            rows = conn.execute(
                """
                SELECT f.chunk_id, f.doc_id, f.content, bm25(kb_chunks_fts) AS rank
                FROM kb_chunks_fts f
                JOIN kb_chunks c ON c.id = f.chunk_id
                JOIN kb_documents d ON d.id = f.doc_id
                WHERE c.enabled = 1 AND d.parse_status = 'completed'
                  AND kb_chunks_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (match, max(top_k * 3, 40)),
            ).fetchall()
        except Exception as exc:  # noqa: BLE001 — FTS 语法错误不该炸掉整次检索
            logger.warning("FTS 查询失败，降级为 LIKE：%s", exc)
            rows = []
        for i, row in enumerate(rows):
            try:
                bm25_raw = float(row["rank"])
            except (TypeError, ValueError, KeyError):
                bm25_raw = float(i)
            content = str(row["content"] or "")
            cid = str(row["chunk_id"])
            relevance = _keyword_relevance(content, q, bm25_raw=bm25_raw, order_i=i)
            by_id[cid] = {
                "chunk_id": cid,
                "doc_id": row["doc_id"],
                "content": content,
                "score": relevance,
                "keyword_score": relevance,
                "source": "keyword",
            }

    # ② LIKE 兜底：中文分词不一致时的唯一保底召回（CORE-KB-01/02）
    like = f"%{q}%"
    try:
        like_rows = conn.execute(
            """
            SELECT c.id AS chunk_id, c.doc_id, c.content, 0 AS rank
            FROM kb_chunks c
            JOIN kb_documents d ON d.id = c.doc_id
            WHERE c.enabled = 1 AND d.parse_status = 'completed' AND c.content LIKE ?
            LIMIT ?
            """,
            (like, max(top_k * 3, 40)),
        ).fetchall()
    except Exception:  # noqa: BLE001
        like_rows = []
    for i, row in enumerate(like_rows):
        cid = str(row["chunk_id"])
        content = str(row["content"] or "")
        relevance = _keyword_relevance(content, q, bm25_raw=0.0, order_i=i)
        prev = by_id.get(cid)
        if prev is None or relevance > float(prev.get("score") or 0):
            by_id[cid] = {
                "chunk_id": cid,
                "doc_id": row["doc_id"],
                "content": content,
                "score": relevance,
                "keyword_score": relevance,
                "source": "keyword",
            }

    hits = sorted(by_id.values(), key=lambda h: float(h.get("score") or 0), reverse=True)[:top_k]
    for i, h in enumerate(hits):
        h["rank"] = i + 1
    return hits


def search_vector(
    conn: Any,
    query_vec: list[float],
    *,
    top_k: int = 20,
    model: str = "",
) -> list[dict[str, Any]]:
    """向量召回。sqlite-vec 可用时走 ANN，否则退化为全表扫 + 纯 Python 余弦。"""
    if not query_vec:
        return []
    dim = len(query_vec)
    candidate_limit = max(int(top_k or 20), 1)

    from .vector_index import recall_ids

    vec_hits = recall_ids(
        conn,
        dim=dim,
        model=model,
        query_vec=query_vec,
        top_k=candidate_limit,
    )
    if vec_hits is not None:
        ids = [chunk_id for chunk_id, _distance in vec_hits]
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"""
            SELECT e.chunk_id, e.doc_id, e.dim, e.embedding, c.content, c.context_header
            FROM kb_chunk_embeddings e
            JOIN kb_chunks c ON c.id = e.chunk_id
            JOIN kb_documents d ON d.id = e.doc_id
            WHERE e.chunk_id IN ({placeholders}) AND e.dim = ?
              AND (? = '' OR e.model = ?)
              AND c.enabled = 1 AND d.parse_status = 'completed'
            """,
            [*ids, dim, str(model or ""), str(model or "")],
        ).fetchall()
        by_id = {str(row["chunk_id"]): row for row in rows}
        hits: list[dict[str, Any]] = []
        for rank, (chunk_id, distance) in enumerate(vec_hits, 1):
            row = by_id.get(chunk_id)
            if not row:
                continue
            # Distance → bounded similarity in (0, 1]; avoid negative vectorScore.
            try:
                dist = max(float(distance), 0.0)
            except (TypeError, ValueError):
                dist = 1.0
            similarity = 1.0 / (1.0 + dist)
            hits.append(
                {
                    "chunk_id": chunk_id,
                    "doc_id": row["doc_id"],
                    "content": row["content"],
                    "context_header": row["context_header"] or "",
                    "score": similarity,
                    "vector_score": similarity,
                    "source": "vector",
                    "rank": rank,
                }
            )
        return hits

    # 降级路径：全表扫，用堆保留 top-K（避免把全部向量读进内存排序）
    scored: list[tuple[float, int, dict[str, Any]]] = []
    rows = conn.execute(
        """
        SELECT e.chunk_id, e.doc_id, e.dim, e.embedding, c.content, c.context_header
        FROM kb_chunk_embeddings e
        JOIN kb_chunks c ON c.id = e.chunk_id
        JOIN kb_documents d ON d.id = e.doc_id
        WHERE c.enabled = 1 AND d.parse_status = 'completed'
          AND (? = '' OR e.model = ?)
        """,
        (str(model or ""), str(model or "")),
    ).fetchall()
    for row in rows:
        row_dim = int(row["dim"])
        if row_dim != dim:
            continue
        vec = unpack_embedding(bytes(row["embedding"]), row_dim)
        score = cosine(query_vec, vec)
        hit = {
            "chunk_id": row["chunk_id"],
            "doc_id": row["doc_id"],
            "content": row["content"],
            "context_header": row["context_header"] or "",
            "score": score,
            "source": "vector",
        }
        entry = (score, id(hit), hit)
        if len(scored) < candidate_limit:
            heapq.heappush(scored, entry)
        elif score > scored[0][0]:
            heapq.heapreplace(scored, entry)

    scored.sort(key=lambda x: x[0], reverse=True)
    hits = []
    for i, (_score, _tie, hit) in enumerate(scored[:top_k]):
        hit["rank"] = i + 1
        hits.append(hit)
    return hits


def search_title(conn: Any, query: str, *, top_k: int = 20) -> list[dict[str, Any]]:
    """标题 / 文件名 / 路径匹配。按名字找文档的场景纯向量检索经常漏。"""
    q = (query or "").strip()
    if not q:
        return []
    like = f"%{q}%"
    docs = conn.execute(
        """
        SELECT id FROM kb_documents
        WHERE parse_status = 'completed'
          AND (title LIKE ? OR file_name LIKE ? OR rel_path LIKE ?
               OR IFNULL(summary_text,'') LIKE ?)
        ORDER BY updated_at DESC
        LIMIT ?
        """,
        (like, like, like, like, top_k),
    ).fetchall()
    hits: list[dict[str, Any]] = []
    for i, d in enumerate(docs):
        row = conn.execute(
            """
            SELECT id, doc_id, content FROM kb_chunks
            WHERE doc_id = ? AND enabled = 1
            ORDER BY ordinal LIMIT 1
            """,
            (d["id"],),
        ).fetchone()
        if not row:
            continue
        hits.append(
            {
                "chunk_id": row["id"],
                "doc_id": row["doc_id"],
                "content": row["content"],
                "rank": i + 1,
                "source": "title",
            }
        )
    return hits


# ── 融合与精排 ────────────────────────────────────────────────────────────


def rrf_fuse(
    keyword_hits: list[dict[str, Any]],
    vector_hits: list[dict[str, Any]],
    *,
    top_k: int = 8,
    k: int = RRF_K,
    w_kw: float = 1.0,
    w_vec: float = 1.0,
) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion：`score += w / (k + rank)`。

    额外把关键词相关度乘 0.25 加进去 —— 纯 RRF 只看排名，会让「只命中一个词
    但排名第一」和「整句原样命中且排名第一」同分。加这一项让精确命中更靠前。
    """
    scores: dict[str, float] = {}
    meta: dict[str, dict[str, Any]] = {}
    kw_scores: dict[str, float] = {}
    vec_scores: dict[str, float] = {}
    for hit in keyword_hits:
        cid = hit["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + w_kw * (1.0 / (k + int(hit["rank"])))
        # Prefer keyword relevance magnitude when available (exact phrase >> weak FTS).
        kw_rel = float(hit.get("keyword_score") or hit.get("score") or 0)
        scores[cid] += w_kw * 0.25 * kw_rel
        kw_scores[cid] = max(kw_scores.get(cid, 0.0), kw_rel)
        meta[cid] = {**meta.get(cid, {}), **hit, "source": "hybrid"}
    for hit in vector_hits:
        cid = hit["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + w_vec * (1.0 / (k + int(hit["rank"])))
        v_rel = float(hit.get("vector_score") or hit.get("score") or 0)
        vec_scores[cid] = max(vec_scores.get(cid, 0.0), v_rel)
        prev = meta.get(cid) or {}
        meta[cid] = {**prev, **hit, "source": "hybrid" if prev else "vector"}
    ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    out: list[dict[str, Any]] = []
    for cid, score in ordered:
        item = dict(meta.get(cid) or {})
        item["chunk_id"] = cid
        item["rrf_score"] = score
        if cid in kw_scores:
            item["keyword_score"] = kw_scores[cid]
        if cid in vec_scores:
            item["vector_score"] = vec_scores[cid]
            item["score"] = vec_scores[cid]
        elif cid in kw_scores:
            item["score"] = kw_scores[cid]
        out.append(item)
    return out


def enrich_hits(conn: Any, hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """给 chunk 命中补文档元数据，输出前端消费的 camelCase 形状。"""
    if not hits:
        return []
    chunk_ids = [h["chunk_id"] for h in hits]
    placeholders = ",".join("?" * len(chunk_ids))
    rows = conn.execute(
        f"""
        SELECT c.*, d.title, d.file_name, d.rel_path, d.summary_text
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.doc_id
        WHERE c.id IN ({placeholders})
        """,
        chunk_ids,
    ).fetchall()
    by_id = {row["id"]: row for row in rows}

    enriched: list[dict[str, Any]] = []
    for h in hits:
        row = by_id.get(h["chunk_id"])
        if not row:
            continue
        vec = h.get("vector_score")
        if vec is None and h.get("source") == "vector":
            vec = h.get("score")
        kw = h.get("keyword_score")
        if kw is None and h.get("source") == "keyword":
            kw = h.get("score")
        rel_path = str(row["rel_path"] or "")
        enriched.append(
            {
                "chunkId": row["id"],
                "docId": row["doc_id"],
                "kbId": "",
                "content": row["content"],
                "contextHeader": row["context_header"] or "",
                "chunkKind": row["chunk_kind"],
                "title": row["title"],
                "fileName": row["file_name"],
                "folderPath": _folder_of(rel_path),
                "tags": [],
                "rrfScore": h.get("rrf_score"),
                "vectorScore": vec,
                "keywordScore": kw,
                "source": h.get("source"),
                "assets": [],
            }
        )
    return enriched


def _folder_of(rel_path: str) -> str:
    """从相对路径取所在文件夹（不含文件名）。"""
    normalized = (rel_path or "").replace("\\", "/")
    idx = normalized.rfind("/")
    return normalized[:idx] if idx > 0 else ""


def rerank_by_query_match(items: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """词面启发式重排（EvoFlow 原实现，作为模型重排的降级路径）。

    标题命中 +3、正文命中 +1.5；没有精确短语时用中文 bigram 重叠打折计分。
    """
    q = str(query or "").strip().casefold()
    if not q or not items:
        return items

    def _key(item: dict[str, Any]) -> tuple[float, float, float, float]:
        title = str(item.get("title") or item.get("fileName") or "").casefold()
        content = str(item.get("content") or "").casefold()
        title_hit = 3.0 if q in title else 0.0
        content_hit = 1.5 if q in content else 0.0
        # Partial CJK overlap when full phrase is absent.
        if title_hit == 0.0 and len(q) >= 4:
            title_hit = 2.0 * _cjk_overlap(q, title)
        if content_hit == 0.0 and len(q) >= 4:
            content_hit = 1.0 * _cjk_overlap(q, content)
        rrf = float(item.get("rrfScore") or item.get("rrf_score") or 0)
        kw = float(item.get("keywordScore") or item.get("keyword_score") or 0)
        vec = float(item.get("vectorScore") or item.get("vector_score") or 0)
        return (title_hit + content_hit, kw, rrf, max(vec, 0.0))

    return sorted(items, key=_key, reverse=True)


def apply_model_rerank(
    items: list[dict[str, Any]],
    query: str,
    client: Any,
    *,
    top_k: int = 8,
) -> list[dict[str, Any]]:
    """用 cross-encoder 模型精排；不可用时抛异常，由调用方降级。

    Rerank 没有 OpenAI 标准，`client.rerank` 内部按 `ZCODE_KNOWLEDGE_RERANK_FORMAT`
    自动探测响应格式，返回 `[(原索引, 分数)]`。
    """
    if not items or not query.strip():
        return items
    pairs = client.rerank(query, [item.get("content") or "" for item in items])

    # 去重键用 chunkId，**不能**用 id(item)：dict 对象被复制/回收后 id 会复用，
    # 早期用 id() 去重导致同一个 chunk 出现两次（一次带 rerankScore、一次不带）。
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for index, score in pairs:
        if index < 0 or index >= len(items):
            continue
        item = items[index]
        key = str(item.get("chunkId") or "")
        if key and key in seen:
            continue
        seen.add(key)
        enriched = dict(item)
        enriched["rerankScore"] = float(score)
        result.append(enriched)
        if len(result) >= top_k:
            break

    # 模型可能只返回 top_n 条；把没进榜的补在后面，避免结果凭空变少
    if len(result) < top_k:
        for item in items:
            key = str(item.get("chunkId") or "")
            if key and key in seen:
                continue
            seen.add(key)
            result.append(item)
            if len(result) >= top_k:
                break
    return result


__all__ = [
    "RRF_K",
    "apply_model_rerank",
    "cosine",
    "enrich_hits",
    "pack_embedding",
    "rerank_by_query_match",
    "rrf_fuse",
    "search_keyword",
    "search_title",
    "search_vector",
    "unpack_embedding",
]
