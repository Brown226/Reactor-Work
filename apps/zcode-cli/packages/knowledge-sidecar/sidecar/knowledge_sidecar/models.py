"""embedding / rerank HTTP 客户端。

设计要点（spec §6.2 / 用户要求「接口形式兼容 OpenAI 格式」）：

1. **embedding 走标准 OpenAI `/v1/embeddings`** —— SiliconFlow、vLLM、
   OpenAI、Ollama、LM Studio 都是这个形状，零适配即可切换。
2. **rerank 无 OpenAI 标准** —— 各家格式不同，这里做成可插拔：
   · `siliconflow`  —— ``{"results":[{"index":0,"relevance_score":0.04}]}``
   · `tei`          —— ``[{"index":0,"score":0.04}]``（HuggingFace Text Embeddings Inference）
   · `jina`         —— ``{"results":[{"index":0,"relevance_score":0.04}]}``（同 siliconflow 形状）
   · `openai`       —— 少数网关（如 vLLM）暴露 ``/v1/rerank`` 时用 chat.completions 形状，
                       本实现不假设，交由 ``custom_extractor`` 覆盖。
   默认按响应字段自动探测：看到 ``results`` 数组且含 ``index`` 就用它，
   看到顶层数组就用数组形式。探测不到才报错。

3. **失败即降级**：任何网络/协议错误都抛 ``ModelServiceError``，
   调用方（检索链路）退回 RRF 顺序，不阻塞检索（spec §6.3）。

4. **不引入 numpy**：sidecar 的资产树刻意不含 numpy / onnxruntime
   （见 scripts/prepare-knowledge-assets.mjs 的决策注释），所以这里用纯 Python
   的 ``struct`` 打包 float32、纯 Python 余弦相似度。
"""

from __future__ import annotations

import json
import logging
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("knowledge_sidecar.models")

DEFAULT_TIMEOUT = 60.0
DEFAULT_BATCH_SIZE = 32


class ModelServiceError(Exception):
    """embedding / rerank 服务不可用或协议不符。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ModelServiceConfig:
    """指向一个 OpenAI 兼容的服务端点。"""

    base_url: str
    api_key: str = ""
    embedding_model: str = ""
    rerank_model: str = ""
    timeout: float = DEFAULT_TIMEOUT
    batch_size: int = DEFAULT_BATCH_SIZE
    # 显式指定 rerank 响应格式；缺省自动探测。
    rerank_format: str = "auto"


def pack_vector(values: list[float]) -> bytes:
    """float32 小端打包 —— 与 schema 里 BLOB 的存储约定一致。"""
    return struct.pack(f"{len(values)}f", *values)


def unpack_vector(blob: bytes) -> list[float]:
    return list(struct.unpack(f"{len(blob) // 4}f", blob))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """纯 Python 余弦 —— 不依赖 numpy。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    return dot / ((norm_a ** 0.5) * (norm_b ** 0.5))


def _normalize_base_url(base_url: str) -> str:
    normalized = (base_url or "").strip().rstrip("/")
    if not normalized:
        raise ModelServiceError("INVALID_BASE_URL", "base_url 不能为空")
    return normalized


def _embeddings_url(base_url: str) -> str:
    """构造 embeddings 端点。

    ``https://api.openai.com``      → ``…/v1/embeddings``
    ``https://api.openai.com/v1``   → ``…/v1/embeddings``
    ``https://api.siliconflow.cn``  → ``…/v1/embeddings``

    不产生 ``/v1/v1/embeddings`` 这类双版本路径。
    """
    base = _normalize_base_url(base_url)
    if base.endswith("/v1"):
        return f"{base}/embeddings"
    return f"{base}/v1/embeddings"


def _rerank_url(base_url: str) -> str:
    """rerank 端点：优先 ``/v1/rerank``，base 已含 /v1 时只补 /rerank。"""
    base = _normalize_base_url(base_url)
    if base.endswith("/v1"):
        return f"{base}/rerank"
    return f"{base}/v1/rerank"


