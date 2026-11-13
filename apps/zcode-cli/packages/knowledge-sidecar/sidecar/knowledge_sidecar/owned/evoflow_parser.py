"""文档解析：把各种格式转成 Markdown 正文。

## 为什么不用 markitdown

实测（2026-11-13）两版都不可接受：
- `0.1.x` → 依赖 `magika` → `onnxruntime`（14.4MB 原生 wheel）+ 运行时下载 ONNX 模型；
- `0.0.1a2` → 顶层硬导入 `mammoth` / `pandas` / `pdfminer` / `pptx`，其中
  `pandas` → `numpy`，而 numpy 的 cp311 ABI wheel 与 Python 3.12 不兼容，
  `import numpy` 直接失败。

所以这里用**纯标准库**解析：
- `.docx` / `.pptx` / `.xlsx` 本质是 zip + XML，用 `zipfile` + `ElementTree`；
- `.pdf` 用 `pdfplumber`（office-engines 已有），没有则退回纯标准库的
  文本流提取（只对未压缩流有效，够用于大多数导出件）；
- 纯文本类直接读。

代价是 Office 解析要自己实现，收益是资产树零原生依赖、无平台 ABI 矩阵。

## 设计约束

- 解析结果统一成 Markdown：标题层级、段落、列表、表格、代码块。
  Markdown 便于后面的分块器按结构切分（表格/代码不被切断）。
- 解析失败不抛到 RPC 层，而是返回 `ParseResult(ok=False, error=...)`，
  由调用方写进 `kb_documents.parse_error`（spec §4.4 的降级语义）。
- 单文件大小上限由网关控制（256MB）；这里只做流式读取与大小保护。
"""

from __future__ import annotations

import logging
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

logger = logging.getLogger("knowledge_sidecar.parser")

# Office XML 命名空间。写成完整 URI 而非前缀，便于 ElementTree 查找。
NS_WORD = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NS_DRAWING = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
NS_SHEET = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_SLIDE = "{http://schemas.openxmlformats.org/presentationml/2006/main}"

# 纯文本类扩展名：直接读，不做转换。
TEXT_EXTENSIONS = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".mdx": "markdown",
    ".txt": "text",
    ".csv": "csv",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".html": "html",
    ".htm": "html",
    ".py": "code",
}


def supported_extensions() -> set[str]:
    return set(TEXT_EXTENSIONS) | {".docx", ".pptx", ".xlsx", ".pdf", ".doc", ".ppt", ".xls"}


@dataclass
class ParseResult:
    ok: bool
    markdown: str = ""
    title: str = ""
    error: str = ""
    # 解析器给分块器的提示：是否已有结构化标题（有则分块器按标题切）
    has_structure: bool = False
    # 统计（写进 doc 便于 UI 展示）
    stats: dict[str, int] = field(default_factory=dict)


def parse_file(path: Path) -> ParseResult:
    """按扩展名分派解析器。失败时返回 ok=False 而非抛异常。"""
    extension = path.suffix.lower()
    try:
        if extension in TEXT_EXTENSIONS:
            return _parse_text(path, TEXT_EXTENSIONS[extension])
        if extension == ".docx":
            return _parse_docx(path)
        if extension == ".pptx":
            return _parse_pptx(path)
        if extension == ".xlsx":
            return _parse_xlsx(path)
        if extension == ".pdf":
            return _parse_pdf(path)
        if extension in (".doc", ".ppt", ".xls"):
            return ParseResult(
                ok=False,
                error=(
                    f"旧版 Office 二进制格式（{extension}）不受支持，"
                    "请另存为 .docx / .pptx / .xlsx 后重新上传"
                ),
            )
        return ParseResult(ok=False, error=f"不支持的格式：{extension or '(无扩展名)'}")
    except Exception as exc:  # noqa: BLE001 — 单个文件失败不能让整批索引挂掉
        logger.error("解析失败 %s：%s", path, exc, exc_info=True)
        return ParseResult(ok=False, error=f"解析失败：{exc.__class__.__name__}: {exc}")


