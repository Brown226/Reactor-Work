"""知识库 sidecar 的存储层：中心库 + 每库独立 SQLite。

布局（见 spec §5.1）：

.. code-block:: text

    <dataRoot>/
    ├── owned.sqlite          # 中心库：库元数据
    └── kb_<kbId>/
        ├── kb.sqlite         # 该库的文档 / 分块 / 向量 / 任务
        └── blobs/            # 原始文件

为什么每库一个 SQLite：库可独立备份/删除/重建；单库索引损坏不影响其他库；
向量表按库隔离，换嵌入模型时只重建该库（spec §5.1）。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

CENTRAL_DB_NAME = "owned.sqlite"
KB_DB_NAME = "kb.sqlite"
BLOBS_DIR_NAME = "blobs"

# 中心库：所有库的元数据。字段裁剪自 EvoFlow kb_bases，去掉多租户/内置库相关列。
CENTRAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS kb_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_dim INTEGER NOT NULL DEFAULT 0,
  content_mode TEXT NOT NULL DEFAULT 'hybrid',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# 每库：文档 / 分块 / 向量 / FTS / 任务。与 spec §5.2 一致。
KB_SCHEMA = """
CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error TEXT,
  summary_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_rel_path ON kb_documents(rel_path);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  context_header TEXT NOT NULL DEFAULT '',
  heading_path TEXT NOT NULL DEFAULT '',
  chunk_kind TEXT NOT NULL DEFAULT 'text',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON kb_chunks(doc_id, ordinal);

CREATE TABLE IF NOT EXISTS kb_chunk_embeddings (
  chunk_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_model ON kb_chunk_embeddings(model, dim);

CREATE TABLE IF NOT EXISTS kb_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  doc_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON kb_jobs(state, created_at);

CREATE TABLE IF NOT EXISTS kb_schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

# FTS5 单独建：老版本 SQLite 可能没编译 fts5，缺了就降级为纯向量检索（spec §6.3）。
FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  doc_id UNINDEXED,
  content,
  tokenize='unicode61'
);
"""


class StorageError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _connect(path: Path) -> sqlite3.Connection:
    """打开连接并设置 WAL + 忙等待。

    WAL 让读写不互相阻塞（检索与索引并行）；``busy_timeout`` 让并发写入排队而不是
    立刻抛 ``database is locked``（spec §4.4 的锁冲突重试靠它兜底）。
    """
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class KnowledgeStore:
    def __init__(self, data_root: Path) -> None:
        self._root = data_root
        self._root.mkdir(parents=True, exist_ok=True)
        self._central_path = self._root / CENTRAL_DB_NAME
        self._fts_available: bool | None = None
        self._init_central()

    # ── 路径 ────────────────────────────────────────────────────────────
    @property
    def root(self) -> Path:
        return self._root

    def kb_dir(self, kb_id: str) -> Path:
        # kb_id 本身已带 "kb_" 前缀（handlers 用 _new_id("kb") 生成）。
        # 这里再加一次会得到 kb_kb_xxx 的双前缀目录 —— 早期版本踩过，
        # 症状是库能建但目录名与 id 对不上，删库时找不到目标。
        return self._root / kb_id

    def kb_db_path(self, kb_id: str) -> Path:
        return self.kb_dir(kb_id) / KB_DB_NAME

    def kb_blobs_dir(self, kb_id: str) -> Path:
        return self.kb_dir(kb_id) / BLOBS_DIR_NAME

    # ── 初始化 ──────────────────────────────────────────────────────────
    def _init_central(self) -> None:
        with self.central() as conn:
            conn.executescript(CENTRAL_SCHEMA)

    def _init_kb(self, kb_id: str) -> None:
        self.kb_dir(kb_id).mkdir(parents=True, exist_ok=True)
        self.kb_blobs_dir(kb_id).mkdir(parents=True, exist_ok=True)
        # 直接用底层连接建 schema：kb_conn 会先检查文件存在，而此刻文件还没被创建，
        # 用它建库会自己把自己挡在门外（KB_NOT_FOUND）。
        conn = _connect(self.kb_db_path(kb_id))
        try:
            conn.executescript(KB_SCHEMA)
        finally:
            conn.close()

    # ── 连接 ────────────────────────────────────────────────────────────
    @contextmanager
    def central(self) -> Iterator[sqlite3.Connection]:
        conn = _connect(self._central_path)
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def kb_conn(self, kb_id: str) -> Iterator[sqlite3.Connection]:
        path = self.kb_db_path(kb_id)
        if not path.exists():
            raise StorageError("KB_NOT_FOUND", f"知识库不存在：{kb_id}")
        conn = _connect(path)
        try:
            yield conn
        finally:
            conn.close()

    # ── FTS ─────────────────────────────────────────────────────────────
    def ensure_fts(self, kb_id: str) -> bool:
        """尝试建 FTS5 表；不支持时返回 False，检索降级为纯向量。"""
        if self._fts_available is False:
            return False
        try:
            with self.kb_conn(kb_id) as conn:
                conn.executescript(FTS_SCHEMA)
            self._fts_available = True
            return True
        except sqlite3.OperationalError:
            self._fts_available = False
            return False

    @property
    def fts_available(self) -> bool | None:
        return self._fts_available

    # ── 生命周期 ────────────────────────────────────────────────────────
    def create_kb_dir(self, kb_id: str) -> None:
        self._init_kb(kb_id)

    def drop_kb_dir(self, kb_id: str) -> None:
        """删库：整个目录（SQLite + blobs）一并清掉（spec 验收 #11）。"""
        import shutil

        target = self.kb_dir(kb_id)
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
