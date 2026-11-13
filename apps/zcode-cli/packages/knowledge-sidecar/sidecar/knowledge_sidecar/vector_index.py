"""sqlite-vec 向量索引加速（可选）。

> **来源**：移植自 EvoFlow `backend/packages/harness/evoflow/knowledge/owned/vector_index.py`
> （公司自有项目，已获书面授权）。改动：
> ① 表名去掉 `kb_id`（本仓每库独立 DB，不需要在表名里再区分库）；
> ② 去掉 `kb_id=?` 过滤条件；③ 表名做标识符白名单校验防注入。

## 为什么是「可选」

`sqlite-vec` 是原生扩展。本仓刻意不打包原生依赖（spec §2.2），所以它可能不存在。
此时检索**不受影响** —— `search.search_vector` 会退化为全表扫 + 纯 Python 余弦。
数据量上万块之后才需要考虑 ANN，P0 阶段（单库几千块）扫描完全够用。

## 为什么要检查覆盖度

一个库可能先按老路径（纯 BLOB 扫描）建好索引，之后才装上 sqlite-vec。
这时 vec0 表是**空的或不全的**，直接拿它做 ANN 会漏召回。
所以 `recall_ids` 比较 vec 表行数和 BLOB 行数，不全就返回 None 让调用方降级。
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import struct
from typing import Any

logger = logging.getLogger("knowledge_sidecar.vector_index")

# 扩展加载状态**不做跨连接缓存**。
#
# [踩过的坑] 早期版本用 `set[int]` 存 `id(conn)` 来跳过重复 load。CPython 会复用
# 已释放对象的 id：连接 A 加载完扩展 → 关闭 → 新建连接 B 恰好拿到同一个 id →
# 被误判成「已加载」→ 跳过 load_extension → 查询抛 `no such module: vec0`。
# 症状是「进程里第一次检索正常，之后全部退化」，而且不报错（被降级吞掉），极难定位。
#
# SQLite 的扩展是**连接级**的，本仓 `store.kb_conn()` 每次操作都开新连接，
# 所以本来就必须每个连接都 load 一次。缓存既不正确也没有收益（dlopen 本身由
# 操作系统缓存），直接去掉。
_sqlite_vec_available: bool | None = None

# vec0 的向量列宽是表定义时固定的，换 embedding 模型 = 换维度 = 换表
_TABLE_PREFIX = "kb_vec_"


def _table_name(dim: int, model: str) -> str:
    """每个 (模型, 维度) 组合一张表。换模型不需要删旧表，只是切到新表。"""
    identity = str(model or "")
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"{_TABLE_PREFIX}{digest}_{int(dim)}"


def _pack(values: list[float]) -> bytes:
    return struct.pack(f"{len(values)}f", *values)


def _load_extension(conn: Any) -> bool:
    """在当前连接上加载 sqlite-vec 扩展。

    每次调用都必须真正 load —— SQLite 扩展是连接级的，不能跨连接共享。
    只有 `import sqlite_vec` 本身会失败（包装时没带这个 wheel）才缓存为不可用，
    因为那是进程级事实。
    """
    global _sqlite_vec_available
    if _sqlite_vec_available is False:
        return False
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        conn.load_extension(sqlite_vec.loadable_path())
        conn.enable_load_extension(False)
        _sqlite_vec_available = True
        return True
    except ImportError:
        _sqlite_vec_available = False
        logger.info("sqlite-vec 未安装，向量检索走全表扫描（功能正常，仅慢一些）")
        return False
    except Exception:  # noqa: BLE001 — 扩展加载失败按不可用处理
        logger.debug("sqlite-vec 扩展加载失败", exc_info=True)
        return False


def ensure_table(conn: Any, *, dim: int, model: str = "") -> str | None:
    table = _table_name(dim, model)
    try:
        if not _load_extension(conn):
            return None
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {table} "
            f"USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[{int(dim)}])"
        )
        return table
    except (sqlite3.Error, ValueError) as exc:
        logger.debug("sqlite-vec 不可用：%s", exc)
        return None


def insert_many(
    conn: Any,
    *,
    dim: int,
    model: str = "",
    rows: list[tuple[str, list[float]]],
) -> bool:
    if not rows:
        return True
    table = ensure_table(conn, dim=dim, model=model)
    if not table:
        return False
    try:
        conn.executemany(
            f"INSERT OR REPLACE INTO {table}(chunk_id, embedding) VALUES (?, ?)",
            [(chunk_id, _pack(vector)) for chunk_id, vector in rows],
        )
        return True
    except sqlite3.Error:
        logger.debug("sqlite-vec 写入跳过", exc_info=True)
        return False


def delete_many(
    conn: Any,
    *,
    dim: int,
    model: str = "",
    chunk_ids: list[str],
) -> None:
    if not chunk_ids:
        return
    table = ensure_table(conn, dim=dim, model=model)
    if not table:
        return
    conn.executemany(f"DELETE FROM {table} WHERE chunk_id=?", [(cid,) for cid in chunk_ids])


def delete_chunk_ids(conn: Any, chunk_ids: list[str]) -> None:
    """从所有 vec 表里删掉这些 chunk（含旧模型分区的表）。"""
    if not chunk_ids:
        return
    tables = conn.execute(
        f"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '{_TABLE_PREFIX}%'"
    ).fetchall()
    for row in tables:
        name = str(row[0])
        # 标识符白名单：表名来自 sqlite_master，但仍要防拼接注入
        if not name.replace("_", "").isalnum():
            continue
        try:
            conn.executemany(
                f"DELETE FROM {name} WHERE chunk_id=?", [(cid,) for cid in chunk_ids]
            )
        except sqlite3.Error:
            logger.debug("sqlite-vec 清理跳过：%s", name, exc_info=True)


def recall_ids(
    conn: Any,
    *,
    dim: int,
    model: str = "",
    query_vec: list[float],
    top_k: int,
) -> list[tuple[str, float]] | None:
    """返回 [(chunk_id, distance)]；返回 None 表示调用方应降级为全表扫。"""
    table = ensure_table(conn, dim=dim, model=model)
    if not table:
        return None
    try:
        # vec 表可能是新建的，而 BLOB 行早就存在。只有 vec 表覆盖了完整分区时
        # 才能用 ANN，否则会漏召回 —— 交给调用方走精确扫描。
        vec_count = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        blob_count = int(
            conn.execute(
                "SELECT COUNT(*) FROM kb_chunk_embeddings WHERE dim=? AND (?='' OR model=?)",
                (int(dim), str(model or ""), str(model or "")),
            ).fetchone()[0]
        )
        if vec_count == 0 or vec_count < blob_count:
            return None
        rows = conn.execute(
            f"SELECT chunk_id, distance FROM {table} "
            f"WHERE embedding MATCH ? AND k=? ORDER BY distance",
            (_pack(query_vec), max(1, int(top_k))),
        ).fetchall()
        return [(str(row["chunk_id"]), float(row["distance"])) for row in rows]
    except sqlite3.Error:
        logger.debug("sqlite-vec 召回跳过", exc_info=True)
        return None


__all__ = [
    "delete_chunk_ids",
    "delete_many",
    "ensure_table",
    "insert_many",
    "recall_ids",
]