class ModelServiceClient:
    """OpenAI 兼容的 embedding + 多格式 rerank 客户端。"""

    def __init__(self, config: ModelServiceConfig) -> None:
        self._config = config

    # ── embedding（OpenAI 标准）─────────────────────────────────────────
    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._config.embedding_model
        if not model:
            raise ModelServiceError("NO_EMBEDDING_MODEL", "未配置 embedding 模型")
        vectors: list[list[float]] = []
        batch_size = max(1, self._config.batch_size)
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            vectors.extend(self._embed_batch(batch, model))
        return vectors

    def _embed_batch(self, texts: list[str], model: str) -> list[list[float]]:
        payload: dict[str, Any] = {"model": model, "input": texts}
        body = self._post(_embeddings_url(self._config.base_url), payload, self._config.timeout)
        data = body.get("data")
        if not isinstance(data, list) or not data:
            raise ModelServiceError(
                "BAD_EMBEDDINGS_RESPONSE",
                f"embeddings 响应缺少 data 数组：{str(body)[:200]}",
            )
        # OpenAI 约定按 index 排序；缺 index 时按原顺序（ SiliconFlow 两者都满足）。
        ordered = sorted(
            (item for item in data if isinstance(item, dict)),
            key=lambda item: item.get("index", 0),
        )
        vectors: list[list[float]] = []
        for item in ordered:
            embedding = item.get("embedding")
            if not isinstance(embedding, list) or not embedding:
                raise ModelServiceError(
                    "BAD_EMBEDDINGS_RESPONSE", "embeddings 响应里缺少 embedding 向量"
                )
            vectors.append([float(value) for value in embedding])
        if len(vectors) != len(texts):
            raise ModelServiceError(
                "EMBEDDINGS_COUNT_MISMATCH",
                f"请求 {len(texts)} 条、返回 {len(vectors)} 条",
            )
        return vectors

    # ── rerank（多格式探测）────────────────────────────────────────────
    def rerank(
        self,
        query: str,
        documents: list[str],
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        """返回 ``[(原索引, 分数)]``，按分数降序。"""
        if not query or not documents:
            return []
        model = self._config.rerank_model
        if not model:
            raise ModelServiceError("NO_RERANK_MODEL", "未配置 rerank 模型")
        payload = {
            "model": model,
            "query": query,
            "documents": documents,
        }
        if top_n is not None:
            payload["top_n"] = int(top_n)
        body = self._post(_rerank_url(self._config.base_url), payload, self._config.timeout)
        return self._parse_rerank_response(body, len(documents))

    def _parse_rerank_response(
        self, body: Any, expected: int
    ) -> list[tuple[int, float]]:
        """按配置或自动探测解析各家 rerank 响应。"""
        results = self._extract_results(body)
        parsed: list[tuple[int, float]] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            index = item.get("index")
            if not isinstance(index, int):
                continue
            score = item.get("relevance_score", item.get("score"))
            if not isinstance(score, (int, float)):
                continue
            if 0 <= index < expected:
                parsed.append((index, float(score)))
        if not parsed:
            raise ModelServiceError(
                "BAD_RERANK_RESPONSE",
                f"无法从响应解析出 rerank 结果：{str(body)[:200]}",
            )
        return sorted(parsed, key=lambda pair: pair[1], reverse=True)

    def _extract_results(self, body: Any) -> list[Any]:
        if not isinstance(body, dict):
            # TEI 顶层就是数组：[{"index":0,"score":0.04}, ...]
            if isinstance(body, list):
                return body
            raise ModelServiceError("BAD_RERANK_RESPONSE", "rerank 响应既不是对象也不是数组")

        fmt = (self._config.rerank_format or "auto").lower()
        if fmt == "auto":
            # 自动探测：优先 results 数组（SiliconFlow / Jina），退回顶层数组（TEI）。
            results = body.get("results")
            if isinstance(results, list):
                return results
            raise ModelServiceError(
                "BAD_RERANK_RESPONSE",
                "响应里没有 results 数组，也无法识别为 TEI 数组格式",
            )

        if fmt in ("siliconflow", "jina", "results"):
            results = body.get("results")
            if isinstance(results, list):
                return results
        elif fmt in ("tei", "array"):
            if isinstance(body.get("results"), list):
                return body["results"]
        raise ModelServiceError(
            "BAD_RERANK_RESPONSE",
            f"rerank_format={fmt} 与响应形状不匹配：{str(body)[:200]}",
        )

    # ── 传输 ────────────────────────────────────────────────────────────
    def _post(self, url: str, payload: dict[str, Any], timeout: float) -> Any:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self._config.api_key:
            headers["Authorization"] = f"Bearer {self._config.api_key}"
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")[:300]
            except Exception:
                pass
            raise ModelServiceError(
                f"HTTP_{exc.code}", f"{url} 返回 HTTP {exc.code}：{detail}"
            ) from exc
        except urllib.error.URLError as exc:
            raise ModelServiceError(
                "NETWORK_UNREACHABLE", f"{url} 不可达：{exc.reason}"
            ) from exc
        except TimeoutError as exc:
            raise ModelServiceError("TIMEOUT", f"{url} 超时（{timeout}s）") from exc
        except json.JSONDecodeError as exc:
            raise ModelServiceError("BAD_JSON", f"{url} 响应不是合法 JSON：{exc}") from exc


# ── 配置来源 ────────────────────────────────────────────────────────────────

def config_from_env(env: dict[str, str] | None = None) -> ModelServiceConfig | None:
    """从环境变量构造配置；缺关键字段返回 None（检索降级为纯关键词）。

    环境变量契约（spec §4.4）：
      ZCODE_KNOWLEDGE_MODEL_BASE_URL   必填，OpenAI 兼容服务根地址
      ZCODE_KNOWLEDGE_MODEL_API_KEY    可选（本地服务常为空）
      ZCODE_KNOWLEDGE_EMBEDDING_MODEL  必填
      ZCODE_KNOWLEDGE_RERANK_MODEL     可选；缺省则不做模型重排
      ZCODE_KNOWLEDGE_RERANK_FORMAT    可选：auto | siliconflow | tei | jina
    """
    import os

    environ = env if env is not None else os.environ

    def pick(name: str) -> str:
        return (environ.get(name) or "").strip()

    base_url = pick("ZCODE_KNOWLEDGE_MODEL_BASE_URL")
    embedding_model = pick("ZCODE_KNOWLEDGE_EMBEDDING_MODEL")
    if not base_url or not embedding_model:
        return None

    timeout = DEFAULT_TIMEOUT
    raw_timeout = pick("ZCODE_KNOWLEDGE_MODEL_TIMEOUT")
    if raw_timeout:
        try:
            timeout = max(1.0, float(raw_timeout))
        except ValueError:
            logger.warning("忽略非法 ZCODE_KNOWLEDGE_MODEL_TIMEOUT=%s", raw_timeout)

    return ModelServiceConfig(
        base_url=base_url,
        api_key=pick("ZCODE_KNOWLEDGE_MODEL_API_KEY"),
        embedding_model=embedding_model,
        rerank_model=pick("ZCODE_KNOWLEDGE_RERANK_MODEL"),
        rerank_format=pick("ZCODE_KNOWLEDGE_RERANK_FORMAT") or "auto",
        timeout=timeout,
    )


def client_from_env(env: dict[str, str] | None = None) -> ModelServiceClient | None:
    config = config_from_env(env)
    return ModelServiceClient(config) if config else None


__all__ = [
    "ModelServiceClient",
    "ModelServiceConfig",
    "ModelServiceError",
    "cosine_similarity",
    "pack_vector",
    "unpack_vector",
    "client_from_env",
    "config_from_env",
]
