# -*- coding: utf-8 -*-
"""
extract_report_materials.py
===========================
从 PKPM-PBECA《公共建筑节能计算分析报告书 / 规定性指标计算报告书》(.doc / .docx) 中
自动提取「围护结构构造做法 + 门窗（透明幕墙）热工参数」，输出 PKPM 材料库样式 JSON。
默认与 --strict 均输出标准 JSON（无注释、无尾随逗号），输出文件编码为 ANSI(GBK)。

数据来源（报告书章节）
----------------------
  3.1 非透明材料热工参数依据表        -> 材料层的 干密度(consistency) / 选用依据(criName)
  4.4 透明幕墙类型 / 4.5 门透光部分类型 -> windows[]
  5.2.x 围护结构热工性能              -> struct[]
        （"XXX构造类型N（YYY）：..." 段落 + 紧随其后的「热工性能判定」表）

计算规则（与 PKPM 一致：按原始输入全精度重算，不取报告中的三位小数截断值）
--------------------------------------------------------------------------
  单层热阻      dataR   = (ply/1000) / (diath * correct)
  单层热惰性    D_i     = (ply/1000) / diath * sDiath        # 不乘修正系数
  构造传热阻    dataRT  = Σ dataR + dataRI + dataRE
  构造传热系数  dataK   = 1 / dataRT
  构造热惰性    dataDrs = Σ D_i

用法
----
  python extract_report_materials.py "D:\\path\\规定性指标计算报告书.doc"
  python extract_report_materials.py 报告书.doc -o 材料.json
  python extract_report_materials.py 报告书.doc --strict             # 标准 JSON（无注释）
  python extract_report_materials.py 报告书.doc --cri "《xxx标准》"    # 覆盖默认规范依据
  python extract_report_materials.py 报告书.doc --frame-ratio 0.25    # 窗框占整窗面积比
  python extract_report_materials.py 报告书.doc --force               # 允许覆盖已有输出
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

# ---------------------------------------------------------------------------
# 默认值 / 常量
# ---------------------------------------------------------------------------
DEFAULT_CRI = "《公共建筑节能设计标准》GB50189-2015"   # 构造/门窗规范依据（报告书正文不体现，取 PKPM 默认）
DEFAULT_FRAME_AREA_RATIO = 0.2                        # 窗框占整窗面积比 scaleWinAndHoleFrameArea
DEFAULT_RI = 0.11                                     # 内表面换热阻
DEFAULT_RE = 0.05                                     # 外表面换热阻

# PKPM GpDbTypeManager.h 中的子类名称（cateName 白名单）
CANON_CATEGORIES = [
    "屋面主体层", "屋面", "外墙", "填充墙", "剪力墙", "框架柱", "构造柱", "框架梁",
    "圈梁", "过梁", "热桥梁", "热桥过梁", "热桥楼板", "热桥柱",
    "底部接触空气的架空楼板", "周边地面", "地面", "非采暖楼梯间隔墙",
    "内墙", "分户墙", "楼板", "户门", "外门", "阳台门",
    "透明幕墙", "外窗", "门透光部分", "屋顶透光部分", "变形缝",
]

# 透明（门窗类）子类：这些「构造类型」属于 windows，不进 struct
TRANSPARENT_CATES = {"外窗", "透明幕墙", "门透光部分", "屋顶透光部分",
                     "外门", "户门", "阳台门", "窗", "幕墙"}

# 玻璃系统 token 中的气体关键字 -> 标准气体名（长关键字必须排在前面）
GAS_RE = re.compile(r"^(氩气|氪气|氙气|氮气|氖气|空气|真空|"
                    r"sf6|argon|krypton|xenon|neon|air|ar|kr|xe|ne|n2|a|v)(?![a-z0-9])", re.I)
GAS_NAME = {
    "氩气": "氩气", "ar": "氩气", "argon": "氩气",
    "氪气": "氪气", "kr": "氪气", "krypton": "氪气",
    "氙气": "氙气", "xe": "氙气", "xenon": "氙气",
    "氮气": "氮气", "n2": "氮气",
    "氖气": "氖气", "ne": "氖气", "neon": "氖气",
    "空气": "空气", "a": "空气", "air": "空气",
    "真空": "真空", "v": "真空", "sf6": "六氟化硫",
}

STOP_ROW_PREFIX = ("各层之和", "热阻", "传热系数", "太阳辐射吸收系数", "标准条目",
                   "结论", "备注", "合计", "加权", "需要进行修正", "限值", "判定")

_NUM = r"[-+]?\d+(?:\.\d+)?"
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

# 与报告表内「三位小数截断值」对账时的容差
TOL_R = 0.006       # 热阻 / 传热阻：报告多位按 2~3 位小数截断（ΣR=3.26→Ro=3.41），
                    # 全精度重算与报告差值可达 0.005，故 2026-09-20 由 0.0011 放宽到 0.006
TOL_K = 0.011       # 传热系数（报告保留 2 位）
TOL_D = 0.011       # 热惰性指标（报告保留 2 位）


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def squash(s):
    """去掉全部空白，便于表头/名称匹配。"""
    return re.sub(r"\s+", "", s or "")


def clean_para(t):
    """段落文本清洗：去单元格结束符/域代码/控制符，压缩空白。"""
    t = (t or "").replace("\x07", " ").replace("\r", " ").replace("\x0b", " ")
    t = _CTRL.sub("", t)
    return re.sub(r"\s+", " ", t).strip()


def clean_cell(t):
    """单元格文本清洗：保留换行（\n），用于「使用部位」这类多行单元格。"""
    t = (t or "").replace("\x07", "").replace("\x0b", "\n").replace("\r", "\n")
    t = _CTRL.sub("", t)
    lines = [re.sub(r"[ \t]+", " ", x).strip() for x in t.split("\n")]
    return "\n".join([x for x in lines if x])


def to_float(s):
    """'0.029'/'1.20'/'40' -> float；'--'、空、非数值 -> None。"""
    if s is None:
        return None
    t = str(s).strip()
    if t in ("", "--", "—", "-", "－", "N/A", "na", "无"):
        return None
    t = t.replace("，", ".").replace(",", "")
    m = re.search(_NUM, t)
    return float(m.group()) if m else None


def num(v):
    """输出格式化：float 用 repr（最短可往返），字符串用 JSON 转义。"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, int):
        return str(v)
    return json.dumps(v, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Word 连接
# ---------------------------------------------------------------------------
def get_word():
    """返回 (word_app, need_quit)。优先使用 PKPMAgent 的 get_office_app。"""
    try:
        from PKPMAgent.utils.link_office import get_office_app
        app = get_office_app("Word")
        if isinstance(app, str):
            raise RuntimeError(app)
        return app, False
    except Exception as exc:                    # 脱离 Agent 环境时回退 win32com
        sys.stderr.write("[warn] get_office_app 不可用(%s)，回退 win32com\n" % exc)
        import win32com.client
        return win32com.client.DispatchEx("Word.Application"), True


# ---------------------------------------------------------------------------
# 纯 Python .docx 后端（提速改造 T3）
#
#   复用技能内置 references/docx_parse.py 的 XML 遍历能力（zipfile + ElementTree，
#   零 Word 依赖），但单元格 / 段落清洗一律走本模块的 clean_cell / clean_para，
#   保证与 Word COM 路径产出**逐格一致**的 grids / blocks。
#
#   实测（27.4MB .doc，28 表 / 2792 段 / 1554 单元格）：
#       Word COM DocModel  10.5s   ->   纯 Python 后端  0.025s   （约 400 倍）
#
#   两个必须遵守的等价性要点（踩过的坑，勿改）：
#     1) 列号取「行内 w:tc 的序号」，**不按 gridSpan 累加**。
#        Word COM 的 Cell.ColumnIndex 就是行内序号；按 gridSpan 累加会让
#        「修正系数α(gridSpan=2)」之后的列整体右移一位，导致 parse_basis_table
#        的 parts / cri 列错位（实测 28 表中 15 表出错）。
#     2) 单元格文本必须用 clean_cell（保留 \n 多行），不能用 docx_parse.table_grid
#        自带的有损清洗（它把 \r 换成空格、吞掉 \x0b）。
# ---------------------------------------------------------------------------
DOCX_PARSE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "references")


