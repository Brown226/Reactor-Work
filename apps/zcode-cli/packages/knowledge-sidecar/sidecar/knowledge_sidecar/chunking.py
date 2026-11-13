"""递归分块器：保护表格 / 代码块 / 图片，按标题与句子边界切分。

## 为什么要有保护性区段

朴素按字符数切会在任意位置切断：
- 围栏代码块 → 半截代码无法理解；
- Markdown 表格 → 表头与数据分离，表结构丢失；
- 图片引用 `![alt](url)` → 引用语法被切坏。

所以先识别这些区间，切分点**跳开**它们（spec §7.1）。

## 踩过的坑（EvoFlow 注释里的真实事故）

曾有一个固定 5000 字符上限忽略用户配置，导致 3k 字符的 FAQ 包变成单个
vector，检索彻底失效。**配置的 `chunk_size` 是唯一权威**，不允许再出现
隐藏上限。

## 算法

1. 若正文长度 ≤ chunk_size → 整篇一个 chunk（不切）。
2. 否则按「标题 → 段落 → 句子」三级边界做贪心累积：
   - 优先在 Markdown 标题处断开（保持语义单元完整）；
   - 其次在空行（段落）处断开；
   - 最后才在句子标点处断开。
3. 相邻 chunk 保留 overlap，让跨块上下文可读。
4. 每个 chunk 记录 `heading_path`（当前标题路径），检索时随结果返回。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 默认参数（spec §7.3）。中文场景比英文小，避免语义稀释。
DEFAULT_CHUNK_SIZE = 1000
DEFAULT_CHUNK_OVERLAP = 150
MIN_CHUNK_SIZE = 100

# 保护性区段的正则（spec §7.1）
_FENCE_RE = re.compile(r"```[\s\S]*?```")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
# 表头 + 分隔行 + 连续数据行
_TABLE_RE = re.compile(
    r"(?:^|\n)(\|[^\n]+\|\n\|(?:\s*:?-+:?\s*\|)+\s*\n(?:\|[^\n]+\|\n?)*)",
)

# 标题行
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")

# 句子边界：中文句号/问号/感叹号/分号，英文句点后跟空格
_SENTENCE_RE = re.compile(r"(?<=[。！？；.!?])\s*")


@dataclass
class Chunk:
    content: str
    ordinal: int
    heading_path: str = ""
    context_header: str = ""
    chunk_kind: str = "text"
    token_estimate: int = 0


def estimate_tokens(text: str) -> int:
    """粗估 token 数：中文按 1.5 字符/token，英文按 4 字符/token 折中取 2.5。

    只用于 UI 展示与注入预算，不参与切分决策（切分按字符数）。
    """
    if not text.strip():
        return 0
    return max(1, int(len(text) / 2.5))


def find_protected_spans(text: str) -> list[tuple[int, int]]:
    """返回不可切断的区间列表（已合并重叠）。"""
    spans: list[tuple[int, int]] = []
    for pattern in (_FENCE_RE, _IMAGE_RE, _TABLE_RE):
        for match in pattern.finditer(text):
            spans.append((match.start(), match.end()))
    if not spans:
        return []
    spans.sort()
    merged = [spans[0]]
    for start, end in spans[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def _inside_protected(position: int, spans: list[tuple[int, int]]) -> bool:
    for start, end in spans:
        if start < position < end:
            return True
    return False


def _nearest_safe_position(
    text: str, position: int, spans: list[tuple[int, int]], search_back: int = 200
) -> int:
    """把切分点从保护性区段内部挪到其外部（向前找最近的边界）。"""
    if not _inside_protected(position, spans):
        return position
    for start, _end in spans:
        if start < position:
            candidate = start
        else:
            # 落在该区段里：退到区段起点之前
            candidate = max(0, start)
            if candidate > position:
                candidate = start
            break
    else:
        return position
    # 再往前找最近的段落/句末，避免切在单词中间
    floor = max(0, candidate - search_back)
    window = text[floor:candidate]
    for pattern in (r"\n\n", r"[。！？；.!?]\s", r"\n"):
        matches = list(re.finditer(pattern, window))
        if matches:
            return floor + matches[-1].end()
    return candidate


def _heading_stack(text: str) -> list[tuple[int, int, int, str]]:
    """扫描全文的标题，返回 (起始偏移, 级别, 结束偏移占位, 标题文本)。

    用行扫描而不是正则全文匹配，避免代码块里的 `#` 被误判标题。
    """
    spans = find_protected_spans(text)
    result: list[tuple[int, int, int, str]] = []
    offset = 0
    for line in text.split("\n"):
        line_end = offset + len(line)
        match = _HEADING_RE.match(line)
        if match and not _inside_protected(offset, spans):
            result.append((offset, len(match.group(1)), line_end, match.group(2).strip()))
        offset = line_end + 1
    return result


def _heading_path_at(
    headings: list[tuple[int, int, int, str]], position: int
) -> tuple[str, str]:
    """返回 position 处生效的 heading_path（如「第2章 > 2.1 概述」）与最近的标题。"""
    stack: list[tuple[int, str]] = []
    for start, level, _end, title in headings:
        if start > position:
            break
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
    if not stack:
        return "", ""
    path = " > ".join(title for _level, title in stack)
    return path, stack[-1][1]


def _split_text_by_budget(text: str, limit: int, spans: list[tuple[int, int]]) -> list[str]:
    """把一段文本按 limit 字符切成若干片，避开保护性区段。"""
    if len(text) <= limit:
        return [text]
    pieces: list[str] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(start + limit, length)
        if end >= length:
            pieces.append(text[start:])
            break
        # 优先在段落边界断开
        window_start = max(start + limit // 2, start)
        segment = text[window_start:end]
        cut = -1
        for pattern in (r"\n\n", r"[。！？；.!?]\s", r"\n", r"\s"):
            matches = list(re.finditer(pattern, segment))
            if matches:
                cut = window_start + matches[-1].end()
                break
        if cut <= start:
            cut = end
        cut = _nearest_safe_position(text, cut, spans)
        if cut <= start:
            cut = end
        pieces.append(text[start:cut])
        start = cut
    return pieces


def chunk_markdown(
    text: str,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[Chunk]:
    """把 Markdown 正文切成 chunk 列表。

    chunk_size / chunk_overlap 会被校验并夹到合理范围；配置是唯一权威，
    没有隐藏上限（见模块头的历史事故）。
    """
    body = (text or "").strip()
    if not body:
        return []

    size = max(MIN_CHUNK_SIZE, int(chunk_size or DEFAULT_CHUNK_SIZE))
    overlap = max(0, min(int(chunk_overlap or 0), size // 2))

    # 1) 短文档整篇一个 chunk
    if len(body) <= size:
        heading_path, _ = _heading_path_at(_heading_stack(body), 0)
        return [
            Chunk(
                content=body,
                ordinal=0,
                heading_path=heading_path,
                context_header=heading_path,
                chunk_kind=_dominant_kind(body),
                token_estimate=estimate_tokens(body),
            )
        ]

    spans = find_protected_spans(body)
    headings = _heading_stack(body)
    pieces = _split_text_by_budget(body, size, spans)

    chunks: list[Chunk] = []
    cursor = 0
    for index, piece in enumerate(pieces):
        # 定位该片段在原文的起点（用于取 heading_path）
        position = body.find(piece[:40], cursor) if piece[:40] else cursor
        if position < 0:
            position = cursor
        cursor = position + len(piece)

        heading_path, nearest = _heading_path_at(headings, position)

        # 加 overlap：从上一片段尾部取，避免跨块上下文断裂
        content = piece
        if index > 0 and overlap > 0:
            previous_tail = pieces[index - 1][-overlap:]
            if previous_tail and not content.startswith(previous_tail):
                content = previous_tail + content

        chunks.append(
            Chunk(
                content=content.strip(),
                ordinal=index,
                heading_path=heading_path,
                context_header=nearest or heading_path,
                chunk_kind=_dominant_kind(piece),
                token_estimate=estimate_tokens(content),
            )
        )

    # 过短的块并入前一块（MIN_CHUNK_SIZE 阈值）
    merged: list[Chunk] = []
    for chunk in chunks:
        if merged and len(chunk.content) < MIN_CHUNK_SIZE:
            previous = merged[-1]
            merged[-1] = Chunk(
                content=f"{previous.content}\n\n{chunk.content}".strip(),
                ordinal=previous.ordinal,
                heading_path=previous.heading_path,
                context_header=previous.context_header,
                chunk_kind=previous.chunk_kind,
                token_estimate=estimate_tokens(previous.content) + chunk.token_estimate,
            )
        else:
            merged.append(chunk)

    # 重编号，保证 ordinal 连续
    for index, chunk in enumerate(merged):
        chunk.ordinal = index
    return merged


def _dominant_kind(text: str) -> str:
    """判断片段主类型，供检索时按类型加权（表格/代码命中权重更高）。"""
    if _FENCE_RE.search(text):
        return "code"
    if _TABLE_RE.search(text):
        return "table"
    if _IMAGE_RE.search(text):
        return "image_caption"
    return "text"
