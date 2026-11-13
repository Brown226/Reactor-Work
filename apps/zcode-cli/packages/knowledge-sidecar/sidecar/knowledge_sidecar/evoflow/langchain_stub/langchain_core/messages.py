"""`langchain_core.messages` 的最小替身。

只提供 `HumanMessage` / `SystemMessage` 两个构造器。它们不会被真正发给模型
（本仓 sidecar 不做 LLM 索引），只在代码路径里被构造出来占位。
"""

from __future__ import annotations

from typing import Any


class _Message:
    def __init__(self, content: str = "", **kwargs: Any) -> None:
        self.content = content
        self.additional_kwargs = kwargs

    def __repr__(self) -> str:
        return f"{type(self).__name__}(content={self.content[:40]!r})"


class HumanMessage(_Message):
    """用户消息。"""


class SystemMessage(_Message):
    """系统消息。"""


__all__ = ["HumanMessage", "SystemMessage"]
