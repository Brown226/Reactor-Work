"""Portable plugin UI v1 contract. Shared by the application and standalone validator.

Only standard-library imports: plugin-creator scripts can run outside the server.
Conditions belong to parameter keys, never to their position in the layout.
"""
from __future__ import annotations

import copy
import math
import re
from typing import Any

VERSION = 1
ACTIONS = {"run", "reset"}
DECIMAL = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")


def default_ui(params: list[dict]) -> dict:
    sections: list[dict] = []
    last_group: str | None = None
    for p in params:
        group = p.get("group", "")
        if not sections or group != last_group:
            sections.append({"id": f"group:{p['key']}", "title": group,
                             "collapsible": bool(group), "collapsed": False, "items": []})
        sections[-1]["items"].append({"id": f"field:{p['key']}", "type": "field", "key": p["key"], "width": "auto"})
        last_group = group
    return {"version": VERSION, "fields": {}, "sections": sections}


def reconcile_ui(ui: dict, params: list[dict]) -> tuple[dict, list[str]]:
    """Only reconcile references to removed/added parameters; never repair conditions."""
    result = copy.deepcopy(ui)
    result.setdefault("fields", {})
    keys = {p["key"] for p in params}
    warnings: list[str] = []
    seen: set[str] = set()
    fields = result.get("fields")
    if isinstance(fields, dict):
        for key in list(fields):
            if key not in keys:
                del fields[key]
                warnings.append(f"已移除不存在的参数：{key}")
    sections = result.get("sections")
    if not isinstance(sections, list):
        return result, warnings
    for section in sections:
        if not isinstance(section, dict) or not isinstance(section.get("items"), list):
            continue
        kept = []
        for item in section["items"]:
            if isinstance(item, dict) and item.get("type") == "field":
                key = item.get("key")
                if isinstance(key, str) and key not in keys:
                    warnings.append(f"已移除不存在的布局字段：{key}")
                    continue
                if isinstance(key, str):
                    seen.add(key)
            kept.append(item)
        section["items"] = kept
    added = [p for p in params if p["key"] not in seen]
    if added:
        existing = {s["id"] for s in sections if isinstance(s, dict) and isinstance(s.get("id"), str)}
        section_id = "added-parameters"
        while section_id in existing:
            section_id += "-new"
        sections.append({"id": section_id, "title": "", "collapsible": False, "collapsed": False,
                         "items": [{"id": f"field:{p['key']}", "type": "field", "key": p["key"], "width": "auto"} for p in added]})
    return result, warnings


def _literal_matches(value: Any, param: dict) -> bool:
    kind = param["type"]
    if kind == "bool":
        return isinstance(value, bool)
    if kind in ("int", "float"):
        try:
            return (isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) and (kind != "int" or int(value) == value))
        except OverflowError:
            return False
    return isinstance(value, str) and (kind != "enum" or value in param.get("options", []))


