"""分块：保护性区段 + 递归切分 + 标题策略。

> **来源**：本文件移植自 EvoFlow `backend/packages/harness/evoflow/knowledge/owned/chunking.py`
> （公司自有项目，已获书面授权）。移植时只改了两处：
> ① 数据结构从 `ChunkPiece` 改成本仓既有的 `Chunk`（字段同名，多一个 `ordinal`）；
> ② 对外函数名 `split_text` → `chunk_markdown`，保持本仓调用点不变。
> **算法逻辑一行未改** —— 早期自己实现时省掉了 `_overlap_tail` 的边界回溯，
> 导致 chunk 从句子中间截断（实测第 2 块以「，」开头），这是重写带来的质量损失。

## 三档策略

- `recursive`：按分隔符递归切，保护性区段（代码块 / 表格 / 图片）不切；
- `heading`：先按 Markdown 标题切，超长章节再递归切；
- `auto`：标题 ≥ 2 且正文够长时用 heading，否则 recursive。

## 保护性区段

围栏代码块、表格、图片视为原子单位 —— 检索时半张表格没有意义，且会让
「表格里有什么」这类查询彻底失效。切分只在区段外进行。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# 与 spec §7.3 默认值一致。EvoFlow 默认 2048/256；本仓历史上用 600/120，
# 这里保留本仓默认值（小模型上下文更短，块太大会挤掉其他召回）。
DEFAULT_CHUNK_SIZE = 600
DEFAULT_CHUNK_OVERLAP = 120
MIN_CHUNK_SIZE = 32

_HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_TABLE_RE = re.compile(
    r"(?:^|\n)(\|[^\n]+\|\n\|(?:\s*:?-+:?\s*\|)+\s*\n(?:\|[^\n]+\|\n?)*)",
    re.MULTILINE,
)


@dataclass
class Chunk:
    content: str
    ordinal: int = 0
    context_header: str = ""
    heading_path: str = ""
    chunk_kind: str = "text"
    token_estimate: int = 0


def estimate_tokens(text: str) -> int:
    """粗估 token 数：按 4 字符 = 1 token。只用于 UI 展示和预算判断。"""
    return max(1, len(text) // 4) if text.strip() else 0


# ── 保护性区段 ────────────────────────────────────────────────────────────


def find_protected_spans(text: str) -> list[tuple[int, int]]:
    """找出不可切断的区段（代码块 / 表格 / 图片），返回合并后的区间。"""
    spans: list[tuple[int, int]] = []
    for rx in (_FENCE_RE, _IMAGE_RE, _TABLE_RE):
        for m in rx.finditer(text):
            spans.append((m.start(), m.end()))
    spans.sort()
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def _is_inside(spans: list[tuple[int, int]], pos: int) -> bool:
    for s, e in spans:
        if s < pos < e:
            return True
        if pos < s:
            return False
    return False


# ── 切分原语 ──────────────────────────────────────────────────────────────


def _split_separators(text: str, separators: list[str]) -> list[str]:
    if not separators:
        return [text] if text else []
    sep = separators[0]
    rest = separators[1:]
    # Python str.split("") raises; treat empty sep as character-level split.
    if sep == "":
        return list(text) if text else []
    if sep not in text:
        return _split_separators(text, rest) if rest else ([text] if text else [])
    parts = text.split(sep)
    out: list[str] = []
    for i, part in enumerate(parts):
        piece = part if i == len(parts) - 1 else part + sep
        if not piece:
            continue
        if rest and len(piece) > 0:
            out.extend(_split_separators(piece, rest))
        else:
            out.append(piece)
    return out


def _kind_for(text: str) -> str:
    has_table = "|" in text and re.search(r"\|(?:\s*:?-+:?\s*\|)", text) is not None
    has_code = "```" in text
    has_img = "![" in text
    if has_code:
        return "code"
    if has_table and has_img:
        return "mixed"
    if has_table:
        return "table"
    if has_img:
        return "mixed"
    return "text"


def _overlap_tail(text: str, overlap: int) -> str:
    """取尾部重叠窗口，尽量从可读边界开始。

    优先在重叠窗口内回溯到段落 / 句子开头，让下一块不从半句话中间开始
    （这是「上下文片段丢失」的常见成因）。候选片段太短（< max(48, overlap//5)）
    就认为没有意义，继续尝试更宽松的边界。
    """
    text = text or ""
    overlap = int(overlap or 0)
    if overlap <= 0 or not text:
        return ""
    if len(text) <= overlap:
        return text

    window = text[-overlap:]
    # Prefer the latest clean boundary so we keep as much overlap as possible.
    best = ""
    for sep in ("\n\n", "\n", "。", "！", "？", "；", ". ", "! ", "? ", "; "):
        idx = window.rfind(sep)
        if idx < 0:
            continue
        candidate = window[idx + len(sep) :]
        # Keep enough context; tiny tails are useless for retrieval continuity.
        if len(candidate) >= max(48, overlap // 5):
            best = candidate
            break
    if best:
        return best.lstrip()
    return window.lstrip()


def _make_chunk(
    content: str,
    *,
    ordinal: int = 0,
    context_header: str = "",
    heading_path: str = "",
) -> Chunk:
    body = (content or "").strip()
    return Chunk(
        content=body,
        ordinal=ordinal,
        context_header=context_header,
        heading_path=heading_path,
        chunk_kind=_kind_for(body),
        token_estimate=estimate_tokens(body),
    )


def _split_recursive(
    text: str,
    *,
    chunk_size: int = 2048,
    chunk_overlap: int = 256,
    context_header: str = "",
    heading_path: str = "",
) -> list[Chunk]:
    """Split by character budget with protected spans (spec §7.2)."""
    text = (text or "").strip()
    if not text:
        return []

    chunk_size = max(64, int(chunk_size))
    chunk_overlap = max(0, min(int(chunk_overlap), chunk_size // 2))
    # Whole section already fits — do not nick it into scraps.
    if len(text) <= chunk_size:
        return [
            _make_chunk(
                text, context_header=context_header, heading_path=heading_path
            )
        ]

    protected = find_protected_spans(text)

    # Extract protected blocks as atomic units interleaved with free text.
    units: list[str] = []
    cursor = 0
    for s, e in protected:
        if cursor < s:
            units.append(text[cursor:s])
        units.append(text[s:e])
        cursor = e
    if cursor < len(text):
        units.append(text[cursor:])

    # Further split free-text units; keep protected units whole.
    seps = ["\n\n", "\n", "。", "；", " ", ""]
    atoms: list[str] = []
    for unit in units:
        if not unit:
            continue
        # Protected if unit matches a protected span content approximately
        is_prot = False
        for s, e in protected:
            if text[s:e] == unit:
                is_prot = True
                break
        if is_prot or len(unit) <= chunk_size:
            atoms.append(unit)
        else:
            atoms.extend(_split_separators(unit, seps))

    chunks: list[Chunk] = []
    buf = ""
    for atom in atoms:
        if not atom:
            continue
        if len(atom) > chunk_size * 2:
            # Hard split oversized atom (e.g. huge table) by lines.
            if buf.strip():
                chunks.append(
                    _make_chunk(
                        buf,
                        context_header=context_header,
                        heading_path=heading_path,
                    )
                )
                carry = _overlap_tail(buf, chunk_overlap)
                buf = ""
            else:
                carry = ""
            lines = atom.splitlines(keepends=True)
            cur = carry
            header = ""
            if lines and lines[0].strip().startswith("|") and len(lines) > 1:
                header = lines[0] + (
                    lines[1] if re.search(r":?-+:?", lines[1] or "") else ""
                )
            for line in lines:
                if cur and len(cur) + len(line) > chunk_size:
                    chunks.append(
                        _make_chunk(
                            cur,
                            context_header=context_header,
                            heading_path=heading_path,
                        )
                    )
                    tail = _overlap_tail(cur, chunk_overlap)
                    cur = (header + line) if header else (tail + line if tail else line)
                else:
                    cur += line
            if cur.strip():
                chunks.append(
                    _make_chunk(
                        cur,
                        context_header=context_header,
                        heading_path=heading_path,
                    )
                )
            buf = ""
            continue

        if buf and len(buf) + len(atom) > chunk_size:
            chunks.append(
                _make_chunk(
                    buf, context_header=context_header, heading_path=heading_path
                )
            )
            # Always try to carry readable overlap (even when buf ≤ overlap).
            carry = _overlap_tail(buf, chunk_overlap)
            buf = (carry + atom) if carry else atom
        else:
            buf += atom

    if buf.strip():
        chunks.append(
            _make_chunk(buf, context_header=context_header, heading_path=heading_path)
        )
    return chunks


def _heading_at(text: str, pos: int) -> tuple[str, int]:
    """返回 pos 位置所属标题的 (标题文本, 标题级别)。"""
    current = ("", 0)
    for m in _HEADING_LINE_RE.finditer(text):
        if m.start() > pos:
            break
        current = (m.group(2).strip(), len(m.group(1)))
    return current


def _split_by_heading(
    text: str,
    *,
    chunk_size: int = 2048,
    chunk_overlap: int = 256,
) -> list[Chunk]:
    """按 Markdown 标题切分；单节超长时递归切分并保留 heading 上下文。"""
    matches = list(_HEADING_LINE_RE.finditer(text))
    if not matches:
        return _split_recursive(
            text, chunk_size=chunk_size, chunk_overlap=chunk_overlap
        )

    # 每个标题开启一节；第一个标题之前的内容算前言。
    sections: list[tuple[str, str, int]] = []  # (heading_path, body, start_pos)
    if matches[0].start() > 0:
        sections.append(("", text[: matches[0].start()], 0))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        title = m.group(2).strip()
        sections.append((title, text[m.start() : end], m.start()))

    chunks: list[Chunk] = []
    for heading_path, body, start_pos in sections:
        if not body.strip():
            continue
        if len(body) <= chunk_size:
            chunks.append(
                _make_chunk(
                    body, context_header=heading_path, heading_path=heading_path
                )
            )
        else:
            chunks.extend(
                _split_recursive(
                    body,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                    context_header=heading_path,
                    heading_path=heading_path,
                )
            )
    return chunks


def chunk_markdown(
    text: str,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
    strategy: str = "auto",
) -> list[Chunk]:
    """把 Markdown 正文切成 chunk 列表。

    ``strategy``：``recursive`` | ``heading`` | ``auto``（默认，按标题密度自动选）。
    ``chunk_size`` / ``chunk_overlap`` 会被夹到合理范围；配置是唯一权威，
    没有隐藏上限（见模块头的历史事故）。
    """
    raw = text or ""
    stripped = raw.strip()
    if not stripped:
        return []

    size = max(MIN_CHUNK_SIZE, int(chunk_size or DEFAULT_CHUNK_SIZE))
    overlap = max(0, int(chunk_overlap or 0))

    # Already fits the configured budget → keep whole (strategy irrelevant).
    if len(stripped) <= size:
        heading = ""
        m = _HEADING_LINE_RE.search(stripped)
        if m:
            heading = m.group(2).strip()
        return [_make_chunk(stripped, context_header=heading, heading_path=heading)]

    picked = (strategy or "auto").strip().lower()
    if picked == "auto":
        headings = len(_HEADING_LINE_RE.findall(stripped))
        picked = (
            "heading"
            if headings >= 2 and len(stripped) > max(128, size)
            else "recursive"
        )

    result: list[Chunk]
    if picked == "heading":
        result = _split_by_heading(
            stripped, chunk_size=size, chunk_overlap=overlap
        )
    else:
        result = _split_recursive(
            stripped, chunk_size=size, chunk_overlap=overlap
        )

    # 重编号，保证 ordinal 连续（下游按 ordinal 排序取正文）
    for index, chunk in enumerate(result):
        chunk.ordinal = index
    return result


__all__ = [
    "Chunk",
    "DEFAULT_CHUNK_OVERLAP",
    "DEFAULT_CHUNK_SIZE",
    "MIN_CHUNK_SIZE",
    "chunk_markdown",
    "estimate_tokens",
    "find_protected_spans",
]
