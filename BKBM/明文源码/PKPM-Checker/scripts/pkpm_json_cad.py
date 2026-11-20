#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Draw PKPM CheckList JSON review annotations in AutoCAD via COM."""
from __future__ import annotations

import argparse
import math
import re
import sys
import time
from pathlib import Path
from typing import Any

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from pkpm_json_query import flatten_reviews, filter_reviews, load_from_args, summary_report  # noqa: E402

DEFAULT_LAYER = "PKPM_Check_Show_Mark"
DEFAULT_COLOR = 6  # AutoCAD ACI 6 = 洋红/品红
DEFAULT_TEXT_STYLE = "PKPM_Check_Show_Text"
DEFAULT_FONT_FILE = "pkpmeng.shx"
DEFAULT_BIG_FONT_FILE = "pkpmchn.shx"
DEFAULT_WIDTH_FACTOR = 0.7
DEFAULT_OBLIQUE_ANGLE = 0.0
DEFAULT_MERGE_TOLERANCE = 1e-6
DEFAULT_TEXT_HEIGHT = 50.0
NOTE_TEXT_WIDTH_FACTOR = 60.0
NOTE_LEADER_OUT_FACTOR = 6.0
NOTE_LEADER_OUT_EXTRA = 100.0
NOTE_TEXT_LINE_SPACING = 70.0
NOTE_TEXT_SIDE_GAP_FACTOR = 0.30
AC_ATTACHMENT_TOP_LEFT = 1
AC_LINE_SPACING_STYLE_AT_LEAST = 1
BEAM_NAME_PREFIXES = ("WKL", "KZL", "JZL", "KL", "LL", "XL", "DL", "L")
COLUMN_NAME_PREFIXES = ("KZ", "YBZ", "GBZ", "AZ", "BZ", "DZ", "QZ", "Z")


def acad_point(x: float, y: float, z: float = 0.0) -> Any:
    import pythoncom
    import win32com.client

    return win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, [float(x), float(y), float(z)])


def pump_wait(seconds: float = 0.1) -> None:
    try:
        import pythoncom

        pythoncom.PumpWaitingMessages()
    except Exception:
        pass
    time.sleep(seconds)


