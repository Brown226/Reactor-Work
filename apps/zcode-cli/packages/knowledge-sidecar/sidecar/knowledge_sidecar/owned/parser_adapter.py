"""解析适配：把本仓 `parser.parse_file` 包装成 EvoFlow parser 的签名。

## 为什么要这一层

两边的 `parse_file` 契约不同：

| | 本仓 `knowledge_sidecar.parser` | EvoFlow `knowledge.parser` |
| --- | --- | --- |
| 返回 | `ParseResult(ok, markdown, title, error)` | `str`（Markdown 正文） |
| 失败 | `ok=False` + `error` 文案 | 抛异常 |
| 依赖 | 纯标准库（zipfile + ElementTree） | markitdown → onnxruntime / pandas |

移植过来的 `owned/pipeline.py` 按 EvoFlow 契约写（`text = parse_file(path)`），
所以要有这一层做转换。**不直接把本仓 parser 改造成 EvoFlow 形状**，因为本仓
顶层 `handlers` 还依赖 `ParseResult` 的 `ok` / `error` 语义。

## 为什么用本仓 parser 而不是 EvoFlow 的

EvoFlow 的 parser 依赖 `markitdown`，而 markitdown 会把资产树推到 90MB+
并引入原生 ABI 矩阵（详见 `scripts/prepare-knowledge-assets.mjs` 的说明）。
本仓 parser 用标准库解 OOXML，零原生依赖，且实测能正确还原 docx 的
层级标题（`Heading1` → `#`）。
"""

from __future__ import annotations

import logging
from pathlib import Path

from knowledge_sidecar.parser import parse_file as _native_parse

logger = logging.getLogger("knowledge_sidecar.owned.parser_adapter")


class ParseError(RuntimeError):
    """解析失败。对应 EvoFlow parser 抛异常的行为。"""


def parse_file(path: Path, *, doc_id: str = "", kb_id: str = "") -> str:
    """解析文件并返回 Markdown 正文。失败时抛 `ParseError`。

    `doc_id` / `kb_id` 只用于日志上下文 —— EvoFlow 的 parser 用它们做图片
    资产落盘，本仓 P0 不抽图片（`assets` 表保留但不填充）。
    """
    result = _native_parse(Path(path))
    if not result.ok:
        context = f"（doc={doc_id} kb={kb_id}）" if doc_id or kb_id else ""
        raise ParseError(f"{result.error}{context}")
    text = result.markdown or ""
    if not text.strip():
        # 空正文按失败处理：EvoFlow 的 pipeline 也把空解析视为错误，
        # 否则会产生 0 个 chunk 的「成功」文档，检索时永远命不中。
        raise ParseError(f"解析结果为空{('（doc=' + doc_id + '）') if doc_id else ''}")
    return text


def supported_extensions() -> set[str]:
    """本仓 parser 支持的扩展名。"""
    from knowledge_sidecar.parser import supported_extensions as _native_supported

    return _native_supported()


__all__ = ["ParseError", "parse_file", "supported_extensions"]