# ── 纯文本类 ────────────────────────────────────────────────────────────────


def _parse_text(path: Path, kind: str) -> ParseResult:
    raw = path.read_bytes()
    text = _decode(raw)
    if kind == "html":
        text = _html_to_markdown(text)
    elif kind == "json":
        # JSON 原样保留（分块器会按行/对象切），但包进代码块便于阅读
        text = f"```json\n{text}\n```"
    return ParseResult(
        ok=True,
        markdown=text,
        title=path.stem,
        has_structure=kind == "markdown" and bool(re.search(r"^#{1,6}\s", text, re.M)),
        stats={"chars": len(text), "lines": text.count("\n") + 1},
    )


def _decode(raw: bytes) -> str:
    """按 UTF-8 → GBK → latin-1 依次尝试。国内文档 GBK 很常见。"""
    for encoding in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _html_to_markdown(html: str) -> str:
    """极简 HTML → Markdown：标题、段落、列表、换行。不做完整转换。"""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", html)
    # 标题
    for level in range(1, 7):
        text = re.sub(
            rf"(?is)<h{level}[^>]*>(.*?)</h{level}>",
            lambda m, lv=level: f"\n{'#' * lv} {re.sub(r'<[^>]+>', '', m.group(1)).strip()}\n",
            text,
        )
    # 列表项
    text = re.sub(
        r"(?is)<li[^>]*>(.*?)</li>",
        lambda m: f"\n- {re.sub(r'<[^>]+>', '', m.group(1)).strip()}",
        text,
    )
    # 段落与换行
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p>", "\n\n", text)
    text = re.sub(r"(?is)<[^>]+>", "", text)
    # HTML 实体（只处理最常见的几个）
    for entity, char in (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&quot;", '"')):
        text = text.replace(entity, char)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ── DOCX ────────────────────────────────────────────────────────────────────


def _parse_docx(path: Path) -> ParseResult:
    with zipfile.ZipFile(path) as archive:
        if "word/document.xml" not in archive.namelist():
            return ParseResult(ok=False, error="不是有效的 .docx（缺 word/document.xml）")
        root = ElementTree.fromstring(archive.read("word/document.xml"))

    lines: list[str] = []
    for paragraph in root.iter(f"{NS_WORD}p"):
        text = _docx_paragraph_text(paragraph)
        if not text.strip():
            continue
        style = _docx_paragraph_style(paragraph)
        level = _heading_level(style)
        if level:
            lines.append(f"{'#' * level} {text.strip()}")
        elif _docx_is_list_item(paragraph):
            lines.append(f"- {text.strip()}")
        else:
            lines.append(text.strip())

    markdown = "\n\n".join(lines)
    return ParseResult(
        ok=True,
        markdown=markdown,
        title=path.stem,
        has_structure=any(line.startswith("#") for line in lines),
        stats={"paragraphs": len(lines), "chars": len(markdown)},
    )


def _docx_paragraph_text(paragraph: ElementTree.Element) -> str:
    """拼接一个段落的全部 run 文本。制表符与换行按 Markdown 习惯保留。"""
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{NS_WORD}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{NS_WORD}tab":
            parts.append("\t")
        elif node.tag in (f"{NS_WORD}br", f"{NS_WORD}cr"):
            parts.append("\n")
    return "".join(parts)


def _docx_paragraph_style(paragraph: ElementTree.Element) -> str:
    props = paragraph.find(f"{NS_WORD}pPr")
    if props is None:
        return ""
    style = props.find(f"{NS_WORD}pStyle")
    return style.get(f"{NS_WORD}val", "") if style is not None else ""


def _docx_is_list_item(paragraph: ElementTree.Element) -> bool:
    props = paragraph.find(f"{NS_WORD}pPr")
    return props is not None and props.find(f"{NS_WORD}numPr") is not None


def _heading_level(style_id: str) -> int:
    """把 Word 的 pStyle 映射成标题层级。`Heading1` / `1` / `标题 1` 都认。"""
    if not style_id:
        return 0
    normalized = style_id.strip().lower().replace(" ", "")
    match = re.match(r"^(?:heading|标题)(\d)$", normalized)
    if match:
        return max(1, min(6, int(match.group(1))))
    if normalized in ("title", "标题"):
        return 1
    return 0


# ── PPTX ────────────────────────────────────────────────────────────────────


def _parse_pptx(path: Path) -> ParseResult:
    with zipfile.ZipFile(path) as archive:
        slide_names = sorted(
            name
            for name in archive.namelist()
            if re.match(r"ppt/slides/slide\d+\.xml$", name)
        )
        if not slide_names:
            return ParseResult(ok=False, error="不是有效的 .pptx（无幻灯片）")

        sections: list[str] = []
        for index, name in enumerate(slide_names, 1):
            root = ElementTree.fromstring(archive.read(name))
            texts = [
                node.text.strip()
                for node in root.iter(f"{NS_DRAWING}t")
                if node.text and node.text.strip()
            ]
            if not texts:
                continue
            # 首行当标题，其余按段落
            title = texts[0]
            body = "\n\n".join(texts[1:]) if len(texts) > 1 else ""
            block = f"## 第 {index} 页：{title}"
            if body:
                block += f"\n\n{body}"
            sections.append(block)

    markdown = "\n\n".join(sections)
    return ParseResult(
        ok=True,
        markdown=markdown,
        title=path.stem,
        has_structure=True,
        stats={"slides": len(sections), "chars": len(markdown)},
    )


# ── XLSX ────────────────────────────────────────────────────────────────────


def _parse_xlsx(path: Path) -> ParseResult:
    with zipfile.ZipFile(path) as archive:
        if "xl/workbook.xml" not in archive.namelist():
            return ParseResult(ok=False, error="不是有效的 .xlsx")
        shared = _xlsx_shared_strings(archive)
        sheet_names = _xlsx_sheet_names(archive)
        sheet_files = sorted(
            name for name in archive.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", name)
        )
        if not sheet_files:
            return ParseResult(ok=False, error="工作簿里没有工作表")

        sections: list[str] = []
        for index, name in enumerate(sheet_files):
            sheet_label = sheet_names[index] if index < len(sheet_names) else f"Sheet{index + 1}"
            table = _xlsx_sheet_markdown(archive, name, shared)
            if table:
                sections.append(f"## {sheet_label}\n\n{table}")

    markdown = "\n\n".join(sections)
    return ParseResult(
        ok=True,
        markdown=markdown,
        title=path.stem,
        has_structure=True,
        stats={"sheets": len(sections), "chars": len(markdown)},
    )


def _xlsx_shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    values: list[str] = []
    for item in root.iter(f"{NS_SHEET}si"):
        # 一个 si 可能由多个 r/t 组成（富文本），要全部拼接
        text = "".join(node.text or "" for node in item.iter(f"{NS_SHEET}t"))
        values.append(text)
    return values


def _xlsx_sheet_names(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    except (KeyError, ElementTree.ParseError):
        return []
    return [sheet.get("name", "") for sheet in root.iter(f"{NS_SHEET}sheet")]


def _xlsx_sheet_markdown(
    archive: zipfile.ZipFile, sheet_file: str, shared: list[str]
) -> str:
    root = ElementTree.fromstring(archive.read(sheet_file))
    rows: list[list[str]] = []
    for row in root.iter(f"{NS_SHEET}row"):
        cells: list[str] = []
        for cell in row.iter(f"{NS_SHEET}c"):
            cell_type = cell.get("t", "")
            value = ""
            if cell_type == "inlineStr":
                value = "".join(node.text or "" for node in cell.iter(f"{NS_SHEET}t"))
            else:
                raw = cell.find(f"{NS_SHEET}v")
                if raw is not None and raw.text:
                    if cell_type == "s":
                        # 共享字符串表索引
                        try:
                            value = shared[int(raw.text)]
                        except (ValueError, IndexError):
                            value = raw.text
                    else:
                        value = raw.text
            cells.append(value.replace("|", "\\|").replace("\n", " ").strip())
        if cells and any(cells):
            rows.append(cells)

    if not rows:
        return ""

    # 首行当表头；列数取最大
    width = max(len(row) for row in rows)
    header = rows[0] + [""] * (width - len(rows[0]))
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    for row in rows[1:]:
        padded = row + [""] * (width - len(row))
        lines.append("| " + " | ".join(padded) + " |")
    return "\n".join(lines)


# ── PDF ─────────────────────────────────────────────────────────────────────


def _parse_pdf(path: Path) -> ParseResult:
    """PDF 解析：优先 pdfplumber（office-engines 已带），否则退回纯标准库。

    纯标准库实现只处理未压缩内容流 —— 对扫描件和加密件无效，但覆盖大多数
    由 Word/LaTeX 导出的文本型 PDF。失败时明确告知需要 pdfplumber。
    """
    try:
        import pdfplumber  # noqa: PLC0415 — 可选依赖，缺失时走兜底
    except ImportError:
        return _parse_pdf_stdlib(path)

    pages: list[str] = []
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, 1):
            text = page.extract_text() or ""
            if text.strip():
                pages.append(f"## 第 {index} 页\n\n{text.strip()}")
    markdown = "\n\n".join(pages)
    if not markdown.strip():
        return ParseResult(
            ok=False,
            error="PDF 未提取到文本（可能是扫描件，需 OCR；请用 ocr-tools 先识别）",
        )
    return ParseResult(
        ok=True,
        markdown=markdown,
        title=path.stem,
        has_structure=True,
        stats={"pages": len(pages), "chars": len(markdown)},
    )


def _parse_pdf_stdlib(path: Path) -> ParseResult:
    """无 pdfplumber 时的兜底：从原始字节里捞文本流。

    只处理未压缩的 `BT ... ET` 文本块，能覆盖部分简单 PDF。
    解压型内容流需要 zlib（标准库有）但不是所有 PDF 都用 FlateDecode，
    所以这里只做尽力而为，失败时给出明确提示。
    """
    import zlib

    raw = path.read_bytes()
    chunks: list[str] = []
    # FlateDecode 内容流：stream ... endstream
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", raw, re.S):
        blob = match.group(1)
        try:
            decoded = zlib.decompress(blob)
        except zlib.error:
            decoded = blob
        for text_match in re.finditer(rb"\((.*?)\)\s*Tj", decoded, re.S):
            try:
                chunks.append(text_match.group(1).decode("latin-1"))
            except Exception:  # noqa: BLE001
                continue
        for array_match in re.finditer(rb"\[(.*?)\]\s*TJ", decoded, re.S):
            for part in re.finditer(rb"\((.*?)\)", array_match.group(1), re.S):
                try:
                    chunks.append(part.group(1).decode("latin-1"))
                except Exception:  # noqa: BLE001
                    continue

    markdown = " ".join(chunks).strip()
    if not markdown:
        return ParseResult(
            ok=False,
            error=(
                "PDF 文本提取失败：当前环境没有 pdfplumber，且无法从内容流还原文本。"
                "请安装 pdfplumber（office-engines 自带）或先用 ocr-tools 识别。"
            ),
        )
    logger.warning("PDF 使用标准库兜底解析 %s（建议装 pdfplumber 提升质量）", path)
    return ParseResult(
        ok=True,
        markdown=markdown,
        title=path.stem,
        stats={"chars": len(markdown), "fallback": 1},
    )
