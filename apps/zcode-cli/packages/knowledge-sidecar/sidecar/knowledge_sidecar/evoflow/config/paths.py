"""`evoflow.config.paths` 的等价实现：把根目录指向本仓的知识库 data-root。

EvoFlow 用 `get_paths().base_dir`，本仓用 `--data-root` 命令行参数。
这里用一个模块级变量承接 —— 由 `knowledge_sidecar.__main__` 在启动时写入，
之后的移植代码调用 `knowledge_root()` 就能拿到正确路径。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# 由 sidecar 启动时写入（见 __main__._run）
_base_dir: Path | None = None


def set_base_dir(path: Path) -> None:
    """设置根目录。移植代码的所有 `xxx_root()` 都基于它解析。"""
    global _base_dir
    _base_dir = Path(path).expanduser().resolve()
    _base_dir.mkdir(parents=True, exist_ok=True)


def resolve_base_dir() -> Path:
    """当前根目录。未设置时抛错而不是猜一个 —— 猜错会把数据写到意外位置。"""
    if _base_dir is None:
        raise RuntimeError(
            "evoflow 兼容层未初始化：需要先调用 evoflow.config.paths.set_base_dir(data_root)"
        )
    return _base_dir


@dataclass(frozen=True)
class Paths:
    base_dir: Path


def get_paths() -> Paths:
    return Paths(base_dir=resolve_base_dir())


__all__ = ["Paths", "get_paths", "resolve_base_dir", "set_base_dir"]