def wait_for_acad_ready(acad: Any, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    last_exc: Exception | None = None
    while time.monotonic() < deadline:
        try:
            _ = acad.Documents.Count
            return
        except Exception as exc:
            last_exc = exc
            pump_wait(0.25)
    raise RuntimeError(f"AutoCAD COM 未就绪，等待 {timeout:g}s 超时：{last_exc}")


def active_document_or_none(acad: Any) -> Any | None:
    try:
        return acad.ActiveDocument
    except Exception:
        return None


def command_names(doc: Any) -> str:
    try:
        return str(doc.GetVariable("CMDNAMES") or "").strip()
    except Exception:
        return ""


def cancel_active_command(acad: Any, timeout: float = 5.0) -> None:
    """Cancel a pending AutoCAD command prompt before COM open/draw operations."""
    doc = active_document_or_none(acad)
    if doc is None or not command_names(doc):
        return
    for cancel in ("\x03\x03", "\x1b\x1b"):
        try:
            doc.SendCommand(cancel)
        except Exception:
            pass
        deadline = time.monotonic() + timeout / 2.0
        while time.monotonic() < deadline:
            if not command_names(doc):
                return
            pump_wait(0.1)


def comparable_path(path_value: str | Path) -> str:
    try:
        return str(Path(str(path_value)).expanduser().resolve()).replace("/", "\\").rstrip("\\").casefold()
    except Exception:
        return str(path_value).replace("/", "\\").rstrip("\\").casefold()


def doc_full_name(doc: Any) -> str:
    try:
        value = str(doc.FullName or "")
        if value:
            return value
    except Exception:
        pass
    try:
        folder = str(doc.Path or "")
        name = str(doc.Name or "")
        if folder and name:
            return str(Path(folder) / name)
        return name
    except Exception:
        return ""


def iter_acad_documents(acad: Any) -> list[Any]:
    try:
        docs = acad.Documents
        count = int(docs.Count)
    except Exception:
        return []
    out: list[Any] = []
    try:
        for doc in docs:
            out.append(doc)
        if out:
            return out
    except Exception:
        pass
    seen: set[str] = set()
    for idx in [*range(count), *range(1, count + 1)]:
        try:
            doc = docs.Item(idx)
            ident = doc_full_name(doc) or str(idx)
            if ident in seen:
                continue
            seen.add(ident)
            out.append(doc)
        except Exception:
            continue
    return out


def find_open_document(acad: Any, dwg_path: Path) -> Any | None:
    target = comparable_path(dwg_path)
    for doc in iter_acad_documents(acad):
        full_name = doc_full_name(doc)
        if full_name and comparable_path(full_name) == target:
            return doc
    return None


def activate_document(doc: Any) -> None:
    try:
        doc.Activate()
    except Exception:
        pass


def wait_for_document_open(acad: Any, dwg_path: Path, timeout: float = 60.0) -> Any | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        doc = find_open_document(acad, dwg_path)
        if doc is not None:
            activate_document(doc)
            return doc
        pump_wait(0.25)
    return None


def get_acad() -> Any:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        acad = win32com.client.GetActiveObject("AutoCAD.Application")
    except Exception:
        acad = win32com.client.DispatchEx("AutoCAD.Application")
    try:
        acad.Visible = True
    except Exception:
        pass
    try:
        acad.WindowState = 3
    except Exception:
        pass
    wait_for_acad_ready(acad)
    return acad


def open_dwg_if_needed(acad: Any, dwg_path: str | None) -> Any:
    """Return an active DWG document.

    Stable open policy:
    - if AutoCAD is not running, get_acad() starts it through COM;
    - if an AutoCAD command prompt is pending, cancel it first;
    - if target DWG is already open, only activate it;
    - otherwise open by Documents.Open (not command-line OPEN/SendCommand).
    """
    wait_for_acad_ready(acad)
    cancel_active_command(acad)
    if not dwg_path:
        doc = active_document_or_none(acad)
        if doc is None:
            docs = iter_acad_documents(acad)
            if not docs:
                raise RuntimeError("未指定 --dwg，且当前 AutoCAD 没有活动图纸")
            doc = docs[0]
        activate_document(doc)
        cancel_active_command(acad)
        return doc
    p = Path(dwg_path).expanduser()
    if not p.is_absolute():
        p = p.resolve()
    if not p.exists():
        raise FileNotFoundError(f"DWG 文件不存在：{p}")
    already_open = find_open_document(acad, p)
    if already_open is not None:
        activate_document(already_open)
        cancel_active_command(acad)
        print(f"DWG 已打开，已切换到现有图纸：{p}")
        return already_open
    try:
        doc = acad.Documents.Open(str(p))
    except Exception as exc:
        opened = wait_for_document_open(acad, p, timeout=5.0)
        if opened is not None:
            cancel_active_command(acad)
            return opened
        raise RuntimeError(f"AutoCAD COM 打开 DWG 失败：{p}；{exc}") from exc
    opened = wait_for_document_open(acad, p, timeout=60.0) or doc
    activate_document(opened)
    cancel_active_command(acad)
    return opened


def ensure_layer(doc: Any, name: str, color: int = DEFAULT_COLOR) -> Any:
    try:
        layer = doc.Layers.Item(name)
    except Exception:
        layer = doc.Layers.Add(name)
    try:
        layer.Color = int(color)
    except Exception:
        pass
    return layer


def ensure_text_style(
    doc: Any,
    name: str = DEFAULT_TEXT_STYLE,
    font_file: str = DEFAULT_FONT_FILE,
    big_font_file: str = DEFAULT_BIG_FONT_FILE,
    width_factor: float = DEFAULT_WIDTH_FACTOR,
    oblique_angle: float = DEFAULT_OBLIQUE_ANGLE,
) -> Any:
    try:
        style = doc.TextStyles.Item(name)
    except Exception:
        style = doc.TextStyles.Add(name)
    for attr, value in (
        ("FontFile", font_file),
        ("BigFontFile", big_font_file),
        ("Width", float(width_factor)),
        ("WidthFactor", float(width_factor)),
        ("ObliqueAngle", float(oblique_angle)),
    ):
        try:
            setattr(style, attr, value)
        except Exception:
            pass
    return style


def set_annotation_context(doc: Any, layer: Any, text_style: Any) -> None:
    """Set current AutoCAD layer/text style before drawing, then each entity is styled again.

    Some AutoCAD/vertical-product COM calls create entities on the current layer first.
    We therefore both set document defaults here and explicitly set Layer/StyleName on
    every created entity in apply_entity_style().
    """
    try:
        doc.ActiveLayer = layer
    except Exception:
        pass
    try:
        doc.ActiveTextStyle = text_style
    except Exception:
        pass


def ensure_annotation_context(
    doc: Any,
    layer_name: str,
    color: int,
    text_style: str,
    font_file: str,
    big_font_file: str,
    width_factor: float,
    oblique_angle: float,
) -> None:
    layer = ensure_layer(doc, layer_name, color)
    style = ensure_text_style(doc, text_style, font_file, big_font_file, width_factor, oblique_angle)
    set_annotation_context(doc, layer, style)


def apply_entity_style(obj: Any, layer: str, color: int = DEFAULT_COLOR, style_name: str | None = None) -> Any:
    try:
        obj.Layer = layer
    except Exception:
        pass
    try:
        obj.Color = int(color)
    except Exception:
        pass
    if style_name:
        for attr in ("StyleName", "TextStyleName"):
            try:
                setattr(obj, attr, style_name)
            except Exception:
                pass
    try:
        obj.Update()
    except Exception:
        pass
    return obj


def set_entity_rotation(obj: Any, rotation: float | None) -> None:
    if rotation is None:
        return
    try:
        obj.Rotation = float(rotation)
    except Exception:
        pass


def add_text(ms: Any, text: str, x: float, y: float, height: float, layer: str, color: int, style_name: str, rotation: float | None = None) -> Any:
    obj = ms.AddText(text, acad_point(x, y, 0), float(height))
    set_entity_rotation(obj, rotation)
    return apply_entity_style(obj, layer, color, style_name)


def add_mtext_or_text(
    ms: Any,
    text: str,
    x: float,
    y: float,
    z: float,
    width: float,
    height: float,
    layer: str,
    color: int,
    style_name: str,
    rotation: float | None = None,
) -> Any:
    try:
        mt = ms.AddMText(acad_point(x, y, z), float(width), text)
        mt.Height = float(height)
        try:
            mt.AttachmentPoint = AC_ATTACHMENT_TOP_LEFT
        except Exception:
            pass
        try:
            mt.LineSpacingStyle = AC_LINE_SPACING_STYLE_AT_LEAST
        except Exception:
            pass
        try:
            mt.LineSpacingDistance = NOTE_TEXT_LINE_SPACING
        except Exception:
            pass
        try:
            # AutoCAD default factor 1.0 gives distance ~= height * 5/3.
            # Set the matching factor as fallback for versions that ignore LineSpacingDistance.
            default_distance = max(float(height) * (5.0 / 3.0), 1e-6)
            mt.LineSpacingFactor = max(0.25, min(4.0, NOTE_TEXT_LINE_SPACING / default_distance))
        except Exception:
            pass
        set_entity_rotation(mt, rotation)
        return apply_entity_style(mt, layer, color, style_name)
    except Exception:
        return add_text(ms, text.replace("\n", " "), x, y, height, layer, color, style_name, rotation)


def text_display_units(text: str) -> int:
    units = 0
    for ch in str(text or ""):
        if ch == "\t":
            units += 4
        elif ord(ch) >= 0x2E80:
            units += 2
        else:
            units += 1
    return units


def estimate_note_line_count(text: str, width: float, height: float) -> int:
    """Estimate rendered MText rows so longer notes get longer leader lines."""
    height = max(float(height or 1.0), 1e-6)
    width = max(float(width or height), height)
    # In SHX/CJK drawings one Chinese char is roughly one text height wide, while ASCII is narrower.
    max_units = max(int(width / height * 2.0), 1)
    count = 0
    for raw_line in str(text or "").splitlines() or [""]:
        units = max(text_display_units(raw_line), 1)
        count += max(1, math.ceil(units / max_units))
    return max(count, 1)


def note_text_width(height: float) -> float:
    return max(float(height) * NOTE_TEXT_WIDTH_FACTOR, float(height))


def note_leader_length(text: str, height: float, width: float | None = None) -> float:
    """Return lead-out length + fixed text line spacing * estimated text rows."""
    height = max(float(height or 1.0), 1e-6)
    width = note_text_width(height) if width is None else float(width)
    rows = estimate_note_line_count(text, width, height)
    lead_out_length = max(height * NOTE_LEADER_OUT_FACTOR + NOTE_LEADER_OUT_EXTRA, 1.0)
    return max(lead_out_length + NOTE_TEXT_LINE_SPACING * rows, 1.0)


def add_oriented_note(
    ms: Any,
    text: str,
    mark: tuple[float, float, float],
    direction: tuple[float, float],
    height: float,
    layer: str,
    color: int,
    style_name: str,
    draw_circle: bool = False,
) -> None:
    ux, uy = direction
    length = math.hypot(ux, uy)
    if length <= 1e-9:
        ux, uy = 0.0, 1.0
    else:
        ux, uy = ux / length, uy / length

    width = note_text_width(height)
    line_len = note_leader_length(text, height, width)
    ex, ey, ez = mark[0] + ux * line_len, mark[1] + uy * line_len, mark[2]
    line = ms.AddLine(acad_point(mark[0], mark[1], mark[2]), acad_point(ex, ey, ez))
    apply_entity_style(line, layer, color)
    if draw_circle:
        try:
            circle = ms.AddCircle(acad_point(mark[0], mark[1], mark[2]), height * 0.35)
            apply_entity_style(circle, layer, color)
        except Exception:
            pass

    # Text baseline is perpendicular to the leader direction.  Use the leader
    # endpoint as the MText top-left anchor so the visible line spans the full
    # text block height plus the requested lead-out length.
    text_angle = math.atan2(uy, ux) - math.pi / 2.0
    bx, by = math.cos(text_angle), math.sin(text_angle)
    side_gap = height * NOTE_TEXT_SIDE_GAP_FACTOR
    tx = ex + bx * side_gap
    ty = ey + by * side_gap
    add_mtext_or_text(ms, text, tx, ty, ez, width, height, layer, color, style_name, text_angle)


def point_from_value(value: Any) -> tuple[float, float, float] | None:
    if isinstance(value, dict):
        keys = [("x", "y", "z"), ("X", "Y", "Z")]
        for kx, ky, kz in keys:
            if kx in value and ky in value:
                try:
                    return float(value[kx]), float(value[ky]), float(value.get(kz, 0.0) or 0.0)
                except Exception:
                    return None
        return None
    if isinstance(value, str):
        parts = [p for p in re.split(r"[,;\s]+", value.strip()) if p]
    elif isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        return None
    if len(parts) < 2:
        return None
    try:
        z = parts[2] if len(parts) >= 3 else 0.0
        return float(parts[0]), float(parts[1]), float(z or 0.0)
    except Exception:
        return None


def named_point(row: dict[str, Any], *names: str) -> tuple[float, float, float] | None:
    sources = [row]
    values = row.get("values")
    if isinstance(values, dict):
        sources.append(values)
    lowered = {name.lower() for name in names}
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key, value in source.items():
            if str(key).lower() in lowered:
                pt = point_from_value(value)
                if pt:
                    return pt
    return None


def coords_points(coords: Any) -> list[tuple[float, float, float]]:
    direct = point_from_value(coords)
    if direct:
        return [direct]
    out: list[tuple[float, float, float]] = []
    if not isinstance(coords, list):
        return out
    for item in coords:
        pt = point_from_value(item)
        if pt:
            out.append(pt)
    return out


def distance2(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2


def ordered_endpoints(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    dx = abs(a[0] - b[0])
    dy = abs(a[1] - b[1])
    if dx >= dy:
        return (a, b) if a[0] <= b[0] else (b, a)
    return (a, b) if a[1] <= b[1] else (b, a)


def midpoint(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0


def annotation_points(row: dict[str, Any]) -> dict[str, tuple[float, float, float] | None]:
    """Return left/mark/right points from JSON without unit conversion."""
    left = named_point(row, "leftPoint", "LeftPoint", "left")
    mark = named_point(row, "MarkPoint", "markPoint", "mark", "point")
    right = named_point(row, "rightPoint", "RightPoint", "right")
    pts = coords_points(row.get("coords"))

    if (not left or not mark or not right) and len(pts) >= 3:
        # CheckList coords 按 MarkPoint / leftPoint / rightPoint 顺序输出。
        # 柱构件常见 left/right 为同一点，不能用“最长边”反推 MarkPoint。
        mark = mark or pts[0]
        left = left or pts[1]
        right = right or pts[2]
    elif (not left or not mark or not right) and len(pts) == 2:
        inferred_left, inferred_right = ordered_endpoints(pts[0], pts[1])
        left = left or inferred_left
        right = right or inferred_right
        mark = mark or midpoint(inferred_left, inferred_right)
    elif not mark and len(pts) == 1:
        mark = pts[0]

    return {"left": left, "mark": mark, "right": right}


def add_leader_note(ms: Any, text: str, x: float, y: float, z: float, height: float, layer: str, color: int, style_name: str, index: int = 0) -> None:
    # Legacy helper: keep a mostly vertical leader, with small fan-out for repeated notes.
    add_oriented_note(ms, text, (x, y, z), (0.15 * (index % 3), 1.0), height, layer, color, style_name, draw_circle=True)


def add_perpendicular_note(
    ms: Any,
    text: str,
    mark: tuple[float, float, float],
    left: tuple[float, float, float] | None,
    right: tuple[float, float, float] | None,
    height: float,
    layer: str,
    color: int,
    style_name: str,
) -> None:
    if left and right:
        vx, vy = right[0] - left[0], right[1] - left[1]
        length = math.hypot(vx, vy)
    else:
        vx, vy, length = 1.0, 0.0, 1.0
    if length <= 1e-9:
        nx, ny = 0.0, 1.0
    else:
        ux, uy = vx / length, vy / length
        nx, ny = -uy, ux
    # 统一选择向右/向上的法线，文字再放到短线右侧，避免梁标注跑到图纸远处。
    if nx < -1e-9 or (abs(nx) <= 1e-9 and ny < 0):
        nx, ny = -nx, -ny
    add_oriented_note(ms, text, mark, (nx, ny), height, layer, color, style_name)


def is_beam_review(row: dict[str, Any]) -> bool:
    raw_name = str(row.get("component") or "")
    name = raw_name.strip().upper()
    if any(name.startswith(prefix) for prefix in BEAM_NAME_PREFIXES):
        return True
    if any(name.startswith(prefix) for prefix in COLUMN_NAME_PREFIXES):
        return False
    text = f"{raw_name} {row.get('part') or ''} {row.get('message') or ''}"
    if "梁" in text:
        return True
    if "柱" in text:
        return False
    return False


def is_column_review(row: dict[str, Any]) -> bool:
    raw_name = str(row.get("component") or "")
    name = raw_name.strip().upper()
    if any(name.startswith(prefix) for prefix in BEAM_NAME_PREFIXES):
        return False
    if any(name.startswith(prefix) for prefix in COLUMN_NAME_PREFIXES):
        return True
    text = f"{raw_name} {row.get('part') or ''} {row.get('message') or ''}"
    if "柱" in text:
        return True
    if "梁" in text:
        return False
    return False


def add_vertical_note(
    ms: Any,
    text: str,
    mark: tuple[float, float, float],
    height: float,
    layer: str,
    color: int,
    style_name: str,
) -> None:
    add_oriented_note(ms, text, mark, (0.0, 1.0), height, layer, color, style_name)


def mark_point_key(mark: tuple[float, float, float], tolerance: float = DEFAULT_MERGE_TOLERANCE) -> tuple[int, int, int] | tuple[float, float, float]:
    tol = float(tolerance or 0.0)
    if tol <= 0:
        return (round(float(mark[0]), 9), round(float(mark[1]), 9), round(float(mark[2]), 9))
    return tuple(int(round(float(v) / tol)) for v in mark)


def merge_review_texts(texts: list[str]) -> str:
    unique: list[str] = []
    seen: set[str] = set()
    for text in texts:
        item = str(text or "").strip()
        if not item:
            continue
        key = re.sub(r"\s+", " ", item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    if len(unique) <= 1:
        return unique[0] if unique else ""
    return "\n".join(f"{idx}. {item}" for idx, item in enumerate(unique, 1))


def compact_review_text(row: dict[str, Any], max_len: int = 0) -> str:
    parts = []
    head = f"[{row.get('check_type','')}/{row.get('severity','')}] {row.get('standard','')} {row.get('clause','')}".strip()
    if head:
        parts.append(head)
    comp = row.get("component") or ""
    part = row.get("part") or ""
    if comp or part:
        parts.append(f"{comp} {part}".strip())
    parts.append(row.get("message") or "")
    text = "\n".join(p for p in parts if p)
    if max_len and len(text) > max_len:
        text = text[: max_len - 1] + "…"
    return text


def draw_reviews(args: argparse.Namespace) -> int:
    data = load_from_args(args)
    rows = filter_reviews(flatten_reviews(data), args)
    if args.limit and args.limit > 0:
        rows = rows[: args.limit]

    acad = get_acad()
    doc = open_dwg_if_needed(acad, args.dwg)
    ms = doc.ModelSpace
    ensure_annotation_context(doc, args.layer, args.color, args.text_style, args.font_file, args.big_font_file, args.width_factor, args.oblique_angle)

    groups: list[dict[str, Any]] = []
    by_mark: dict[tuple[int, int, int] | tuple[float, float, float], dict[str, Any]] = {}
    review_count = 0
    skipped = 0
    for row in rows:
        pts = annotation_points(row)
        mark = pts.get("mark")
        if not mark:
            skipped += 1
            continue
        text = compact_review_text(row, args.max_len)
        key = mark_point_key(mark, args.merge_tolerance)
        group = by_mark.get(key)
        if group is None:
            group = {"mark": mark, "left": None, "right": None, "texts": [], "has_beam": False, "has_column": False}
            by_mark[key] = group
            groups.append(group)
        group["texts"].append(text)
        if is_column_review(row):
            group["has_column"] = True
        elif is_beam_review(row):
            group["has_beam"] = True
            if pts.get("left") and pts.get("right") and not (group.get("left") and group.get("right")):
                group["left"], group["right"] = pts.get("left"), pts.get("right")
        elif pts.get("left") and pts.get("right") and not (group.get("left") and group.get("right")):
            group["left"], group["right"] = pts.get("left"), pts.get("right")
        review_count += 1

    drawn = 0
    for group in groups:
        text = merge_review_texts(group.get("texts") or [])
        if not text:
            continue
        mark = group["mark"]
        left = group.get("left")
        right = group.get("right")
        if group.get("has_column"):
            add_vertical_note(ms, text, mark, args.text_height, args.layer, args.color, args.text_style)
        elif group.get("has_beam") or (left and right):
            add_perpendicular_note(ms, text, mark, left, right, args.text_height, args.layer, args.color, args.text_style)
        else:
            add_vertical_note(ms, text, mark, args.text_height, args.layer, args.color, args.text_style)
        drawn += 1
    merged = max(review_count - drawn, 0)
    print(f"已绘制 JSON 校审意见批注：{drawn} 处/{review_count} 条；同点合并：{merged} 条；无坐标跳过：{skipped} 条")
    return 0


def draw_summary(args: argparse.Namespace) -> int:
    data = load_from_args(args)
    summary = summary_report(data)
    acad = get_acad()
    doc = open_dwg_if_needed(acad, args.dwg)
    ms = doc.ModelSpace
    ensure_annotation_context(doc, args.layer, args.color, args.text_style, args.font_file, args.big_font_file, args.width_factor, args.oblique_angle)
    text = (
        f"PKPM图纸识别校审：图纸 {summary.get('drawing_count', 0)} 张，"
        f"构件 {summary.get('component_count', 0)} 个，"
        f"审查意见 {summary.get('review_count', 0)} 条"
    )
    add_text(ms, text, args.x, args.y, args.text_height, args.layer, args.color, args.text_style)
    print(f"已绘制 JSON 校审汇总：{text}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Draw PKPM CheckList JSON review annotations in AutoCAD via COM.")
    parser.add_argument("--json", action="append", help="CheckList.json 路径，可多次传入")
    parser.add_argument("--from-log", help="识别校审 log.json 路径，从 output_json 字段读取 CheckList.json")
    parser.add_argument("--dwg", help="可选：用 AutoCAD COM Documents.Open 直接打开指定 DWG 后绘制；不传则使用当前活动 CAD 图纸")
    parser.add_argument("--text-height", type=float, default=DEFAULT_TEXT_HEIGHT)
    parser.add_argument("--layer", default=DEFAULT_LAYER)
    parser.add_argument("--color", type=int, default=DEFAULT_COLOR)
    parser.add_argument("--text-style", default=DEFAULT_TEXT_STYLE)
    parser.add_argument("--font-file", default=DEFAULT_FONT_FILE)
    parser.add_argument("--big-font-file", default=DEFAULT_BIG_FONT_FILE)
    parser.add_argument("--width-factor", type=float, default=DEFAULT_WIDTH_FACTOR)
    parser.add_argument("--oblique-angle", type=float, default=DEFAULT_OBLIQUE_ANGLE)
    parser.add_argument("--merge-tolerance", type=float, default=DEFAULT_MERGE_TOLERANCE, help="MarkPoint 同点合并容差，默认 1e-6；设为 0 则按四舍五入坐标精确合并")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("reviews", help="绘制 JSON 审查意见批注")
    p.add_argument("--drawing")
    p.add_argument("--component-name")
    p.add_argument("--name-match", choices=["exact", "contains"], default="exact")
    p.add_argument("--check-type")
    p.add_argument("--severity")
    p.add_argument("--level", choices=["all", "strong", "ying", "yi", "other"], default="all")
    p.add_argument("--contains")
    p.add_argument("--sort", choices=["spec", "component", "raw"], default="component")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--max-len", type=int, default=0)
    p.add_argument("--merge-tolerance", type=float, default=argparse.SUPPRESS, help="MarkPoint 同点合并容差；也可放在子命令后")

    p = sub.add_parser("summary", help="绘制 JSON 校审汇总文字")
    p.add_argument("--x", type=float, default=0.0)
    p.add_argument("--y", type=float, default=0.0)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "reviews":
        return draw_reviews(args)
    if args.command == "summary":
        return draw_summary(args)
    raise ValueError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
