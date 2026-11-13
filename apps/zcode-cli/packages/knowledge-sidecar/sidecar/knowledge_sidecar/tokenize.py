"""中文分词：写入与查询必须用同一套切词，否则 FTS5 永远命中不了。

## 为什么单独抽出来

早期版本写入时用 jieba 切成「材料 复验 不合格」，查询时却拿整串
「材料复验不合格怎么处理」去做 FTS5 短语匹配 —— 短语匹配要求 token 严格相邻，
而原文里「材料」后面是「必须」不是「复验」，于是**一条都命中不了**。
这个 bug 在只有向量检索时看不出来（向量照样能召回），一旦关掉向量就完全失效。

把切词抽成独立模块，让 `pipeline`（写入）和 `search`（查询）共用同一份逻辑，
是避免这类「两侧不一致」的结构性做法。

## jieba 缺失时怎么办

返回原串。此时中文 FTS 退化为整段匹配（基本只有整句原样出现才命中），
但英文 / 数字 / 代码仍能正常检索，且不阻断索引 —— 「能用」优于「全部失败」。
"""

from __future__ import annotations

import logging

logger = logging.getLogger("knowledge_sidecar.tokenize")

_jieba_ready: bool | None = None


def jieba_available() -> bool:
    """jieba 是否可用（首次调用会尝试导入并缓存结果）。"""
    global _jieba_ready
    if _jieba_ready is None:
        try:
            import jieba  # noqa: F401,PLC0415

            _jieba_ready = True
        except ImportError:
            _jieba_ready = False
            logger.warning("jieba 不可用，中文 FTS 检索质量会下降（关键词召回基本失效）")
    return _jieba_ready


def tokenize(text: str) -> str:
    """把文本切成空格连接的词串，供 FTS5 的 unicode61 tokenizer 索引。

    标点会被 jieba 保留为独立 token，FTS5 的 unicode61 会自动丢弃它们，
    所以这里不需要额外过滤。
    """
    if not text:
        return ""
    if not jieba_available():
        return text
    import jieba  # noqa: PLC0415

    return " ".join(jieba.cut(text))


def query_tokens(query: str) -> list[str]:
    """把查询切成 token 列表，供拼 FTS5 的 OR 表达式。

    与 `tokenize` 的差别：这里丢掉标点和空白 token —— 查询里的「，」「？」这类
    符号拼进 MATCH 会让 FTS5 语法报错。
    """
    raw = tokenize((query or "").strip())
    if not raw:
        return []
    tokens: list[str] = []
    for token in raw.split():
        cleaned = "".join(ch for ch in token if ch.isalnum() or ch == "_")
        if cleaned:
            tokens.append(cleaned)
    return tokens


__all__ = ["jieba_available", "query_tokens", "tokenize"]