def _load_docx_parse():
    """导入技能内置 docx_parse（纯 Python，无 Word 依赖）。"""
    if DOCX_PARSE_DIR not in sys.path:
        sys.path.insert(0, DOCX_PARSE_DIR)
    import docx_parse
    return docx_parse


def docx_table_grid(tbl, dp):
    """w:tbl -> {(row, col): text}；处理 gridSpan(横向合并) 与 vMerge(纵向合并)。

    列号 = 行内 w:tc 序号（与 Word COM Cell.ColumnIndex 一致，见上方要点 1）。
    vMerge continue 仍占一个序号位，只是不写文本（矩形化时补 ""）。
    """
    W = dp.W
    g = {}
    r = 0
    for tr in tbl.findall(W + "tr"):
        c = 0
        for tc in tr.findall(W + "tc"):
            c += 1
            tcPr = tc.find(W + "tcPr")
            vmerge = None
            if tcPr is not None:
                vm = tcPr.find(W + "vMerge")
                if vm is not None:
                    vmerge = vm.get(W + "val", "continue")
            if vmerge in (None, "restart"):
                g[(r + 1, c)] = clean_cell(dp._cell_text(tc))
        r += 1
    return g


def docx_grid_rows(g):
    """{(r,c): text} -> 矩形二维数组（缺位补 ""），与 DocModel._read_table 输出同构。"""
    if not g:
        return []
    maxr = max(r for r, _ in g)
    maxc = max(c for _, c in g)
    return [[g.get((r, c), "") for c in range(1, maxc + 1)] for r in range(1, maxr + 1)]


def read_docx_model(path, verbose=True):
    """纯 Python 读取 .docx -> (grids, blocks)，结构与 DocModel 完全一致。"""
    import zipfile
    import xml.etree.ElementTree as ET
    t0 = time.time()
    dp = _load_docx_parse()
    W = dp.W
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(W + "body")
    if body is None:
        raise ValueError("docx 缺少 word/document.xml 的 body 节点：%s" % path)
    grids, blocks = [], []
    for el in body:
        if el.tag == W + "p":
            blocks.append(("p", clean_para(dp._para_text(el))))
        elif el.tag == W + "tbl":
            grids.append(docx_grid_rows(docx_table_grid(el, dp)))
            blocks.append(("t", len(grids) - 1))
    if verbose:
        print("  [docx后端] 纯 Python 读取 %d 个表格 / %d 个块 ... %.2fs"
              % (len(grids), len(blocks), time.time() - t0))
    return grids, blocks


