# -*- coding: utf-8 -*-
"""纯 Python 解析 .docx（zipfile + ElementTree），模拟 Word COM 的
Range().Text / Table.Range.Cells(RowIndex,ColumnIndex) 行为。"""
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _para_text(p):
    """段落文本：w:t 拼接，w:br / w:cr 转为 \x0b（Word 中的手动换行符）"""
    out = []
    for node in p.iter():
        tag = node.tag
        if tag == W + "t":
            out.append(node.text or "")
        elif tag in (W + "br", W + "cr"):
            out.append("\x0b")
        elif tag == W + "tab":
            out.append("\t")
    return "".join(out)


def _cell_paras(tc):
    return [_para_text(p) for p in tc.findall(W + "p")]


def _cell_text(tc):
    """单元格文本，段落之间用 \r 分隔（与 Word COM 一致）"""
    return "\r".join(_cell_paras(tc))


def table_grid(tbl):
    """返回 {(row, col): text}，处理 gridSpan(横向合并) 与 vMerge(纵向合并)。
    横向合并：文本放在起始列，被跨越的列留空(缺失)。
    纵向合并：文本放在 restart 行，continue 行留空(缺失)。"""
    grid = {}
    r = 0
    for tr in tbl.findall(W + "tr"):
        c = 0
        for tc in tr.findall(W + "tc"):
            tcPr = tc.find(W + "tcPr")
            span = 1
            vmerge = None
            if tcPr is not None:
                gs = tcPr.find(W + "gridSpan")
                if gs is not None:
                    span = int(gs.get(W + "val", "1"))
                vm = tcPr.find(W + "vMerge")
                if vm is not None:
                    vmerge = vm.get(W + "val", "continue")
            if vmerge in (None, "restart"):
                txt = _cell_text(tc)
                txt = txt.replace("\r\x07", "").replace("\x07", "")
                txt = txt.replace("\r", " ").replace("\x0b", "").strip()
                grid[(r + 1, c + 1)] = txt
            c += span
        r += 1
    return grid


def grid_rows(g):
    if not g:
        return []
    maxr = max(r for r, c in g)
    maxc = max(c for r, c in g)
    return [[g.get((r, c), "") for c in range(1, maxc + 1)] for r in range(1, maxr + 1)]


def parse_docx(path):
    """返回 items: [('p', text) | ('table', rows, grid)]，按文档顺序"""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(W + "body")
    items = []
    for el in body:
        if el.tag == W + "p":
            items.append(("p", _para_text(el)))
        elif el.tag == W + "tbl":
            g = table_grid(el)
            items.append(("table", grid_rows(g), g))
    return items


def full_text(items):
    """模拟 Word doc.Range().Text：段落以 \r 结束，表格单元格以 \r\x07 结束"""
    out = []
    for it in items:
        if it[0] == "p":
            out.append(it[1] + "\r")
        else:
            rows = it[1]
            for row in rows:
                for cell in row:
                    out.append(cell + "\r\x07")
                out.append("\x07")
    return "".join(out)
