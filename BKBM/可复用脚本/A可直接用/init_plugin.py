# -*- coding: utf-8 -*-
"""
初始化插件骨架：创建插件文件夹，生成含 TODO 占位的 SKILL.md 与带 argparse 参数头部的
scripts/main.py。

用法:
    python init_plugin.py "<显示名>" [--from-script <已有脚本路径>] [--with-ui]

- 目录布局与 skill 一致（SKILL.md + scripts/），入口是 scripts/main.py。
- 显示名可以是中文；文件夹名由显示名规范化而来，**重名自动加 _2 / _3 后缀**
  （显示名允许重复，文件夹名不允许——直接复用会让后建的 main.py 覆盖前一个）。
- --from-script：把已有脚本的正文接到 argparse 参数头部之下，作为 main.py 的初稿。
- 输出目录固定为用户插件目录，不在该目录下的位置不会被系统发现。
"""

import argparse
import re
import sys
import json
from pathlib import Path

try:
    from .ui_schema import default_ui
except ImportError:
    from ui_schema import default_ui

# 用户插件目录（与 PKPMAgent.plugin_kit.paths.USER_PLUGINS_DIR 一致；
# 独立计算以便脱离包运行）
PLUGINS_DIR = Path.home() / "AppData" / "Local" / "PKPM" / "LLMEnv" / "plugins"

MAX_DIR_NAME = 60
ILLEGAL_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

SKILL_TEMPLATE = """---
name: {name}
description: [TODO: 一句话写清这个插件做什么、用户什么时候要用它]
plugin:
  entry: scripts/main.py
  params:
    - {{key: TODO_key, label: TODO标签, type: float, unit: m, default: 0}}
---

# {name}

[TODO: 什么时候用它 —— 一两句]

## 参数

[TODO: 每个参数是什么意思、单位、合理范围。写到脱离原始对话也能读懂：
将来修改这个插件时，这里是唯一的上下文来源。]

## 注意事项

[TODO: 有什么坑、前置条件（如「需先打开 PKPM 工程」）、什么情况下会失败]
"""

MAIN_HEADER = '''# -*- coding: utf-8 -*-
"""[TODO: 一句话说明本脚本做什么]"""

# ── 参数（界面运行时由 PKPM Agent 以命令行参数传入；直接运行本文件时用下方默认值）──
import argparse

_p = argparse.ArgumentParser(description="[TODO: 一句话说明本脚本做什么]")
# [TODO: 每个清单参数一行 add_argument，default 必须与 SKILL.md 里的 default 一致]
_p.add_argument("--TODO_key", type=float, default=0, help="TODO标签，m")
_a = _p.parse_args()

TODO_key = _a.TODO_key

'''

MAIN_BODY_PLACEHOLDER = """# ── 实现 ──
# [TODO: 把对话里试错的调用序列重写成一份干净、可从头跑到尾的脚本]
# [TODO: 有独立职责或重复逻辑时拆到同目录模块（如 geometry.py），这里 import 后调用；
#        scripts/ 已在 sys.path 中，直接 `from geometry import build` 即可]
# [TODO: 关键结果用 print 输出——运行完只有这些文字会显示给用户]
"""


def sanitize_dir_name(display_name: str) -> str:
    cleaned = ILLEGAL_NAME_RE.sub("_", (display_name or "").strip())
    cleaned = cleaned.strip(" .")[:MAX_DIR_NAME]
    return cleaned or "插件"


def unique_dir(display_name: str) -> Path:
    PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
    base = sanitize_dir_name(display_name)
    existing = {d.name.lower() for d in PLUGINS_DIR.iterdir() if d.is_dir()}
    if base.lower() not in existing:
        return PLUGINS_DIR / base
    counter = 2
    while f"{base}_{counter}".lower() in existing:
        counter += 1
    return PLUGINS_DIR / f"{base}_{counter}"


def read_source(path: str) -> str:
    src = Path(path)
    if not src.is_file():
        print(f"[ERROR] 找不到脚本: {src}")
        sys.exit(1)
    try:
        return src.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return src.read_text(encoding="gbk", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description="创建插件骨架（SKILL.md + main.py）")
    parser.add_argument("display_name", help="插件显示名（可用中文）")
    parser.add_argument("--from-script", default="", help="已有脚本路径，作为 main.py 初稿")
    parser.add_argument("--with-ui", action="store_true", help="生成可选的 ui.json 自动布局骨架，完成参数后再补显示条件")
    args = parser.parse_args()

    name = (args.display_name or "").strip()
    if not name:
        print("[ERROR] 显示名不能为空")
        return 1

    plugin_dir = unique_dir(name)
    if plugin_dir.name != sanitize_dir_name(name):
        print(f"提示: 文件夹重名，已改用 '{plugin_dir.name}'（显示名仍是 '{name}'）")

    scripts_dir = plugin_dir / "scripts"
    scripts_dir.mkdir(parents=True)
    print(f"[OK] 创建插件目录: {plugin_dir}")

    (plugin_dir / "SKILL.md").write_text(SKILL_TEMPLATE.format(name=name), encoding="utf-8")
    print("[OK] 创建 SKILL.md（含 TODO 模板）")

    body = read_source(args.from_script) if args.from_script else MAIN_BODY_PLACEHOLDER
    if args.from_script:
        print(f"[OK] 已读入原脚本 {args.from_script}（{len(body.splitlines())} 行）作为 main.py 初稿")
    (scripts_dir / "main.py").write_text(MAIN_HEADER + body, encoding="utf-8")
    print("[OK] 创建 scripts/main.py（含 argparse 参数头部）")
    if args.with_ui:
        definition = default_ui([{"key": "TODO_key", "type": "float", "group": ""}])
        (plugin_dir / "ui.json").write_text(json.dumps(definition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("[OK] 创建 ui.json：完成参数清单后同步更新字段引用，详见 references/ui-schema.md")
        print("     骨架未判断内容宽度；按标签和控件选择宽度，不把最窄档作为通用默认。")

    print(f"\n下一步:")
    print("1. 改写 scripts/main.py：把参数从代码里提到 argparse 头部，写死量保持写死；")
    print("   有独立职责或重复逻辑时拆到 scripts/ 下的模块，入口保留参数与调用")
    print("2. 填完 SKILL.md 的全部 TODO（UTF-8 无 BOM），params 与 main.py 头部逐条对应")
    print("3. 运行 validate_plugin.py 校验")
    print("4. 用 python_executor 试跑一次 scripts/main.py（见 SKILL.md「执行与调试」）")
    print(f"5. 请用户到「插件」页打开「{name}」核对表单，不对就说一句让 Agent 改")
    return 0


if __name__ == "__main__":
    sys.exit(main())
