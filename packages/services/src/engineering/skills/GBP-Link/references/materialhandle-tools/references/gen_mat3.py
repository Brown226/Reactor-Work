# -*- coding: utf-8 -*-
"""
从 BECS / 斯维尔(Swell) 建筑节能设计报告书(.docx) 中提取围护结构材料/构造数据，
按标准 JSON 格式输出（无注释，同级最后一个节点不带逗号），输出编码 ANSI(GBK)。

兼容性（支持斯维尔居住建筑节能设计报告书）：
* 构造表：兼容多种表头——「材料名称」「材料名称（由上到下）」「材料名称（由外到内）」，
  厚度列「厚度」「厚度δ」；自动跳过 单位行 / 各层之和∑ / 传热系数K=... /
  考虑热桥后K=... / 标准依据 / 标准要求 / 结论 等非材料层行（缺失数值即跳过，不再崩溃）。
* 表面热阻：从 K 公式总阻值推导（K=1/(0.16+∑R) → RE+RI=0.16，夏季工况），
  不再硬断言 0.15，兼容 BECS(0.15) 与斯维尔(0.16)。
* 外窗表：兼容两种表头——BECS 用「自遮阳系数」列、斯维尔用「太阳得热系数」列；
  窗名称兼容 "玻璃+气体-窗框[Kf=..,框面积..%]"（BECS）与 "12A钢铝单框双玻窗（平均）"
  （斯维尔）两种命名，自动解析气体层厚度/种类（12A→12mm空气）与玻璃层数（单/双/三玻）。
* 工程材料表：逐行防御解析，跳过单位行（W/(m.K) 等）与空行。

优化：
* 数值解析 _num 改为「取首个数字 token」：厚度列 "50(65)"→50、"0.70[默认]"→0.70，
  修复商业裙楼系列报告「挤塑聚苯板」整层因厚度含括号被跳过的问题。
* 工程材料表末列兼容「数据来源」（A#综合楼报告）与「备注」两种表头；备注无
  「来源：」前缀时直接取整格作规范依据。
* 窗名称拆分新增两种格式：「断热铝合金窗--5中透光双银Low-E+12氩气+5透明玻璃」
  （双横线、窗框在前）与「普通铝合金窗+12mm透明玻璃」（无分隔、首数字前为窗框），
  玻璃层数/气体层解析更准确。

优化（支持天正 T-Ec《公共建筑节能计算报告书》）：
* 构造表兼容「各层材料名称」表头（天正），汇总行兼容「合    计」。
* 无「工程材料表」的报告（天正无独立材料表）不再报错，材料参数直接取构造表数值。
* 表面热阻兼容天正公式行「R0=Ri+∑R+Re = 0.11」/「R0=Ri+∑R+Ri = 0.22」（传热阻/传热系数
  两行内容在第二列）；吸收系数行缺失时按公式行 R[ie] 判定内外。
* 外窗表兼容天正表头「类别|类型|传热系数|遮阳系数|可见光透射比」（遮阳系数=SC→SHGC=SC×0.87，
  类型列代替构造名称列，类别列区分 窗/透明幕墙）。
* 窗框兼容天正「窗类型N：隔热铝合金, 75系列平开窗(…)」段落（逗号前为窗框材料）。
* 外门兼容天正「外门类型|传热系数|标准规定|结论」表。

注意：解析核心与 user_skills/becs-material-json/references/bec/gen_mat2.py 保持一致，改动需同步。
"""
import re, os, json

import sys as _sys
WORKDIR = _sys.argv[1] if len(_sys.argv) > 1 else r"C:\Users\LinLin\Documents\PKPMAgent\01a08a42-3496-7b52-b4a1-14cdcff4bb06"
DOCX    = _sys.argv[2] if len(_sys.argv) > 2 else r"D:\Downloads\BECS\0.6\0.6.docx"
OUT     = _sys.argv[3] if len(_sys.argv) > 3 else os.path.join(os.path.dirname(DOCX), os.path.splitext(os.path.basename(DOCX))[0] + "_材料.txt")

# cateName 重命名（BECS Skill）
CATE_RENAME = {
    "屋面": "屋面主体层",
    "外墙": "填充墙",
    "楼梯间隔墙": "内墙填充墙",
    "楼板": "层间楼板",
}

# ---------------------------------------------------------------- 0. 通用工具
def _cell(r, j):
    return r[j].strip() if j is not None and j < len(r) else ""

