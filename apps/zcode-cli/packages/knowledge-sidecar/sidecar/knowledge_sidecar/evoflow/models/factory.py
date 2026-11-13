"""`evoflow.models.factory` 的等价实现。

只提供 `_default_resolved_model_name` —— 移植代码用它取默认模型名。
本仓没有「模型注册表」概念，返回空串表示「未配置」，调用方会走默认分支。
"""

from __future__ import annotations

from typing import Any


def _default_resolved_model_name(*_args: Any, **_kwargs: Any) -> str:
    return ""


__all__ = ["_default_resolved_model_name"]