# ---------------------------------------------------------------------------
# 文档模型：把 Word 文档拍平成按顺序排列的 段落 / 表格 块序列
# ---------------------------------------------------------------------------
class DocModel(object):

    def __init__(self, doc, verbose=True):
        self.doc = doc
        self.grids = []          # [table_index] -> 二维字符串数组
        self.blocks = []         # [('p', text) | ('t', table_index)]，按文档顺序
        self._read(verbose)

    @classmethod
    def from_docx(cls, path, verbose=True):
        """提速改造 T3：不经 Word COM，用纯 Python 后端直接构建模型。

        产出的 grids / blocks 与 Word COM 路径逐格一致（已回归验证）。
        """
        obj = cls.__new__(cls)
        obj.doc = None
        obj.grids, obj.blocks = read_docx_model(path, verbose=verbose)
        return obj

    # -- 单个表格 -> 二维数组（用 Cells 遍历，正确处理合并单元格）-----------
    @staticmethod
    def _read_table(tb):
        cells = {}
        for c in tb.Range.Cells:
            cells[(c.RowIndex, c.ColumnIndex)] = clean_cell(c.Range.Text)
        if not cells:
            return []
        maxr = max(r for r, _ in cells)
        maxc = max(c for _, c in cells)
        return [[cells.get((r, c), "") for c in range(1, maxc + 1)]
                for r in range(1, maxr + 1)]

    def _read(self, verbose):
        t0 = time.time()
        n_tab = self.doc.Tables.Count
        spans = []                                    # (first_para_index, para_count)
        for i in range(1, n_tab + 1):
            tb = self.doc.Tables(i)
            first = self.doc.Range(0, tb.Range.Start).Paragraphs.Count + 1
            spans.append((first, tb.Range.Paragraphs.Count))
            self.grids.append(self._read_table(tb))
        if verbose:
            print("  读取 %d 个表格 ... %.1fs" % (n_tab, time.time() - t0))

        # 标记属于表格的段落序号（这些段落无需再取文本，可省 ~90% 的 COM 调用）
        n_par = self.doc.Paragraphs.Count
        in_tab = bytearray(n_par + 2)
        for first, cnt in spans:
            for k in range(first, first + cnt):
                if 0 <= k < len(in_tab):
                    in_tab[k] = 1

        t0 = time.time()
        texts = {}
        idx = 0
        for p in self.doc.Paragraphs:                 # 枚举比索引快得多
            idx += 1
            if not in_tab[idx]:
                texts[idx] = clean_para(p.Range.Text)
        if verbose:
            print("  读取 %d 个段落（表外 %d 个）... %.1fs"
                  % (idx, len(texts), time.time() - t0))

        if idx != n_par:                              # 对齐失败则退回逐段取 Start 的稳妥方式
            if verbose:
                print("  [warn] 段落计数不一致，回退到精确位置模式")
            texts, in_tab = self._read_slow(n_par)

        # 合成有序块序列：表格按其首段落序号插入到段落流中
        order = ([(f, 0, "t", i) for i, (f, c) in enumerate(spans)] +
                 [(k, 1, "p", k) for k in texts])
        order.sort()
        self.blocks = [(kind, (val if kind == "t" else texts[val]))
                       for _pos, _pri, kind, val in order]

    def _read_slow(self, n_par):
        spans = []
        for i in range(1, self.doc.Tables.Count + 1):
            tb = self.doc.Tables(i)
            spans.append((tb.Range.Start, tb.Range.End))
        texts, in_tab = {}, bytearray(n_par + 2)
        idx = 0
        for p in self.doc.Paragraphs:
            idx += 1
            st = p.Range.Start
            if any(a <= st < b for a, b in spans):
                in_tab[idx] = 1
            else:
                texts[idx] = clean_para(p.Range.Text)
        return texts, in_tab


# ---------------------------------------------------------------------------
# 3.1 非透明材料热工参数依据  ->  材料「选用依据 / 干密度」库
# ---------------------------------------------------------------------------
class MatBasis(object):
    __slots__ = ("name", "density", "diath", "sDiath", "correct", "parts", "cri")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def __repr__(self):
        return "<MatBasis %s λ=%s 部位=%s 依据=%s>" % (self.name, self.diath, self.parts, self.cri)


def parse_basis_table(grid):
    """解析「非透明材料热工参数依据」表 -> [MatBasis]；不是该表则返回 []。"""
    if not grid or len(grid) < 3:
        return []
    head = squash("".join(grid[0])) + squash("".join(grid[1]))
    if not ("材料名称" in head and "干密度" in head and "选用依据" in head):
        return []

    ncol = max(len(r) for r in grid)
    col = {"name": 0, "density": None, "diath": None, "sDiath": None,
           "correct": None, "parts": None, "cri": ncol - 1}
    for i in range(ncol):
        h = squash("".join((r[i] if i < len(r) else "") for r in grid[:2]))
        if "干密度" in h and col["density"] is None:
            col["density"] = i
        elif "蓄热系数" in h and col["sDiath"] is None:
            col["sDiath"] = i
        elif "导热系数" in h and col["diath"] is None:
            col["diath"] = i
        elif ("修正系数" in h or h.endswith("α")) and col["correct"] is None:
            col["correct"] = i
        if "使用部位" in h:
            col["parts"] = i
    if col["parts"] is None:
        col["parts"] = max(ncol - 2, 0)
    if col["cri"] == col["parts"]:
        col["cri"] = ncol - 1

    out = []
    for r in grid[2:]:
        def g(key):
            i = col[key]
            return r[i] if (i is not None and i < len(r)) else ""
        if not squash(g("name")):
            continue
        out.append(MatBasis(
            name=squash(g("name")),
            density=to_float(g("density")),
            diath=to_float(g("diath")),
            sDiath=to_float(g("sDiath")),
            correct=to_float(g("correct")),
            parts=[x for x in re.split(r"[\n、,，/;；\s]+", g("parts")) if x],
            cri=re.sub(r"\s+", " ", g("cri")).strip(),
        ))
    return out


def match_basis(basis_list, mat_name, diath, cate_name, prefix):
    """按 材料名 + 导热系数 + 使用部位 打分匹配材料依据（同名多条时区分）。"""
    key = squash(mat_name)
    cands = [b for b in basis_list if squash(b.name) == key]
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    tags = {squash(cate_name), squash(prefix)} - {""}

    def score(b):
        s = 0
        if b.diath is not None and diath is not None and abs(b.diath - diath) < 1e-9:
            s += 4
        for p in (b.parts or []):
            sp = squash(p)
            if sp in tags or any(sp in t or t in sp for t in tags):
                s += 2
                break
        return s

    return max(cands, key=score)


# ---------------------------------------------------------------------------
# 5.2.x 围护结构热工性能表  ->  struct[]
# ---------------------------------------------------------------------------
STRUCT_HEAD_RE = re.compile(
    r"^(?P<cate>.+?)构造类型\s*(?P<idx>\d*)\s*"
    r"(?:[（(]\s*(?P<name>[^（）()]+?)\s*[)）])?\s*[：:]?\s*(?P<mats>.*)$")

# 2026-09-20：表式窗模板的类型小标题（"外窗类型1"/"透明幕墙类型1"/"门透光部分类型1"…）
WIN_TYPE_HEAD_RE = re.compile(
    r"^(?:外窗|透明幕墙|门透光部分|屋顶透光部分|天窗|凸窗|窗|幕墙)[^：:]*类型\s*\d*\s*$")


def find_header_row(grid):
    """在前 4 行中定位真正的表头行（有些模板表格首行是"屋面1"这类标题行）。"""
    for i in range(min(4, len(grid or []))):
        h = squash("".join(grid[i]))
        if ("材料名称" in h and "厚度" in h and "导热系数" in h
                and "蓄热系数" in h and "热阻" in h):
            return i
    return -1