def _num(r, j):
    """取单元格中第一个数值（兼容 "50(65)"→50、"0.70[默认]"→0.70、"－"→None）。
    2026-09-20：改为「取首个数字 token」，修复商业裙楼报告厚度列 "50(65)" 被整体
    float() 失败导致整层被跳过的问题。"""
    s = _cell(r, j)
    if not s:
        return None
    m = re.search(r"[-+]?\d+(?:\.\d+)?", s.replace(",", ""))
    return float(m.group()) if m else None

def _find_col(hdr, *keys):
    """在表头中查找第一个包含任一关键字的列号（表头去空格后匹配），找不到返回 None。"""
    for j, h in enumerate(hdr):
        hh = h.replace(" ", "")
        for k in keys:
            if k in hh:
                return j
    return None

# ---------------------------------------------------------------- 1. 读 docx（纯 Python 解析，不依赖 Word COM）
import sys
sys.path.insert(0, WORKDIR)
import docx_parse as DP

_items = DP.parse_docx(DOCX)
full_text = DP.full_text(_items)

grids, titles = {}, {}
_last_paras = []
_ti = 0
for _it in _items:
    if _it[0] == "p":
        s = _it[1].replace("\x07", "").replace("\x0b", "").strip()
        if s:
            _last_paras.append(s)
            _last_paras = _last_paras[-6:]
    else:
        _ti += 1
        grids[_ti] = _it[1]
        titles[_ti] = _last_paras[-1] if _last_paras else ""

# ---------------------------------------------------------------- 2. 工程材料表
mats = {}          # name -> dict
mat_order = []
for i, rows in grids.items():
    if not (rows and rows[0]):
        continue
    if not rows[0][0].replace(" ", "").startswith("材料名称"):
        continue
    # 2026-09-20：末列兼容「备注」与「数据来源」两种表头（A#综合楼报告用「数据来源」）
    if _find_col(rows[0], "备注") is None and _find_col(rows[0], "数据来源") is None:
        continue
    hdr = rows[0]
    c_name  = _find_col(hdr, "材料名称")
    c_diath = _find_col(hdr, "导热系数")
    c_sd    = _find_col(hdr, "蓄热系数")
    c_rho   = _find_col(hdr, "密度")
    c_cp    = _find_col(hdr, "比热容")
    c_steam = _find_col(hdr, "蒸汽渗透")
    c_rmk   = _find_col(hdr, "备注")
    if c_rmk is None:
        c_rmk = _find_col(hdr, "数据来源")
    for r in rows[1:]:
        nm = _cell(r, c_name)
        if not nm:
            continue
        diath = _num(r, c_diath)
        if diath is None:
            # 单位行（W/(m.K) 等）或汇总行：跳过
            continue
        remark = _cell(r, c_rmk)
        cri = ""
        # 2026-09-20：兼容「来源：《…》」前缀与直接给规范名（A#报告「数据来源」列无前缀）
        m = re.match(r"^来源[:：]\s*(.+)$", remark)
        if m:
            cri = m.group(1).strip()
        else:
            cri = remark.strip()
        steam_raw = _cell(r, c_steam)
        steam_none = ("蒸汽渗透系数没有给出" in remark) or ("没有给出" in steam_raw)
        steam_v = _num(r, c_steam)
        mats[nm] = dict(
            name        = nm,
            diath       = diath,
            sDiath      = _num(r, c_sd) or 0.0,
            consistency = _num(r, c_rho) or 0.0,
            dataSpecific= _num(r, c_cp) or 0.0,
            steam_raw   = steam_raw,
            steam_none  = steam_none,
            steamQuotiety = steam_v if steam_v is not None else 0.0,
            criName     = cri,
            remark      = remark,
        )
        mat_order.append(nm)
    break
if not mats:
    # 2026-09-21：天正（T-Ec）等模板无独立「工程材料表」，材料参数直接取构造表值
    print("[warn] 未找到工程材料表（天正等模板无独立材料表），材料参数将直接采用构造表数值")

# ---------------------------------------------------------------- 3. 构造表
def is_layer_table(rows):
    if len(rows) < 3 or not rows[0]: return False
    h0 = rows[0][0].replace(" ", "")
    # 2026-09-21：兼容天正表头「各层材料名称」（BECS 为「材料名称（由上到下）」等）
    return "材料名称" in h0 and any("厚度" in x for x in rows[0])

