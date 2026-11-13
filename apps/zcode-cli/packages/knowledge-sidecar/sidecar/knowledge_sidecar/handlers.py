"""P0-a 的方法实现：库的增删改查 + 健康检查。

检索链路（P0-c/d）与解析分块（P0-b）不在本阶段实现，先留明确的 ``NOT_IMPLEMENTED``，
避免前端拿到一个「能调但返回空」的假接口。
"""

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .store import KnowledgeStore, StorageError

# 内容模式白名单：与 spec §6.3 一致。
CONTENT_MODES = {"hybrid", "keyword", "vector"}


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
    def __init__(self, store: KnowledgeStore, version: str) -> None:
        self._store = store
        self._version = version

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

    # ── P0-b 之后实现 ───────────────────────────────────────────────────
    async def search(self, _params: dict[str, Any]) -> Any:
        raise StorageError("NOT_IMPLEMENTED", "检索链路在 P0-c/d 实现")

    async def read_doc(self, _params: dict[str, Any]) -> Any:
        raise StorageError("NOT_IMPLEMENTED", "正文读取在 P0-b 实现")

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

    async def reindex(self, _params: dict[str, Any]) -> Any:
        raise StorageError("NOT_IMPLEMENTED", "重建索引在 P0-c 实现")

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
