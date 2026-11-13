"""`evoflow.memory.consolidate` 的等价实现。

EvoFlow 的 job worker 除了知识库作业，还顺手处理「记忆整合」作业。
本仓知识库 sidecar 不管记忆，所以这是空操作 —— 让 worker 的 job 分发
不会因为遇到未知 kind 而失败。
"""

from __future__ import annotations

from typing import Any


async def run_consolidate_job(*_args: Any, **_kwargs: Any) -> None:
    return None


__all__ = ["run_consolidate_job"]