def parse_layer_table(rows):
    hdr = rows[0]
    c_name  = _find_col(hdr, "材料名称")
    c_ply   = _find_col(hdr, "厚度")
    c_diath = _find_col(hdr, "导热系数")
    c_sd    = _find_col(hdr, "蓄热系数")
    c_corr  = _find_col(hdr, "修正系数")
    c_R     = _find_col(hdr, "热阻")
    c_D     = _find_col(hdr, "热惰性")
    if c_name is None or c_ply is None:
        return None
    layers, sumR_doc, sumD_doc, kformula, cri, absorb = [], None, None, None, "", None
    skipped = []
    for r in rows[1:]:
        c0 = _cell(r, c_name)
        if not c0:
            continue
        # 天正模板：公式行/结论行内容在第二列（c_ply 位置），如
        #   「屋面主体部位传热阻 | R0=Ri+∑R+Re = 0.11」
        #   「屋面主体部位传热系数 | K = 1/R0 =0.15」
        c1 = _cell(r, c_ply)
        c0s = c0.replace(" ", "")
        if c0s.startswith("各层之和") or "合计" in c0s:
            sumR_doc = _cell(r, c_R); sumD_doc = _cell(r, c_D); continue
        if "太阳辐射吸收系数" in c0:
            absorb = _cell(r, c_ply) or _cell(r, c_diath); continue
        if c0s.startswith("传热系数K") or "传热系数" in c0s:
            # 追加而非覆盖：天正模板「R0=…」行先出现，须保留供 surface_resistances 使用
            kformula = (kformula + " " if kformula else "") + c0 + (" " + c1 if c1 else ""); continue
        if "传热阻" in c0 or c1.startswith("R0="):
            # 天正表面热阻公式行：R0=Ri+∑R+Re = 0.11（并入 kformula 供 surface_resistances 使用）
            kformula = (kformula or "") + "|" + c1; continue
        if c0s.startswith("考虑热桥"):
            continue
        if c0 == "标准依据":
            cri = _cell(r, c_ply); continue
        if c0s in ("标准要求", "结论", "标准规定", "修正后K,D", "修正后K, D", "修正原因"):
            continue
        ply = _num(r, c_ply); diath = _num(r, c_diath); sd = _num(r, c_sd)
        if ply is None or diath is None:
            skipped.append(c0)
            continue
        layers.append(dict(name=c0,
                           ply=ply,
                           diath=diath,
                           sDiath=sd if sd is not None else 0.0,
                           correct=_num(r, c_corr) if c_corr is not None else 1.0,
                           R_doc=_cell(r, c_R),
                           D_doc=_cell(r, c_D)))
    return layers, sumR_doc, sumD_doc, kformula, cri, absorb, skipped

constr_tables = []      # (title, table_index, parsed)
seen = set()
_skipped_rows = []
for i, rows in grids.items():
    if is_layer_table(rows):
        ti = titles[i]
        if ti in seen: continue
        seen.add(ti)
        parsed = parse_layer_table(rows)
        if parsed is None:
            continue
        constr_tables.append((ti, i, parsed))
        _skipped_rows.extend(parsed[-1])

# ---------------------------------------------------------------- 4. 类别归一
def cate_of(section_text, constr_name):
    s = section_text + constr_name
    if "屋顶" in s or "屋面" in s:            return "屋面"
    if "热桥" in s:                            return "热桥柱"
    if "楼梯间" in s or "走廊隔墙" in s:       return "楼梯间隔墙"
    if "分户墙" in s:                          return "分户墙"
    if "架空" in s or "外挑" in s:             return "架空或外挑楼板"
    if "楼板" in s or "地面" in s:             return "楼板"
    if "外墙" in s or "山墙" in s:             return "外墙"
    if "内墙" in s:                            return "内墙"
    return section_text

# 从"围护结构作法简要说明"取 章节名 -> 构造名 顺序
# 注意：文档目录(TOC)里也有"围护结构作法简要说明…体形系数"，必须取最后一次出现（正文节）
brief = []
pos = full_text.rfind("围护结构作法简要说明")
if pos >= 0:
    mb = re.search(r"围护结构作法简要说明(.*?)(?:体形系数|$)", full_text[pos:], re.S)
    if mb:
        blk = mb.group(1)
        for item in re.split(r"\r(?=\d+\.\s)", blk):
            m = re.match(r"\s*\d+\.\s*([^：:]+)[：:]\s*([^：:]+)[：:]", item.replace("\x07", ""))
            if m:
                brief.append((m.group(1).strip(), m.group(2).strip(), item))
            else:
                m2 = re.match(r"\s*\d+\.\s*([^：:]+)[：:]\s*(.+)", item.replace("\x07", ""), re.S)
                if m2: brief.append((m2.group(1).strip(), m2.group(2).split("：")[0].strip(), item))

