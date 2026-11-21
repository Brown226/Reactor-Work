#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Query and interpret MulCkdata SQLite review databases.

Stdlib-only helper. It reads TEXT as raw bytes and decodes defensively because
some MulCkdata DBs contain mixed UTF-8/GBK text.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

DRAW_KIND_LABELS = {0: "施工图", 1: "配筋简图"}

TABLE_ALIASES = {
    "dwg": ["DwgInfo"],
    "draw": ["DrawInfo", "DrwInfo"],
    "wpj": ["WpjInfo"],
    "reviews": ["SElesTable"],
    "simple_beam": ["SSimpleLocBeamTable"],
    "simple_col": ["SSimpleLocColTable"],
    "check_beam": ["CheckDataBeamTable"],
    "check_col": ["CheckDataColTable"],
    "base_check": ["CheckDataBaseTable", "CheckBaseDataTable"],
    "drw_beam": ["DrwDataBeamTable"],
    "drw_col": ["DrwDataColTable"],
    "elevation": ["ElevationTable"],
}

DRWTYPE_BITS = {1: "梁平面", 2: "柱平面", 4: "墙平面", 8: "板平面", 16: "柱表", 32: "墙大样"}
SEL_CHECKRLST_BITS = {1: "梁已阅", 2: "柱已阅", 4: "墙已阅", 8: "板已阅"}
OV_TYPE_BITS = {
    1: "宜",
    2: "应",
    4: "黑体",
    8: "使用附加限值",
    16: "按实计算",
    32: "用户附加",
    64: "属性丢失",
    128: "识别有误",
}
REVIEW_CLASS_PRIORITY = {"强条": 0, "应": 1, "宜": 2, "其他": 3}
CHECK_RESULT_TYPES = {1: "计算与实配比较", 2: "规范校审", 3: "图面检查"}
GJTYPE_NAMES = {0: "框架梁", 1: "连梁", 2: "框架柱", 3: "墙身", 4: "板"}
COMPONENTTYPE_NAMES = {0: "梁", 1: "柱", 2: "墙身", 3: "边缘构件", 4: "墙梁", 5: "板", 6: "板支座"}
BEAM_DETAILTYPE_NAMES = {
    0: "框架梁",
    1: "非框架梁",
    2: "连梁",
    3: "转换梁",
    4: "悬挑梁",
    5: "左端框梁",
    6: "右端框梁",
}
COL_DETAILTYPE_BITS = {
    1: "型钢混凝土柱",
    2: "异形柱",
    4: "角柱",
    8: "转换柱",
}
COL_DETAILTYPE_ZERO = "普通混凝土柱"
BEAM_MAINBAR_POSITIONS = [
    "上部通长筋",
    "左支座",
    "右支座",
    "架立筋",
    "下部入支座筋",
    "不入支座筋",
    "腰筋",
]
COLUMN_MAINBAR_RECT_POSITIONS = ["角筋（全部角筋）", "B边（不含角筋）", "H边（不含角筋）"]
COLUMN_MAINBAR_CIRCLE_POSITIONS = ["全截面", "未用位置2", "未用位置3"]
COLUMN_MAINBAR_IRREGULAR_POSITIONS = ["第1肢配筋", "第2肢配筋", "第3肢配筋"]
COLUMN_MAINBAR_GENERIC_POSITIONS = [
    "角筋/全截面/第1肢",
    "B边（不含角筋）/第2肢",
    "H边（不含角筋）/第3肢",
]
COLUMN_SECTION_TYPE_NAMES = {1: "矩形柱", 3: "圆形柱", 4: "L形异形柱", 5: "T形异形柱", 6: "Z形异形柱", 7: "十字形异形柱"}
COLUMN_IRREGULAR_EXPECTED_SLOTS = {4: 2, 5: 2, 6: 3, 7: 2}
BEAM_STEELINFO_POSITIONS = [
    "左上纵筋",
    "中上纵筋",
    "右上纵筋",
    "左下纵筋",
    "中下纵筋",
    "右下纵筋",
    "加密/非加密区箍筋综合",
    "加密区箍筋",
    "非加密区箍筋",
    "腰筋",
    "受扭腰筋",
]
COLUMN_STEELINFO_POSITIONS = [
    "角筋",
    "B边纵筋",
    "H边纵筋",
    "加密/非加密区箍筋综合",
    "节点核心区箍筋",
    "加密区箍筋",
    "非加密区箍筋",
]
BEAM_STISTEEL_POSITIONS = ["加密区箍筋", "非加密区箍筋"]
COLUMN_STISTEEL_ZONES = ["节点核心区", "加密区", "非加密区"]
COLUMN_STISTEEL_SIDES = ["B边箍筋", "H边箍筋"]
REBAR_GRADE_LETTERS = {
    1: "F",  # HPB235
    2: "B",  # HRB335
    3: "C",  # HRB400
    4: "C",  # RRB400
    5: "A",  # HPB300
    6: "D",  # HRB500/HRBF500
    7: "E",  # CRR550
    8: "G",  # CRB600H
    9: "H",  # HTRB600
    10: "I",  # T63
}
DRAW_INFO_SPECS = {
    0: ("iDwgType", "图纸类型代码", "int"),
    2: ("iFloor", "图纸楼层号集合", "int_list"),
    3: ("outline_points", "图纸在 CAD 中的四个角点轮廓坐标", "points"),
    4: ("cDwgTitle", "图纸图名", "str"),
    5: ("cfloorname", "图名中的楼层关键字", "str"),
    6: ("cTypeName", "图名中的图纸类型关键字", "str"),
    7: ("iCheckRlstType", "图纸校审意见处理结果代码", "int"),
    8: ("iCheckstatus", "图纸校审状态代码", "int"),
    9: ("MatDealRlst", "图纸手动校审标记信息", "int_list"),
    10: ("code_ids", "本图涉及的规范条文号集合", "int_list"),
    11: ("cWpjName", "图纸对应的配筋简图名称集合", "str_list"),
}

WPJ_INFO_SPECS = {
    0: ("iDwgType", "配筋简图类型代码", "int"),
    1: ("reserved_kind_1", "同施工图 Kind=1；文档标为未使用", "str"),
    2: ("iFloor", "配筋简图楼层号集合", "int_list"),
    3: ("outline_points", "配筋简图在 CAD 中的四个角点轮廓坐标", "points"),
    4: ("cOriginDwgName", "配筋简图来源 dwg 名", "str"),
    5: ("cDwgTitle", "配筋简图图名", "str"),
    30: ("fHight", "配筋简图层高", "float"),
    50: ("iStdFloor", "配筋简图标准层号", "int"),
    51: ("iKZDJ_GZ", "抗震构造等级集合", "int_list"),
    52: ("iCover", "保护层厚度集合", "int_list"),
}

WPJ_COMPONENT_KIND_NAMES = {
    6: "beam_concrete_strength",
    7: "column_concrete_strength",
    8: "wall_concrete_strength",
    9: "slab_concrete_strength",
    16: "beam_mainbar_strength",
    17: "column_mainbar_strength",
    18: "wall_mainbar_strength",
    19: "slab_mainbar_strength",
    40: "beam_stirrup_strength",
    41: "column_stirrup_strength",
    42: "wall_stirrup_strength",
    43: "boundary_member_stirrup_strength",
    44: "slab_stirrup_strength",
}

PAIR_FIELDS = {
    "sDrwintData",
    "sDrwfloatData",
    "sBeamintData",
    "sBeamfloatData",
    "sColintData",
    "sColfloatData",
    "sDsnBeamintData",
    "sDsnBeamfloatData",
    "sDsnColintData",
    "sDsnColfloatData",
}
INT_LIST_FIELDS = {"siPmids", "sFloorSE", "sneg", "siYXZCalNum", "sikindType", "sisectType", "sistruc"}
FLOAT_LIST_FIELDS = {
    "sPlx",
    "sPly",
    "sfCalAs",
    "sfNratio",
    "sfCalAsv",
    "sfCalVAs",
    "ssecpar",
    "sfStiExLen",
    "sfStiExRatio_B",
    "sfStiExRatio_H",
}

PAIR_FIELD_MAPS = {
    "sDrwintData": {"1": "m_ier_gz", "2": "m_ic", "3": "m_iAdm", "4": "m_iCompType", "5": "m_iDetailType", "6": "m_iSectType"},
    "sDrwfloatData": {"1": "m_fCover"},
    "sBeamintData": {"1": "m_iSpan", "2": "m_iSlabDepth", "3": "m_bShowLRMain", "4": "m_barc", "5": "m_bN"},
    "sBeamfloatData": {"1": "m_fl", "2": "m_fDownDepth", "3": "m_fb", "4": "m_fh"},
    "sDsnBeamintData": {"1": "isectype", "2": "m_iGrade_Dsn", "3": "m_iGrade_Dsn_ngh"},
    "sDsnBeamfloatData": {"1": "m_fCalAs_N", "2": "m_fUc"},
    "sColintData": {"1": "m_bCicle", "2": "m_bpLess", "3": "m_bpvLess", "4": "m_bfSteellLess", "5": "m_bRLess2", "6": "m_bShowCheckResult", "7": "m_bDetail"},
    "sColfloatData": {"1": "m_fp", "2": "m_fpV", "3": "m_fSteelR", "4": "m_fpLimit", "5": "m_fpvLimit", "6": "m_fSteelLimit"},
    "sDsnColintData": {"1": "m_iGrade_Dsn", "2": "m_iGrade_Dsn_ngh"},
    "sDsnColfloatData": {"1": "m_fr", "2": "m_fUc"},
}


