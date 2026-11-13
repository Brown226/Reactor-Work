"""`evoflow.context.internal_model_invoke` 的等价实现。

EvoFlow 用它让知识库内部（摘要、Wiki 生成、图谱抽取）调用 LLM。
本仓 sidecar **不直接调 LLM** —— 那会让 sidecar 持有模型配置和对话状态，
而且断网/无模型时整个知识库都不可用。

所以这里抛 NotImplementedError：调用方（移植代码）都把它包在 try/except 里，
会自然降级为「跳过生成能力，检索照常」。这正好是我们要的语义。
"""

from __future__ import annotations

from typing import Any


async def ainvoke_internal_chat_model(*_args: Any, **_kwargs: Any) -> Any:
    raise NotImplementedError(
        "sidecar 不直接调用 LLM：摘要/Wiki/图谱生成由上层 agent 负责，"
        "无模型时自动降级为纯检索"
    )


__all__ = ["ainvoke_internal_chat_model"]