brief_map = {c: (sec, raw) for sec, c, raw in brief}

# 构件类型（外墙平均热工特性表）: 构造名称 -> 构件类型
comp_type = {}
for i, rows in grids.items():
    if rows and rows[0] and rows[0][0].replace(" ", "") == "构造名称" and any("构件" in x for x in rows[0]):
        for r in rows[1:]:
            if len(r) > 1 and r[0] and r[1] and r[0] != "合计":
                comp_type.setdefault(r[0].strip(), r[1].strip())

DEFAULT_CRI = "《建筑节能与可再生能源利用通用规范》GB55015-2021"
m = re.search(r"设计依据\r?\s*1\.\s*(《[^》]+》[A-Za-z0-9\-]+)", full_text)
if m: DEFAULT_CRI = m.group(1)

def clean_cri(s):
    if not s: return DEFAULT_CRI
    s = re.split(r"第[\d\.]+条", s)[0].strip()
    return s or DEFAULT_CRI

# 表面热阻：优先从 K 公式总阻值推导，兼容 0.15(冬季)/0.16(夏季) 等
def surface_resistances(kformula, exterior):
    mk = re.search(r"K\s*=\s*1\s*/\s*\(\s*([\d\.]+)\s*\+", kformula or "")
    if mk:
        tot = float(mk.group(1))
        if exterior:
            if abs(tot - 0.16) < 1e-6:   return 0.05, 0.11   # 夏季工况（斯维尔常见）
            if abs(tot - 0.15) < 1e-6:   return 0.04, 0.11   # 冬季工况（BECS 常见）
            re_ = 0.04 if tot > 0.15 else 0.0
            return round(re_, 6), round(tot - re_, 6)
        return round(tot / 2.0, 6), round(tot / 2.0, 6)      # 两侧室内对称
    # 2026-09-21：天正模板公式行「R0=Ri+∑R+Re = 0.11」/「R0=Ri+∑R+Ri = 0.22」
    m0 = re.search(r"R0\s*=\s*Ri\s*\+\s*∑R\s*\+\s*R([ie])\s*=\s*([\d\.]+)", kformula or "")
    if m0:
        tot = float(m0.group(2))
        if m0.group(1) == "i":
            return round(tot / 2.0, 6), round(tot / 2.0, 6)
        if tot >= 0.15:
            return round(tot - 0.11, 6), 0.11
        return 0.0, round(tot, 6)
    return (0.04, 0.11) if exterior else (0.11, 0.11)

# ---------------------------------------------------------------- 5. 组装 struct
struct_list = []
for title, ti, (layers, sumR_doc, sumD_doc, kformula, cri, absorb, _sk) in constr_tables:
    sec, _raw = brief_map.get(title, ("", ""))
    ct = comp_type.get(title, "")
    cate = cate_of(sec or ct, ct if ct in ("热桥柱",) else title)
    if ct == "热桥柱": cate = "热桥柱"
    cate = CATE_RENAME.get(cate, cate)

    # 表面热阻：有"外表面太阳辐射吸收系数"行 => 外侧暴露，否则两侧均为室内
    exterior = absorb is not None
    dataRE, dataRI = surface_resistances(kformula, exterior)

    mat_list, Rlist, Dlist = [], [], []
    for L in layers:
        nm = L["name"]
        info = mats.get(nm)
        diath  = info["diath"]  if info else L["diath"]
        sDiath = info["sDiath"] if info else L["sDiath"]
        if abs(diath - L["diath"]) > 1e-6:
            print("[warn] %s/%s: 构造表导热系数 %s 与材料表 %s 不一致，按材料表取值"
                  % (title, nm, L["diath"], diath))
        if abs(sDiath - L["sDiath"]) > 1e-6:
            print("[warn] %s/%s: 构造表蓄热系数 %s 与材料表 %s 不一致，按材料表取值"
                  % (title, nm, L["sDiath"], sDiath))
        R = (L["ply"] / 1000.0) / (diath * L["correct"])
        D = R * sDiath * L["correct"]
        Rlist.append(R); Dlist.append(D)
        d = {"name": nm}
        if info and info["criName"]: d["criName"] = info["criName"]
        d["ply"] = float(L["ply"]); d["correct"] = float(L["correct"])
        d["diath"] = diath; d["sDiath"] = sDiath
        d["consistency"]  = info["consistency"]  if info else 0.0
        if not (info and info["steam_none"]):
            d["steamQuotiety"] = info["steamQuotiety"] if info else 0.0
        d["dataSpecific"] = info["dataSpecific"] if info else 0.0
        d["dataR"] = R
        mat_list.append(d)

    dataRT  = dataRE + dataRI + sum(Rlist)
    dataK   = 1.0 / dataRT
    sumD    = sum(Dlist)
    struct_list.append(dict(cateName=cate, name=title, criName=clean_cri(cri),
                            dataK=dataK, dataRT=dataRT, dataRE=dataRE, dataRI=dataRI,
                            dataDrs=sumD, matDetailList=mat_list,
                            _doc=(sumR_doc, sumD_doc, kformula)))