def is_thermal_table(grid):
    return bool(grid) and find_header_row(grid) >= 0


def thermal_col_map(grid, hrow=0):
    m = {}
    for i, c in enumerate(grid[hrow]):
        h = squash(c)
        if "材料名称" in h:
            m.setdefault("name", i)
        elif "厚度" in h:
            m.setdefault("ply", i)
        elif "蓄热系数" in h:
            m.setdefault("sDiath", i)
        elif "导热系数" in h:
            m.setdefault("diath", i)
        elif "热阻" in h:
            m.setdefault("R", i)
        elif "热惰性" in h:
            m.setdefault("D", i)
        elif "修正系数" in h or h == "α":
            m.setdefault("correct", i)
    m.setdefault("name", 0)
    return m


def parse_thermal_table(grid):
    """解析热工性能判定表 -> (layers, ri, re, rep_ro, rep_k, rep_d)"""
    hrow = find_header_row(grid)
    if hrow < 0:
        hrow = 0
    cm = thermal_col_map(grid, hrow)
    layers = []
    ri = re_ = None
    rep_ro = rep_k = rep_d = None

    def cell(row, key):
        i = cm.get(key)
        return row[i] if (i is not None and i < len(row)) else ""

    for row in grid[hrow + 1:]:
        if not row or not squash(row[0]):
            continue
        first = squash(row[0])
        joined = " ".join(row)

        if "热阻" in first and "Ro" in joined:
            # 2026-09-20：兼容「Ro=Ri+∑R+Ri」（两侧均室内——内墙/分户墙/层间楼板等，
            # 报告按 RI=RE=0.11 计；此前误用默认 0.11/0.05 导致 K 重算偏高）
            m = re.search(r"Ro\s*=\s*Ri\s*\+\s*∑R\s*\+\s*R([ie])\s*=\s*(" + _NUM + r")", joined)
            if m:
                rep_ro = float(m.group(2))
                if m.group(1) == "i":
                    ri = re_ = 0.11
            # 成对匹配 "Ri=...;Re=..." 或 "Ri=...;Ri=..."（分号支持 ASCII ";" 与全角 "；"）
            m = re.search(r"Ri\s*=\s*(" + _NUM + r")[^;；\n]*?[;；]\s*R([ie])\s*=\s*(" + _NUM + r")", joined)
            if m:
                ri = float(m.group(1))
                re_ = ri if m.group(2) == "i" else float(m.group(3))
            continue
        if "传热系数" in first:
            m = re.search(r"K\s*=\s*1\s*/\s*Ro\s*=\s*(" + _NUM + r")", joined)
            if m:
                rep_k = float(m.group(1))
            continue
        if any(k in first for k in STOP_ROW_PREFIX):
            if "各层之和" in first:
                rep_d = to_float(cell(row, "D"))
            continue

        ply = to_float(cell(row, "ply"))
        diath = to_float(cell(row, "diath"))
        if ply is None or diath is None or diath == 0:
            continue            # 报告中以 "--" 占位的层（如高分子防水卷材）不参与热工计算
        sdiath = to_float(cell(row, "sDiath"))
        correct = to_float(cell(row, "correct"))
        layers.append({
            "name": squash(row[cm["name"]]),
            "ply": float(ply),
            "correct": 1.0 if correct is None else float(correct),
            "diath": float(diath),
            "sDiath": 0.0 if sdiath is None else float(sdiath),
            "rep_R": to_float(cell(row, "R")),
            "rep_D": to_float(cell(row, "D")),
        })

    return layers, float(ri if ri is not None else DEFAULT_RI), \
        float(re_ if re_ is not None else DEFAULT_RE), rep_ro, rep_k, rep_d


def resolve_cate(name, prefix):
    """确定 cateName（对应 GpDbTypeManager.h 子类名称）。
    优先级：构造名去编号 -> 章节前缀 -> 构造名的最长标准后缀 -> 前缀的最长标准后缀。"""
    base = squash(re.sub(r"\d+$", "", squash(name)))
    prefix = squash(prefix or "")
    if base in CANON_CATEGORIES:
        return base
    if prefix in CANON_CATEGORIES:
        return prefix
    hit = [c for c in CANON_CATEGORIES if base.endswith(c)]
    if hit:
        return max(hit, key=len)
    hit = [c for c in CANON_CATEGORIES if prefix.endswith(c)]
    if hit:
        return max(hit, key=len)
    return base or prefix


# ---------------------------------------------------------------------------
# 4.4 / 4.5 透明幕墙、门透光部分  ->  windows[]
# ---------------------------------------------------------------------------
HEADING_RE = re.compile(r"^\s*(\d+(?:\.\d+)*)\s+(\S.*?)\s*$")
WIN_STRUCT_RE = re.compile(r"^构造\s*[：:]\s*(?P<body>.+?)\s*$")


def split_frame_glass(text):
    """'构造：隔热铝合金（5Low-E+9A+5+9Ar+5（中透光））' -> ('隔热铝合金', '5Low-E+9A+5+9Ar+5（中透光）')
    做法：从末尾的右括号反向配平，找到与之匹配的左括号，兼容玻璃名内的嵌套括号。"""
    m = WIN_STRUCT_RE.match(text)
    if not m:
        return None, None
    body = m.group("body").strip()
    if not body or body[-1] not in "）)":
        return None, None
    bal = 0
    for i in range(len(body) - 1, -1, -1):
        ch = body[i]
        if ch in "）)":
            bal += 1
        elif ch in "（(":
            bal -= 1
        if bal == 0:
            return body[:i].strip(), body[i + 1:-1].strip()
    return None, None
GLASS_TOK_PANE = re.compile(r"^(\d+(?:\.\d+)?)")
_LEAD_NUM = re.compile(r"^\d+(?:\.\d+)?\s*(?:mm)?\s*", re.I)


def split_gas_token(tok):
    """'16Ar'/'12氩气'/'9A'/'20A内置百叶'/'V' -> (厚度 or None, 气体名)；非气体层返回 (None, None)"""
    m = GLASS_TOK_PANE.match(tok)
    ply = float(m.group(1)) if m else None
    kw = _LEAD_NUM.sub("", tok).strip()
    g = GAS_RE.match(kw)
    if not g:
        return None, None
    return ply, GAS_NAME.get(g.group(1).lower(), g.group(1))


