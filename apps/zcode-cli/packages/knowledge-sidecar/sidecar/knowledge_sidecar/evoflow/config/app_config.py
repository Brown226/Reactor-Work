"""`evoflow.config.app_config` 的等价实现。

EvoFlow 用 config.yaml 承载「已配置的模型列表」和路径设置。本仓没有 YAML
配置体系，模型端点来自 `ZCODE_KNOWLEDGE_*` 环境变量（spec §4.4）。

这里构造**恰好够移植代码用的** AppConfig：
- `models`：把环境变量里的 embedding / rerank 模型包装成模型条目，
  这样 `embedding/registry.py` 的「按名字找 embedding 模型」逻辑能正常工作；
- `get_model_config(ident)`：按名字/id 查模型；
- `model_extra`：空的 paths 配置，让 `kb_root` 回落到 `paths.knowledge_root()`。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from .model_config import ModelConfig

# 模型条目直接复用 ModelConfig —— 移植代码（embedding/registry.py 等）会把
# `cfg.models` 里的元素当 ModelConfig 用，字段必须一致。
ModelEntry = ModelConfig


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


@dataclass
class AppConfig:
    """最小配置对象：只提供移植代码会读的字段。"""

    models: list[ModelConfig] = field(default_factory=list)
    model_extra: dict[str, Any] = field(default_factory=dict)

    def get_model_config(self, identifier: str) -> ModelConfig | None:
        """按 name / model / display_name 精确或大小写不敏感地查模型。"""
        ident = str(identifier or "").strip()
        if not ident:
            return None
        lowered = ident.lower()
        for entry in self.models:
            if ident in (entry.name, entry.model, entry.display_name):
                return entry
            if lowered in (entry.name.lower(), entry.model.lower(), entry.display_name.lower()):
                return entry
        return None


def _build_models() -> list[ModelConfig]:
    """从环境变量构造模型列表。

    只登记真正配置了的端点 —— 没配的不要塞一个假模型进去，
    否则 registry 会以为「有可用的 embedding 模型」而实际调不通。
    """
    base_url = _env("ZCODE_KNOWLEDGE_MODEL_BASE_URL")
    api_key = _env("ZCODE_KNOWLEDGE_MODEL_API_KEY")
    models: list[ModelConfig] = []

    embedding_model = _env("ZCODE_KNOWLEDGE_EMBEDDING_MODEL")
    if base_url and embedding_model:
        models.append(
            ModelConfig(
                name=embedding_model,
                model=embedding_model,
                use="openai-compatible",
                vendor="openai-compatible",
                base_url=base_url,
                api_key=api_key,
                display_name=embedding_model,
            )
        )

    rerank_model = _env("ZCODE_KNOWLEDGE_RERANK_MODEL")
    if base_url and rerank_model:
        models.append(
            ModelConfig(
                name=rerank_model,
                model=rerank_model,
                use="openai-compatible",
                vendor="openai-compatible",
                base_url=base_url,
                api_key=api_key,
                display_name=rerank_model,
            )
        )

    return models


_config: AppConfig | None = None


def get_app_config() -> AppConfig:
    """返回配置单例。环境变量在首次调用时读取。"""
    global _config
    if _config is None:
        _config = AppConfig(models=_build_models())
    return _config


def reset_app_config_for_tests() -> None:
    """测试用：清掉单例，下次调用重新读环境变量。"""
    global _config
    _config = None


__all__ = ["AppConfig", "ModelConfig", "ModelEntry", "get_app_config", "reset_app_config_for_tests"]
