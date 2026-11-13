"""`evoflow.persistence.secret_store` 的等价实现。

EvoFlow 把 API Key 加密后存本地库。本仓的安全边界不同：凭据只经由环境变量
注入 sidecar（`ZCODE_KNOWLEDGE_MODEL_API_KEY`），**不落盘**，所以这里是一个
内存实现 —— 写入只在进程内有效，正好符合「凭据不持久化」的既定策略。
"""

from __future__ import annotations


class SecretStore:
    """内存凭据存储。进程退出即失效。"""

    def __init__(self) -> None:
        self._values: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self._values.get(key)

    def set(self, key: str, value: str) -> None:
        self._values[key] = value

    def delete(self, key: str) -> None:
        self._values.pop(key, None)


_default: SecretStore | None = None


def get_secret_store() -> SecretStore:
    global _default
    if _default is None:
        _default = SecretStore()
    return _default


__all__ = ["SecretStore", "get_secret_store"]