def parse_glass_system(gs):
    """'6Low-e+16Ar+6+16Ar+6Low-e' -> (玻璃层数, 中空层数, 气体厚度, 气体种类)"""
    toks = [t.strip() for t in re.split(r"[+＋]", gs or "") if t.strip()]
    panes = gases = 0
    gas_ply = gas_sort = None
    for t in toks:
        ply, gname = split_gas_token(t)
        if gname:
            gases += 1
            if ply is not None and gas_ply is None:
                gas_ply = ply
            if gas_sort is None:
                gas_sort = gname
        elif GLASS_TOK_PANE.match(t):
            panes += 1
    if gases == 0 and panes > 1:
        gases = panes - 1
    return panes, gases, gas_ply, gas_sort


def parse_window_perf(text):
    def grab(pat):
        m = re.search(pat, text)
        return float(m.group(1)) if m else None
    return {
        "dataK": grab(r"传热系数\s*[：:]?\s*(" + _NUM + r")"),
        "summerSHGC": grab(r"夏季玻璃太阳得热系数\s*[：:]?\s*(" + _NUM + r")"),
        "winterSHGC": grab(r"冬季玻璃太阳得热系数\s*[：:]?\s*(" + _NUM + r")"),
        "summerSC": grab(r"夏季玻璃遮阳系数\s*[：:]?\s*(" + _NUM + r")"),
        "winterSC": grab(r"冬季玻璃遮阳系数\s*[：:]?\s*(" + _NUM + r")"),
        "glassShineScale": grab(r"可见光透射比\s*[：:]?\s*(" + _NUM + r")"),
    }


def win_cate_from_heading(heading):
    h = HEADING_RE.match(heading or "")
    t = h.group(2) if h else (heading or "")
    t = re.sub(r"类型\s*[（(].*?[)）]\s*$", "", t)
    t = re.sub(r"类型\s*\d*\s*$", "", t)     # 2026-09-20：剥掉 "类型1" 编号（"外窗类型1"→"外窗"）
    t = re.sub(r"类型$", "", t)
    t = t.strip()
    if t in CANON_CATEGORIES:
        return t
    hit = [c for c in CANON_CATEGORIES if t.endswith(c) or c.endswith(t)]
    return max(hit, key=len) if hit else t


# ---------------------------------------------------------------------------
# 主提取流程
# ---------------------------------------------------------------------------
def extract(model, opts):
    blocks, grids = model.blocks, model.grids
    warnings, notes = [], []

    basis = []
    for g in grids:
        basis.extend(parse_basis_table(g))
    if opts.verbose:
        print("  非透明材料依据条目：%d" % len(basis))

    structs, windows, win_refs = [], [], []
    last_heading = ""
    last_win_type = ""     # 2026-09-20：表式窗模板的「外窗类型1/透明幕墙类型1…」小标题
    pending = None

    for bi, (kind, val) in enumerate(blocks):
        if kind == "t":
            if pending is not None and is_thermal_table(grids[val]):
                structs.append(build_struct(pending, grids[val], basis, opts, warnings))
                pending = None
            continue

        text = val
        if not text:
            continue
        if HEADING_RE.match(text):
            last_heading = text
        if WIN_TYPE_HEAD_RE.match(text):
            last_win_type = text

        m = STRUCT_HEAD_RE.match(text)
        if m:
            prefix = m.group("cate").strip()
            name = (m.group("name") or "").strip() or "%s%s" % (prefix, m.group("idx") or "1")
            cate = resolve_cate(name, prefix)
            # 2026-09-20：「非透明外门」虽归入 cate=外门，但并非透明构件，
            # 不再放入 win_refs（其传热系数见「表24 非透明外门」/段落，人工核对即可）
            if (cate in TRANSPARENT_CATES
                    and "非透明" not in (prefix + name + (m.group("mats") or ""))):
                win_refs.append((cate, name, prefix))
                continue
            if pending is not None:
                warnings.append("构造「%s」未找到对应的热工性能判定表" % pending["name"])
            pending = {"prefix": prefix, "name": name, "cate": cate,
                       "desc": m.group("mats").strip(), "heading": last_heading}
            continue

        if text.startswith("构造：") or text.startswith("构造:"):
            w = build_window(text, blocks, bi, last_heading, opts, warnings)
            if w:
                windows.append(w)
            continue

        if text.startswith("外窗：") or text.startswith("外窗:"):
            w = build_window_v2(text, blocks, bi, last_win_type, opts, warnings)
            if w:
                windows.append(w)

    if pending is not None:
        warnings.append("构造「%s」未找到对应的热工性能判定表" % pending["name"])

    # 2026-09-20：表式窗兜底——「外窗传热系数判定」等判定表给出 类型名 -> K 映射，
    # 段落未覆盖的类型（如门透光部分类型1）按成组条目补充（无玻璃分解，报告未给出）。
    win_names = {w["name"] for w in windows}
    for g in grids:
        if not g or len(g) < 3 or not g[0]:
            continue
        hh = [squash(x) for x in g[0]]
        if "类型" not in "".join(hh) or "传热系数" not in "".join(hh) or "材料名称" in "".join(hh):
            continue
        ci = ck = None
        for i, h in enumerate(hh):
            if ci is None and "类型" in h:
                ci = i
            if ck is None and "传热系数" in h and "限值" not in h and "加权" not in h:
                ck = i
        if ci is None or ck is None:
            continue
        for r in g[1:]:
            tname = (r[ci] if ci < len(r) else "").strip()
            if not tname or "类型" not in tname:
                continue
            if "非透明" in tname or "非透光" in tname:
                continue
            if tname in win_names:
                continue
            m = re.search(_NUM, r[ck] if ck < len(r) else "")
            if not m:
                continue
            cat = win_cate_from_heading(tname)
            if cat not in TRANSPARENT_CATES:
                continue
            windows.append({"cateName": cat, "name": tname, "criName": opts.cri,
                            "winFrameMaterial": "", "glassSystem": "",
                            "dataK": float(m.group()),
                            "winterSC": None, "summerSC": None, "winterSHGC": None,
                            "scaleWinAndHoleFrameArea": opts.frame_ratio,
                            "glassShineScale": None,
                            "gasPly": 0.0, "gasSort": "", "gasLayerCounts": 0, "glassLayers": 0})
            win_names.add(tname)

    if not windows and win_refs:
        warnings.append("未在第4章找到「构造：/热工性能：」门窗描述段，"
                        "但第5章存在 %d 条外窗构造类型，请人工补充 windows[]" % len(win_refs))

    annotate_anomaly(structs, opts, notes)
    return structs, windows, warnings, notes