# ---------------------------------------------------------------- 6. 外窗
GAS_WORDS = "A(?:IR)?|AR|KR|XE|N2|空气|氩气|氪气|氙气|氮气|真空|惰性气体|混合气体|SF6|六氟化硫"
GAS_TOK = re.compile(r"^(\d+(?:\.\d+)?)\s*(" + GAS_WORDS + r")$", re.I)
GAS_SCAN = re.compile(r"(\d+(?:\.\d+)?)\s*(" + GAS_WORDS + r")", re.I)

def _gas_sort(raw):
    """气体代号 -> 中文名：12A→空气，12Ar→氩气，12空气→空气。"""
    r = raw.strip()
    u = r.upper()
    if r == "A" or u == "AIR": return "空气"
    if u == "AR":   return "氩气"
    if u == "KR":   return "氪气"
    if u == "XE":   return "氙气"
    if u == "N2" or u == "N₂": return "氮气"
    if not r.isascii():        return r     # 中文气体名原样返回
    return "空气"

FRAME_WORDS = ["断桥铝合金", "断桥铝", "铝合金", "塑钢", "钢铝", "铝木", "塑料", "实木", "彩钢"]
def _guess_frame(nm):
    for f in FRAME_WORDS:
        if f in nm:
            return f
    return ""

def _split_frame_glass(base):
    """从窗构造名拆分 (glass_sys, frame_mat)；拆分不出返回 (None, None)。
    2026-09-20 新增，兼容三种命名：
      1) "断热铝合金窗--5中透光双银Low-E+12氩气+5透明玻璃"（双横线，窗框在前）
      2) "5透明+12空气-铝合金[Kf=…]"（BECS 单横线，窗框在后）
      3) "普通铝合金窗+12mm透明玻璃"（无分隔，首数字前为窗框）
    2026-09-21 新增：天正风格 "75系列平开窗(5Low-E+12Ar+5Low-E+12Ar+5暖边)"
      ——括号内为玻璃系统、括号前为类型名（窗框材料在「窗类型N：…」段落另行匹配）。
      注意必须先剥括号，否则 "5Low-E" 中的单横线会被 2) 分支误切。
    """
    mb = re.search(r"^(.*?)[(（](.*)[)）]$", base.strip())
    if mb and mb.group(2):
        inner = mb.group(2).strip()
        if inner and any(ch.isdigit() for ch in inner) and not any(f in inner for f in FRAME_WORDS):
            return inner, ""
    if "--" in base:
        left, _, right = base.rpartition("--")
        left, right = left.strip(), right.strip()
        if left and right:
            return right, left
    if "-" in base:
        left, _, right = base.rpartition("-")
        left, right = left.strip(), right.strip()
        if left and right:
            if right[:1].isdigit():      # 右侧以数字开头 → 右侧是玻璃系统
                return right, left
            return left, right           # BECS 式：左侧玻璃，右侧窗框
    m = re.search(r"\d", base)
    if m and m.start() > 0:
        head, rest = base[:m.start()], base[m.start():]
        if any(f in head for f in FRAME_WORDS):
            return rest.strip("+＋ "), head.rstrip("+＋ ")
    return None, None

