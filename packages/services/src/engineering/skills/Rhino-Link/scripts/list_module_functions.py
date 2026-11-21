# -*- coding: utf-8 -*-
"""
List functions in a given RhinoScript module.

Usage:
    python list_module_functions.py <module> [--limit N]

Examples:
    python list_module_functions.py Curve_Methods
    python list_module_functions.py Surface_and_Polysurface_Methods --limit 30
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


def list_functions(module: str, limit: int | None = None):
    conn = connect_db(DB_PATH)
    cur = conn.cursor()
    sql = (
        "SELECT f.name, f.purpose FROM functions f "
        "JOIN modules m ON f.module_id = m.id "
        "WHERE m.name = ? ORDER BY f.name"
    )
    params: tuple = (module,)
    if limit:
        sql += " LIMIT ?"
        params = (module, limit)
    rows = cur.execute(sql, params).fetchall()
    conn.close()
    return rows


def main():
    if len(sys.argv) < 2:
        print("用法: python list_module_functions.py <module> [--limit N]")
        print("示例: python list_module_functions.py Curve_Methods")
        sys.exit(1)

    module = sys.argv[1]
    limit = None
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        if idx + 1 < len(sys.argv):
            limit = int(sys.argv[idx + 1])

    rows = list_functions(module, limit)

    print(f"模块 '{module}' 包含的函数:")
    if not rows:
        print("  (未找到，请用 list_top_modules.py 确认模块名)")
        sys.exit(1)
    for name, purpose in rows:
        print(f"{name}: {purpose}")
    if limit and len(rows) == limit:
        print(f"(显示前 {limit} 个，可能还有更多)")
    else:
        print(f"共 {len(rows)} 个函数")


if __name__ == "__main__":
    main()
