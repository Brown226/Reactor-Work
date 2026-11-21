# -*- coding: utf-8 -*-
"""
List all top-level RhinoScript modules.

Usage:
    python list_top_modules.py
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


def main():
    conn = connect_db(DB_PATH)
    cur = conn.cursor()
    rows = cur.execute(
        "SELECT name, description FROM modules ORDER BY name"
    ).fetchall()
    conn.close()

    for name, desc in rows:
        preview = (desc[:1000] + "...") if desc and len(desc) > 1000 else (desc or "")
        if preview:
            print(f"- {name}")
            print(f"  {preview}")
        else:
            print(f"- {name}")
    print()
    print(f"共 {len(rows)} 个模块")


if __name__ == "__main__":
    main()
