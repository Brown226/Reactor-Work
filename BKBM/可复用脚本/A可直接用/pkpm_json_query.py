#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Query PKPM CheckList JSON review result files.

The parser follows the data-normalization logic used by report_designer.html:
- merge multiple JSON files by rule id for rule metadata;
- keep SupportChecktype;
- preserve raw drawing result entries for the drawing summary table;
- count BeamInfo/ColuInfo/WallInfo summaries;
- flatten issues by TopruleId (or the first ruleIds item) and issue.components;
- preserve per-component review messages and rule metadata.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

EMPTY_FILTER_TOKEN = "__EMPTY__"
EMPTY_FILTER_LABEL = "[空]"
CHECK_TYPES = ["规范审查", "计算结果", "配筋不足", "配筋冗余", "图模一致", "图纸表达", "重要提示"]


def ensure_array(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def normalize_text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def read_text_smart(path: str | Path) -> str:
    p = Path(path)
    raw = p.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gbk", "cp936"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def load_json_file(path: str | Path) -> Any:
    return json.loads(read_text_smart(path))


def normalize_summary_list(value: Any) -> list[Any]:
    def key(v: Any) -> tuple[int, Any]:
        try:
            return (0, int(v))
        except Exception:
            return (1, str(v))
    out = []
    seen = set()
    for item in ensure_array(value):
        k = str(item)
        if k in seen:
            continue
        seen.add(k)
        out.append(item)
    return sorted(out, key=key)


def normalize_gj_info(info: Any = None) -> dict[str, int]:
    info = info if isinstance(info, dict) else {}
    return {
        "AllGJCount": int(float(info.get("AllGJCount") or 0)),
        "CheckNotpassedGJCount": int(float(info.get("CheckNotpassedGJCount") or 0)),
        "CheckpassedGJCount": int(float(info.get("CheckpassedGJCount") or 0)),
        "NotCheckGJCount": int(float(info.get("NotCheckGJCount") or 0)),
    }


def normalize_summary(summary: Any) -> dict[str, Any]:
    summary = summary if isinstance(summary, dict) else {}
    return {
        "passed": normalize_summary_list(summary.get("passed")),
        "failed": normalize_summary_list(summary.get("failed")),
        "notApplicable": normalize_summary_list(summary.get("notApplicable")),
        "BeamInfo": normalize_gj_info(summary.get("BeamInfo")),
        "ColuInfo": normalize_gj_info(summary.get("ColuInfo")),
        "WallInfo": normalize_gj_info(summary.get("WallInfo")),
    }


def merge_summary(target: dict[str, Any], incoming: dict[str, Any]) -> None:
    for key in ("passed", "failed", "notApplicable"):
        target[key] = normalize_summary_list([*(target.get(key) or []), *(incoming.get(key) or [])])
    for key in ("BeamInfo", "ColuInfo", "WallInfo"):
        if key not in target or not isinstance(target[key], dict):
            target[key] = normalize_gj_info()
        src = incoming.get(key) or {}
        for count_key in ("AllGJCount", "CheckNotpassedGJCount", "CheckpassedGJCount", "NotCheckGJCount"):
            target[key][count_key] = int(target[key].get(count_key) or 0) + int(src.get(count_key) or 0)


def normalize_component(component: Any) -> dict[str, Any]:
    component = component if isinstance(component, dict) else {}
    values = component.get("values") if isinstance(component.get("values"), dict) else {}
    return {
        "name": normalize_text(component.get("name")),
        "part": normalize_text(component.get("part")),
        "coords": ensure_array(component.get("coords")),
        "values": dict(values),
        "message": normalize_text(component.get("message")),
    }


def normalize_result(result: Any) -> dict[str, Any]:
    result = result if isinstance(result, dict) else {}
    issues = []
    for issue in ensure_array(result.get("issues")):
        issue = issue if isinstance(issue, dict) else {}
        issues.append({
            "TopruleId": issue.get("TopruleId"),
            "ruleIds": ensure_array(issue.get("ruleIds")),
            "passCount": int(float(issue.get("passCount") or 0)),
            "failCount": int(float(issue.get("failCount") or 0)),
            "components": [normalize_component(c) for c in ensure_array(issue.get("components"))],
        })
    return {
        "drawing": normalize_text(result.get("drawing")),
        "summary": normalize_summary(result.get("summary")),
        "issues": issues,
    }


def primary_rule_id(issue: dict[str, Any]) -> str:
    if issue.get("TopruleId") is not None:
        return str(issue.get("TopruleId"))
    ids = ensure_array(issue.get("ruleIds"))
    return str(ids[0]) if ids else "missing_id"


def inject_missing_rules(data: dict[str, Any], rules_map: dict[str, dict[str, Any]]) -> None:
    for result in ensure_array(data.get("results")):
        for issue in ensure_array((result if isinstance(result, dict) else {}).get("issues")):
            issue = issue if isinstance(issue, dict) else {}
            p_id = primary_rule_id(issue)
            if p_id not in rules_map:
                rules_map[p_id] = {
                    "id": p_id,
                    "Checktype": "未知分类(异常)",
                    "severity": "",
                    "standard": "缺失的规范条文",
                    "clause": "-",
                    "item": "未知审查项",
                }


def merge_json_payloads(payloads: Iterable[dict[str, Any]]) -> dict[str, Any]:
    rules_map: dict[str, dict[str, Any]] = {}
    result_map: dict[str, dict[str, Any]] = {}
    raw_results: list[dict[str, Any]] = []
    support: dict[str, Any] = {}
    project = {"name": "", "version": "", "date": ""}
    empty_drawing_index = 0

    for data in payloads:
        data = data if isinstance(data, dict) else {}
        current_project = data.get("project") if isinstance(data.get("project"), dict) else {}
        for key in ("name", "version", "date"):
            value = normalize_text(current_project.get(key))
            if value and not project[key]:
                project[key] = value
        if isinstance(data.get("SupportChecktype"), dict):
            support.update(data.get("SupportChecktype") or {})

        for rule in ensure_array(data.get("rules")):
            if not isinstance(rule, dict) or rule.get("id") is None:
                continue
            rid = str(rule.get("id"))
            rules_map[rid] = {**rules_map.get(rid, {}), **rule}
        inject_missing_rules(data, rules_map)

        for result in ensure_array(data.get("results")):
            normalized = normalize_result(result)
            raw_results.append(normalized)
            drawing_key = normalized["drawing"] or f"__EMPTY_DRAWING__{empty_drawing_index}"
            if not normalized["drawing"]:
                empty_drawing_index += 1
            if drawing_key not in result_map:
                result_map[drawing_key] = copy.deepcopy(normalized)
            else:
                merge_summary(result_map[drawing_key]["summary"], normalized["summary"])
                result_map[drawing_key]["issues"].extend(normalized["issues"])

    return {
        "project": project,
        "supportChecktype": support,
        "rules": list(rules_map.values()),
        "results": list(result_map.values()),
        # 用于图纸信息展示：按原始 JSON 中 result 顺序逐张保留，不按图纸名合并。
        "raw_results": raw_results,
    }


def load_payloads(paths: list[str | Path]) -> dict[str, Any]:
    return merge_json_payloads([load_json_file(p) for p in paths])


def output_json_from_log(log_path: str | Path) -> Path | None:
    log_path = Path(log_path)
    data = load_json_file(log_path)
    if not isinstance(data, dict):
        return None
    value = data.get("output_json") or data.get("outputJson") or data.get("checklist_json")
    if not value:
        return None
    p = Path(str(value))
    return p if p.is_absolute() else (log_path.parent / p)


def class_from_severity(severity: str) -> str:
    sev = normalize_text(severity)
    if "强" in sev:
        return "强条"
    if "应" in sev:
        return "应"
    if "宜" in sev:
        return "宜"
    return "其他"


def rule_result_maps(data: dict[str, Any]) -> tuple[set[str], set[str], set[str], Counter[str]]:
    passed, failed, na = set(), set(), set()
    issue_counts: Counter[str] = Counter()
    for result in ensure_array(data.get("results")):
        summary = result.get("summary") or {}
        passed.update(str(x) for x in ensure_array(summary.get("passed")))
        failed.update(str(x) for x in ensure_array(summary.get("failed")))
        na.update(str(x) for x in ensure_array(summary.get("notApplicable")))
        for issue in ensure_array(result.get("issues")):
            comps = ensure_array(issue.get("components"))
            ids = set()
            if issue.get("TopruleId") is not None:
                ids.add(str(issue.get("TopruleId")))
            ids.update(str(x) for x in ensure_array(issue.get("ruleIds")))
            if not ids:
                ids.add("missing_id")
            for rid in ids:
                issue_counts[rid] += len(comps)
    return passed, failed, na, issue_counts


def drawing_summary(result: dict[str, Any]) -> dict[str, Any]:
    summary = result.get("summary") or {}
    out = {
        "drawing": result.get("drawing") or "",
        "issue_group_count": len(ensure_array(result.get("issues"))),
        "review_count": sum(len(ensure_array(issue.get("components"))) for issue in ensure_array(result.get("issues"))),
    }
    checked_total = not_checked_total = all_total = 0
    for short, key in (("beam", "BeamInfo"), ("column", "ColuInfo"), ("wall", "WallInfo")):
        info = normalize_gj_info(summary.get(key))
        checked = info["CheckpassedGJCount"] + info["CheckNotpassedGJCount"]
        not_checked = info["NotCheckGJCount"]
        out[f"{short}_all"] = info["AllGJCount"]
        out[f"{short}_checked"] = checked
        out[f"{short}_failed"] = info["CheckNotpassedGJCount"]
        out[f"{short}_passed"] = info["CheckpassedGJCount"]
        checked_total += checked
        not_checked_total += not_checked
        all_total += info["AllGJCount"]
    out["checked_component_count"] = checked_total
    out["component_count"] = all_total or checked_total + not_checked_total
    return out


def summary_results(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Return drawing result entries for summary display without merging same drawing names."""
    raw = ensure_array(data.get("raw_results"))
    return raw if raw else ensure_array(data.get("results"))


def summary_report(data: dict[str, Any]) -> dict[str, Any]:
    drawings = [drawing_summary(r) for r in summary_results(data)]
    rules = ensure_array(data.get("rules"))
    passed, failed, na, issue_counts = rule_result_maps(data)
    review_count = sum(d["review_count"] for d in drawings)
    by_class = Counter()
    by_check_type = Counter()
    for row in flatten_reviews(data):
        by_class[row["class"] or "其他"] += 1
        by_check_type[row["check_type"] or "未知"] += 1
    return {
        "project": data.get("project") or {},
        "drawing_count": len(drawings),
        "component_count": sum(d["component_count"] for d in drawings),
        "checked_component_count": sum(d["checked_component_count"] for d in drawings),
        "issue_group_count": sum(d["issue_group_count"] for d in drawings),
        "review_count": review_count,
        "rule_count": len(rules),
        "failed_rule_count": len(failed),
        "passed_rule_count": len(passed - failed),
        "not_applicable_rule_count": len(na),
        "by_class": dict(by_class),
        "by_check_type": dict(by_check_type),
        "drawings": drawings,
        "supportChecktype": data.get("supportChecktype") or {},
    }


def rule_map(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(rule.get("id")): rule for rule in ensure_array(data.get("rules")) if isinstance(rule, dict) and rule.get("id") is not None}


def first_coord(coords: Any) -> list[float]:
    for item in ensure_array(coords):
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            out = []
            for v in item[:3]:
                try:
                    out.append(float(v))
                except Exception:
                    out.append(0.0)
            return out
    return []


def flatten_reviews(data: dict[str, Any]) -> list[dict[str, Any]]:
    rules = rule_map(data)
    rows: list[dict[str, Any]] = []
    for draw_idx, result in enumerate(ensure_array(data.get("results")), 1):
        drawing = normalize_text(result.get("drawing")) or f"未命名图纸{draw_idx}"
        for issue_idx, issue in enumerate(ensure_array(result.get("issues")), 1):
            rid = primary_rule_id(issue)
            rule = rules.get(rid) or {}
            components = ensure_array(issue.get("components"))
            for comp_idx, comp in enumerate(components, 1):
                severity = normalize_text(rule.get("severity"))
                rows.append({
                    "drawing": drawing,
                    "issue_index": issue_idx,
                    "component_index": comp_idx,
                    "component": normalize_text(comp.get("name")) or "-",
                    "part": normalize_text(comp.get("part")),
                    "message": normalize_text(comp.get("message")) or "-",
                    "check_type": normalize_text(rule.get("Checktype")) or "未知分类(异常)",
                    "class": class_from_severity(severity),
                    "severity": severity,
                    "standard": normalize_text(rule.get("standard")) or "-",
                    "clause": normalize_text(rule.get("clause")) or "-",
                    "item": normalize_text(rule.get("item")) or "-",
                    "rule_id": rid,
                    "rule_ids": [str(x) for x in ensure_array(issue.get("ruleIds"))],
                    "top_rule_id": "" if issue.get("TopruleId") is None else str(issue.get("TopruleId")),
                    "coords": ensure_array(comp.get("coords")),
                    "point": first_coord(comp.get("coords")),
                    "values": comp.get("values") if isinstance(comp.get("values"), dict) else {},
                    "pass_count": int(issue.get("passCount") or 0),
                    "fail_count": int(issue.get("failCount") or 0),
                })
    return rows


def natural_key(s: Any) -> tuple[Any, ...]:
    parts = re.split(r"(\d+)", normalize_text(s))
    return tuple(int(p) if p.isdigit() else p for p in parts)


def filter_reviews(rows: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    out = rows
    if getattr(args, "drawing", None):
        needle = normalize_text(args.drawing)
        out = [r for r in out if needle in r["drawing"]]
    if getattr(args, "component_name", None):
        name = normalize_text(args.component_name)
        if getattr(args, "name_match", "exact") == "contains":
            out = [r for r in out if name in r["component"]]
        else:
            out = [r for r in out if r["component"] == name]
    if getattr(args, "check_type", None):
        out = [r for r in out if r["check_type"] == args.check_type]
    if getattr(args, "severity", None):
        out = [r for r in out if args.severity in r["severity"]]
    if getattr(args, "level", "all") != "all":
        level_map = {"strong": "强条", "ying": "应", "yi": "宜", "other": "其他"}
        want = level_map.get(args.level, args.level)
        out = [r for r in out if r["class"] == want]
    if getattr(args, "contains", None):
        needle = normalize_text(args.contains)
        out = [r for r in out if needle in json.dumps(r, ensure_ascii=False)]

    sort = getattr(args, "sort", "spec")
    if sort == "component":
        out.sort(key=lambda r: (natural_key(r["drawing"]), natural_key(r["component"]), natural_key(r["part"]), r["issue_index"], r["component_index"]))
    elif sort == "raw":
        out.sort(key=lambda r: (natural_key(r["drawing"]), r["issue_index"], r["component_index"]))
    else:
        pri = {"强条": 0, "应": 1, "宜": 2, "其他": 3}
        out.sort(key=lambda r: (pri.get(r["class"], 9), r["standard"], natural_key(r["clause"]), natural_key(r["drawing"]), natural_key(r["component"])))
    return out


def rules_report(data: dict[str, Any]) -> list[dict[str, Any]]:
    passed, failed, na, issue_counts = rule_result_maps(data)
    rows = []
    for rule in ensure_array(data.get("rules")):
        if not isinstance(rule, dict) or rule.get("id") is None:
            continue
        rid = str(rule.get("id"))
        if rid in failed:
            status = "不通过"
        elif rid in passed:
            status = "通过"
        elif rid in na:
            status = "不涉及"
        else:
            status = "不涉及"
        rows.append({
            "rule_id": rid,
            "check_type": normalize_text(rule.get("Checktype")),
            "standard": normalize_text(rule.get("standard")),
            "clause": normalize_text(rule.get("clause")),
            "severity": normalize_text(rule.get("severity")),
            "item": normalize_text(rule.get("item")),
            "review_result": status,
            "issue_count": issue_counts.get(rid, 0),
        })
    rows.sort(key=lambda r: (r["check_type"], r["standard"], natural_key(r["clause"]), natural_key(r["rule_id"])))
    return rows


def component_report(data: dict[str, Any]) -> list[dict[str, Any]]:
    agg: dict[tuple[str, str], dict[str, Any]] = {}
    for r in flatten_reviews(data):
        key = (r["drawing"], r["component"])
        if key not in agg:
            agg[key] = {"drawing": r["drawing"], "component": r["component"], "review_count": 0, "parts": set(), "classes": Counter(), "first_review": r["message"]}
        agg[key]["review_count"] += 1
        if r["part"]:
            agg[key]["parts"].add(r["part"])
        agg[key]["classes"][r["class"]] += 1
    rows = []
    for item in agg.values():
        rows.append({
            "drawing": item["drawing"],
            "component": item["component"],
            "review_count": item["review_count"],
            "parts": "、".join(sorted(item["parts"], key=natural_key)),
            "classes": dict(item["classes"]),
            "first_review": item["first_review"],
        })
    rows.sort(key=lambda r: (natural_key(r["drawing"]), natural_key(r["component"])))
    return rows


def md_escape(value: Any, max_len: int | None = None) -> str:
    s = normalize_text(value).replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("|", "\\|").replace("\n", " <br> ")
    if max_len and len(s) > max_len:
        return s[: max_len - 1] + "…"
    return s


def print_summary_md(data: dict[str, Any]) -> None:
    s = summary_report(data)
    p = s.get("project") or {}
    print(f"项目：{p.get('name','') or '-'}；版本：{p.get('version','') or '-'}；日期：{p.get('date','') or '-'}")
    print(f"图纸：{s['drawing_count']} 张；构件：{s['component_count']} 个；已审构件：{s['checked_component_count']} 个；审查意见：{s['review_count']} 条；意见组：{s['issue_group_count']} 组；规则：{s['rule_count']} 条")
    if s["by_class"]:
        print("类别统计：" + "；".join(f"{k} {v}" for k, v in s["by_class"].items()))
    print("\n| 序号 | 图纸 | 构件数 | 已审构件数 | 梁构件/已审 | 柱构件/已审 | 墙构件/已审 | 意见组 | 审查意见 |")
    print("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for i, d in enumerate(s["drawings"], 1):
        print(f"| {i} | {md_escape(d['drawing'])} | {d['component_count']} | {d['checked_component_count']} | {d['beam_all']}/{d['beam_checked']} | {d['column_all']}/{d['column_checked']} | {d['wall_all']}/{d['wall_checked']} | {d['issue_group_count']} | {d['review_count']} |")


def print_reviews_md(rows: list[dict[str, Any]], total: int) -> None:
    print(f"意见：{total} 条；返回：{len(rows)} 条")
    print("\n| 序号 | 图纸 | 构件 | 部位 | 审查类别 | 条文性质 | 规范 | 条文 | 审查项目 | 内容 | 定位 |")
    print("| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for i, r in enumerate(rows, 1):
        point = r.get("point") or []
        loc = "" if not point else "[" + ", ".join(f"{x:g}" for x in point[:3]) + "]"
        print(f"| {i} | {md_escape(r['drawing'])} | {md_escape(r['component'])} | {md_escape(r['part'])} | {md_escape(r['check_type'])} | {md_escape(r['severity'])} | {md_escape(r['standard'])} | {md_escape(r['clause'])} | {md_escape(r['item'])} | {md_escape(r['message'])} | {md_escape(loc)} |")


def print_rules_md(rows: list[dict[str, Any]], total: int) -> None:
    print(f"规则：{total} 条；返回：{len(rows)} 条")
    print("\n| 序号 | ID | 审查类别 | 规范 | 条文 | 条文性质 | 审查项目 | 审查结果 | 意见数 |")
    print("| ---: | ---: | --- | --- | --- | --- | --- | --- | ---: |")
    for i, r in enumerate(rows, 1):
        print(f"| {i} | {md_escape(r['rule_id'])} | {md_escape(r['check_type'])} | {md_escape(r['standard'])} | {md_escape(r['clause'])} | {md_escape(r['severity'])} | {md_escape(r['item'])} | {md_escape(r['review_result'])} | {r['issue_count']} |")


def print_components_md(rows: list[dict[str, Any]], total: int) -> None:
    print(f"有意见构件：{total} 个；返回：{len(rows)} 个")
    print("\n| 序号 | 图纸 | 构件 | 部位 | 意见数 | 类别统计 | 首条意见 |")
    print("| ---: | --- | --- | --- | ---: | --- | --- |")
    for i, r in enumerate(rows, 1):
        classes = "；".join(f"{k}:{v}" for k, v in (r.get("classes") or {}).items())
        print(f"| {i} | {md_escape(r['drawing'])} | {md_escape(r['component'])} | {md_escape(r['parts'])} | {r['review_count']} | {md_escape(classes)} | {md_escape(r['first_review'], 120)} |")


def resolve_json_paths(args: argparse.Namespace) -> list[Path]:
    paths: list[Path] = []
    if getattr(args, "from_log", None):
        p = output_json_from_log(args.from_log)
        if p:
            paths.append(p)
    paths.extend(Path(p) for p in (getattr(args, "json", None) or []))
    if not paths:
        raise SystemExit("请使用 --json <CheckList.json> 或 --from-log <log.json> 指定 JSON 结果来源")
    missing = [str(p) for p in paths if not p.exists()]
    if missing:
        raise SystemExit("JSON 文件不存在：" + "；".join(missing))
    return paths


def load_from_args(args: argparse.Namespace) -> dict[str, Any]:
    return load_payloads(resolve_json_paths(args))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query PKPM CheckList JSON review files.")
    parser.add_argument("--json", action="append", help="CheckList.json 路径，可多次传入")
    parser.add_argument("--from-log", help="识别校审 log.json 路径，从 output_json 字段读取 CheckList.json")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    sub = parser.add_subparsers(dest="command", required=True)

    p_summary = sub.add_parser("summary", help="项目/图纸/构件/意见汇总")
    p_summary.add_argument("--format", choices=["markdown", "json"], default=argparse.SUPPRESS)

    p = sub.add_parser("reviews", help="审查意见明细")
    p.add_argument("--format", choices=["markdown", "json"], default=argparse.SUPPRESS)
    p.add_argument("--drawing")
    p.add_argument("--component-name")
    p.add_argument("--name-match", choices=["exact", "contains"], default="exact")
    p.add_argument("--check-type")
    p.add_argument("--severity")
    p.add_argument("--level", choices=["all", "strong", "ying", "yi", "other"], default="all")
    p.add_argument("--contains")
    p.add_argument("--sort", choices=["spec", "component", "raw"], default="component")
    p.add_argument("--limit", type=int, default=0)

    p = sub.add_parser("rules", help="审查条文/规则清单")
    p.add_argument("--format", choices=["markdown", "json"], default=argparse.SUPPRESS)
    p.add_argument("--limit", type=int, default=0)

    p = sub.add_parser("components", help="有审查意见的构件清单")
    p.add_argument("--format", choices=["markdown", "json"], default=argparse.SUPPRESS)
    p.add_argument("--limit", type=int, default=0)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    data = load_from_args(args)
    if args.command == "summary":
        out = summary_report(data)
        if args.format == "json":
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print_summary_md(data)
        return 0
    if args.command == "reviews":
        rows_all = filter_reviews(flatten_reviews(data), args)
        total = len(rows_all)
        rows = rows_all if not args.limit or args.limit <= 0 else rows_all[: args.limit]
        if args.format == "json":
            print(json.dumps({"total": total, "returned": len(rows), "reviews": rows}, ensure_ascii=False, indent=2))
        else:
            print_reviews_md(rows, total)
        return 0
    if args.command == "rules":
        rows_all = rules_report(data)
        total = len(rows_all)
        rows = rows_all if not args.limit or args.limit <= 0 else rows_all[: args.limit]
        if args.format == "json":
            print(json.dumps({"total": total, "returned": len(rows), "rules": rows}, ensure_ascii=False, indent=2))
        else:
            print_rules_md(rows, total)
        return 0
    if args.command == "components":
        rows_all = component_report(data)
        total = len(rows_all)
        rows = rows_all if not args.limit or args.limit <= 0 else rows_all[: args.limit]
        if args.format == "json":
            print(json.dumps({"total": total, "returned": len(rows), "components": rows}, ensure_ascii=False, indent=2))
        else:
            print_components_md(rows, total)
        return 0
    raise ValueError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