def build_struct(pending, grid, basis, opts, warnings):
    layers, ri, re_, rep_ro, rep_k, rep_d = parse_thermal_table(grid)
    cate = pending["cate"]

    sum_r = sum_d = 0.0
    mats = []
    for L in layers:
        R = (L["ply"] / 1000.0) / (L["diath"] * L["correct"])
        D = (L["ply"] / 1000.0) / L["diath"] * L["sDiath"]
        sum_r += R
        sum_d += D
        item = {"name": L["name"], "ply": float(L["ply"]),
                "correct": float(L["correct"]), "diath": float(L["diath"]),
                "sDiath": float(L["sDiath"]), "dataR": R}
        b = match_basis(basis, L["name"], L["diath"], cate, pending["prefix"])
        if b is not None:
            if b.cri:
                item["criName"] = b.cri
            if b.density is not None:
                item["consistency"] = float(b.density)
        mats.append(item)

        if L.get("rep_R") is not None and abs(R - L["rep_R"]) > TOL_R:
            warnings.append("%s / %s：热阻重算 %.4f 与报告 %.3f 偏差过大"
                            % (pending["name"], L["name"], R, L["rep_R"]))

    rt = sum_r + ri + re_
    k = (1.0 / rt) if rt else 0.0
    if rep_ro is not None and abs(rt - rep_ro) > TOL_R:
        warnings.append("%s：传热阻重算 %.4f 与报告 %.3f 偏差过大" % (pending["name"], rt, rep_ro))
    if rep_k is not None and abs(k - rep_k) > TOL_K:
        warnings.append("%s：传热系数重算 %.4f 与报告 %.2f 偏差过大" % (pending["name"], k, rep_k))
    if rep_d is not None and abs(sum_d - rep_d) > TOL_D:
        warnings.append("%s：热惰性指标重算 %.4f 与报告 %.2f 偏差过大" % (pending["name"], sum_d, rep_d))

    return {"cateName": cate, "name": pending["name"], "criName": opts.cri,
            "dataK": k, "dataRT": rt, "dataRE": re_, "dataRI": ri,
            "dataDrs": sum_d, "note": None, "matDetailList": mats}


def annotate_anomaly(structs, opts, notes):
    """同一材料在不同构造中导热系数相差悬殊（如报告笔误 钢筋混凝土 0.190）时追加 note 备注字段。"""
    if not opts.annotate:
        return
    pool = {}
    for s in structs:
        for m in s["matDetailList"]:
            pool.setdefault(m["name"], []).append(m["diath"])
    mode = {}
    for n, vs in pool.items():
        uniq = sorted(set(vs))
        if len(uniq) > 1:
            mode[n] = max(uniq, key=lambda x: (vs.count(x), -x))
    for s in structs:
        msgs = []
        for m in s["matDetailList"]:
            ref = mode.get(m["name"])
            if ref and (m["diath"] < ref / 2.0 or m["diath"] > ref * 2.0):
                msgs.append("报告原表中该构造“%s”导热系数取%.3f（原文如此）"
                            % (m["name"], m["diath"]))
                notes.append("%s / %s：导热系数 %s 明显偏离本文档常规值 %s"
                             % (s["name"], m["name"], m["diath"], ref))
        if msgs:
            s["note"] = "；".join(msgs)


def build_window(text, blocks, bi, heading, opts, warnings):
    frame, glass = split_frame_glass(text)
    if not frame or not glass:
        warnings.append("无法解析门窗构造行：%s" % text)
        return None

    name = ""
    for j in range(bi - 1, max(-1, bi - 6), -1):
        kind, val = blocks[j]
        if kind != "p":
            break
        v = (val or "").strip()
        if HEADING_RE.match(v):
            break
        if not v or v.startswith(("构造", "热工性能", "备注")):
            continue
        name = v
        break

    # 部分模板（如工业建筑节能报告书）没有独立构造名，名称段就是"外窗类型："这类小标题
    np = name.rstrip("：: ").strip()
    if np.endswith("类型"):
        heading = np
        name = ""

    perf = {}
    for j in range(bi + 1, min(len(blocks), bi + 6)):
        kind, val = blocks[j]
        if kind != "p":
            break
        if (val or "").startswith("热工性能"):
            perf = parse_window_perf(val)
            break

    panes, gases, gas_ply, gas_sort = parse_glass_system(glass)
    w = {"cateName": win_cate_from_heading(heading),
         "name": ("%s：%s%s" % (name, frame, glass)) if name else (frame + glass),
         "criName": opts.cri,
         "winFrameMaterial": frame, "glassSystem": glass,
         "dataK": perf.get("dataK"),
         "winterSC": perf.get("winterSC"), "summerSC": perf.get("summerSC"),
         "winterSHGC": perf.get("winterSHGC"),
         "scaleWinAndHoleFrameArea": opts.frame_ratio,
         "glassShineScale": perf.get("glassShineScale"),
         "gasPly": gas_ply, "gasSort": gas_sort,
         "gasLayerCounts": int(gases), "glassLayers": int(panes)}
    for f in ("dataK", "winterSC", "summerSC", "winterSHGC", "glassShineScale"):
        if w[f] is None:
            warnings.append("门窗「%s」缺少字段 %s" % (w["name"], f))
    if not panes:
        warnings.append("门窗「%s」玻璃系统 %s 未能解析出玻璃层数" % (w["name"], glass))
    return w


