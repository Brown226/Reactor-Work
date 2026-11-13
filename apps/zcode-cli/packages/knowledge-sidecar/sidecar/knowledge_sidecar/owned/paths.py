"""Paths for the owned knowledge base (local blob + sqlite)."""

from __future__ import annotations

import os
from pathlib import Path


def knowledge_root() -> Path:
    """知识库数据根目录。

    优先级：
    1. `ZCODE_KNOWLEDGE_DATA_ROOT`（本仓约定，sidecar 启动时由 --data-root 写回）
    2. `EVOFLOW_KNOWLEDGE_ROOT`（EvoFlow 原名，保留兼容）
    3. `get_paths().base_dir` —— **直接用它，不再拼 "knowledge"**

    [踩过的坑] 早期这里写的是 `get_paths().base_dir / "knowledge"`。
    而 sidecar 的 `--data-root` 由 Node 侧传成 `<用户数据根>/knowledge`，
    于是数据实际落到 `~/.reactor/knowledge/knowledge/` —— 多一层嵌套。
    症状是「重启后库列表为空」：新进程按新路径读，旧数据在旧路径下，
    看起来像数据丢了，其实只是路径算重了。
    """
    override = (os.getenv("ZCODE_KNOWLEDGE_DATA_ROOT") or "").strip()
    if override:
        root = Path(override).expanduser().resolve()
    else:
        evoflow_override = (os.getenv("EVOFLOW_KNOWLEDGE_ROOT") or "").strip()
        if evoflow_override:
            root = Path(evoflow_override).expanduser().resolve()
        else:
            evoflow_home = (os.getenv("EVOFLOW_HOME") or "").strip()
            if evoflow_home:
                root = Path(evoflow_home).expanduser().resolve() / "knowledge"
            else:
                from knowledge_sidecar.evoflow.config.paths import get_paths

                root = get_paths().base_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "files").mkdir(parents=True, exist_ok=True)
    (root / "kbs").mkdir(parents=True, exist_ok=True)
    return root


def owned_db_path() -> Path:
    return knowledge_root() / "owned.sqlite"


def files_dir() -> Path:
    return knowledge_root() / "files"