def decode_bytes(value: bytes) -> str:
    for enc in ("utf-8", "gb18030", "cp936"):
        try:
            return value.decode(enc)
        except UnicodeDecodeError:
            pass
    return value.decode("utf-8", "replace")


def clean_value(value: Any, type_name: str | None = None) -> Any:
    if isinstance(value, bytes):
        return decode_bytes(value)
    return value


def parse_int(s: Any) -> int | None:
    txt = "" if s is None else str(s).strip()
    if not txt:
        return None
    try:
        return int(float(txt))
    except ValueError:
        return None


def parse_float(s: Any) -> float | None:
    txt = "" if s is None else str(s).strip()
    if not txt:
        return None
    try:
        return float(txt)
    except ValueError:
        return None


def split_nonempty(s: Any, sep: str = ",") -> list[str]:
    txt = "" if s is None else str(s).strip()
    return [] if not txt else [p.strip() for p in txt.split(sep) if p.strip()]


def parse_int_list(s: Any) -> list[int]:
    return [v for v in (parse_int(p) for p in split_nonempty(s, ",")) if v is not None]


def parse_float_list(s: Any) -> list[float]:
    return [v for v in (parse_float(p) for p in split_nonempty(s, ",")) if v is not None]


def parse_points(s: Any) -> list[list[float]]:
    txt = "" if s is None else str(s).strip()
    if not txt:
        return []
    if ";" in txt:
        return [parse_float_list(part) for part in txt.split(";") if part.strip()]
    vals = parse_float_list(txt)
    if len(vals) in (2, 3):
        return [vals]
    return [vals[i : i + 2] for i in range(0, len(vals), 2)] if vals else []