def parse_window_name(nm):
    """从窗构造名称解析 (glass_sys, frame_mat, gas_ply, gas_sort, gas_layers, glass_cnt)。
    兼容 BECS 式 "玻璃+气体-窗框[Kf=..,框面积..%]"、斯维尔式 "12A钢铝单框双玻窗（平均）"
    与 "断热铝合金窗--5中透光双银Low-E+12氩气+5透明玻璃"（2026-09-20 新增）。"""
    base = nm.split("[")[0].strip()
    gs_f = _split_frame_glass(base)
    if gs_f and gs_f[0]:
        glass_sys, frame_mat = gs_f
    else:
        glass_sys, frame_mat = base, _guess_frame(base)
    gas_ply, gas_sort, gas_layers, glass_cnt = 0.0, "", 0, 0
    for tk in re.split(r"[+＋]", glass_sys):
        tk = tk.strip()
        if not tk:
            continue
        mg = GAS_TOK.match(tk)
        if mg:
            gas_layers += 1
            gas_ply = float(mg.group(1))
            gas_sort = _gas_sort(mg.group(2))
        else:
            glass_cnt += 1
    # 无 "+" 分段（斯维尔式整名）：整名扫描气体层，如 "12A钢铝单框双玻窗"
    if gas_layers == 0:
        mw = GAS_SCAN.search(glass_sys)
        if mw:
            gas_ply = float(mw.group(1))
            gas_sort = _gas_sort(mw.group(2))
            gas_layers = 1
    # 玻璃层数：优先"单/双/三/四/五玻"，否则以分段数兜底
    mc = re.search(r"(单|双|三|四|五)玻", glass_sys)
    if mc:
        glass_cnt = {"单": 1, "双": 2, "三": 3, "四": 4, "五": 5}[mc.group(1)]
    elif glass_cnt == 0 and glass_sys:
        glass_cnt = 1
    return glass_sys, frame_mat, gas_ply, gas_sort, gas_layers, glass_cnt

windows_list = []
for i, rows in grids.items():
    if not (rows and rows[0]):
        continue
    hdr0 = rows[0]
    # 2026-09-21：兼容天正表头（首列「类别」，类型列名「类型」，遮阳列名「遮阳系数」）
    if hdr0[0].replace(" ", "") not in ("序号", "类别"):
        continue
    if _find_col(hdr0, "构造名称") is None and _find_col(hdr0, "类型") is None:
        continue
    if _find_col(hdr0, "传热系数") is None:
        continue
    if _find_col(hdr0, "可见光透射比") is None:
        continue
    has_sc   = _find_col(hdr0, "自遮阳系数") is not None   # BECS
    has_shgc = _find_col(hdr0, "太阳得热系数") is not None # 斯维尔
    has_sc2  = _find_col(hdr0, "遮阳系数") is not None     # 天正（SC 列）
    if not (has_sc or has_shgc or has_sc2):
        continue
    c_name = _find_col(hdr0, "构造名称")
    if c_name is None:
        c_name = _find_col(hdr0, "类型")
    c_K    = _find_col(hdr0, "传热系数")
    c_sc   = _find_col(hdr0, "自遮阳系数")
    c_shgc = _find_col(hdr0, "太阳得热系数")
    c_sc2  = _find_col(hdr0, "遮阳系数")
    c_vis  = _find_col(hdr0, "可见光透射比")
    c_rmk  = _find_col(hdr0, "备注")
    for r in rows[1:]:
        nm = _cell(r, c_name)
        if not nm: continue
        K = _num(r, c_K)
        if K is None: continue
        vis = _num(r, c_vis) or 0.0
        rmk = _cell(r, c_rmk)
        mv = re.search(r"玻璃可见光透射比\s*=\s*([\d\.]+)", rmk)
        if mv: vis = float(mv.group(1))
        if has_sc:
            SC = _num(r, c_sc) or 0.0
            shgc = round(SC * 0.87, 3)          # BECS: 自遮阳系数 -> SHGC
        elif has_shgc:
            shgc = _num(r, c_shgc) or 0.0
            SC = round(shgc / 0.87, 3)          # 斯维尔: 太阳得热系数 -> SC
        else:
            SC = _num(r, c_sc2) or 0.0          # 天正: 遮阳系数（SC）
            shgc = round(SC * 0.87, 3)

        glass_sys, frame_mat, gas_ply, gas_sort, gas_layers, glass_cnt = parse_window_name(nm)
        # 2026-09-21：天正窗框在「窗类型N：隔热铝合金, 75系列平开窗(…)」段落（逗号前）
        if not frame_mat:
            mtf = re.search(r"窗类型\s*\d+\s*[：:]\s*([^,，]+)[,，]\s*" + re.escape(nm), full_text)
            if mtf:
                frame_mat = mtf.group(1).strip()
        mkf = re.search(r"Kf\s*=\s*([\d\.]+)", nm)
        mfa = re.search(r"框面积\s*([\d\.]+)\s*%", nm)
        # 太阳得热系数：优先取"简要说明"中的高精度值
        msh = re.search(re.escape(nm) + r"[：:]\s*\r?\s*传热系数\s*([\d\.]+)\s*W/(?:m\^2|m2|㎡)\.?\s*K[，,]\s*太阳得热系数\s*([\d\.]+)",
                        full_text)
        if msh:
            K = float(msh.group(1))
            shgc = float(msh.group(2))
            if not has_sc and not has_sc2:
                SC = round(shgc / 0.87, 3)
        # 2026-09-21：天正「类别」列区分 窗 / 透明幕墙（BECS/斯维尔首列为序号，保持外窗）
        cat_hint = _cell(r, 0).strip().replace(" ", "")
        if cat_hint == "透明幕墙":
            cate_out = "透明幕墙"
        else:
            cate_out = "外窗"
        windows_list.append(dict(cateName=cate_out, name=nm, criName=DEFAULT_CRI,
            winFrameMaterial=frame_mat, glassSystem=glass_sys, dataK=K,
            winterSC=SC, summerSC=SC, winterSHGC=shgc,
            winFrameK=float(mkf.group(1)) if mkf else 0.0,
            scaleWinAndHoleFrameArea=(float(mfa.group(1)) / 100.0) if mfa else 0.0,
            glassShineScale=vis, gasPly=gas_ply, gasSort=gas_sort,
            gasLayerCounts=gas_layers, gasGlassCounts=glass_cnt))
    break

