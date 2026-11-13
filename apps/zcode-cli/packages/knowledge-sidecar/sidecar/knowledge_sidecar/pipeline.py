"""索引流水线：解析 → 分块 → 落库。

## 编排

```
parse:  kb_documents(parse_status=pending)
        → parser.parse_file() → markdown
        → chunking.chunk_markdown() → chunks
        → 写 kb_chunks（先删旧）+ FTS
        → kb_documents(parse_status=completed | failed)
embed:  （P0-c）对 kb_chunks 里有正文但无向量的块调 embedding，写 kb_chunk_embeddings
```

## 为什么分成两个 job kind

解析与嵌入的失败语义不同：
- 解析失败 → 文档没有正文，关键词也搜不到（`parse_status=failed`）；
- 嵌入失败 → 正文还在，关键词检索仍可用（`parse_status=completed`，
  只是没有向量；spec §4.4「语义降级」）。

合成一个 job 会让「嵌入服务挂了」表现成「文档解析失败」，误导排查。

## 幂等

同一文档重跑 parse 会先删它的旧 chunks 与 FTS 行，不会累积重复。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .chunking import DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, chunk_markdown
from .parser import parse_file
from .store import KnowledgeStore
from .tokenize import tokenize

logger = logging.getLogger("knowledge_sidecar.pipeline")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _new_chunk_id(doc_pk: str, ordinal: int) -> str:
    return f"{doc_pk}_c{ordinal:04d}"


@dataclass
class ParseOutcome:
    ok: bool
    doc_id: str
    chunks: int = 0
    chars: int = 0
    error: str = ""


def run_parse_job(
    store: KnowledgeStore,
    kb_id: str,
    doc_pk: str,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> ParseOutcome:
    """同步执行一次解析作业。由 worker 调用，不直接暴露给 RPC。"""
    with store.kb_conn(kb_id) as conn:
        row = conn.execute("SELECT * FROM kb_documents WHERE id=?", (doc_pk,)).fetchone()
        if row is None:
            return ParseOutcome(ok=False, doc_id=doc_pk, error="文档不存在")
        file_name = row["file_name"]
        rel_path = row["rel_path"]
        # 状态先置 parsing，让 UI 能显示「处理中」
        conn.execute(
            "UPDATE kb_documents SET parse_status='parsing', updated_at=? WHERE id=?",
            (_now(), doc_pk),
        )

    blob_dir = store.kb_blobs_dir(kb_id) / doc_pk
    source = blob_dir / file_name
    if not source.is_file():
        _mark_failed(store, kb_id, doc_pk, f"原始文件缺失：{file_name}")
        return ParseOutcome(ok=False, doc_id=doc_pk, error="原始文件缺失")

    result = parse_file(source)
    if not result.ok:
        _mark_failed(store, kb_id, doc_pk, result.error)
        return ParseOutcome(ok=False, doc_id=doc_pk, error=result.error)

    chunks = chunk_markdown(result.markdown, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    if not chunks:
        _mark_failed(store, kb_id, doc_pk, "解析成功但无有效正文（空文档？）")
        return ParseOutcome(ok=False, doc_id=doc_pk, error="无有效正文")

    with store.kb_conn(kb_id) as conn:
        # 幂等：先清旧分块与 FTS
        conn.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_pk,))
        conn.execute("DELETE FROM kb_chunk_embeddings WHERE doc_id=?", (doc_pk,))
        try:
            conn.execute("DELETE FROM kb_chunks_fts WHERE doc_id=?", (doc_pk,))
        except Exception:  # noqa: BLE001 — FTS 不可用时忽略
            pass

        for chunk in chunks:
            chunk_id = _new_chunk_id(doc_pk, chunk.ordinal)
            conn.execute(
                """
                INSERT INTO kb_chunks
                  (id, doc_id, ordinal, content, context_header, heading_path,
                   chunk_kind, token_estimate, enabled)
                VALUES (?,?,?,?,?,?,?,?,1)
                """,
                (
                    chunk_id,
                    doc_pk,
                    chunk.ordinal,
                    chunk.content,
                    chunk.context_header,
                    chunk.heading_path,
                    chunk.chunk_kind,
                    chunk.token_estimate,
                ),
            )
            # FTS 索引：中文要预分词后再写入
            _index_fts(conn, chunk_id, doc_pk, chunk.content)

        conn.execute(
            """
            UPDATE kb_documents
               SET parse_status='completed', parse_error=NULL,
                   title=?, summary_text=?, updated_at=?
             WHERE id=?
            """,
            (
                result.title or row["title"],
                (result.markdown[:500] if result.markdown else None),
                _now(),
                doc_pk,
            ),
        )
        # 解析成功 → 排一个 embed job（P0-c 消费）
        conn.execute(
            """
            INSERT INTO kb_jobs (id, kind, doc_id, state, created_at, updated_at)
            VALUES (?, 'embed', ?, 'queued', ?, ?)
            """,
            (f"job_{doc_pk}_embed", doc_pk, _now(), _now()),
        )

    logger.info(
        "解析完成 kb=%s doc=%s chunks=%d chars=%d rel=%s",
        kb_id,
        doc_pk,
        len(chunks),
        len(result.markdown),
        rel_path,
    )
    return ParseOutcome(
        ok=True, doc_id=doc_pk, chunks=len(chunks), chars=len(result.markdown)
    )


def _index_fts(conn: Any, chunk_id: str, doc_pk: str, content: str) -> None:
    """写 FTS5 索引。

    中文没有空格分词，直接写正文会让 FTS 只按整串匹配。这里用 jieba 切成
    空格连接的串再写入；查询侧用 `tokenize.tokenize()` 做**同一套**处理 ——
    两侧切词不一致会让 FTS 永远命中不了（见 tokenize.py 头部说明）。

    jieba 缺失时退化为原样写入 —— 中文检索会变差但英文/代码仍可用，
    且不阻断索引（“能用”优于“全部失败”）。
    """
    try:
        tokens = tokenize(content)
        conn.execute(
            "INSERT INTO kb_chunks_fts(chunk_id, doc_id, content) VALUES (?,?,?)",
            (chunk_id, doc_pk, tokens),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("FTS 写入跳过 %s：%s", chunk_id, exc)


def _mark_failed(store: KnowledgeStore, kb_id: str, doc_pk: str, reason: str) -> None:
    with store.kb_conn(kb_id) as conn:
        conn.execute(
            "UPDATE kb_documents SET parse_status='failed', parse_error=?, updated_at=? WHERE id=?",
            (reason[:1000], _now(), doc_pk),
        )
    logger.warning("解析失败 kb=%s doc=%s：%s", kb_id, doc_pk, reason)


def pending_jobs(
    store: KnowledgeStore,
    kb_id: str,
    *,
    limit: int = 20,
    kinds: tuple[str, ...] = ("parse", "embed"),
) -> list[dict[str, str]]:
    """取出待执行的作业（worker 轮询用）。

    按 kind 一起取而非分两次轮询：worker 单线程串行消费，混在一起能保证
    「先 parse 后 embed」的天然顺序（同一文档的 embed job 在 parse 之后才排队），
    也避免一个 kind 饿死另一个。
    """
    placeholders = ",".join("?" * len(kinds))
    with store.kb_conn(kb_id) as conn:
        rows = conn.execute(
            f"""
            SELECT id, kind, doc_id FROM kb_jobs
             WHERE state='queued' AND kind IN ({placeholders})
             ORDER BY created_at LIMIT ?
            """,
            (*kinds, limit),
        ).fetchall()
    return [
        {"id": row["id"], "kind": row["kind"], "doc_id": row["doc_id"] or ""}
        for row in rows
    ]


# 保留旧名字兼容既有调用点
pending_parse_jobs = pending_jobs


def run_embed_job(
    store: KnowledgeStore,
    kb_id: str,
    doc_pk: str,
    *,
    client: Any = None,
    model: str = "",
) -> ParseOutcome:
    """对文档的分块批量算向量并写入 kb_chunk_embeddings。

    ## 失败语义（与 parse 不同）

    嵌入失败**不**把 `parse_status` 置 failed —— 正文和 FTS 索引都还在，
    关键词检索照常可用（spec §4.4 语义降级）。只在 `parse_error` 里记原因，
    让 UI 能提示「向量化失败，已降级为关键词检索」。

    ## 为什么要先查再算

    重跑 parse 会删掉旧向量，但用户也可能只想要增量（例如只重试失败的那些）。
    这里只对「有正文但没有对应向量」的块调接口，省调用次数也省时间。
    """
    if client is None:
        return ParseOutcome(ok=False, doc_id=doc_pk, error="未配置 embedding 服务")

    with store.kb_conn(kb_id) as conn:
        rows = conn.execute(
            """
            SELECT c.id AS chunk_id, c.content, c.context_header
              FROM kb_chunks c
              LEFT JOIN kb_chunk_embeddings e ON e.chunk_id = c.id
             WHERE c.doc_id = ? AND c.enabled = 1 AND e.chunk_id IS NULL
             ORDER BY c.ordinal
            """,
            (doc_pk,),
        ).fetchall()

    if not rows:
        logger.info("无待嵌入分块 kb=%s doc=%s（已全部完成）", kb_id, doc_pk)
        return ParseOutcome(ok=True, doc_id=doc_pk, chunks=0)

    # 带 context_header 一起送进去：标题是重要的语义上下文，
    # 否则「3.1 材料」这种块脱离标题后语义极弱。
    texts = [
        f"{row['context_header']}\n{row['content']}".strip()
        if row["context_header"]
        else row["content"]
        for row in rows
    ]

    try:
        vectors = client.embed(texts)
    except Exception as exc:  # noqa: BLE001 — 任何嵌入失败都应降级而非中断
        reason = f"向量化失败（已降级为关键词检索）：{exc}"
        logger.warning("嵌入失败 kb=%s doc=%s：%s", kb_id, doc_pk, exc)
        with store.kb_conn(kb_id) as conn:
            conn.execute(
                "UPDATE kb_documents SET parse_error=?, updated_at=? WHERE id=?",
                (reason[:1000], _now(), doc_pk),
            )
        return ParseOutcome(ok=False, doc_id=doc_pk, error=reason)

    if len(vectors) != len(rows):
        reason = f"向量数量不匹配：请求 {len(rows)} 条、返回 {len(vectors)} 条"
        logger.error("%s kb=%s doc=%s", reason, kb_id, doc_pk)
        return ParseOutcome(ok=False, doc_id=doc_pk, error=reason)

    from .search import pack_embedding
    from .vector_index import insert_many

    dim = len(vectors[0]) if vectors else 0
    now = _now()
    with store.kb_conn(kb_id) as conn:
        conn.execute("DELETE FROM kb_chunk_embeddings WHERE doc_id=?", (doc_pk,))
        conn.executemany(
            """
            INSERT OR REPLACE INTO kb_chunk_embeddings
              (chunk_id, doc_id, model, dim, embedding)
            VALUES (?,?,?,?,?)
            """,
            [
                (row["chunk_id"], doc_pk, model, dim, pack_embedding(vec))
                for row, vec in zip(rows, vectors, strict=True)
            ],
        )
        # sqlite-vec 可用时同步写一份进 vec0 表（加速 ANN 召回）
        try:
            insert_many(
                conn,
                dim=dim,
                model=model,
                rows=[
                    (row["chunk_id"], vec)
                    for row, vec in zip(rows, vectors, strict=True)
                ],
            )
        except Exception:  # noqa: BLE001 — ANN 是可选加速，失败不影响主路径
            logger.debug("sqlite-vec 同步跳过", exc_info=True)
        conn.execute(
            "UPDATE kb_documents SET parse_error=NULL, updated_at=? WHERE id=?",
            (now, doc_pk),
        )

    logger.info(
        "嵌入完成 kb=%s doc=%s chunks=%d dim=%d model=%s",
        kb_id,
        doc_pk,
        len(rows),
        dim,
        model or "(默认)",
    )
    return ParseOutcome(ok=True, doc_id=doc_pk, chunks=len(rows))


def claim_job(store: KnowledgeStore, kb_id: str, job_id: str) -> bool:
    """把作业标成 running。返回 True 表示抢到（防重复执行）。"""
    with store.kb_conn(kb_id) as conn:
        cursor = conn.execute(
            "UPDATE kb_jobs SET state='running', attempts=attempts+1, updated_at=? "
            "WHERE id=? AND state='queued'",
            (_now(), job_id),
        )
        return cursor.rowcount > 0


def finish_job(
    store: KnowledgeStore, kb_id: str, job_id: str, *, ok: bool, error: str = ""
) -> None:
    with store.kb_conn(kb_id) as conn:
        conn.execute(
            "UPDATE kb_jobs SET state=?, last_error=?, updated_at=? WHERE id=?",
            ("done" if ok else "failed", error[:1000] or None, _now(), job_id),
        )