def parse_index_value_pairs(s: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    txt = "" if s is None else str(s).strip()
    if not txt:
        return result
    for token in txt.split(";"):
        token = token.strip()
        if not token or "," not in token:
            continue
        k, v = token.split(",", 1)
        v = v.strip()
        result[k.strip()] = int(v) if re.fullmatch(r"[-+]?\d+", v) else (parse_float(v) if parse_float(v) is not None else v)
    return result


def parse_semicolon_rows(s: Any) -> list[list[str]]:
    txt = "" if s is None else str(s).strip()
    return [] if not txt else [[cell.strip() for cell in part.split(",")] for part in txt.split(";") if part.strip()]


def decode_bits(value: Any, mapping: dict[int, str]) -> list[str]:
    n = parse_int(value)
    if n is None:
        return []
    return [label for bit, label in mapping.items() if n & bit]


def parse_named_rows(s: Any, names: list[str]) -> list[dict[str, Any]]:
    rows = []
    for row in parse_semicolon_rows(s):
        item = {}
        for i, name in enumerate(names):
            item[name] = row[i] if i < len(row) else ""
        if len(row) > len(names):
            item["extra"] = row[len(names) :]
        rows.append(item)
    return rows


def map_pair_names(field: str, pairs: dict[str, Any]) -> dict[str, Any]:
    mapping = PAIR_FIELD_MAPS.get(field, {})
    return {mapping.get(k, k): v for k, v in pairs.items()}


def add_base_data_labels(parsed_fields: dict[str, Any], component_kind: str | None = None) -> None:
    data = parsed_fields.get("sDrwintData")
    if not isinstance(data, dict):
        return
    by_name = data.get("by_name", {})
    comp = parse_int(by_name.get("m_iCompType"))
    detail = parse_int(by_name.get("m_iDetailType"))
    if comp is not None and not component_kind:
        by_name["m_iCompType_label"] = COMPONENTTYPE_NAMES.get(comp, "")
    if component_kind:
        table_label = "梁" if component_kind == "beam" else "柱" if component_kind == "column" else component_kind
        by_name["component_type_from_table"] = table_label
        by_name["m_iCompType_label"] = table_label
        if comp is not None:
            by_name["m_iCompType_label_from_value"] = COMPONENTTYPE_NAMES.get(comp, "")
    if detail is not None:
        if component_kind == "beam" or (component_kind is None and comp == 0):
            by_name["m_iDetailType_label"] = BEAM_DETAILTYPE_NAMES.get(detail, "")
        elif component_kind == "column" or (component_kind is None and comp == 1):
            by_name["m_iDetailType_label"] = COL_DETAILTYPE_ZERO if detail == 0 else decode_bits(detail, COL_DETAILTYPE_BITS)


def nonzero_rebar_row(item: dict[str, Any], keys: list[str]) -> bool:
    for key in keys:
        value = item.get(key, "")
        if value in ("", None):
            continue
        if parse_float(value) not in (None, 0.0):
            return True
        if parse_float(value) is None and str(value).strip() not in {"0", "0.0", "0.00"}:
            return True
    return False


def column_mainbar_positions(section_type: Any) -> tuple[list[str], str]:
    sect = parse_int(section_type)
    if sect == 1:
        return COLUMN_MAINBAR_RECT_POSITIONS, "矩形柱：[3] 依次为角筋（全部角筋）、B边（不含角筋）、H边（不含角筋）"
    if sect == 3:
        return COLUMN_MAINBAR_CIRCLE_POSITIONS, "圆形柱：只使用全截面位置"
    if sect in {4, 5, 6, 7}:
        return COLUMN_MAINBAR_IRREGULAR_POSITIONS, "异形柱：按肢记录，最多三肢；L形/十字形通常用两肢，工形/Z形通常用三肢"
    return COLUMN_MAINBAR_GENERIC_POSITIONS, "柱：[3] 表示位置维度而非规格维度；矩形柱为角筋/B边/H边，圆形柱为全截面，异形柱为各肢"


def annotate_mainbar(rows: Any, component_kind: str | None, section_type: Any = None) -> None:
    if not isinstance(rows, list):
        return
    if component_kind == "beam":
        positions, shape, note = BEAM_MAINBAR_POSITIONS, "[5][7][2]", "梁：[5]最多五排，[7]为七类位置，[2]为每排每位置最多两种规格"
    elif component_kind == "column":
        positions, note = column_mainbar_positions(section_type)
        shape = "[5][3][2]"
    else:
        return
    pos_count, spec_count = len(positions), 2
    total = 5 * pos_count * spec_count
    for serial, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        item["serial_index"] = serial + 1
        item["array_shape"] = shape
        item["shape_note"] = note
        if serial < total:
            row_idx = serial // (pos_count * spec_count)
            rem = serial % (pos_count * spec_count)
            pos_idx = rem // spec_count
            spec_idx = rem % spec_count
            item["array_index_zero_based"] = f"[{row_idx}][{pos_idx}][{spec_idx}]"
            item["row_no"] = row_idx + 1
            item["position_index"] = pos_idx + 1
            item["position"] = positions[pos_idx]
            item["spec_slot"] = spec_idx + 1
        item["is_empty"] = not nonzero_rebar_row(item, ["iDia", "iGrade", "iNum", "iBunDle"])


def annotate_stisteel(rows: Any, component_kind: str | None) -> None:
    if not isinstance(rows, list):
        return
    for serial, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        item["serial_index"] = serial + 1
        if component_kind == "beam":
            item["array_shape"] = "[2]"
            if serial < len(BEAM_STISTEEL_POSITIONS):
                item["position"] = BEAM_STISTEEL_POSITIONS[serial]
        elif component_kind == "column":
            item["array_shape"] = "[3][2]"
            if serial < len(COLUMN_STISTEEL_ZONES) * len(COLUMN_STISTEEL_SIDES):
                zone_idx = serial // len(COLUMN_STISTEEL_SIDES)
                side_idx = serial % len(COLUMN_STISTEEL_SIDES)
                item["array_index_zero_based"] = f"[{zone_idx}][{side_idx}]"
                item["zone"] = COLUMN_STISTEEL_ZONES[zone_idx]
                item["side"] = COLUMN_STISTEEL_SIDES[side_idx]
        item["is_empty"] = not nonzero_rebar_row(item, ["iDia", "iGrade", "iDist", "ing", "fGrade"])


def annotate_steelinfo(rows: Any, component_kind: str | None) -> None:
    if not isinstance(rows, list):
        return
    positions = BEAM_STEELINFO_POSITIONS if component_kind == "beam" else COLUMN_STEELINFO_POSITIONS if component_kind == "column" else []
    for serial, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        item["serial_index"] = serial + 1
        if serial < len(positions):
            item["position"] = positions[serial]
        item["is_empty"] = not nonzero_rebar_row(item, ["cSteel", "fDsnCal0", "fDsnCal1", "fRealCal"])


def rebar_grade_to_str(grade: Any) -> str:
    """Convert numeric steel grade to the drawing letter used in reinforcement strings."""
    return REBAR_GRADE_LETTERS.get(parse_int(grade), "C")


def rebar_amount(item: dict[str, Any] | None) -> int:
    return parse_int((item or {}).get("iNum")) or 0


def rebar_grade(item: dict[str, Any] | None) -> int:
    return parse_int((item or {}).get("iGrade")) or 0


def rebar_dia(item: dict[str, Any] | None) -> int:
    return parse_int((item or {}).get("iDia")) or 0


def is_valid_mainbar(item: dict[str, Any] | None, *, require_grade: bool = False) -> bool:
    if not isinstance(item, dict):
        return False
    if rebar_amount(item) <= 0 or rebar_dia(item) <= 0:
        return False
    return not require_grade or rebar_grade(item) > 0


def format_mainbar_item(item: dict[str, Any] | None, *, amount: int | None = None, suffix: str = "") -> str:
    if not is_valid_mainbar(item):
        return ""
    n = rebar_amount(item) if amount is None else amount
    return f"{n}{rebar_grade_to_str(rebar_grade(item))}{rebar_dia(item)}{suffix}"


def mainbar_matrix(rows: Any, pos_count: int) -> list[list[list[dict[str, Any] | None]]]:
    matrix: list[list[list[dict[str, Any] | None]]] = [[[None for _ in range(2)] for _ in range(pos_count)] for _ in range(5)]
    if not isinstance(rows, list):
        return matrix
    for serial, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        row_idx = (parse_int(item.get("row_no")) or 0) - 1
        pos_idx = (parse_int(item.get("position_index")) or 0) - 1
        spec_idx = (parse_int(item.get("spec_slot")) or 0) - 1
        if row_idx < 0 or pos_idx < 0 or spec_idx < 0:
            row_idx = serial // (pos_count * 2)
            rem = serial % (pos_count * 2)
            pos_idx = rem // 2
            spec_idx = rem % 2
        if 0 <= row_idx < 5 and 0 <= pos_idx < pos_count and 0 <= spec_idx < 2:
            matrix[row_idx][pos_idx][spec_idx] = item
    return matrix


def active_mainbar_positions(matrix: list[list[list[dict[str, Any] | None]]], pos_count: int) -> list[int]:
    active: list[int] = []
    for pos_idx in range(pos_count):
        if any(any(is_valid_mainbar(item) for item in matrix[row_idx][pos_idx]) for row_idx in range(len(matrix))):
            active.append(pos_idx)
    return active


def max_nonempty_row(matrix: list[list[list[dict[str, Any] | None]]], positions: Iterable[int], *, require_grade: bool = False) -> int:
    highest = -1
    for row_idx in range(len(matrix)):
        for pos_idx in positions:
            if 0 <= pos_idx < len(matrix[row_idx]) and any(is_valid_mainbar(x, require_grade=require_grade) for x in matrix[row_idx][pos_idx]):
                highest = row_idx
    return highest


def format_mainbar_position(matrix: list[list[list[dict[str, Any] | None]]], pos_idx: int) -> str:
    highest = max_nonempty_row(matrix, [pos_idx])
    if highest < 0:
        return ""
    row_strings: list[str] = []
    for row_idx in range(highest + 1):
        parts = [format_mainbar_item(item) for item in matrix[row_idx][pos_idx]]
        parts = [p for p in parts if p]
        row_strings.append("+".join(parts) if parts else "0")
    return "/".join(row_strings)


def format_beam_bottom_mainbar(matrix: list[list[list[dict[str, Any] | None]]]) -> str:
    """Merge beam bottom bars: position 4=入支座底筋, position 5=不入支座底筋."""
    highest = max_nonempty_row(matrix, [4, 5], require_grade=True)
    if highest < 0:
        return ""
    all_rows: list[str] = []
    for row_idx in range(highest + 1):
        row_parts: list[str] = []
        merged_non_support: set[int] = set()
        support_items = matrix[row_idx][4]
        non_support_items = matrix[row_idx][5]

        for j, support in enumerate(support_items):
            if not is_valid_mainbar(support, require_grade=True):
                continue
            matched = [
                k
                for k, non_support in enumerate(non_support_items)
                if k not in merged_non_support
                and is_valid_mainbar(non_support, require_grade=True)
                and rebar_grade(non_support) == rebar_grade(support)
                and rebar_dia(non_support) == rebar_dia(support)
            ]
            if matched:
                non_support_count = sum(rebar_amount(non_support_items[k]) for k in matched)
                merged_non_support.update(matched)
                row_parts.append(format_mainbar_item(support, amount=rebar_amount(support) + non_support_count, suffix=f"(-{non_support_count})"))
            else:
                row_parts.append(format_mainbar_item(support))

        for k, non_support in enumerate(non_support_items):
            if k in merged_non_support or not is_valid_mainbar(non_support, require_grade=True):
                continue
            suffix = f"(-{rebar_amount(non_support)})" if not row_parts else ""
            row_parts.append(format_mainbar_item(non_support, suffix=suffix))

        all_rows.append("+".join([p for p in row_parts if p]) if row_parts else "0")
    return "/".join(all_rows)


def beam_waist_prefix(parsed_fields: dict[str, Any]) -> str:
    beam_int = parsed_fields.get("sBeamintData")
    m_bn = None
    if isinstance(beam_int, dict):
        m_bn = parse_int(beam_int.get("by_name", {}).get("m_bN"))
    # m_bN=1 表示受扭腰筋；0 表示构造腰筋。工程图字符串中 N=受扭，G=构造。
    return "N" if m_bn == 1 else "G"


def first_int(values: Any) -> int | None:
    if isinstance(values, list) and values:
        return parse_int(values[0])
    return parse_int(values)


def column_section_info(
    parsed_fields: dict[str, Any],
    matrix: list[list[list[dict[str, Any] | None]]],
    raw_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve the column section object used for reinforcement string output.

    The drawing base field `sDrwintData.m_iSectType` is the primary section type.
    `sikindType/sisectType/sistruc` are saved design/check-model section arrays
    and are useful fallback evidence when the base field is empty. `sPlx/sPly`
    and `scSectSize` provide geometric evidence for composite/irregular sections.
    """
    raw_row = raw_row or {}
    drw = parsed_fields.get("sDrwintData")
    drw_by_name = drw.get("by_name", {}) if isinstance(drw, dict) else {}
    col = parsed_fields.get("sColintData")
    col_by_name = col.get("by_name", {}) if isinstance(col, dict) else {}

    section_type = parse_int(drw_by_name.get("m_iSectType"))
    circle_flag = parse_int(col_by_name.get("m_bCicle"))
    sikind0 = first_int(parsed_fields.get("sikindType"))
    sisect0 = first_int(parsed_fields.get("sisectType"))
    sistruc0 = first_int(parsed_fields.get("sistruc"))
    sect_size = str(raw_row.get("scSectSize", "") or "")
    plx_count = len(parsed_fields.get("sPlx", [])) if isinstance(parsed_fields.get("sPlx"), list) else 0
    ply_count = len(parsed_fields.get("sPly", [])) if isinstance(parsed_fields.get("sPly"), list) else 0
    active_positions = active_mainbar_positions(matrix, 3)
    active_count = len(active_positions)

    evidence = {
        "sDrwintData.m_iSectType": section_type,
        "sColintData.m_bCicle": circle_flag,
        "sikindType[0]": sikind0,
        "sisectType[0]": sisect0,
        "sistruc[0]": sistruc0,
        "scSectSize": sect_size,
        "sPlx_count": plx_count,
        "sPly_count": ply_count,
        "active_mainbar_positions": active_positions,
    }

    looks_circle = section_type == 3 or sect_size.strip().upper().startswith("D=")
    looks_irregular = (
        section_type in COLUMN_IRREGULAR_EXPECTED_SLOTS
        or "+" in sect_size
        or plx_count > 4
        or ply_count > 4
        or sikind0 == 1
        or (sisect0 not in (None, 0, 1, 3))
    )

    if looks_circle:
        return {
            "kind": "circle",
            "label": "圆形柱",
            "output_indices": [0],
            "output_labels": ["全截面"],
            "category_count": 1,
            "evidence": evidence,
            "note": "圆形柱输出 1 类：全截面。优先依据 sDrwintData.m_iSectType=3 或 scSectSize 的 D= 格式判断。",
        }

    if looks_irregular:
        expected = COLUMN_IRREGULAR_EXPECTED_SLOTS.get(section_type)
        count = expected or active_count or 3
        if active_count:
            count = max(count, active_count)
        count = max(1, min(3, count))
        labels = [f"第{i + 1}肢配筋" for i in range(count)]
        shape_name = COLUMN_SECTION_TYPE_NAMES.get(section_type, "异形柱")
        note = f"{shape_name}输出 {count} 类肢配筋。"
        if expected and active_count > expected:
            note += f"截面类型建议 {expected} 类，但实配数组存在 {active_count} 个非空位置，输出时保留非空位置。"
        return {
            "kind": "irregular",
            "label": shape_name,
            "output_indices": list(range(count)),
            "output_labels": labels,
            "category_count": count,
            "evidence": evidence,
            "note": note,
        }

    return {
        "kind": "rect",
        "label": "矩形柱",
        "output_indices": [0, 1, 2],
        "output_labels": COLUMN_MAINBAR_RECT_POSITIONS,
        "category_count": 3,
        "evidence": evidence,
        "note": "矩形柱输出 3 类：角筋、B边、H边。sColintData.m_bCicle 只作为辅助字段，不单独作为圆柱判断依据。",
    }


def build_reinforcement_text(parsed_fields: dict[str, Any], component_kind: str | None, raw_row: dict[str, Any] | None = None) -> dict[str, Any]:
    rows = parsed_fields.get("sMainBar") or parsed_fields.get("smainBar")
    if not isinstance(rows, list):
        return {}
    if component_kind == "beam":
        matrix = mainbar_matrix(rows, len(BEAM_MAINBAR_POSITIONS))
        waist = format_mainbar_position(matrix, 6)
        return {
            "component_kind": "beam",
            "array_shape": "[5][7][2]",
            "category_count": 6,
            "grade_letters": REBAR_GRADE_LETTERS,
            "top_continuous": format_mainbar_position(matrix, 0),
            "left_support_top": format_mainbar_position(matrix, 1),
            "right_support_top": format_mainbar_position(matrix, 2),
            "erection": format_mainbar_position(matrix, 3),
            "bottom": format_beam_bottom_mainbar(matrix),
            "waist": f"{beam_waist_prefix(parsed_fields)}{waist}" if waist else "",
            "note": "梁底筋已将下部入支座筋与不入支座筋合并；括号内负数表示不入支座筋根数，例如 6C25(-2)。",
        }
    if component_kind == "column":
        matrix = mainbar_matrix(rows, 3)
        section_info = column_section_info(parsed_fields, matrix, raw_row)
        active_indices = section_info["output_indices"]
        output_labels = section_info["output_labels"]
        values = {output_labels[i]: format_mainbar_position(matrix, physical_idx) for i, physical_idx in enumerate(active_indices)}
        return {
            "component_kind": "column",
            "array_shape": "[5][3][2]",
            "section_info": section_info,
            "section_type": section_info["evidence"].get("sDrwintData.m_iSectType"),
            "section_label": section_info["label"],
            "category_count": section_info["category_count"],
            "grade_letters": REBAR_GRADE_LETTERS,
            "positions": values,
            "note": section_info["note"],
        }
    return {}


def summarize_reinforcement_text(reinforcement_text: Any) -> str:
    if not isinstance(reinforcement_text, dict):
        return ""
    if reinforcement_text.get("component_kind") == "beam":
        labels = [
            ("top_continuous", "上通"),
            ("left_support_top", "左支座"),
            ("right_support_top", "右支座"),
            ("erection", "架立"),
            ("bottom", "底筋"),
            ("waist", "腰筋"),
        ]
        return "；".join(f"{label}:{reinforcement_text.get(key)}" for key, label in labels if reinforcement_text.get(key))
    if reinforcement_text.get("component_kind") == "column":
        positions = reinforcement_text.get("positions", {})
        if isinstance(positions, dict):
            return "；".join(f"{k}:{v}" for k, v in positions.items() if v)
    return ""


def annotate_component_arrays(parsed_fields: dict[str, Any], component_kind: str | None, raw_row: dict[str, Any] | None = None) -> None:
    section_type = None
    drw = parsed_fields.get("sDrwintData")
    if isinstance(drw, dict):
        section_type = drw.get("by_name", {}).get("m_iSectType")
    for name in ("sMainBar", "smainBar"):
        annotate_mainbar(parsed_fields.get(name), component_kind, section_type)
    annotate_stisteel(parsed_fields.get("sStisteel"), component_kind)
    for name in ("sSteelInfo", "sSteelinfo", "sSteelInfoInTab"):
        annotate_steelinfo(parsed_fields.get(name), component_kind)
    reinforcement_text = build_reinforcement_text(parsed_fields, component_kind, raw_row)
    if reinforcement_text:
        parsed_fields["reinforcement_text"] = reinforcement_text
        parsed_fields["reinforcement_summary"] = summarize_reinforcement_text(reinforcement_text)



def parse_draw_check_count_kind(kind: int, content: Any) -> tuple[str, str, dict[str, Any]] | None:
    """Parse DrawInfo extended count Kind = iEleType*1000 + iGJ."""
    i_ele_type, i_gj = divmod(kind, 1000)
    if i_ele_type not in CHECK_RESULT_TYPES or i_gj not in GJTYPE_NAMES:
        return None
    vals = parse_int_list(content)
    parsed = {
        "check_result_type_code": i_ele_type,
        "check_result_type": CHECK_RESULT_TYPES[i_ele_type],
        "component_code": i_gj,
        "component": GJTYPE_NAMES[i_gj],
        "checked_total": vals[0] if len(vals) > 0 else None,
        "passed": vals[1] if len(vals) > 1 else None,
        "opinion_count": vals[2] if len(vals) > 2 else None,
        "with_opinion": vals[2] if len(vals) > 2 else None,
    }
    name = f"check_count_{i_ele_type}_{i_gj}"
    desc = "构件审查统计：Kind=iEleType*1000+iGJ；Content=已审查总数,审查通过数,审查意见条数"
    return name, desc, parsed


def parse_by_kind(kind: int, content: Any, specs: dict[int, tuple[str, str, str]], *, wpj: bool = False, draw: bool = False) -> tuple[str, str, Any]:
    if draw:
        count = parse_draw_check_count_kind(kind, content)
        if count:
            return count
    name, desc, parser = specs.get(kind, (f"unknown_kind_{kind}", "未在文档中定义的 Kind", "str"))
    if wpj and kind in WPJ_COMPONENT_KIND_NAMES:
        name, desc, parser = WPJ_COMPONENT_KIND_NAMES[kind], "配筋简图构件材料强度/等级字段", "int_list"
    if parser == "int":
        parsed = parse_int(content)
    elif parser == "float":
        parsed = parse_float(content)
    elif parser == "int_list":
        parsed = parse_int_list(content)
    elif parser == "str_list":
        parsed = split_nonempty(content, ",")
    elif parser == "points":
        parsed = parse_points(content)
    else:
        parsed = "" if content is None else content
    return name, desc, parsed


class MulCkDB:
    def __init__(self, db_path: str | Path):
        self.path = Path(db_path)
        if not self.path.exists():
            raise FileNotFoundError(f"DB not found: {self.path}")
        self.conn = sqlite3.connect(str(self.path))
        self.conn.text_factory = bytes
        self.conn.row_factory = sqlite3.Row
        self._tables: dict[str, str] | None = None
        self._schema: dict[str, dict[str, str]] = {}

    def close(self) -> None:
        self.conn.close()

    def table_names(self) -> list[str]:
        if self._tables is None:
            rows = self.conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
            names = [str(clean_value(r["name"])) for r in rows]
            self._tables = {n.lower(): n for n in names}
        return list(self._tables.values())

    def table(self, name_or_alias: str, required: bool = False) -> str | None:
        self.table_names()
        lookup = self._tables or {}
        for cand in TABLE_ALIASES.get(name_or_alias, [name_or_alias]):
            if cand.lower() in lookup:
                return lookup[cand.lower()]
        if required:
            raise KeyError(f"Missing table {name_or_alias}; tried {TABLE_ALIASES.get(name_or_alias, [name_or_alias])}")
        return None

    def columns(self, table: str) -> dict[str, str]:
        key = table.lower()
        if key not in self._schema:
            cols: dict[str, str] = {}
            for r in self.conn.execute(f'PRAGMA table_info("{table}")'):
                cols[str(clean_value(r["name"]))] = str(clean_value(r["type"]))
            self._schema[key] = cols
        return self._schema[key]

    def col(self, table: str, *candidates: str, required: bool = True) -> str | None:
        by_lower = {c.lower(): c for c in self.columns(table)}
        for cand in candidates:
            if cand.lower() in by_lower:
                return by_lower[cand.lower()]
        if required:
            raise KeyError(f"Missing column in {table}: {candidates}")
        return None

    def decode_row(self, row: sqlite3.Row, table: str | None = None) -> dict[str, Any]:
        types = self.columns(table) if table else {}
        return {k: clean_value(row[k], types.get(k)) for k in row.keys()}

    def select_rows(
        self,
        table: str,
        where: list[tuple[Iterable[str] | str, Any]] | None = None,
        order: list[Iterable[str] | str] | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        for candidates, value in where or []:
            c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
            clauses.append(f'"{c}" = ?')
            params.append(value)
        order_cols = []
        for candidates in order or []:
            try:
                c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
                if c:
                    order_cols.append(f'"{c}"')
            except KeyError:
                pass
        sql = f'SELECT * FROM "{table}"'
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        if order_cols:
            sql += " ORDER BY " + ", ".join(order_cols)
        if limit and limit > 0:
            sql += f" LIMIT {int(limit)}"
        return [self.decode_row(r, table) for r in self.conn.execute(sql, params).fetchall()]

    def select_rows_like(
        self,
        table: str,
        where: list[tuple[Iterable[str] | str, Any]] | None,
        like_column: Iterable[str] | str,
        pattern: str,
        order: list[Iterable[str] | str] | None = None,
    ) -> list[dict[str, Any]]:
        clauses, params = [], []
        for candidates, value in where or []:
            c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
            clauses.append(f'"{c}" = ?')
            params.append(value)
        like_col = self.col(table, *list(like_column)) if not isinstance(like_column, str) else self.col(table, like_column)
        clauses.append(f'"{like_col}" LIKE ?')
        params.append(f"%{pattern}%")
        order_cols = []
        for candidates in order or []:
            try:
                c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
                if c:
                    order_cols.append(f'"{c}"')
            except KeyError:
                pass
        sql = f'SELECT * FROM "{table}" WHERE ' + " AND ".join(clauses)
        if order_cols:
            sql += " ORDER BY " + ", ".join(order_cols)
        return [self.decode_row(r, table) for r in self.conn.execute(sql, params).fetchall()]

    def select_rows_in(
        self,
        table: str,
        where: list[tuple[Iterable[str] | str, Any]] | None,
        in_column: Iterable[str] | str,
        values: Iterable[Any],
        order: list[Iterable[str] | str] | None = None,
    ) -> list[dict[str, Any]]:
        value_list = list(dict.fromkeys(v for v in values if v is not None))
        if not value_list:
            return []
        clauses, params = [], []
        for candidates, value in where or []:
            c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
            clauses.append(f'"{c}" = ?')
            params.append(value)
        in_col = self.col(table, *list(in_column)) if not isinstance(in_column, str) else self.col(table, in_column)
        order_cols = []
        for candidates in order or []:
            try:
                c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
                if c:
                    order_cols.append(f'"{c}"')
            except KeyError:
                pass
        rows: list[dict[str, Any]] = []
        max_chunk = max(1, 900 - len(params))
        base_where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        for i in range(0, len(value_list), max_chunk):
            chunk = value_list[i : i + max_chunk]
            placeholders = ", ".join("?" for _ in chunk)
            sql = f'SELECT * FROM "{table}"{base_where}'
            sql += (" AND " if clauses else " WHERE ") + f'"{in_col}" IN ({placeholders})'
            if order_cols:
                sql += " ORDER BY " + ", ".join(order_cols)
            rows.extend(self.decode_row(r, table) for r in self.conn.execute(sql, [*params, *chunk]).fetchall())
        return rows

    def count_rows(self, table: str | None, where: list[tuple[Iterable[str] | str, Any]] | None = None) -> int:
        if not table:
            return 0
        clauses, params = [], []
        for candidates, value in where or []:
            c = self.col(table, *list(candidates)) if not isinstance(candidates, str) else self.col(table, candidates)
            clauses.append(f'"{c}" = ?')
            params.append(value)
        sql = f'SELECT COUNT(*) AS c FROM "{table}"'
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        return int(self.conn.execute(sql, params).fetchone()["c"])


def normalize_dwg_row(row: dict[str, Any]) -> dict[str, Any]:
    kind = parse_int(row.get("DrwKind"))
    return {
        "ProjectName": row.get("ProjectName", ""),
        "CutName": row.get("CutName", ""),
        "DrwKind": kind,
        "DrwKindLabel": DRAW_KIND_LABELS.get(kind, f"未知({kind})"),
        "CutID": row.get("CutID", row.get("CutId")),
        "InsertTime": row.get("InsertTime", row.get("insertTime", "")),
    }


def review_counts_by_cut(db: MulCkDB) -> dict[int, int]:
    table = db.table("reviews")
    if not table:
        return {}
    cut_col = db.col(table, "DrwCutID", "DrwCutId", required=False)
    if not cut_col:
        return {}
    rows = db.conn.execute(f'SELECT "{cut_col}" AS cut_id, COUNT(*) AS c FROM "{table}" GROUP BY "{cut_col}"').fetchall()
    return {int(r["cut_id"]): int(r["c"]) for r in rows if r["cut_id"] is not None}


def info_fields_by_cut(db: MulCkDB, alias: str, cut_candidates: list[str], specs: dict[int, tuple[str, str, str]], *, wpj: bool = False, draw: bool = False) -> dict[int, dict[str, Any]]:
    table = db.table(alias)
    if not table:
        return {}
    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in db.select_rows(table, order=[cut_candidates, "Kind"]):
        cut_id = parse_int(row_get(row, *cut_candidates))
        if cut_id is not None:
            grouped[cut_id].append(row)
    return {cut_id: parse_info_rows(rows, specs, wpj=wpj, draw=draw).get("fields", {}) for cut_id, rows in grouped.items()}


def list_projects(db: MulCkDB) -> dict[str, Any]:
    table = db.table("dwg", required=True)
    rows = [normalize_dwg_row(r) for r in db.select_rows(table, order=["ProjectName", "DrwKind", ["CutID", "CutId"]])]
    review_counts = review_counts_by_cut(db)
    draw_fields = info_fields_by_cut(db, "draw", ["DrwCutID", "DrwCutId"], DRAW_INFO_SPECS, draw=True)
    wpj_fields = info_fields_by_cut(db, "wpj", ["WpjCutID", "WpjCutId"], WPJ_INFO_SPECS, wpj=True)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in rows:
        cut_id = parse_int(d.get("CutID"))
        fields = wpj_fields.get(cut_id, {}) if parse_int(d.get("DrwKind")) == 1 else draw_fields.get(cut_id, {})
        title = fields.get("cDwgTitle") or fields.get("cOriginDwgName") or d.get("CutName", "")
        type_name = fields.get("cTypeName") or "、".join(fields.get("iDwgType_labels", [])) or d.get("DrwKindLabel", "")
        grouped[str(d.get("ProjectName", ""))].append(
            {
                "cut_id": cut_id,
                "drawing_name": title,
                "drawing_type": type_name,
                "review_count": review_counts.get(cut_id or -1, 0),
            }
        )
    return {
        "database": str(db.path),
        "project_count": len(grouped),
        "drawing_count": len(rows),
        "projects": [{"project_name": p, "drawing_count": len(ds), "drawings": ds} for p, ds in grouped.items()],
    }

def resolve_drawings(db: MulCkDB, cut_id: int | None = None, cut_name: str | None = None, project: str | None = None) -> list[dict[str, Any]]:
    table = db.table("dwg", required=True)
    if cut_id is not None:
        return [normalize_dwg_row(r) for r in db.select_rows(table, where=[(["CutID", "CutId"], cut_id)], order=["ProjectName", "DrwKind"])]
    rows = db.select_rows(table, order=["ProjectName", "DrwKind", ["CutID", "CutId"]])
    out = []
    for row in rows:
        if project and str(row.get("ProjectName", "")) != project:
            continue
        if cut_name and cut_name not in str(row.get("CutName", "")):
            continue
        out.append(normalize_dwg_row(row))
    return out


def parse_info_rows(rows: list[dict[str, Any]], specs: dict[int, tuple[str, str, str]], *, wpj: bool = False, draw: bool = False) -> dict[str, Any]:
    by_kind, fields = {}, {}
    for row in rows:
        kind = parse_int(row.get("Kind"))
        if kind is None:
            continue
        content = row.get("Content", "")
        name, desc, parsed = parse_by_kind(kind, content, specs, wpj=wpj, draw=draw)
        by_kind[str(kind)] = {"field": name, "description": desc, "content": row.get("Content", ""), "parsed": parsed, "version": row.get("Version")}
        fields[name] = parsed
        if draw and kind == 0:
            fields["iDwgType_labels"] = decode_bits(content, DRWTYPE_BITS)
        elif draw and kind == 7:
            fields["iCheckRlstType_labels"] = decode_bits(content, SEL_CHECKRLST_BITS)
        elif draw and isinstance(parsed, dict) and name.startswith("check_count_"):
            fields.setdefault("check_counts", []).append(parsed)
    return {"fields": fields, "by_kind": by_kind, "raw_rows": rows}


def drawing_brief(db: MulCkDB, cut_id: int, dwg_info: dict[str, Any] | None = None) -> dict[str, Any]:
    if dwg_info is None:
        matches = resolve_drawings(db, cut_id=cut_id)
        dwg_info = matches[0] if matches else {"CutID": cut_id}
    drw_kind = parse_int(dwg_info.get("DrwKind"))
    if drw_kind == 1:
        table = db.table("wpj")
        rows = db.select_rows(table, where=[(["WpjCutID", "WpjCutId"], cut_id)], order=["Kind"]) if table else []
        info = parse_info_rows(rows, WPJ_INFO_SPECS, wpj=True)
    else:
        table = db.table("draw")
        rows = db.select_rows(table, where=[(["DrwCutID", "DrwCutId"], cut_id)], order=["Kind"]) if table else []
        info = parse_info_rows(rows, DRAW_INFO_SPECS, draw=True)
    fields = info.get("fields", {})
    reviews = db.table("reviews")
    review_count = db.count_rows(reviews, [(["DrwCutID", "DrwCutId"], cut_id)]) if reviews else 0
    title = fields.get("cDwgTitle") or fields.get("cOriginDwgName") or dwg_info.get("CutName", "")
    type_name = fields.get("cTypeName") or "、".join(fields.get("iDwgType_labels", [])) or dwg_info.get("DrwKindLabel", "")
    return {
        "database": str(db.path),
        "summary_only": True,
        "cut_id": cut_id,
        "dwg_info": dwg_info,
        "drawing_name": title,
        "drawing_type": type_name,
        "review_count": review_count,
        "outline_points": fields.get("outline_points", []),
    }


def drawing_report(db: MulCkDB, cut_id: int, dwg_info: dict[str, Any] | None = None) -> dict[str, Any]:
    if dwg_info is None:
        matches = resolve_drawings(db, cut_id=cut_id)
        dwg_info = matches[0] if matches else {"CutID": cut_id}
    drw_kind = parse_int(dwg_info.get("DrwKind"))
    report: dict[str, Any] = {"database": str(db.path), "dwg_info": dwg_info}
    if drw_kind == 1:
        table = db.table("wpj")
        rows = db.select_rows(table, where=[(["WpjCutID", "WpjCutId"], cut_id)], order=["Kind"]) if table else []
        report["info_source"] = "WpjInfo"
        report["wpj_info"] = parse_info_rows(rows, WPJ_INFO_SPECS, wpj=True)
    else:
        table = db.table("draw")
        rows = db.select_rows(table, where=[(["DrwCutID", "DrwCutId"], cut_id)], order=["Kind"]) if table else []
        report["info_source"] = "DrawInfo"
        report["draw_info"] = parse_info_rows(rows, DRAW_INFO_SPECS, draw=True)
    reviews, beam_idx, col_idx = db.table("reviews"), db.table("check_beam"), db.table("check_col")
    simple_beam, simple_col = db.table("simple_beam"), db.table("simple_col")
    report["counts"] = {
        "drawing_reviews": db.count_rows(reviews, [(["DrwCutID", "DrwCutId"], cut_id)]) if reviews else 0,
        "beam_components": db.count_rows(beam_idx, [(["DrwCutID", "DrwCutId"], cut_id)]) if beam_idx else 0,
        "column_components": db.count_rows(col_idx, [(["DrwCutID", "DrwCutId"], cut_id)]) if col_idx else 0,
        "beam_simple_locations": db.count_rows(simple_beam, [(["DrwCutID", "DrwCutId"], cut_id)]) if simple_beam else 0,
        "column_simple_locations": db.count_rows(simple_col, [(["DrwCutID", "DrwCutId"], cut_id)]) if simple_col else 0,
    }
    report["inferred_component_kind"] = infer_component_kind(report)
    return report


def infer_component_kind(report: dict[str, Any]) -> str:
    texts = [str(report.get("dwg_info", {}).get("CutName", ""))]
    for key in ("draw_info", "wpj_info"):
        fields = report.get(key, {}).get("fields", {})
        texts.extend(str(fields.get(k, "")) for k in ("cDwgTitle", "cTypeName"))
    text = " ".join(texts)
    if "梁" in text:
        return "beam"
    if "柱" in text:
        return "column"
    counts = report.get("counts", {})
    if counts.get("beam_components") and not counts.get("column_components"):
        return "beam"
    if counts.get("column_components") and not counts.get("beam_components"):
        return "column"
    return "unknown"


def parse_sign(s: Any) -> dict[str, int | None]:
    vals = parse_int_list(s)
    return {"iAccept": vals[0] if len(vals) > 0 else None, "idelete": vals[1] if len(vals) > 1 else None}


def review_class_from_iog(value: Any) -> str:
    n = parse_int(value) or 0
    if n & 4:
        return "强条"
    if n & 2:
        return "应"
    if n & 1:
        return "宜"
    return "其他"


def review_code_id(row: dict[str, Any]) -> int:
    code = parse_int(row.get("OV_type"))
    if code is not None:
        return code
    codes = parse_int_list(row.get("vctcodeids", ""))
    return codes[0] if codes else 0


def parse_review_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    guids_field = "vctguids" if "vctguids" in out else "vcguids"
    review_class = review_class_from_iog(out.get("iOG"))
    code_id = review_code_id(out)
    out["parsed"] = {
        "vctguids": parse_int_list(out.get(guids_field, "")),
        "vctcodeids": parse_int_list(out.get("vctcodeids", "")),
        "OV_type_code_id": code_id,
        "iOG_flags": decode_bits(out.get("iOG"), OV_TYPE_BITS),
        "review_class": review_class,
        "review_priority": REVIEW_CLASS_PRIORITY.get(review_class, 99),
        "MarkPoint": parse_float_list(out.get("MarkPoint", "")),
        "leftPoint": parse_float_list(out.get("leftPoint", "")),
        "rightPoint": parse_float_list(out.get("rightPoint", "")),
        "SIGN": parse_sign(out.get("SIGN", "")),
    }
    return out


def review_sort_key(row: dict[str, Any], mode: str = "spec") -> tuple[Any, ...]:
    parsed = row.get("parsed", {})
    pr = parsed.get("review_priority", 99)
    code = parsed.get("OV_type_code_id") or 0
    ele = str(row.get("eleName", ""))
    ino = parse_int(row.get("iNo")) or 0
    span = parse_int(row.get("BeamSpanNo")) or 0
    if mode == "component":
        return (ele, ino, pr, code, span)
    if mode == "raw":
        return (ino, span, pr, code)
    return (pr, code, ele, ino, span)


def review_rows(
    db: MulCkDB,
    cut_id: int,
    limit: int = 0,
    contains: str | None = None,
    sort: str = "spec",
    component_name: str | None = None,
    level: str = "all",
    name_match: str = "exact",
) -> dict[str, Any]:
    table = db.table("reviews")
    if not table:
        return {"database": str(db.path), "cut_id": cut_id, "reviews": [], "note": "SElesTable not found"}
    if component_name and name_match == "contains":
        raw_rows = db.select_rows_like(table, [(["DrwCutID", "DrwCutId"], cut_id)], "eleName", component_name, order=["iNo", "iGJType", "ELETYPE"])
    elif component_name:
        raw_rows = db.select_rows(table, where=[(["DrwCutID", "DrwCutId"], cut_id), ("eleName", component_name)], order=["iNo", "iGJType", "ELETYPE"])
    else:
        raw_rows = db.select_rows(table, where=[(["DrwCutID", "DrwCutId"], cut_id)], order=["iNo", "iGJType", "ELETYPE"])
    rows = [parse_review_row(r) for r in raw_rows]
    if contains:
        rows = [r for r in rows if contains in json.dumps(r, ensure_ascii=False)]
    if level != "all":
        level_map = {"strong": "强条", "ying": "应", "yi": "宜", "other": "其他"}
        want = level_map.get(level, level)
        rows = [r for r in rows if r.get("parsed", {}).get("review_class") == want]
    rows = sorted(rows, key=lambda r: review_sort_key(r, sort))
    total = len(rows)
    if limit and limit > 0:
        rows = rows[:limit]
    return {"database": str(db.path), "cut_id": cut_id, "total": total, "returned": len(rows), "sort": sort, "level": level, "component_name": component_name, "name_match": name_match, "reviews": rows}


def split_check_details(s: Any) -> list[str]:
    txt = "" if s is None else str(s)
    return [] if txt == "" else [p for p in re.split(r";\+;", txt) if p != ""]


def split_preserve(s: Any, sep: str) -> list[str]:
    return [] if s is None or str(s) == "" else [p.strip() for p in str(s).split(sep)]


def parse_base_check_row(row: dict[str, Any]) -> dict[str, Any]:
    details = split_check_details(row.get("scSele_Details", ""))
    titles = split_preserve(row.get("scSele_Titles", ""), ";")
    code_groups = [parse_int_list(x) for x in split_preserve(row.get("siCodeIdSs", ""), ";")]
    delete_flags, show_flags = parse_int_list(row.get("sbDeletes", "")), parse_int_list(row.get("sbShows", ""))
    ogs, colors = parse_int_list(row.get("siOG", "")), parse_int_list(row.get("siTitle_Colors", ""))
    items = []
    for i in range(max(len(details), len(titles), len(code_groups), len(delete_flags), len(show_flags), len(ogs), len(colors), 0)):
        items.append(
            {
                "detail": details[i] if i < len(details) else "",
                "title": titles[i] if i < len(titles) else "",
                "code_ids": code_groups[i] if i < len(code_groups) else [],
                "deleted": delete_flags[i] if i < len(delete_flags) else None,
                "shown": show_flags[i] if i < len(show_flags) else None,
                "og": ogs[i] if i < len(ogs) else None,
                "og_flags": decode_bits(ogs[i], OV_TYPE_BITS) if i < len(ogs) else [],
                "title_color": colors[i] if i < len(colors) else None,
            }
        )
    return {
        "raw": row,
        "component_type": COMPONENTTYPE_NAMES.get(parse_int(row.get("iCheckComPonent")), ""),
        "status": parse_int_list(row.get("sCheckStatus", "")),
        "hide_tabs": parse_int_list(row.get("sbHideTab", "")),
        "check_types": parse_int_list(row.get("siCheckType", "")),
        "review_items": items,
    }


def parse_drw_data_row(row: dict[str, Any], component_kind: str | None = None) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for k, v in row.items():
        if k in PAIR_FIELDS:
            pairs = parse_index_value_pairs(v)
            parsed[k] = {"by_index": pairs, "by_name": map_pair_names(k, pairs)}
        elif k in INT_LIST_FIELDS:
            parsed[k] = parse_int_list(v)
        elif k in FLOAT_LIST_FIELDS or k == "siSect":
            parsed[k] = parse_float_list(v)
        elif k in {"sMainBar", "smainBar"}:
            parsed[k] = parse_named_rows(v, ["iDia", "iGrade", "iNum", "iBunDle"])
        elif k == "sStisteel":
            parsed[k] = parse_named_rows(v, ["iDia", "iGrade", "iDist", "ing", "fGrade"])
        elif k in {"sSteelInfo", "sSteelinfo", "sSteelInfoInTab"}:
            parsed[k] = parse_named_rows(v, ["cSteel", "fDsnCal0", "fDsnCal1", "fRealCal", "bSameSteelGrade", "iResult"])
        elif isinstance(v, str) and ("," in v or ";" in v):
            parsed[k] = parse_semicolon_rows(v) if ";" in v else split_nonempty(v, ",")
    annotate_component_arrays(parsed, component_kind, row)
    return {"raw": row, "parsed_fields": parsed}


def parse_drw_data_brief(row: dict[str, Any], component_kind: str | None = None) -> dict[str, Any]:
    """Parse only fields needed for designer-facing component/reinforcement answers."""
    parsed: dict[str, Any] = {}
    for k in ("sDrwintData", "sBeamintData", "sColintData"):
        v = row_get(row, k)
        if v is not None:
            pairs = parse_index_value_pairs(v)
            parsed[k] = {"by_index": pairs, "by_name": map_pair_names(k, pairs)}
    for k in ("siPmids", "sikindType", "sisectType", "sistruc"):
        v = row_get(row, k)
        if v is not None:
            parsed[k] = parse_int_list(v)
    for k in ("siSect", "sPlx", "sPly"):
        v = row_get(row, k)
        if v is not None:
            parsed[k] = parse_float_list(v)
    v = row_get(row, "sMainBar", "smainBar")
    if v is not None:
        parsed["sMainBar"] = parse_named_rows(v, ["iDia", "iGrade", "iNum", "iBunDle"])
    annotate_component_arrays(parsed, component_kind, row)
    return {"raw": {}, "parsed_fields": parsed}


def component_table_config(kind: str) -> dict[str, str]:
    if kind == "beam":
        return {"index_alias": "check_beam", "data_alias": "drw_beam", "data_index_col": "nNoDrwDataBeam"}
    return {"index_alias": "check_col", "data_alias": "drw_col", "data_index_col": "nNoDrwDataCol"}


def row_get(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in row:
            return row.get(name)
    lower = {k.lower(): k for k in row}
    for name in names:
        key = lower.get(name.lower())
        if key is not None:
            return row.get(key)
    return None


def component_rows(
    db: MulCkDB,
    cut_id: int,
    kind: str = "auto",
    limit: int = 0,
    component_name: str | None = None,
    recognition_only: bool = False,
    name_match: str = "exact",
    detail: str = "brief",
    list_components: bool = False,
) -> dict[str, Any]:
    if kind == "auto":
        inferred = drawing_report(db, cut_id).get("inferred_component_kind", "unknown")
        kinds = [inferred] if inferred in ("beam", "column") else ["beam", "column"]
    elif kind in ("beam", "column", "col"):
        kinds = ["column" if kind == "col" else kind]
    else:
        kinds = ["beam", "column"]

    detail = "full" if detail == "full" else "brief"
    records, missing = [], []
    total_matches = 0
    counts_by_kind: dict[str, int] = {}
    need_rows = bool(component_name or list_components)

    for k in kinds:
        cfg = component_table_config(k)
        idx_table = db.table(cfg["index_alias"])
        data_table = db.table(cfg["data_alias"])
        base_table = db.table("base_check")
        if not idx_table:
            missing.append(f"{k}: missing {cfg['index_alias']}")
            continue

        count_for_kind = db.count_rows(idx_table, where=[(["DrwCutID", "DrwCutId"], cut_id)])
        counts_by_kind[k] = count_for_kind
        if not need_rows:
            total_matches += count_for_kind
            continue
        if not data_table or (not recognition_only and not base_table):
            missing.append(f"{k}: missing {cfg['data_alias']} / base_check")
            continue

        remaining = None if not limit or limit <= 0 else max(0, limit - len(records))

        if component_name:
            if name_match == "contains":
                data_candidates = db.select_rows_like(data_table, [(["DrwCutID", "DrwCutId"], cut_id)], "scMergeName", component_name, order=[["iNo", "iNO"]])
            else:
                data_candidates = db.select_rows(data_table, where=[(["DrwCutID", "DrwCutId"], cut_id), ("scMergeName", component_name)], order=[["iNo", "iNO"]])
            data_by_no_all = {row_get(r, "iNo", "iNO"): r for r in data_candidates}
            idx_rows_all = db.select_rows_in(
                idx_table,
                [(["DrwCutID", "DrwCutId"], cut_id)],
                cfg["data_index_col"],
                data_by_no_all.keys(),
                order=["iNo"],
            )
            total_matches += len(idx_rows_all)
            idx_rows = idx_rows_all if remaining is None else idx_rows_all[:remaining]
            data_by_no = data_by_no_all
        else:
            total_matches += count_for_kind
            if remaining == 0:
                continue
            idx_rows = db.select_rows(idx_table, where=[(["DrwCutID", "DrwCutId"], cut_id)], order=["iNo"], limit=remaining)
            data_nos = [idx.get(cfg["data_index_col"]) for idx in idx_rows]
            data_rows = db.select_rows_in(data_table, [(["DrwCutID", "DrwCutId"], cut_id)], ["iNo", "iNO"], data_nos, order=[["iNo", "iNO"]])
            data_by_no = {row_get(r, "iNo", "iNO"): r for r in data_rows}

        base_by_no: dict[Any, list[dict[str, Any]]] = defaultdict(list)
        if not recognition_only and base_table and idx_rows:
            base_nos = [idx.get("nNoBaseCheckData") for idx in idx_rows]
            for r in db.select_rows_in(base_table, [(["DrwCutID", "DrwCutId"], cut_id)], ["iNo", "iNO"], base_nos, order=[["iNo", "iNO"], "iCheckComPonent"]):
                base_by_no[row_get(r, "iNo", "iNO")].append(r)

        for idx in idx_rows:
            data_no, base_no = idx.get(cfg["data_index_col"]), idx.get("nNoBaseCheckData")
            data_row = data_by_no.get(data_no)
            if not data_row:
                continue

            data = parse_drw_data_row(data_row, component_kind=k) if detail == "full" else parse_drw_data_brief(data_row, component_kind=k)
            add_base_data_labels(data.get("parsed_fields", {}), k)
            parsed_fields = data.get("parsed_fields", {})
            reinforcement_text = parsed_fields.get("reinforcement_text", {}) if isinstance(parsed_fields, dict) else {}
            base_rows = [] if recognition_only else base_by_no.get(base_no, [])
            parsed_checks = [] if recognition_only else [parse_base_check_row(r) for r in base_rows]
            check_items = [it for chk in parsed_checks for it in chk.get("review_items", [])]

            record = {
                "component_type": k,
                "cut_id": cut_id,
                "component_name": row_get(data_row, "scMergeName") or "",
                "section_size": row_get(data_row, "scSectSize") or "",
                "pmids": parse_int_list(row_get(data_row, "siPmids") or ""),
                "reinforcement_summary": summarize_reinforcement_text(reinforcement_text),
                "check_item_count": len(check_items),
                "first_review": check_items[0].get("detail", "") if check_items else "",
            }
            if detail == "full":
                record["check_index_iNo"] = idx.get("iNo")
                record["draw_data_index"] = data_no
                record["base_check_index"] = base_no
                record["reinforcement_text"] = reinforcement_text
                record["check_data"] = parsed_checks
            else:
                record["review_items"] = check_items
            records.append(record)

    return {
        "database": str(db.path),
        "cut_id": cut_id,
        "kind_requested": kind,
        "recognition_only": recognition_only,
        "component_name": component_name,
        "name_match": name_match,
        "detail": detail,
        "list_components": list_components,
        "counts_by_kind": counts_by_kind,
        "total": total_matches,
        "returned": len(records),
        "missing_tables": missing,
        "components": records,
    }

def schema_report(db: MulCkDB) -> dict[str, Any]:
    return {
        "database": str(db.path),
        "tables": [{"table": t, "row_count": db.count_rows(t), "columns": [{"name": c, "type": typ} for c, typ in db.columns(t).items()]} for t in db.table_names()],
    }


def md_escape(value: Any, max_len: int | None = None) -> str:
    s = "" if value is None else str(value)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("|", "\\|").replace("\n", " <br> ")
    return (s[: max_len - 1] + "…") if max_len and len(s) > max_len else s


def review_row_brief(row: dict[str, Any]) -> dict[str, Any]:
    parsed = row.get("parsed", {}) if isinstance(row, dict) else {}
    text = row.get("OV_str_Detail") or row.get("OV_str") or row.get("cContent") or row.get("cPropertyloss") or ""
    point = parsed.get("MarkPoint") or parsed.get("leftPoint") or parsed.get("rightPoint") or []
    return {
        "class": parsed.get("review_class", ""),
        "code": parsed.get("OV_type_code_id") or "",
        "component": row.get("eleName", ""),
        "text": "" if text is None else str(text),
        "point": point[:2] if isinstance(point, list) else point,
    }


def component_row_brief(row: dict[str, Any]) -> dict[str, Any]:
    items = row.get("review_items")
    if items is None:
        items = [it for chk in row.get("check_data", []) for it in chk.get("review_items", [])]
    return {
        "type": row.get("component_type", ""),
        "name": row.get("component_name", ""),
        "section_size": row.get("section_size", ""),
        "pmids": row.get("pmids", []),
        "reinforcement": row.get("reinforcement_summary", ""),
        "review_count": row.get("check_item_count", len(items or [])),
        "first_review": row.get("first_review") or ((items or [{}])[0].get("detail", "") if items else ""),
    }


def compact_output(data: Any, command: str) -> Any:
    if not isinstance(data, dict):
        return data
    if command == "projects":
        return {
            "project_count": data.get("project_count", len(data.get("projects", []))),
            "drawing_count": data.get("drawing_count", 0),
            "projects": data.get("projects", []),
        }
    if command == "drawing":
        if "matches" in data:
            return data
        return {
            "cut_id": data.get("cut_id"),
            "drawing_name": data.get("drawing_name"),
            "drawing_type": data.get("drawing_type"),
            "review_count": data.get("review_count", 0),
            "outline_points": data.get("outline_points", []),
        }
    if command == "reviews":
        return {
            "cut_id": data.get("cut_id"),
            "total": data.get("total", 0),
            "returned": data.get("returned", 0),
            "sort": data.get("sort"),
            "level": data.get("level"),
            "component_name": data.get("component_name"),
            "reviews": [review_row_brief(r) for r in data.get("reviews", [])],
        }
    if command == "components":
        return {
            "cut_id": data.get("cut_id"),
            "total": data.get("total", 0),
            "returned": data.get("returned", 0),
            "counts_by_kind": data.get("counts_by_kind", {}),
            "component_name": data.get("component_name"),
            "components": [component_row_brief(c) for c in data.get("components", [])],
        }
    if command == "schema":
        return {"tables": [{"table": t.get("table"), "row_count": t.get("row_count")} for t in data.get("tables", [])]}
    return data


def print_projects_md(data: dict[str, Any]) -> None:
    print(f"项目：{data.get('project_count', len(data.get('projects', [])))} 个；图纸：{data.get('drawing_count', 0)} 张\n")
    print("| 项目 | CutID | 图纸名称 | 类型 | 校审意见数量 |")
    print("| --- | ---: | --- | --- | ---: |")
    for project in data.get("projects", []):
        pname = project.get("project_name", "")
        for d in project.get("drawings", []):
            print(f"| {md_escape(pname, 80)} | {d.get('cut_id')} | {md_escape(d.get('drawing_name'))} | {md_escape(d.get('drawing_type'))} | {d.get('review_count', 0)} |")


def print_schema_md(data: dict[str, Any]) -> None:
    print("| 表 | 行数 |")
    print("| --- | ---: |")
    for t in data.get("tables", []):
        print(f"| `{t['table']}` | {t['row_count']} |")


def print_drawing_md(data: dict[str, Any]) -> None:
    if "matches" in data:
        print(json.dumps(compact_output(data, "drawing"), ensure_ascii=False, indent=2))
        return
    print("| 图纸名称 | 类型 | 校审意见数量 |")
    print("| --- | --- | ---: |")
    print(f"| {md_escape(data.get('drawing_name'))} | {md_escape(data.get('drawing_type'))} | {data.get('review_count', 0)} |")


def print_reviews_md(data: dict[str, Any]) -> None:
    print(f"CutID: `{data.get('cut_id')}`；意见: {data.get('total', 0)}；返回: {data.get('returned', 0)}；排序: {data.get('sort', 'spec')}\n")
    print("| 类别 | 规范 | 构件 | 内容 | 定位 |")
    print("| --- | ---: | --- | --- | --- |")
    for r in data.get("reviews", []):
        b = review_row_brief(r)
        print(f"| {md_escape(b.get('class'))} | {b.get('code') or ''} | {md_escape(b.get('component'))} | {md_escape(b.get('text'))} | {md_escape(b.get('point'))} |")


def print_components_md(data: dict[str, Any]) -> None:
    counts = data.get("counts_by_kind", {}) or {}
    if not data.get("components"):
        beam = counts.get("beam", 0)
        col = counts.get("column", 0)
        parts = []
        if "beam" in counts:
            parts.append(f"梁 {beam}")
        if "column" in counts:
            parts.append(f"柱 {col}")
        tail = f"（{'；'.join(parts)}）" if parts else ""
        print(f"CutID: `{data.get('cut_id')}`；构件总数: {data.get('total', 0)}{tail}")
        return
    print(f"CutID: `{data.get('cut_id')}`；匹配构件: {data.get('total', 0)}；返回: {data.get('returned', 0)}\n")
    print("| # | 类型 | 构件名 | 尺寸 | PMIDs | 配筋 | 校审条数 | 首条意见 |")
    print("| ---: | --- | --- | --- | --- | --- | ---: | --- |")
    for i, c in enumerate(data.get("components", []), 1):
        b = component_row_brief(c)
        print(f"| {i} | {b.get('type')} | {md_escape(b.get('name'))} | {md_escape(b.get('section_size'))} | {md_escape(b.get('pmids'))} | {md_escape(b.get('reinforcement'), 180)} | {b.get('review_count', 0)} | {md_escape(b.get('first_review'))} |")

def emit(data: Any, fmt: str, command: str) -> None:
    data = compact_output(data, command) if fmt == "json" else data
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif command == "projects":
        print_projects_md(data)
    elif command == "schema":
        print_schema_md(data)
    elif command == "drawing":
        print_drawing_md(data)
    elif command == "reviews":
        print_reviews_md(data)
    elif command == "components":
        print_components_md(data)
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect and interpret MulCkdata SQLite DB files.")
    parser.add_argument("--db", required=True, help="Path to MulCkdata.db")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_format_arg(p: argparse.ArgumentParser) -> None:
        # Let users place --format either before or after the subcommand.
        p.add_argument("--format", choices=["markdown", "json"], default=argparse.SUPPRESS)

    p = sub.add_parser("schema", help="List tables, row counts, and columns")
    add_format_arg(p)
    p = sub.add_parser("projects", help="List projects and drawings from DwgInfo")
    add_format_arg(p)
    p = sub.add_parser("drawing", help="Show one drawing/basic info by CutID or CutName")
    add_format_arg(p)
    p.add_argument("--cut-id", type=int)
    p.add_argument("--cut-name")
    p.add_argument("--project")
    p.add_argument("--full", action="store_true", help="Show full parsed fields instead of designer brief")
    p = sub.add_parser("reviews", help="List drawing-level review rows from SElesTable")
    add_format_arg(p)
    p.add_argument("--cut-id", type=int, required=True)
    p.add_argument("--limit", type=int, default=50, help="0 means no limit")
    p.add_argument("--contains", help="Filter rows by substring across decoded fields")
    p.add_argument("--component-name", help="Filter by eleName")
    p.add_argument("--name-match", choices=["exact", "contains"], default="exact", help="Component name match mode; exact is faster")
    p.add_argument("--sort", choices=["spec", "component", "raw"], default="spec", help="Default spec: 强条、应、宜, then same code together")
    p.add_argument("--level", choices=["all", "strong", "ying", "yi", "other"], default="all")
    p = sub.add_parser("components", help="Join CheckData* index, DrwData* recognition data, and CheckBaseDataTable")
    add_format_arg(p)
    p.add_argument("--cut-id", type=int, required=True)
    p.add_argument("--kind", choices=["auto", "beam", "column", "col", "all"], default="auto")
    p.add_argument("--limit", type=int, default=50, help="0 means no limit")
    p.add_argument("--component-name", help="Filter by scMergeName, e.g. KZ1 or KL2")
    p.add_argument("--name-match", choices=["exact", "contains"], default="exact", help="Component name match mode; exact is faster")
    p.add_argument("--recognition-only", action="store_true", help="Only show drawing recognition/reinforcement data; skip component review details")
    p.add_argument("--detail", choices=["brief", "full"], default="brief", help="brief omits raw decoded rows for faster JSON/context output")
    p.add_argument("--list", action="store_true", help="List component rows; without this and without --component-name only counts are shown")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    db = MulCkDB(args.db)
    try:
        if args.command == "schema":
            data = schema_report(db)
        elif args.command == "projects":
            data = list_projects(db)
        elif args.command == "drawing":
            matches = resolve_drawings(db, args.cut_id, args.cut_name, args.project)
            if not matches:
                data = {"database": str(db.path), "matches": [], "note": "No drawing matched"}
            elif args.cut_id is None and len(matches) != 1:
                data = {"database": str(db.path), "matches": matches, "note": "Multiple drawings matched; rerun with --cut-id for details"}
            else:
                cut_id = int(args.cut_id if args.cut_id is not None else matches[0]["CutID"])
                data = drawing_report(db, cut_id, matches[0] if matches else None) if args.full else drawing_brief(db, cut_id, matches[0] if matches else None)
        elif args.command == "reviews":
            data = review_rows(db, args.cut_id, args.limit, args.contains, args.sort, args.component_name, args.level, args.name_match)
        elif args.command == "components":
            data = component_rows(db, args.cut_id, args.kind, args.limit, args.component_name, args.recognition_only, args.name_match, args.detail, args.list)
        else:
            raise ValueError(args.command)
        emit(data, args.format, args.command)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
