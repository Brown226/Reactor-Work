# -*- coding: utf-8 -*-
"""
Get function detail or search functions across all modules.

Usage:
    python get_function_detail.py <module> <function>
    python get_function_detail.py --search <keyword>

Examples:
    python get_function_detail.py Curve_Methods AddCircle
    python get_function_detail.py --search Circle
"""

import os
import sqlite3
from PKPMAgent.skill_kit.vault import connect_db
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

DB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "references", "rhinoscript_api.db")
)


def get_detail(module: str, func: str):
    conn = connect_db(DB_PATH)
    cur = conn.cursor()
    row = cur.execute(
        """SELECT f.name, f.syntax, f.purpose, f.parameters,
                  f.returns, f.example, f.see_also, m.name
           FROM functions f JOIN modules m ON f.module_id = m.id
           WHERE m.name = ? AND f.name = ?""",
        (module, func),
    ).fetchone()
    conn.close()
    return row


def search(keyword: str, limit: int = 20):
    conn = connect_db(DB_PATH)
    cur = conn.cursor()
    pat = f"%{keyword}%"
    rows = cur.execute(
        """SELECT f.name, m.name, f.purpose
           FROM functions f JOIN modules m ON f.module_id = m.id
           WHERE f.name LIKE ? OR f.purpose LIKE ?
           ORDER BY (f.name LIKE ?) DESC, f.name
           LIMIT ?""",
        (pat, pat, pat, limit),
    ).fetchall()
    conn.close()
    return rows


def format_detail(row) -> str:
    name, syntax, purpose, parameters, returns, example, see_also, module = row
    out = []
    out.append(f"**{module}/{name}**")
    out.append("")
    if purpose:
        out.append(f"- purpose: {purpose}")
        out.append("")
    if syntax:
        out.append("- syntax:")
        out.append(syntax)
        out.append("")
    if parameters:
        out.append("- parameters:")
        out.append(parameters)
        out.append("")
    if returns:
        out.append("- returns:")
        out.append(returns)
        out.append("")
    if example:
        out.append("- example (VBScript, see SKILL.md for Python COM translation):")
        out.append(example)
        out.append("")
    if see_also:
        out.append(f"- see_also: {see_also}")
    return "\n".join(out)


def main():
    if len(sys.argv) < 2:
        print("用法:")
        print("  python get_function_detail.py <module> <function>")
        print("  python get_function_detail.py --search <keyword>")
        sys.exit(1)

    if sys.argv[1] == "--search":
        if len(sys.argv) < 3:
            print("错误: --search 需要关键词")
            sys.exit(1)
        keyword = sys.argv[2]
        rows = search(keyword)
        print(f"搜索 '{keyword}' 的结果:")
        if not rows:
            print("  (未找到)")
            return
        for fname, mname, purpose in rows:
            preview = (purpose[:80] + "...") if purpose and len(purpose) > 80 else (purpose or "")
            print(f"- {mname}/{fname}")
            if preview:
                print(f"  {preview}")
        print()
        print(f"共 {len(rows)} 个匹配，可用 get_function_detail.py <module> <function> 查看详情")
        return

    if len(sys.argv) < 3:
        print("错误: 需要 module 和 function 名")
        sys.exit(1)
    module, func = sys.argv[1], sys.argv[2]
    row = get_detail(module, func)
    if not row:
        print(f"未找到: {module}/{func}")
        print(f"提示: 可用 --search {func} 搜索")
        sys.exit(1)
    print(format_detail(row))


if __name__ == "__main__":
    main()