def parse_window_v2(win_line, glass_line):
    """表式窗模板（2026-09-20）：「外窗：传热系数…，外窗自身夏季/冬季太阳得热系数…，
    窗框系数…」+「玻璃：…玻璃遮阳系数…，玻璃可见光透射比…」。

    注意与段式窗模板的差异：SHGC 取「外窗自身」值（已含窗框系数折算），
    遮阳系数/可见光透射比取「玻璃」行值。"""
    def grab(pat, s):
        m = re.search(pat, s)
        return float(m.group(1)) if m else None
    return {
        "dataK":        grab(r"传热系数\s*[：:]?\s*(" + _NUM + r")", win_line),
        "summerSHGC":   grab(r"外窗自身夏季太阳得热系数\s*[：:]?\s*(" + _NUM + r")", win_line),
        "winterSHGC":   grab(r"外窗自身冬季太阳得热系数\s*[：:]?\s*(" + _NUM + r")", win_line),
        "summerSC":     grab(r"夏季玻璃遮阳系数\s*[：:]?\s*(" + _NUM + r")", glass_line),
        "winterSC":     grab(r"冬季玻璃遮阳系数\s*[：:]?\s*(" + _NUM + r")", glass_line),
        "glassShineScale": grab(r"玻璃可见光透射比\s*[：:]?\s*(" + _NUM + r")", glass_line),
        "frameRatio":   grab(r"窗框系数\s*[：:]?\s*(" + _NUM + r")", win_line),
    }


def build_window_v2(text, blocks, bi, win_type, opts, warnings):
    """表式窗模板（2026-09-20，公共建筑节能计算分析报告书等）：
    类型小标题（"外窗类型1"）+「外窗：…」+「玻璃：…」段落，无「构造：」行。
    报告不给出玻璃分层/气体层（只有整窗热工参数），按成组条目输出。"""
    glass_line = ""
    for j in range(bi + 1, min(len(blocks), bi + 4)):
        kind, val = blocks[j]
        if kind != "p":
            break
        if (val or "").startswith("玻璃："):
            glass_line = val
            break

    perf = parse_window_v2(text, glass_line)
    name = (win_type or "外窗类型1").strip()
    w = {"cateName": win_cate_from_heading(name),
         "name": name,
         "criName": opts.cri,
         "winFrameMaterial": "", "glassSystem": "",
         "dataK": perf["dataK"],
         "winterSC": perf["winterSC"], "summerSC": perf["summerSC"],
         "winterSHGC": perf["winterSHGC"],
         "scaleWinAndHoleFrameArea": perf.get("frameRatio") or opts.frame_ratio,
         "glassShineScale": perf["glassShineScale"],
         "gasPly": 0.0, "gasSort": "", "gasLayerCounts": 0, "glassLayers": 0}
    for f in ("dataK", "winterSC", "summerSC", "winterSHGC", "glassShineScale"):
        if w[f] is None:
            warnings.append("门窗「%s」缺少字段 %s（表式窗段落无此参数）" % (name, f))
    if not win_type:
        warnings.append("「外窗：」段落缺少类型小标题，默认按「外窗类型1」输出")
    return w


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
def render_jsonc(structs, windows):
    """输出标准 JSON（无注释；每个对象/数组的同级最后一个节点不带逗号），保留原排版。"""
    L = []
    A = L.append
    A("{")
    A('    "struct":')
    A("    [")
    for si, s in enumerate(structs):
        A("        {")
        A('            "cateName": %s,' % num(s["cateName"]))
        A('            "name": %s,' % num(s["name"]))
        A('            "criName": %s,' % num(s["criName"]))
        A('            "dataK": %s,' % num(s["dataK"]))
        A('            "dataRT": %s,' % num(s["dataRT"]))
        A('            "dataRE": %s,' % num(s["dataRE"]))
        A('            "dataRI": %s,' % num(s["dataRI"]))
        A('            "dataDrs": %s,' % num(s["dataDrs"]))
        if s.get("note"):
            A('            "note": %s,' % num(s["note"]))
        A('            "matDetailList":[')
        mats = s["matDetailList"]
        for mi, m in enumerate(mats):
            A("            {")
            A('                "name": %s,' % num(m["name"]))
            if "criName" in m:
                A('                "criName": %s,' % num(m["criName"]))
            A('                "ply": %s,' % num(m["ply"]))
            A('                "correct": %s,' % num(m["correct"]))
            A('                "diath": %s,' % num(m["diath"]))
            A('                "sDiath": %s,' % num(m["sDiath"]))
            if "consistency" in m:
                A('                "consistency": %s,' % num(m["consistency"]))
            A('                "dataR": %s' % num(m["dataR"]))
            A("            }%s" % ("," if mi != len(mats) - 1 else ""))
        A("            ]")
        A("        }%s" % ("," if si != len(structs) - 1 else ""))
    A("    ],")
    A('    "windows":[')
    for wi, w in enumerate(windows):
        A("    {")
        A('        "cateName":%s,' % num(w["cateName"]))
        A('        "name": %s,' % num(w["name"]))
        A('        "criName": %s,' % num(w["criName"]))
        A('        "winFrameMaterial": %s,' % num(w["winFrameMaterial"]))
        A('        "glassSystem": %s,' % num(w["glassSystem"]))
        A('        "dataK": %s,' % num(w["dataK"]))
        A('        "winterSC": %s,' % num(w["winterSC"]))
        A('        "summerSC": %s,' % num(w["summerSC"]))
        A('        "winterSHGC": %s,' % num(w["winterSHGC"]))
        A('        "scaleWinAndHoleFrameArea": %s,' % num(w["scaleWinAndHoleFrameArea"]))
        A('        "glassShineScale": %s,' % num(w["glassShineScale"]))
        A('        "gasPly": %s,' % num(w["gasPly"]))
        A('        "gasSort": %s,' % num(w["gasSort"]))
        A('        "gasLayerCounts": %s,' % num(int(w["gasLayerCounts"] or 0)))
        A('        "glassLayers": %s' % num(int(w["glassLayers"] or 0)))
        A("    }%s" % ("," if wi != len(windows) - 1 else ""))
    A("    ]")
    A("}")
    return "\n".join(L) + "\n"


def render_strict(structs, windows):
    """输出可被 json.loads 直接读取的标准 JSON。"""
    mat_keys = ("name", "criName", "ply", "correct", "diath", "sDiath", "consistency", "dataR")
    st_keys = ("cateName", "name", "criName", "dataK", "dataRT", "dataRE", "dataRI", "dataDrs")

    def cs(s):
        d = {k: s[k] for k in st_keys}
        if s.get("note"):
            d["note"] = s["note"]
        d["matDetailList"] = [{k: m[k] for k in mat_keys if k in m} for m in s["matDetailList"]]
        return d

    return json.dumps({"struct": [cs(s) for s in structs], "windows": windows},
                      ensure_ascii=False, indent=4) + "\n"


