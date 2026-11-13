"""`evoflow.models` 的等价实现（最小面）。"""

from __future__ import annotations

from typing import Any


def create_chat_model(*_args: Any, **_kwargs: Any) -> Any:
    """创建聊天模型。本仓的 LLM 由 agent 侧负责，sidecar 不直接调。"""
    raise NotImplementedError(
        "sidecar 不直接创建聊天模型：摘要/Wiki 等生成能力由上层 agent 调用"
    )


__all__ = ["create_chat_model"]