def validate_ui(ui: Any, params: list[dict]) -> list[str]:
    errors: list[str] = []
    if not isinstance(ui, dict):
        return ["ui.json 必须是对象"]
    if type(ui.get("version")) is not int or ui["version"] != VERSION:
        errors.append("不支持的界面版本，version 必须为 1")
    unknown = set(ui) - {"version", "title", "description", "fields", "sections", "toolbar"}
    if unknown:
        errors.append(f"界面含未知属性：{', '.join(sorted(unknown))}")
    for key in ("title", "description"):
        if key in ui and not isinstance(ui[key], str):
            errors.append(f"{key} 必须是文字")
    by_key = {p["key"]: p for p in params}
    fields = ui.get("fields", {})
    dependencies: dict[str, set[str]] = {key: set() for key in by_key}
    if not isinstance(fields, dict):
        errors.append("fields 必须是对象")
        fields = {}
    for key, field in fields.items():
        if key not in by_key:
            errors.append(f"不存在的参数：{key}")
            continue
        if not isinstance(field, dict):
            errors.append(f"{key} 的界面设置必须是对象")
            continue
        if set(field) - {"label", "help", "when"}:
            errors.append(f"{key} 含未知界面属性")
        for prop in ("label", "help"):
            if prop in field and not isinstance(field[prop], str):
                errors.append(f"{key}.{prop} 必须是文字")
        condition = field.get("when")
        if condition is None:
            continue
        if (not isinstance(condition, dict) or set(condition) != {"mode", "rules"}
                or condition.get("mode") not in ("all", "any")
                or not isinstance(condition.get("rules"), list) or not condition["rules"]):
            errors.append(f"{key} 的显示条件需要 mode(all/any) 和非空 rules")
            continue
        for rule in condition["rules"]:
            if not isinstance(rule, dict) or set(rule) != {"param", "op", "value"}:
                errors.append(f"{key} 的条件规则需要 param、op、value")
                continue
            ref = rule["param"]
            if not isinstance(ref, str) or ref not in by_key:
                errors.append(f"{key} 的条件引用了不存在的参数：{ref}")
                continue
            dependencies[key].add(ref)
            if ref == key:
                errors.append(f"{key} 的条件不能引用自身")
            op = rule["op"]
            if op not in ("eq", "ne", "in"):
                errors.append(f"{key} 的条件关系只能是 eq/ne/in")
                continue
            values = rule["value"] if op == "in" else [rule["value"]]
            if not isinstance(values, list) or not values or not all(_literal_matches(v, by_key[ref]) for v in values):
                errors.append(f"{key} 的条件值与 {ref} 的类型或选项不匹配")

    visiting, visited = set(), set()
    def visit(key: str) -> None:
        if key in visiting:
            errors.append(f"显示条件存在循环依赖：{key}")
            return
        if key in visited:
            return
        visiting.add(key)
        for dependency in dependencies[key]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)
    for key in dependencies:
        visit(key)

    ids: set[str] = set()
    placed: set[str] = set()
    actions: set[str] = set()
    def identify(node: dict) -> None:
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id.strip() or node_id in ids:
            errors.append(f"界面元素 id 缺失或重复：{node_id}")
        else:
            ids.add(node_id)

    def check_item(item: Any, toolbar: bool = False) -> None:
        if not isinstance(item, dict):
            errors.append("布局元素必须是对象")
            return
        identify(item)
        kind = item.get("type")
        allowed = {"id", "type"}
        if kind == "field" and not toolbar:
            allowed |= {"key", "width", "column", "breakBefore"}
            key = item.get("key")
            if not isinstance(key, str) or key not in by_key or key in placed:
                errors.append(f"布局字段不存在或重复：{key}")
            else:
                placed.add(key)
            width = item.get("width", "auto")
            if not (width in ("auto", "full") or (type(width) is int and width > 0)):
                errors.append(f"{key} 的宽度须为 auto、full 或正整数")
            if "breakBefore" in item and not isinstance(item["breakBefore"], bool):
                errors.append(f"{key}.breakBefore 必须是布尔值")
            if "column" in item and (type(item["column"]) is not int or not 1 <= item["column"] <= 6):
                errors.append(f"{key}.column 必须是 1–6 的整数")
        elif kind == "action":
            allowed |= {"action", "label"}
            action = item.get("action")
            if not isinstance(action, str) or action not in ACTIONS or action in actions:
                errors.append(f"操作不存在或重复：{action}")
            else:
                actions.add(action)
            if "label" in item and not isinstance(item["label"], str):
                errors.append("按钮文案必须是文字")
        elif kind in ("text", "divider") and not toolbar:
            allowed |= {"text"}
            if kind == "text" and not isinstance(item.get("text"), str):
                errors.append("说明块需要 text")
        else:
            errors.append(f"不支持的布局元素：{kind}")
        if set(item) - allowed:
            errors.append(f"元素 {item.get('id')} 含未知属性")

    sections, toolbar = ui.get("sections"), ui.get("toolbar", [])
    if not isinstance(sections, list) or not isinstance(toolbar, list):
        errors.append("sections 与 toolbar 必须是列表")
        return errors
    for section in sections:
        if not isinstance(section, dict):
            errors.append("分组必须是对象")
            continue
        identify(section)
        if set(section) - {"id", "title", "kind", "collapsible", "collapsed", "items", "width"}:
            errors.append("分组含未知属性")
        if "width" in section and (type(section["width"]) is not int or not 1 <= section["width"] <= 6):
            errors.append("分组 width 必须是 1–6 的整数")
        if section.get("kind", "parameters") not in ("parameters", "actions"):
            errors.append("分组 kind 必须是 parameters 或 actions")
        if not isinstance(section.get("title", ""), str):
            errors.append("分组标题必须是文字")
        for flag in ("collapsible", "collapsed"):
            if flag in section and not isinstance(section[flag], bool):
                errors.append(f"分组 {flag} 必须是布尔值")
        if not isinstance(section.get("items"), list):
            errors.append("分组 items 必须是列表")
            continue
        for item in section["items"]:
            check_item(item)
        # Core operations cannot disappear inside a collapsed or conditional group.
        if section.get("kind") == "actions" or any(isinstance(i, dict) and i.get("type") == "action" for i in section["items"]):
            if section.get("collapsible") or any(isinstance(i, dict) and i.get("type") == "field" for i in section["items"]):
                errors.append("操作按钮须放在独立、不可折叠的操作分组中")
    for item in toolbar:
        check_item(item, True)
    if placed != set(by_key):
        errors.append("布局必须包含所有参数（隐藏参数请配置显示条件）")
    return errors


