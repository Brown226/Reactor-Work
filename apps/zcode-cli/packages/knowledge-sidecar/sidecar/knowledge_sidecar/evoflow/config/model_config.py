"""`evoflow.config.model_config` 的等价实现。

EvoFlow 的 `ModelConfig` 是 Pydantic 模型，字段见
`harness/evoflow/config/model_config.py`。移植过来的代码只用到其中一部分，
但**字段名必须完全对齐** —— `ModelConfig(name=..., use=..., vendor=...)`
这类关键字调用写死在移植代码里，少一个字段就抛 TypeError，
表现为「embedding runtime check failed」。

这里用 dataclass 复刻同样字段名，不做校验（EvoFlow 那边有 Pydantic 校验，
本仓配置来自环境变量，已在构造时保证有效性）。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ModelConfig:
    """一个模型端点。字段名与 EvoFlow `config.model_config.ModelConfig` 对齐。"""

    # ── 必填（EvoFlow 侧无默认值）────────────────────────────────────
    name: str = ""
    model: str = ""
    use: str = ""

    # ── 可选 ────────────────────────────────────────────────────────
    vendor: str | None = None
    display_name: str | None = None
    description: str | None = None

    # 连接
    base_url: str | None = None
    api_key: str | None = None

    # 模型参数
    request_timeout: float | None = None
    max_retries: int | None = None
    max_tokens: int | None = None
    context_length: int | None = None
    input_context_length: int | None = None
    output_context_length: int | None = None

    # 知识库侧会用到的额外字段
    embedding_dim: int | None = None
    dimensions: int | None = None
    batch_size: int = 16
    extra: dict[str, object] = field(default_factory=dict)

    def model_copy(self, *, update: dict[str, object] | None = None) -> ModelConfig:
        """Pydantic 的 `model_copy` 同名方法（移植代码会调用）。"""
        from dataclasses import replace

        return replace(self, **(update or {}))


__all__ = ["ModelConfig"]