# ---------------------------------------------------------------- 7. 门
doors_list = []
DOOR_CATE = [("通往封闭空间的户门", "户门", "(通往封闭空间的户门)"),
             ("通往非封闭空间或户外的户门", "外门", "(通往非封闭空间或户外的户门)")]
for i, rows in grids.items():
    h0 = rows[0][0].replace(" ", "") if (rows and rows[0]) else ""
    if h0 != "构造名称" and "外门" not in h0:
        continue
    if _find_col(rows[0], "传热系数") is None:
        continue
    ti = titles[i]
    joined = "".join(rows[0])
    hit = None
    for key, cate, note in DOOR_CATE:
        if key in ti or key in joined:
            hit = (cate, note); break
    # 2026-09-21：天正「外门类型 | 传热系数 | 标准规定 | 结论」表
    if not hit and ("外门" in h0 or "外门" in joined):
        hit = ("外门", "(通往非封闭空间或户外的户门)")
    if not hit: continue
    if any(d["cateName"] == hit[0] for d in doors_list): continue
    hdr = rows[0]
    c_K = _find_col(hdr, "传热系数")
    for r in rows[1:]:
        nm = r[0].strip()
        if not nm or nm in ("标准依据", "标准要求", "结论"): continue
        Kv = _num(r, c_K)
        if Kv is None: continue
        md = re.search(re.escape(ti) + r"[：:]\s*" + re.escape(nm) + r"[：:]\s*\r?\s*传热系数([\d\.]+)W/m", full_text)
        if md: Kv = float(md.group(1))
        doors_list.append(dict(cateName=hit[0], name=nm, criName=DEFAULT_CRI,
                               doorPanelName=nm, dataK=Kv, _note=hit[1]))
        break

# ---------------------------------------------------------------- 8. 输出（标准 JSON：无注释，同级最后一个节点不带逗号）
def num(v):
    return repr(float(v))

def q(s):
    return json.dumps(str(s), ensure_ascii=False)


