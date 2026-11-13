"""Optional sqlite-vec acceleration for the owned knowledge index."""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import struct
from typing import Any

logger = logging.getLogger(__name__)
_LOADED_CONNECTIONS: set[int] = set()


def _table_name(kb_id: str, dim: int, model: str) -> str:
    identity = f"{kb_id}\0{model}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"kb_vec_{digest}_{int(dim)}"


def _pack(values: list[float]) -> bytes:
    return struct.pack(f"{len(values)}f", *values)


def _load_extension(conn: Any) -> bool:
    if id(conn) in _LOADED_CONNECTIONS:
        return True
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        conn.load_extension(sqlite_vec.loadable_path())
        conn.enable_load_extension(False)
        _LOADED_CONNECTIONS.add(id(conn))
        return True
    except Exception:
        return False


def ensure_table(conn: Any, *, kb_id: str, dim: int, model: str = "") -> str | None:
    table = _table_name(kb_id, dim, model)
    try:
        # Connections used by owned KBs are independent from the central DB.
        # Load the extension lazily so existing installations still degrade to
        # the BLOB scan when sqlite-vec is unavailable.
        if not _load_extension(conn):
            return None
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {table} USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[{int(dim)}])"
        )
        return table
    except (sqlite3.Error, ValueError) as exc:
        logger.debug("owned sqlite-vec unavailable: %s", exc)
        return None


def insert_many(conn: Any, *, kb_id: str, dim: int, model: str = "", rows: list[tuple[str, list[float]]]) -> bool:
    if not rows:
        return True
    table = ensure_table(conn, kb_id=kb_id, dim=dim, model=model)
    if not table:
        return False
    try:
        conn.executemany(
            f"INSERT OR REPLACE INTO {table}(chunk_id, embedding) VALUES (?, ?)",
            [(chunk_id, _pack(vector)) for chunk_id, vector in rows],
        )
        return True
    except sqlite3.Error:
        logger.debug("owned sqlite-vec insert skipped", exc_info=True)
        return False


def delete_many(conn: Any, *, kb_id: str, dim: int, model: str = "", chunk_ids: list[str]) -> None:
    if not chunk_ids:
        return
    table = ensure_table(conn, kb_id=kb_id, dim=dim, model=model)
    if not table:
        return
    conn.executemany(f"DELETE FROM {table} WHERE chunk_id=?", [(cid,) for cid in chunk_ids])


def delete_chunk_ids(conn: Any, chunk_ids: list[str]) -> None:
    """Remove ids from every owned vec table, including old model partitions."""
    if not chunk_ids:
        return
    tables = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kb_vec_%'"
    ).fetchall()
    for row in tables:
        name = str(row[0])
        if not name.replace("_", "").isalnum():
            continue
        try:
            conn.executemany(f"DELETE FROM {name} WHERE chunk_id=?", [(cid,) for cid in chunk_ids])
        except sqlite3.Error:
            logger.debug("owned sqlite-vec cleanup skipped for %s", name, exc_info=True)


def recall_ids(
    conn: Any,
    *,
    kb_id: str,
    dim: int,
    model: str = "",
    query_vec: list[float],
    top_k: int,
) -> list[tuple[str, float]] | None:
    table = ensure_table(conn, kb_id=kb_id, dim=dim, model=model)
    if not table:
        return None
    try:
        # A vec table can be newly created while the legacy BLOB rows already
        # exist. Only use ANN when it covers the complete model partition;
        # otherwise the caller falls back to the compatible exact scan.
        vec_count = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        blob_count = int(
            conn.execute(
                "SELECT COUNT(*) FROM kb_chunk_embeddings WHERE kb_id=? AND dim=? AND (?='' OR model=?)",
                (kb_id, int(dim), str(model or ""), str(model or "")),
            ).fetchone()[0]
        )
        if vec_count == 0 or vec_count < blob_count:
            return None
        rows = conn.execute(
            f"SELECT chunk_id, distance FROM {table} WHERE embedding MATCH ? AND k=? ORDER BY distance",
            (_pack(query_vec), max(1, int(top_k))),
        ).fetchall()
        return [(str(row["chunk_id"]), float(row["distance"])) for row in rows]
    except sqlite3.Error:
        logger.debug("owned sqlite-vec recall skipped", exc_info=True)
        return None
