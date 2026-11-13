"""模型服务环境变量映射。

## 问题

EvoFlow 的移植代码里散落着对 `EVOFLOW_OWNED_EMBEDDING_API_KEY` /
`OPENAI_API_KEY` 等环境变量的直接读取（约 10 处）。本仓的统一约定是
`ZCODE_KNOWLEDGE_*` 前缀（见 `apps/zcode-cli/AGENTS.md`「项目自有的环境变量
统一使用 ZCODE_ 前缀」）。

两个选择：

1. 改移植代码，把所有 `os.environ.get("EVOFLOW_...")` 换成 `ZCODE_...`；
2. **启动时把 `ZCODE_KNOWLEDGE_*` 映射成 EvoFlow 期望的变量名**。

选 2 的理由：改了移植代码，将来再同步 EvoFlow 就会冲突；一次性的启动期
映射既不动上游代码，又能让两家约定各自成立。

## 映射表

| 本仓（权威） | EvoFlow 期望 |
| --- | --- |
| `ZCODE_KNOWLEDGE_MODEL_API_KEY` | `EVOFLOW_OWNED_EMBEDDING_API_KEY`、`OPENAI_API_KEY` |
| `ZCODE_KNOWLEDGE_MODEL_BASE_URL` | `EVOFLOW_OWNED_EMBEDDING_BASE_URL`、`OPENAI_BASE_URL` |
| `ZCODE_KNOWLEDGE_EMBEDDING_MODEL` | `EVOFLOW_OWNED_EMBEDDING_MODEL` |

只在目标变量**未设置**时才写入，不覆盖用户显式配置的 EvoFlow 变量。
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("knowledge_sidecar.env_bridge")

# (源变量, 目标变量列表)
_MAPPINGS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "ZCODE_KNOWLEDGE_MODEL_API_KEY",
        ("EVOFLOW_OWNED_EMBEDDING_API_KEY", "OPENAI_API_KEY"),
    ),
    (
        "ZCODE_KNOWLEDGE_MODEL_BASE_URL",
        ("EVOFLOW_OWNED_EMBEDDING_BASE_URL", "OPENAI_BASE_URL"),
    ),
    (
        "ZCODE_KNOWLEDGE_EMBEDDING_MODEL",
        ("EVOFLOW_OWNED_EMBEDDING_MODEL",),
    ),
)


def apply_env_bridge() -> None:
    """把本仓环境变量映射成移植代码期望的名字。幂等。"""
    applied: list[str] = []
    for source, targets in _MAPPINGS:
        value = (os.environ.get(source) or "").strip()
        if not value:
            continue
        for target in targets:
            if (os.environ.get(target) or "").strip():
                continue  # 用户显式配过，尊重它
            os.environ[target] = value
            applied.append(target)
    if applied:
        # 只记变量名，绝不记值 —— 日志会进诊断包
        logger.info("环境变量映射完成：%s", ", ".join(applied))


__all__ = ["apply_env_bridge"]