L = []
A = L.append
A("{\r\n")
A('    "struct":\r\n')
A("    [\r\n")
for si, s in enumerate(struct_list):
    A("        {\r\n")
    A('            "cateName": ' + q(s["cateName"]) + ",\r\n")
    A('            "name": ' + q(s["name"]) + ",\r\n")
    A('            "criName": ' + q(s["criName"]) + ",\r\n")
    A('            "dataK": ' + num(s["dataK"]) + ",\r\n")
    A('            "dataRT": ' + num(s["dataRT"]) + ",\r\n")
    A('            "dataRE": ' + num(s["dataRE"]) + ",\r\n")
    A('            "dataRI": ' + num(s["dataRI"]) + ",\r\n")
    A('            "dataDrs": ' + num(s["dataDrs"]) + ",\r\n")
    A('            "matDetailList":[\r\n')
    ml = s["matDetailList"]
    for mi, m in enumerate(ml):
        A("            {\r\n")
        A('                "name": ' + q(m["name"]) + ",\r\n")
        if "criName" in m:
            A('                "criName": ' + q(m["criName"]) + ",\r\n")
        A('                "ply": ' + num(m["ply"]) + ",\r\n")
        A('                "correct": ' + num(m["correct"]) + ",\r\n")
        A('                "diath": ' + num(m["diath"]) + ",\r\n")
        A('                "sDiath": ' + num(m["sDiath"]) + ",\r\n")
        A('                "consistency": ' + num(m["consistency"]) + ",\r\n")
        if "steamQuotiety" in m:
            A('                "steamQuotiety": ' + num(m["steamQuotiety"]) + ",\r\n")
        A('                "dataSpecific": ' + num(m["dataSpecific"]) + ",\r\n")
        A('                "dataR": ' + num(m["dataR"]) + "\r\n")
        A("            }" + (",\r\n" if mi < len(ml) - 1 else "\r\n"))
    A("            ]\r\n")
    A("        }" + (",\r\n" if si < len(struct_list) - 1 else "\r\n"))
A("    ],\r\n")

A('    "windows":[\r\n')
for wi, w in enumerate(windows_list):
    A("    {\r\n")
    A('        "cateName":' + q(w["cateName"]) + ",\r\n")
    A('        "name": ' + q(w["name"]) + ",\r\n")
    A('        "criName": ' + q(w["criName"]) + ",\r\n")
    A('        "winFrameMaterial": ' + q(w["winFrameMaterial"]) + ",\r\n")
    A('        "glassSystem": ' + q(w["glassSystem"]) + ",\r\n")
    A('        "dataK": ' + num(w["dataK"]) + ",\r\n")
    A('        "winterSC": ' + num(w["winterSC"]) + ",\r\n")
    A('        "summerSC": ' + num(w["summerSC"]) + ",\r\n")
    A('        "winterSHGC": ' + num(w["winterSHGC"]) + ",\r\n")
    A('        "winFrameK": ' + num(w["winFrameK"]) + ",\r\n")
    A('        "scaleWinAndHoleFrameArea": ' + num(w["scaleWinAndHoleFrameArea"]) + ",\r\n")
    A('        "glassShineScale": ' + num(w["glassShineScale"]) + ",\r\n")
    A('        "gasPly": ' + num(w["gasPly"]) + ",\r\n")
    A('        "gasSort": ' + q(w["gasSort"]) + ",\r\n")
    A('        "gasLayerCounts": ' + str(int(w["gasLayerCounts"])) + ",\r\n")
    A('        "gasGlassCounts": ' + str(int(w["gasGlassCounts"])) + "\r\n")
    A("    }" + (",\r\n" if wi < len(windows_list) - 1 else "\r\n"))
A("    ],\r\n")

A('    "doors":\r\n')
A("    [\r\n")
for di, d in enumerate(doors_list):
    A("        {\r\n")
    A('        "cateName":' + q(d["cateName"]) + ",\r\n")
    A('        "name": ' + q(d["name"]) + ",\r\n")
    A('        "criName": ' + q(d["criName"]) + ",\r\n")
    A('        "doorPanelName": ' + q(d["doorPanelName"]) + ",\r\n")
    A('        "dataK": ' + num(d["dataK"]) + "\r\n")
    A("        }" + (",\r\n" if di < len(doors_list) - 1 else "\r\n"))
A("    ]\r\n")
A("}\r\n")

out = "".join(L)
import stat as _stat
for _out in (OUT, os.path.join(WORKDIR, os.path.basename(OUT))):
    try:
        if os.path.exists(_out):
            os.chmod(_out, os.stat(_out).st_mode | _stat.S_IWRITE)
    except Exception:
        pass
with open(OUT, "w", encoding="gbk", newline="") as f:
    f.write(out)
with open(os.path.join(WORKDIR, os.path.basename(OUT)), "w", encoding="gbk", newline="") as f:
    f.write(out)

print("材料数:", len(mats))
print("构造数:", len(struct_list), [ (s["cateName"], s["name"]) for s in struct_list ])
print("外窗数:", len(windows_list), [ (w["name"], w["dataK"], w["winterSHGC"]) for w in windows_list ])
print("门数:", len(doors_list))
if _skipped_rows:
    print("[warn] 跳过非材料层行：", "；".join(_skipped_rows[:20]))
print("输出:", OUT, len(out), "字符")
