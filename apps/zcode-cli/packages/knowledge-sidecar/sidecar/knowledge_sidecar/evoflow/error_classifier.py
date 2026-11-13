"""`evoflow.error_classifier` 的等价实现（最小面）。

移植过来的 `pipeline` 用它区分「配额用完 / 限流 / 鉴权失败」这几类软故障，
以便给 embedding 调用加冷却期。本仓只需要同样的**分类结论**，
不需要 EvoFlow 那套完整 failover 体系。
"""

from __future__ import annotations

from enum import Enum


class FailoverReason(str, Enum):
    BILLING = "billing"
    RATE_LIMIT = "rate_limit"
    AUTH = "auth"
    UNKNOWN = "unknown"


class _Classification:
    def __init__(self, reason: FailoverReason) -> None:
        self.reason = reason


def classify(exc: BaseException) -> _Classification:
    """按错误文本粗分类。移植代码用它决定冷却时长。"""
    message = str(exc).lower()
    if any(k in message for k in ("insufficient_quota", "usage quota", "额度", "balance")):
        return _Classification(FailoverReason.BILLING)
    if any(k in message for k in ("429", "rate limit", "too many requests")):
        return _Classification(FailoverReason.RATE_LIMIT)
    if any(k in message for k in ("401", "403", "unauthorized", "invalid api key", "token is invalid")):
        return _Classification(FailoverReason.AUTH)
    return _Classification(FailoverReason.UNKNOWN)


__all__ = ["FailoverReason", "classify"]
