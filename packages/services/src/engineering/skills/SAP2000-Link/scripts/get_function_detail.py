# -*- coding: utf-8 -*-
"""
获取函数详细信息

用法:
    python get_function_detail.py <module_path> <function_name>
    python get_function_detail.py --search <keyword>

示例:
    python get_function_detail.py Object_Model/Frame_Object SetLoadDistributed
    python get_function_detail.py --search GetSelected
"""

import sqlite3
import os
import json
import sys
from PKPMAgent.skill_kit.vault import connect_db

DB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "references", "sap2000_api.db")
)


def get_function_detail(module_path, func_name):
    """通过模块路径 + 函数名精确查询"""
    conn = connect_db(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
        SELECT f.name, f.syntax, f.vb_signature, f.purpose,
               f.parameters, f.remarks, f.example, f.see_also
        FROM functions f
        JOIN modules m ON f.module_id = m.id
        WHERE m.path = ? AND f.name = ?
    """, (module_path, func_name))

    result = cur.fetchone()
    conn.close()
    return result


def search_function(keyword, limit=10):
    """按关键词搜索函数（用于只知函数名时）"""
    conn = connect_db(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
        SELECT f.name, m.path, f.syntax, f.purpose,
               f.parameters, f.vb_signature
        FROM functions f
        JOIN modules m ON f.module_id = m.id
        WHERE f.name LIKE ? OR f.purpose LIKE ?
        ORDER BY f.name
        LIMIT ?
    """, (f"%{keyword}%", f"%{keyword}%", limit))

    results = cur.fetchall()
    conn.close()
    return results


def format_output(result):
    """格式化输出函数详情"""
    name, syntax, vb_signature, purpose, parameters, remarks, example, see_also = result

    output = []
    output.append(f"**name:{name}**")    
    output.append("")
    if syntax:
        output.append(f"- syntax:{syntax}")
        output.append("")

    if vb_signature:
        output.append(f"- vb_signature:{vb_signature}")
        output.append("")

    if purpose:
        output.append(f"- purpose:{purpose}")
        output.append("")

    if parameters:
        output.append(f"- parameters:{parameters}")
        output.append("")

    if remarks:
        output.append(f"- remarks:{remarks}")
        output.append("")


    if example:
        output.append(f"- example:")
        output.append(example)
        output.append("")

    if see_also:
        output.append(f"- see_also:{see_also}")
        output.append("")

    return "\n".join(output)


def main():
    if len(sys.argv) < 2:
        print("用法:")
        print("  python get_function_detail.py <module_path> <function_name>")
        print("  python get_function_detail.py --search <keyword>")
        print()
        print("示例:")
        print("  python get_function_detail.py Object_Model/Frame_Object SetLoadDistributed")
        print("  python get_function_detail.py --search GetSelected")
        sys.exit(1)

    if sys.argv[1] == "--search":
        if len(sys.argv) < 3:
            print("错误: --search 需要提供关键词")
            sys.exit(1)

        keyword = sys.argv[2]
        results = search_function(keyword)

        print(f"搜索 '{keyword}' 的结果:")
        print()

        if not results:
            print("  (未找到匹配的函数)")
        else:
            for name, path, syntax, purpose, parameters, vb_signature in results:
                purpose_preview = (purpose[:60] + "...") if purpose and len(purpose) > 60 else (purpose or "N/A")
                print(f"- {name} [{path}]")
                print(f"  {purpose}")
            print()
            print(f"共找到 {len(results)} 个匹配函数，可使用 python get_function_detail.py <module_path> <function_name> 获取详情")

        # # JSON 输出
        # json_output = [
        #     {
        #         "name": name,
        #         "path": path,
        #         "syntax": syntax,
        #         "purpose": purpose,
        #         "parameters": parameters,
        #         "vb_signature": vb_signature
        #     }
        #     for name, path, syntax, purpose, parameters, vb_signature in results
        # ]
        # print("---JSON---")
        # print(json.dumps(json_output, ensure_ascii=False, indent=2))

    else:
        if len(sys.argv) < 3:
            print("错误: 需要提供模块路径和函数名")
            print("用法: python get_function_detail.py <module_path> <function_name>")
            sys.exit(1)

        module_path = sys.argv[1]
        func_name = sys.argv[2]

        result = get_function_detail(module_path, func_name)

        if result:
            print(format_output(result))

            # # JSON 输出
            # json_output = {
            #     "name": result[0],
            #     "syntax": result[1],
            #     "vb_signature": result[2],
            #     "purpose": result[3],
            #     "parameters": result[4],
            #     "remarks": result[5],
            #     "example": result[6],
            #     "see_also": result[7]
            # }
            # print()
            # print("---JSON---")
            # print(json.dumps(json_output, ensure_ascii=False, indent=2))
        else:
            print(f"未找到函数: {func_name} (模块: {module_path})")
            print()
            print("提示: 可以使用 --search 搜索函数名")
            print(f"  python get_function_detail.py --search {func_name}")


if __name__ == "__main__":
    main()
