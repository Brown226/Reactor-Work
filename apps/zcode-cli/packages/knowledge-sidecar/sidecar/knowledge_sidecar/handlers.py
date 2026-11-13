"""RPC 方法实现：库增删改查、上传、解析状态、检索、重建索引。

检索链路移植自 EvoFlow `owned/service.py`（见 `search.py` 头部说明），
降级语义遵循 spec §4.4：任何一路不可用都不中断整体检索，只在结果里标 `degraded`。
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .store import KnowledgeStore, StorageError

logger = logging.getLogger("knowledge_sidecar.handlers")

# 内容模式白名单：与 spec §6.3 一致。title 只在检索时作为可选模式出现，
# 建库时不允许设成 title（那等于关掉正文检索）。
CONTENT_MODES = {"hybrid", "keyword", "vector"}

# 检索模式白名单：比 CONTENT_MODES 多一个 title（按文档名找文档）。
# 建库时只能选 CONTENT_MODES，检索时允许 title。
SEARCH_MODES = CONTENT_MODES | {"title"}


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _row_to_base(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "embeddingModel": row["embedding_model"],
        "embeddingDim": row["embedding_dim"],
        "contentMode": row["content_mode"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


class KnowledgeHandlers:
    def __init__(
        self,
        store: KnowledgeStore,
        version: str,
        model_client: Any = None,
    ) -> None:
        self._store = store
        self._version = version
        self._model_client = model_client

    # ── 健康检查 ────────────────────────────────────────────────────────
    async def ping(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "pong": True,
            "version": self._version,
            "dataRoot": str(self._store.root),
            "ftsAvailable": self._store.fts_available,
        }

    # ── 库 ──────────────────────────────────────────────────────────────
    async def list(self, _params: dict[str, Any]) -> dict[str, Any]:
        with self._store.central() as conn:
            rows = conn.execute(
                "SELECT * FROM kb_bases ORDER BY updated_at DESC"
            ).fetchall()
        return {"bases": [_row_to_base(row) for row in rows]}

    async def create(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        if not name:
            raise StorageError("INVALID_NAME", "name 不能为空")

        content_mode = str(params.get("contentMode") or "hybrid")
        if content_mode not in CONTENT_MODES:
            raise StorageError(
                "INVALID_MODE", f"contentMode 必须是 {sorted(CONTENT_MODES)} 之一"
            )

        kb_id = _new_id("kb")
        now = _now()
        embedding_model = str(params.get("embeddingModel") or "").strip()
        embedding_dim = int(params.get("embeddingDim") or 0)
        if embedding_dim < 0:
            raise StorageError("INVALID_DIM", "embeddingDim 不能为负")

        # 先建目录再写元数据：写元数据失败时目录残留可被下次 create 复用（同名 id 不会撞）。
        self._store.create_kb_dir(kb_id)
        self._store.ensure_fts(kb_id)
        with self._store.central() as conn:
            conn.execute(
                """
                INSERT INTO kb_bases
                  (id, name, description, embedding_model, embedding_dim, content_mode,
                   created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                (
                    kb_id,
                    name,
                    str(params.get("description") or ""),
                    embedding_model,
                    embedding_dim,
                    content_mode,
                    now,
                    now,
                ),
            )
        return {"base": self._base_by_id(kb_id)}

    async def update(self, params: dict[str, Any]) -> dict[str, Any]:
        kb_id = self._require_kb_id(params)
        current = self._base_by_id(kb_id)

        updates: list[str] = []
        values: list[Any] = []
        if "name" in params:
            name = str(params["name"] or "").strip()
            if not name:
                raise StorageError("INVALID_NAME", "name 不能为空")
            updates.append("name=?")
            values.append(name)
        if "description" in params:
            updates.append("description=?")
            values.append(str(params["description"] or ""))
        if "embeddingModel" in params:
            updates.append("embedding_model=?")
            values.append(str(params["embeddingModel"] or "").strip())
        if "contentMode" in params:
            mode = str(params["contentMode"] or "")
            if mode not in CONTENT_MODES:
                raise StorageError("INVALID_MODE", f"contentMode 必须是 {sorted(CONTENT_MODES)}")
            updates.append("content_mode=?")
            values.append(mode)

        if not updates:
            return {"base": current}

        # 换嵌入模型必须同时把 dim 归零：旧向量与新模型维度不兼容，混用会让
        # 检索结果静默失真（spec §4.4「向量维度不匹配」）。dim=0 即「需要重建索引」。
        if "embeddingModel" in params:
            new_model = str(params["embeddingModel"] or "").strip()
            if new_model != current["embeddingModel"]:
                updates.append("embedding_dim=?")
                values.append(0)

        updates.append("updated_at=?")
        values.append(_now())
        values.append(kb_id)
        with self._store.central() as conn:
            conn.execute(f"UPDATE kb_bases SET {', '.join(updates)} WHERE id=?", values)
        return {"base": self._base_by_id(kb_id)}

    async def delete(self, params: dict[str, Any]) -> dict[str, Any]:
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)  # 不存在则抛 KB_NOT_FOUND
        with self._store.central() as conn:
            conn.execute("DELETE FROM kb_bases WHERE id=?", (kb_id,))
        self._store.drop_kb_dir(kb_id)
        return {"deleted": True, "kbId": kb_id}

    # ── 文档（P0-b 实现解析与分块）──────────────────────────────────────
    async def list_docs(self, params: dict[str, Any]) -> dict[str, Any]:
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        with self._store.kb_conn(kb_id) as conn:
            rows = conn.execute(
                "SELECT * FROM kb_documents ORDER BY updated_at DESC"
            ).fetchall()
        return {
            "docs": [
                {
                    "id": row["id"],
                    "docId": row["doc_id"],
                    "title": row["title"],
                    "fileName": row["file_name"],
                    "relPath": row["rel_path"],
                    "byteSize": row["byte_size"],
                    "parseStatus": row["parse_status"],
                    "parseError": row["parse_error"],
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]
        }

    async def upload(self, params: dict[str, Any]) -> dict[str, Any]:
        """登记一个文件并排队解析。

        P0-a 只做「落盘 + 登记 + 排任务」，真正的解析在 P0-b。
        这样 Node 侧的上传链路可以先跑通，解析实现后无需改协议。
        """
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        file_path = str(params.get("filePath") or "").strip()
        if not file_path:
            raise StorageError("INVALID_PATH", "filePath 不能为空")
        source = Path(file_path)
        if not source.is_file():
            raise StorageError("FILE_NOT_FOUND", f"文件不存在：{file_path}")

        rel_path = str(params.get("relPath") or source.name).strip() or source.name
        payload = source.read_bytes()
        content_hash = hashlib.sha256(payload).hexdigest()

        with self._store.kb_conn(kb_id) as conn:
            # 幂等：同 rel_path 且内容哈希未变 → 直接返回既有记录，不重复解析
            # （spec 验收 #8）。
            existing = conn.execute(
                "SELECT * FROM kb_documents WHERE rel_path=?", (rel_path,)
            ).fetchone()
            if existing and existing["content_hash"] == content_hash:
                return {
                    "doc": {
                        "id": existing["id"],
                        "docId": existing["doc_id"],
                        "parseStatus": existing["parse_status"],
                    },
                    "skipped": True,
                }

            doc_pk = existing["id"] if existing else _new_id("doc")
            doc_id = existing["doc_id"] if existing else _new_id("d")
            blob_dir = self._store.kb_blobs_dir(kb_id) / doc_pk
            blob_dir.mkdir(parents=True, exist_ok=True)
            (blob_dir / source.name).write_bytes(payload)

            now = _now()
            if existing:
                conn.execute(
                    """
                    UPDATE kb_documents
                       SET content_hash=?, byte_size=?, parse_status='pending',
                           parse_error=NULL, updated_at=?
                     WHERE id=?
                    """,
                    (content_hash, len(payload), now, doc_pk),
                )
                # 内容变了：旧分块与向量全部作废，避免检索到过期正文。
                conn.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_pk,))
                conn.execute("DELETE FROM kb_chunk_embeddings WHERE doc_id=?", (doc_pk,))
            else:
                conn.execute(
                    """
                    INSERT INTO kb_documents
                      (id, doc_id, title, file_name, rel_path, content_hash, byte_size,
                       parse_status, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,'pending',?,?)
                    """,
                    (
                        doc_pk,
                        doc_id,
                        source.stem,
                        source.name,
                        rel_path,
                        content_hash,
                        len(payload),
                        now,
                        now,
                    ),
                )

            conn.execute(
                """
                INSERT INTO kb_jobs (id, kind, doc_id, state, created_at, updated_at)
                VALUES (?, 'parse', ?, 'queued', ?, ?)
                """,
                (_new_id("job"), doc_pk, now, now),
            )

        return {
            "doc": {"id": doc_pk, "docId": doc_id, "parseStatus": "pending"},
            "skipped": False,
        }

    async def delete_doc(self, params: dict[str, Any]) -> dict[str, Any]:
        """删文档：连同它的分块、向量、FTS 条目与 blob 一起清掉。"""
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        doc_id = str(params.get("docId") or "").strip()
        if not doc_id:
            raise StorageError("MISSING_DOC_ID", "docId 不能为空")
        with self._store.kb_conn(kb_id) as conn:
            row = conn.execute(
                "SELECT id, doc_id FROM kb_documents WHERE id=? OR doc_id=?",
                (doc_id, doc_id),
            ).fetchone()
            if row is None:
                raise StorageError("DOC_NOT_FOUND", f"文档不存在：{doc_id}")
            # FTS 是外部 content 表，级联删不到，必须显式清。
            conn.execute("DELETE FROM kb_chunks_fts WHERE doc_id=?", (row["id"],))
            conn.execute("DELETE FROM kb_documents WHERE id=?", (row["id"],))
        # blob 目录随文档删除（与 kb.delete 的整库清理保持一致）。
        self._store.kb_blobs_dir(kb_id)
        import shutil

        blob_dir = self._store.kb_dir(kb_id) / "blobs" / row["id"]
        if blob_dir.exists():
            shutil.rmtree(blob_dir, ignore_errors=True)
        return {"deleted": True, "docId": row["id"]}

    async def job(self, params: dict[str, Any]) -> dict[str, Any]:
        """查单个索引任务状态（前端轮询用）。"""
        job_id = str(params.get("jobId") or "").strip()
        if not job_id:
            raise StorageError("MISSING_JOB_ID", "jobId 不能为空")
        # 任务表在每个库的 DB 里，但前端只给 jobId —— 扫全部库。
        # P0 只有 parse 一种任务，量小；任务种类变多后再加 job→kb 索引。
        for base in self._all_base_ids():
            with self._store.kb_conn(base["id"]) as conn:
                row = conn.execute("SELECT * FROM kb_jobs WHERE id=?", (job_id,)).fetchone()
                if row:
                    return {
                        "id": row["id"],
                        "kind": row["kind"],
                        "docId": row["doc_id"],
                        "state": row["state"],
                        "attempts": row["attempts"],
                        "lastError": row["last_error"],
                        "createdAt": row["created_at"],
                        "updatedAt": row["updated_at"],
                    }
        raise StorageError("JOB_NOT_FOUND", f"任务不存在：{job_id}")

    async def list_jobs(self, params: dict[str, Any]) -> dict[str, Any]:
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        with self._store.kb_conn(kb_id) as conn:
            rows = conn.execute(
                "SELECT * FROM kb_jobs ORDER BY created_at DESC LIMIT 200"
            ).fetchall()
        return {
            "jobs": [
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "docId": row["doc_id"],
                    "state": row["state"],
                    "attempts": row["attempts"],
                    "lastError": row["last_error"],
                    "createdAt": row["created_at"],
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]
        }

    def _all_base_ids(self) -> list[dict[str, Any]]:
        with self._store.central() as conn:
            rows = conn.execute("SELECT id FROM kb_bases").fetchall()
        return [{"id": row["id"]} for row in rows]

    # ── 文档正文与分块 ───────────────────────────────────────────────────
    async def read_doc(self, params: dict[str, Any]) -> dict[str, Any]:
        """读文档的已解析正文 + 分块列表。

        正文由分块拼回（保留 `\\n\\n` 分隔）：这样不必单独存一份全文，
        且读到的就是检索命中的同一份内容 —— 不会出现「预览和检索结果不一致」。
        """
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        doc_ref = str(params.get("docId") or "").strip()
        if not doc_ref:
            raise StorageError("MISSING_DOC_ID", "docId 不能为空")
        max_chars = int(params.get("maxChars") or 200_000)

        with self._store.kb_conn(kb_id) as conn:
            doc = conn.execute(
                "SELECT * FROM kb_documents WHERE id=? OR doc_id=?", (doc_ref, doc_ref)
            ).fetchone()
            if doc is None:
                raise StorageError("DOC_NOT_FOUND", f"文档不存在：{doc_ref}")
            chunks = conn.execute(
                "SELECT * FROM kb_chunks WHERE doc_id=? AND enabled=1 ORDER BY ordinal",
                (doc["id"],),
            ).fetchall()

        content = "\n\n".join(row["content"] for row in chunks)
        truncated = len(content) > max_chars
        if truncated:
            content = content[:max_chars]
        return {
            "doc": {
                "id": doc["id"],
                "docId": doc["doc_id"],
                "title": doc["title"],
                "fileName": doc["file_name"],
                "relPath": doc["rel_path"],
                "byteSize": doc["byte_size"],
                "parseStatus": doc["parse_status"],
                "parseError": doc["parse_error"],
                "summaryText": doc["summary_text"],
                "updatedAt": doc["updated_at"],
            },
            "content": content,
            "truncated": truncated,
            "chunks": [
                {
                    "id": row["id"],
                    "ordinal": row["ordinal"],
                    "content": row["content"],
                    "headingPath": row["heading_path"],
                    "contextHeader": row["context_header"],
                    "chunkKind": row["chunk_kind"],
                    "tokenEstimate": row["token_estimate"],
                }
                for row in chunks
            ],
        }

    async def retry_doc(self, params: dict[str, Any]) -> dict[str, Any]:
        """重试失败的文档：重置状态并重新排 parse 作业。"""
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        doc_ref = str(params.get("docId") or "").strip()
        if not doc_ref:
            raise StorageError("MISSING_DOC_ID", "docId 不能为空")

        with self._store.kb_conn(kb_id) as conn:
            doc = conn.execute(
                "SELECT id FROM kb_documents WHERE id=? OR doc_id=?", (doc_ref, doc_ref)
            ).fetchone()
            if doc is None:
                raise StorageError("DOC_NOT_FOUND", f"文档不存在：{doc_ref}")
            now = _now()
            conn.execute(
                "UPDATE kb_documents SET parse_status='pending', parse_error=NULL, updated_at=? "
                "WHERE id=?",
                (now, doc["id"]),
            )
            # 清掉该文档的旧 parse 作业，避免重复排队
            conn.execute(
                "DELETE FROM kb_jobs WHERE doc_id=? AND kind='parse'", (doc["id"],)
            )
            conn.execute(
                "INSERT INTO kb_jobs (id, kind, doc_id, state, created_at, updated_at) "
                "VALUES (?, 'parse', ?, 'queued', ?, ?)",
                (_new_id("job"), doc["id"], now, now),
            )
        return {"retried": True, "docId": doc["id"]}

    # ── 检索 ────────────────────────────────────────────────────────────
    async def search(self, params: dict[str, Any]) -> dict[str, Any]:
        """混合检索：三路召回 → RRF 融合 → 模型重排。

        编排移植自 EvoFlow `owned/service.py::search()`，降级链按 spec §6.3：
        - keyword 模式：只走 FTS + LIKE；
        - vector 模式：只走向量（无向量时降级为关键词并标记 degraded）；
        - hybrid（默认）：关键词 + 向量 → RRF(w_kw=1.8, w_vec=0.65)。
          关键词权重更高是因为「精确术语 / 编号 / 引用」场景比语义相似更重要。

        重排：配了 rerank 服务就先模型精排，失败退回词面启发式。
        """
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)

        query = str(params.get("query") or "").strip()
        if not query:
            raise StorageError("MISSING_QUERY", "query 不能为空")

        top_k = int(params.get("topK") or 8)
        top_k = max(1, min(top_k, 50))
        mode = str(params.get("mode") or "hybrid").strip().lower()
        # title 是**检索**专用模式（按文档名找），不在建库的 CONTENT_MODES 白名单里，
        # 但检索时必须允许 —— 早期版本直接拿 CONTENT_MODES 校验，把 title 静默
        # 降级成 hybrid，导致「按文件名找文档」这个场景彻底失效。
        if mode not in SEARCH_MODES:
            mode = "hybrid"

        from .search import (
            apply_model_rerank,
            enrich_hits,
            rerank_by_query_match,
            rrf_fuse,
            search_keyword,
            search_title,
            search_vector,
        )

        fetch_k = max(top_k * 3, 20)
        degraded = False
        keyword_hits: list[dict[str, Any]] = []
        vector_hits: list[dict[str, Any]] = []

        base = self._base_by_id(kb_id)
        embedding_dim = int(base.get("embeddingDim") or 0)

        with self._store.kb_conn(kb_id) as conn:
            # 标题模式：按文档名找，直接返回每篇文档的首块
            if mode == "title":
                fused = search_title(conn, query, top_k=fetch_k)
                items = enrich_hits(conn, fused)[:top_k]
                return {
                    "items": items,
                    "total": len(items),
                    "mode": mode,
                    "degraded": False,
                }

            if mode in ("keyword", "hybrid"):
                keyword_hits = search_keyword(conn, query, top_k=fetch_k)

            if mode in ("vector", "hybrid"):
                qvec: list[float] = []
                if self._model_client is not None and embedding_dim > 0:
                    try:
                        qvec = self._model_client.embed([query])[0]
                    except Exception as exc:  # noqa: BLE001 — 降级不报错
                        degraded = True
                        logger.warning("查询向量化失败，降级为关键词检索：%s", exc)
                if qvec:
                    vector_hits = search_vector(
                        conn,
                        qvec,
                        top_k=fetch_k,
                        model=str(base.get("embeddingModel") or ""),
                    )
                elif mode == "vector":
                    # 明确要语义检索但没有向量能力 → 诚实标记降级
                    degraded = True

            # 融合
            if mode == "keyword" or (mode == "hybrid" and not vector_hits):
                fused = keyword_hits[:fetch_k]
                for i, h in enumerate(fused):
                    h["rank"] = i + 1
                    rel = float(h.get("score") or 0)
                    h["rrf_score"] = rel if rel > 0 else 1.0 / (60 + i + 1)
                if mode == "hybrid" and embedding_dim > 0 and not vector_hits:
                    degraded = True
            elif mode == "vector":
                fused = vector_hits[:fetch_k]
                for i, h in enumerate(fused):
                    h["rank"] = i + 1
                    h["rrf_score"] = h.get("score") or 0
            else:
                # 精确词 / 编号 / 引号短语要压过「语义相近」的结果
                fused = rrf_fuse(
                    keyword_hits,
                    vector_hits,
                    top_k=fetch_k,
                    w_kw=1.8,
                    w_vec=0.65,
                )

            items = enrich_hits(conn, fused)
            # 补 kbId（enrich 时不知道库 id，这里统一填）
            for item in items:
                item["kbId"] = kb_id

            # 精排：模型优先，失败退回词面启发式
            if self._model_client is not None and self._model_client.has_rerank:
                try:
                    items = apply_model_rerank(
                        items, query, self._model_client, top_k=top_k
                    )
                except Exception as exc:  # noqa: BLE001 — rerank 挂了不影响结果
                    logger.warning("模型重排失败，退回词面启发式：%s", exc)
                    items = rerank_by_query_match(items, query)[:top_k]
            else:
                items = rerank_by_query_match(items, query)[:top_k]

        return {
            "items": items,
            "total": len(items),
            "mode": mode,
            "degraded": degraded,
        }

    async def ask(self, params: dict[str, Any]) -> dict[str, Any]:
        """问答：检索出相关片段并拼成带引用的答案上下文。

        **P0 不在这里调 LLM**：sidecar 只负责「检索 + 组装上下文」，生成答案
        由上层 agent / 模型完成。这样做的原因：
        - sidecar 不该持有对话状态，也不该懂 prompt 拼装；
        - 用户换模型 / 换 prompt 策略不需要重启 sidecar；
        - 断网时检索仍可用，只是没有生成能力。
        """
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        query = str(params.get("query") or "").strip()
        if not query:
            raise StorageError("MISSING_QUERY", "query 不能为空")

        top_k = int(params.get("topK") or 6)
        top_k = max(1, min(top_k, 20))

        result = await self.search(
            {
                "kbId": kb_id,
                "query": query,
                "topK": top_k,
                "mode": params.get("mode") or "hybrid",
            }
        )
        items = result.get("items") or []

        # 组装上下文：每段前加来源标记，方便上层引用和前端跳转
        blocks: list[str] = []
        for index, item in enumerate(items, 1):
            header = str(item.get("contextHeader") or "").strip()
            title = str(item.get("title") or item.get("fileName") or "").strip()
            label = " › ".join(part for part in (title, header) if part)
            blocks.append(f"[{index}] {label}\n{item.get('content') or ''}")
        context = "\n\n".join(blocks)

        return {
            "query": query,
            "context": context,
            "sources": [
                {
                    "index": index,
                    "chunkId": item.get("chunkId"),
                    "docId": item.get("docId"),
                    "title": item.get("title"),
                    "contextHeader": item.get("contextHeader"),
                }
                for index, item in enumerate(items, 1)
            ],
            "degraded": result.get("degraded", False),
        }

    async def stats(self, params: dict[str, Any]) -> dict[str, Any]:
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        with self._store.kb_conn(kb_id) as conn:
            doc_count = conn.execute("SELECT COUNT(*) AS n FROM kb_documents").fetchone()["n"]
            chunk_count = conn.execute("SELECT COUNT(*) AS n FROM kb_chunks").fetchone()["n"]
            emb_count = conn.execute(
                "SELECT COUNT(*) AS n FROM kb_chunk_embeddings"
            ).fetchone()["n"]
            by_status = {
                row["parse_status"]: row["n"]
                for row in conn.execute(
                    "SELECT parse_status, COUNT(*) AS n FROM kb_documents GROUP BY parse_status"
                ).fetchall()
            }
        return {
            "kbId": kb_id,
            "documents": doc_count,
            "chunks": chunk_count,
            "embeddings": emb_count,
            "byStatus": by_status,
        }

    async def reindex(self, params: dict[str, Any]) -> dict[str, Any]:
        """整库重建索引：清掉全部分块/向量/FTS，为每篇文档重排 parse + embed。

        parse 会重新分块并再排一个 embed job，所以这里只需要排 parse。
        """
        kb_id = self._require_kb_id(params)
        self._base_by_id(kb_id)
        now = _now()

        with self._store.kb_conn(kb_id) as conn:
            conn.execute("DELETE FROM kb_chunks")
            conn.execute("DELETE FROM kb_chunk_embeddings")
            try:
                conn.execute("DELETE FROM kb_chunks_fts")
            except Exception:  # noqa: BLE001 — FTS 不可用时忽略
                pass
            conn.execute("DELETE FROM kb_jobs WHERE state IN ('queued','running')")
            docs = conn.execute(
                "SELECT id FROM kb_documents ORDER BY created_at"
            ).fetchall()
            for doc in docs:
                conn.execute(
                    "UPDATE kb_documents SET parse_status='pending', parse_error=NULL, "
                    "updated_at=? WHERE id=?",
                    (now, doc["id"]),
                )
                conn.execute(
                    "INSERT INTO kb_jobs (id, kind, doc_id, state, created_at, updated_at) "
                    "VALUES (?, 'parse', ?, 'queued', ?, ?)",
                    (_new_id("job"), doc["id"], now, now),
                )
        logger.info("整库重建索引 kb=%s docs=%d", kb_id, len(docs))
        return {"reindexed": True, "documents": len(docs)}

    # ── 内部 ────────────────────────────────────────────────────────────
    def _require_kb_id(self, params: dict[str, Any]) -> str:
        kb_id = str(params.get("kbId") or "").strip()
        if not kb_id:
            raise StorageError("MISSING_KB_ID", "kbId 不能为空")
        return kb_id

    def _base_by_id(self, kb_id: str) -> dict[str, Any]:
        with self._store.central() as conn:
            row = conn.execute("SELECT * FROM kb_bases WHERE id=?", (kb_id,)).fetchone()
        if row is None:
            raise StorageError("KB_NOT_FOUND", f"知识库不存在：{kb_id}")
        return _row_to_base(row)
