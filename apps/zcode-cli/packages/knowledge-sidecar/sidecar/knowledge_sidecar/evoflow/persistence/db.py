"""`evoflow.persistence.db` 的等价实现。

EvoFlow 的 `get_db()` 返回它自己的中心库（`evoflow.db`），存 kb_bases 等元数据。
本仓的等价物是 `owned.sqlite`（见 `knowledge_sidecar.owned.db`）—— 两者职责相同，
所以这里直接转接到它，不另建一套。
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

_lock = threading.RLock()


@contextmanager
def get_db() -> Iterator[Any]:
    """中心库连接。转接到本仓的 owned.sqlite。"""
    from knowledge_sidecar.owned.db import db as _owned_db

    with _lock, _owned_db() as conn:
        yield conn


@contextmanager
def db_connection_lock() -> Iterator[None]:
    """跨模块串行化写事务的锁。本仓用同一个 RLock。"""
    with _lock:
        yield


__all__ = ["db_connection_lock", "get_db"]