def typed_value(param: dict, raw: Any) -> Any:
    if raw is None:
        raw = param.get("default")
    if param["type"] in ("int", "float"):
        if isinstance(raw, bool) or raw is None or (isinstance(raw, str) and not DECIMAL.fullmatch(raw.strip())):
            return None
        try:
            number = float(raw)
        except (TypeError, ValueError, OverflowError):
            return None
        return number if math.isfinite(number) and (param["type"] != "int" or number.is_integer()) else None
    if param["type"] == "bool":
        return raw if isinstance(raw, bool) else None
    return str(raw) if raw is not None else ""


def active_keys(params: list[dict], values: dict, ui: dict) -> set[str]:
    by_key = {p["key"]: p for p in params}
    fields = ui.get("fields", {})
    active: dict[str, bool] = {}
    visiting: set[str] = set()
    def visit(key: str) -> bool:
        if key in active:
            return active[key]
        if key not in by_key or key in visiting:
            return False
        visiting.add(key)
        condition = fields.get(key, {}).get("when")
        result = True
        if condition:
            matches = []
            for rule in condition["rules"]:
                ref = rule["param"]
                value = typed_value(by_key[ref], values.get(ref, by_key[ref].get("default"))) if ref in by_key else None
                if not visit(ref) or value is None:
                    matches.append(False)
                elif rule["op"] == "in":
                    matches.append(value in rule["value"])
                else:
                    matches.append((value == rule["value"]) if rule["op"] == "eq" else (value != rule["value"]))
            result = all(matches) if condition["mode"] == "all" else any(matches)
        visiting.remove(key)
        active[key] = result
        return result
    return {key for key in by_key if visit(key)}


def coerce_active_values(params: list[dict], values: dict, ui: dict) -> tuple[dict, dict, dict]:
    """Return execution values, retained form values and field errors."""
    retained = {p["key"]: values.get(p["key"], p.get("default")) for p in params}
    active = active_keys(params, retained, ui)
    clean, errors = {}, {}
    for p in params:
        key = p["key"]
        if key not in active:
            continue
        raw = retained[key]
        value = typed_value(p, raw)
        kind = p["type"]
        if kind in ("int", "float"):
            if raw is None or raw == "":
                errors[key] = "请填写此参数"
            elif value is None:
                errors[key] = "请输入整数" if kind == "int" else "请输入有效数字"
            elif p.get("min") is not None and value < p["min"]:
                errors[key] = f"不能小于 {p['min']}"
            elif p.get("max") is not None and value > p["max"]:
                errors[key] = f"不能大于 {p['max']}"
            else:
                value = int(value) if kind == "int" else value
        elif kind == "enum" and value not in p.get("options", []):
            errors[key] = "请选择有效选项"
        elif kind == "bool" and value is None:
            errors[key] = "请选择开或关"
        if key not in errors:
            clean[key] = value
            retained[key] = value
    return clean, retained, errors
