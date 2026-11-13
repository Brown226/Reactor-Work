"""`evoflow.persistence.config_repositories` 的等价实现。

EvoFlow 用它读写 app 级设置（当前只有「新建库是否默认开启摘要」一项）。
本仓没有独立设置库，这类开关走环境变量或默认值，所以这里返回**默认值**
而不是抛错 —— 让移植代码原样跑，且行为可预期。
"""

from __future__ import annotations

from typing import Any


def get_app_setting(key: str, default: Any = None) -> Any:
    """读 app 设置。本仓无设置库，恒返回默认值。"""
    _ = key
    return default


def set_app_setting(key: str, value: Any) -> None:
    """写 app 设置。本仓无设置库，空实现。"""
    _ = (key, value)


__all__ = ["get_app_setting", "set_app_setting"]