def strip_jsonc(text):
    """把 JSONC 转成可解析对象（校验用）：去 /// 注释、补 cateName 行缺失的逗号。"""
    out = []
    for line in text.split("\n"):
        i = line.find("///")
        if i >= 0:
            line = line[:i].rstrip()
        out.append(line)
    s = "\n".join(out)
    s = re.sub(r'("cateName"\s*:\s*"(?:[^"\\]|\\.)*")(\s*\n\s*")', r"\1,\2", s)
    s = re.sub(r",(\s*[}\]])", r"\1", s)          # 样例格式含尾随逗号，需清理
    return json.loads(s)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv=None, app=None, doc=None):
    ap = argparse.ArgumentParser(
        description="从 PKPM 节能计算报告书(.doc/.docx) 提取围护结构材料与门窗信息为 JSON")
    ap.add_argument("input", help="报告书路径 (.doc / .docx)")
    ap.add_argument("-o", "--output", help="输出路径，默认 <输入名>_材料.json")
    ap.add_argument("--strict", action="store_true", help="输出标准 JSON（不含 /// 注释）")
    ap.add_argument("--cri", default=DEFAULT_CRI, help="规范依据，默认：%s" % DEFAULT_CRI)
    ap.add_argument("--frame-ratio", type=float, default=DEFAULT_FRAME_AREA_RATIO,
                    help="窗框占整窗面积比，默认 %.2f" % DEFAULT_FRAME_AREA_RATIO)
    ap.add_argument("--no-annotate", dest="annotate", action="store_false",
                    help="不为异常导热系数追加 note 备注字段")
    ap.add_argument("--force", action="store_true", help="允许覆盖已存在的输出文件")
    ap.add_argument("--backend", choices=("auto", "docx", "word"), default="auto",
                    help="文档读取后端（提速改造 T3）：auto=.docx 走纯 Python、"
                         ".doc/.rtf 走 Word COM；docx=强制纯 Python（输入须为 .docx）；"
                         "word=强制 Word COM。默认 auto")
    ap.add_argument("-q", "--quiet", dest="verbose", action="store_false", help="静默模式")
    ap.set_defaults(annotate=True, verbose=True)
    opts = ap.parse_args(argv)

    src = os.path.abspath(opts.input)
    if not os.path.isfile(src):
        ap.error("找不到输入文件：%s" % src)

    if opts.output:
        out = os.path.abspath(opts.output)
    else:
        stem = os.path.splitext(src)[0]
        out = stem + "_材料.json"
        if os.path.exists(out) and not opts.force:
            out = stem + "_材料_extracted.json"
            print("[warn] 目标文件已存在，改写到：%s（加 --force 可覆盖）" % out)

    # ---- 后端选择（提速改造 T3）----
    ext = os.path.splitext(src)[1].lower()
    backend = opts.backend
    if backend == "auto":
        backend = "docx" if ext == ".docx" else "word"
    if backend == "docx" and ext != ".docx":
        raise ValueError("--backend docx 需要 .docx 输入，当前为 %s（%s）" % (ext, src))

    if backend == "docx":
        # 纯 Python 后端：零 Word 依赖，实测比 Word COM 快约 400 倍
        if opts.verbose:
            print("[1/3] 读取文档（纯 Python docx 后端）：%s" % src)
        model = DocModel.from_docx(src, verbose=opts.verbose)
        if opts.verbose:
            print("[2/3] 解析文档结构 ...")
        structs, windows, warnings, notes = extract(model, opts)
    else:
        # Word COM 后端（.doc / .rtf 直读，或调用方已打开的会话）
        # 提速改造 T1：app / doc 可由调用方传入，避免重复冷启动 Word 与重复 Open 同一文件
        if opts.verbose:
            print("[1/3] 打开文档（Word COM 后端）：%s" % src)
        own_app = app is None
        if own_app:
            app, need_quit = get_word()
        else:
            need_quit = False
        try:
            try:
                app.DisplayAlerts = 0
            except Exception:
                pass
            own_doc = doc is None
            if own_doc:
                doc = app.Documents.Open(src, False, True, False)   # 只读打开
            try:
                if opts.verbose:
                    print("[2/3] 解析文档结构 ...")
                model = DocModel(doc, verbose=opts.verbose)
                structs, windows, warnings, notes = extract(model, opts)
            finally:
                if own_doc:
                    doc.Close(False)
        finally:
            if own_app and need_quit:
                try:
                    app.Quit()
                except Exception:
                    pass

    if opts.verbose:
        print("[3/3] 生成 JSON ...")
    text = render_strict(structs, windows) if opts.strict else render_jsonc(structs, windows)
    if not opts.strict:                       # 自检：输出必须可被 json.loads 解析
        try:
            strip_jsonc(text)
        except Exception as exc:
            warnings.append("JSONC 自检失败（不影响输出文件）：%s" % exc)

    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with open(out, "w", encoding="gbk") as f:
        f.write(text)

    print("-" * 68)
    print("构造条目 struct  : %d" % len(structs))
    for s in structs:
        print("   - [%s] %s  K=%.4f  Ro=%.4f  D=%.4f  (%d 层材料)"
              % (s["cateName"], s["name"], s["dataK"], s["dataRT"], s["dataDrs"],
                 len(s["matDetailList"])))
    print("门窗条目 windows : %d" % len(windows))
    for w in windows:
        print("   - [%s] %s  K=%s  玻璃层数=%s  中空层数=%s  气体=%s/%s"
              % (w["cateName"], w["name"], w["dataK"], w["glassLayers"],
                 w["gasLayerCounts"], w["gasSort"], w["gasPly"]))
    if notes:
        print("提示 %d 条：" % len(notes))
        for x in notes:
            print("   * %s" % x)
    if warnings:
        print("警告 %d 条：" % len(warnings))
        for x in warnings:
            print("   ! %s" % x)
    print("输出文件：%s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
