"""`evoflow.models.credential_sanitize` 的等价实现。

EvoFlow 在把 API Key 交给 provider 前会做「脱敏/补全」：从凭据库或上级配置
继承一个可用 key。本仓的凭据直接来自 `ZCODE_KNOWLEDGE_MODEL_API_KEY`，
既不落盘也没有多级继承，所以这里只做两件事：

1. 去掉首尾空白与误粘的 `Bearer ` 前缀；
2. 空值时返回 None（让调用方走「未配置」分支，而不是拿空串去请求）。
"""

from __future__ import annotations

from typing import Any


def sanitize_api_key(raw: Any) -> str | None:
    """清洗单个 key。"""
    text = str(raw or "").strip()
    if text.lower().startswith("bearer "):
        text = text[7:].strip()
    return text or None


def resolve_and_sanitize_api_key(*args: Any, **kwargs: Any) -> str | None:
    """解析并清洗 api_key。

    移植代码的调用形式是 `resolve_and_sanitize_api_key(model_config)` 或
    `(model_config, explicit_key)` —— 两种都支持：优先用显式传入的，
    否则从 ModelConfig.api_key 取。
    """
    explicit = None
    config = None
    for arg in args:
        if isinstance(arg, str) and explicit is None:
            explicit = arg
        elif hasattr(arg, "api_key"):
            config = arg
    for key in ("api_key", "explicit"):
        if kwargs.get(key) and explicit is None:
            explicit = str(kwargs[key])
    if kwargs.get("model_config") is not None:
        config = kwargs["model_config"]

    if explicit:
        return sanitize_api_key(explicit)
    if config is not None:
        return sanitize_api_key(getattr(config, "api_key", None))
    return None


__all__ = ["resolve_and_sanitize_api_key", "sanitize_api_key"]
