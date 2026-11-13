"""`evoflow.timeutil` 的等价实现。

EvoFlow 全库统一用 `utc_now_iso_z()` 产生带 Z 后缀的 UTC 时间戳。
本仓沿用同一格式，避免移植代码在字符串比较（`ORDER BY created_at`）时出错。
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso_z() -> str:
    """当前 UTC 时间，形如 ``2026-11-13T12:34:56.789012Z``。"""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def parse_iso_z(value: str) -> datetime:
    """解析带 Z 后缀或 +00:00 的 ISO 时间。"""
    text = (value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


__all__ = ["parse_iso_z", "utc_now_iso_z"]
