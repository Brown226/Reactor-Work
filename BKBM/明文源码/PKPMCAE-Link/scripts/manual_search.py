#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
manual_search.py — PyPCAE 内置手册（manual/README.md）检索工具

背景：手册约 143KB / 3382 行，整本读入上下文代价高；本工具按节号/关键词/枚举名
精确截取所需片段，避免全量加载。

用法（PKPM Agent 中，优先用关键词模式）：
    use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='"AnalySetting"')
    use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='--list')
    use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='--section 2.9.8')
    use_skill('pkpmcae-link', run='scripts/manual_search.py', run_args='--enum AnaType')

命令行等价：
    python scripts/manual_search.py "AnalySetting"   # 关键词：定位含该类/词的章节并输出
    python scripts/manual_search.py --list           # 列出全部章节锚点（标题+行号）
    python scripts/manual_search.py --section 2.9.8  # 按节号（或标题词）输出整节原文
    python scripts/manual_search.py --enum AnaType   # 输出指定枚举类的成员清单
"""
import argparse
import os
import re
import sys

MANUAL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "manual", "README.md")
HEAD_RE = re.compile(r"^(#{2,5})\s+(.+)$")
MAX_OUT = 220  # 单节最大输出行数


def load():
    if not os.path.exists(MANUAL):
        sys.exit(f"内置手册缺失：{MANUAL}\n请将 PkpmCAE 安装目录 resources/static/pypcae/doc/README.md 拷入 manual/。")
    return open(MANUAL, encoding="utf-8").read().splitlines()


def build_sections(lines):
    """切分章节：标题行起到下一个同级或更高级标题前。"""
    heads = [(i, len(m.group(1)), m.group(2).strip())
             for i, m in ((i, HEAD_RE.match(l)) for i, l in enumerate(lines)) if m]
    secs = []
    for idx, (ln, lv, title) in enumerate(heads):
        end = len(lines)
        for ln2, lv2, _ in heads[idx + 1:]:
            if lv2 <= lv:
                end = ln2
                break
        secs.append((lv, title, ln, end))
    return secs


def print_section(lines, lv, title, a, b):
    body = lines[a:b]
    print(f"{'#' * lv} {title}   [手册 第{a + 1}-{b}行]")
    print("-" * 60)
    if len(body) > MAX_OUT:
        print("\n".join(body[:MAX_OUT]))
        print(f"\n...（本节共 {len(body)} 行，已截断；用 --section 精确小节号可缩小范围）")
    else:
        print("\n".join(body))


def main():
    ap = argparse.ArgumentParser(description="PyPCAE 内置手册检索")
    ap.add_argument("keyword", nargs="?", help="关键词（类名/标题词），如 AnalySetting、支座、2.8")
    ap.add_argument("--list", action="store_true", help="列出全部章节锚点")
    ap.add_argument("--section", help="按节号或标题词输出整节，如 2.9.8 / 分析参数")
    ap.add_argument("--enum", help="输出指定枚举类的成员清单，如 AnaType")
    args = ap.parse_args()

    lines = load()
    secs = build_sections(lines)

    if args.list:
        for lv, title, a, b in secs:
            print("  " * (lv - 2) + f"{title}  (第{a + 1}-{b}行)")
        return

    if args.enum:
        for lv, title, a, b in secs:
            if title.strip().lower() == args.enum.lower():
                body = "\n".join(lines[a:b])
                members = re.findall(r"^\s*-\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:#(.*))?$", body, re.M)
                print(f"{args.enum}（{len(members)} 个成员）[手册 第{a + 1}-{b}行]")
                for name, cmt in members:
                    print(f"  {name}" + (f"    # {cmt.strip()}" if cmt else ""))
                return
        avail = [t for lv, t, a, b in secs if a > 1000]
        sys.exit(f"未找到枚举类 {args.enum!r}。--list 可查全部标题。")

    key = args.section or args.keyword
    if not key:
        ap.print_help()
        return

    # 1) 标题命中优先
    hits = [(lv, t, a, b) for lv, t, a, b in secs if key in t]
    # 2) 标题未命中 → 正文命中（只保留最深层命中节，剔除其内部还含有命中节的父节）
    if not hits:
        hits = [(lv, t, a, b) for lv, t, a, b in secs
                if any(key in l for l in lines[a:b])]
        hits = [h for h in hits
                if not any(o[2] > h[2] and o[3] <= h[3] for o in hits)]
    if not hits:
        sys.exit(f"手册中未找到 {key!r}。--list 可查全部章节标题。")

    print(f"关键词 {key!r} 命中 {len(hits)} 节：")
    for lv, t, a, b in hits[:3]:
        print_section(lines, lv, t, a, b)
        print()
    if len(hits) > 3:
        print(f"另有 {len(hits) - 3} 节命中，标题：{[t for _, t, _, _ in hits[3:]]}")


if __name__ == "__main__":
    # The agent captures subprocess output as UTF-8, including on Windows.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    main()
