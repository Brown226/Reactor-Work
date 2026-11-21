# -*- coding: utf-8 -*-
"""
初始化技能骨架：创建技能目录，生成含 TODO 占位的 SKILL.md 模板与所需资源目录。

用法:
    python init_skill.py <技能名> [--path 输出目录] [--resources scripts,references,assets]

- 技能名自动规范化为小写连字符；默认输出到用户技能目录
  %LOCALAPPDATA%\\PKPM\\LLMEnv\\skills（不在技能根目录下的位置不会被系统发现）。
- 与现有技能重名会报错：技能按 内置 > SKILLS_EXTRA_PATHS > 用户目录 取高优先级者，
  同名新技能会被遮蔽。
"""

import argparse
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
ALLOWED_RESOURCES = ("scripts", "references", "assets")

# 用户技能目录（与 PKPMAgent.skill_kit.paths.USER_SKILLS_DIR 一致；独立计算以便脱离包运行）
DEFAULT_SKILLS_DIR = Path.home() / "AppData" / "Local" / "PKPM" / "LLMEnv" / "skills"

SKILL_TEMPLATE = """---
name: {skill_name}
description: |
  [TODO: 一句话写清本技能做什么。name+description 是判断「何时使用本技能」的唯一依据，必须完整。]
  触发条件：
  1. [TODO: 用户可能的说法或场景，如「用户要求……」]
  2. [TODO: 涉及的软件、文件类型或关键词]
  3. [TODO: 其他应触发的情形]
---

# {skill_title}

## 概述

[TODO: 1-2 句话说明本技能让 PKPM Agent 能完成什么]

## 结构选型（选定后删除本节）

[TODO: 按用途选一种组织方式，可混合：
- 工作流型（顺序过程）：## 概述 -> ## 第一步 -> ## 第二步…
- 任务型（操作集合）：## 概述 -> ## 快速开始 -> ## 任务A -> ## 任务B…
- 规范型（标准/要求）：## 概述 -> ## 规范 -> ## 细则…
- 能力型（关联功能）：## 概述 -> ## 核心能力 -> ### 1. -> ### 2.…]

## [TODO: 按所选结构替换为第一个正式章节]

[TODO: 写给另一个 PKPM Agent 实例的、不显而易见的程序化知识：
- 技术操作给出可直接执行的代码示例（python_executor 是核心抓手）
- 复杂流程给出决策规则；示例使用真实的用户请求
- 引用资源写明用法：脚本 use_skill('{skill_name}', run='scripts/xxx.py')；
  参考文档 use_skill('{skill_name}', file='references/xxx.md')]
"""


def normalize_skill_name(raw: str) -> str:
    """规范化为小写连字符（仅小写字母/数字/连字符）。"""
    s = re.sub(r"[^a-z0-9]+", "-", raw.strip().lower())
    return re.sub(r"-{2,}", "-", s).strip("-")


def title_case_skill_name(name: str) -> str:
    return " ".join(w.capitalize() for w in name.split("-"))


def existing_skill_names() -> set[str]:
    """收集全部技能根目录下的现有技能名（目录名 + frontmatter name，统一小写）。

    优先复用 PKPMAgent.skill_kit.paths（use_skill/shell_executor 运行时已配好
    PYTHONPATH）；导入失败时退化为只扫内置根目录与用户技能目录的目录名。
    """
    names: set[str] = set()
    try:
        from PKPMAgent.skill_kit.paths import read_skill_frontmatter, skills_roots

        for root in skills_roots():
            p = Path(root)
            if not p.is_dir():
                continue
            for d in sorted(p.iterdir()):
                if d.is_dir() and (d / "SKILL.md").is_file():
                    names.add(d.name.lower())
                    fm = read_skill_frontmatter(d / "SKILL.md")
                    if fm:
                        names.add(fm["name"].lower())
    except Exception:
        builtin_root = Path(__file__).resolve().parents[2]  # skills/skill-creator/scripts -> skills
        for root in (builtin_root, DEFAULT_SKILLS_DIR):
            if root.is_dir():
                for d in sorted(root.iterdir()):
                    if d.is_dir() and (d / "SKILL.md").is_file():
                        names.add(d.name.lower())
    return names


def parse_resources(raw: str) -> list[str]:
    resources = [r.strip() for r in raw.split(",") if r.strip()]
    invalid = sorted(set(resources) - set(ALLOWED_RESOURCES))
    if invalid:
        print(f"[ERROR] 未知资源类型: {', '.join(invalid)}（允许: {', '.join(ALLOWED_RESOURCES)}）")
        sys.exit(1)
    return list(dict.fromkeys(resources))


def init_skill(skill_name: str, skills_root: Path, resources: list[str]) -> Path | None:
    skills_root.mkdir(parents=True, exist_ok=True)
    skill_dir = skills_root / skill_name

    if skill_dir.exists():
        print(f"[ERROR] 技能目录已存在: {skill_dir}")
        print("        如需修改该技能，直接编辑其文件即可，勿重复初始化。")
        return None
    if skill_name.lower() in existing_skill_names():
        print(f"[ERROR] 与现有技能重名: {skill_name}")
        print("        技能按 内置 > SKILLS_EXTRA_PATHS > 用户目录 优先级取高者，同名会被遮蔽，请换名。")
        return None

    skill_dir.mkdir(parents=True)
    print(f"[OK] 创建技能目录: {skill_dir}")

    (skill_dir / "SKILL.md").write_text(
        SKILL_TEMPLATE.format(skill_name=skill_name, skill_title=title_case_skill_name(skill_name)),
        encoding="utf-8",
    )
    print("[OK] 创建 SKILL.md（含 TODO 模板）")

    for res in resources:
        (skill_dir / res).mkdir(exist_ok=True)
        print(f"[OK] 创建 {res}/")

    print(f"\n[OK] 技能 '{skill_name}' 初始化完成: {skill_dir}")
    print("\n下一步:")
    print("1. 先制作 scripts/references/assets 资源（新脚本必须实际运行验证）")
    print("2. 编辑 SKILL.md 完成全部 TODO（UTF-8 无 BOM），删除「结构选型」指导节")
    print("3. 运行 quick_validate.py 校验")
    print("4. 请用户新开会话，以自然请求实测触发与效果")
    return skill_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="创建技能骨架（SKILL.md 模板 + 资源目录）")
    parser.add_argument("skill_name", help="技能名（自动规范化为小写连字符）")
    parser.add_argument("--path", default=str(DEFAULT_SKILLS_DIR), help="输出目录，默认用户技能目录")
    parser.add_argument("--resources", default="", help="逗号分隔: scripts,references,assets")
    args = parser.parse_args()

    skill_name = normalize_skill_name(args.skill_name)
    if not skill_name:
        print("[ERROR] 技能名须包含至少一个字母或数字（中文名请改用英文或拼音）")
        return 1
    if len(skill_name) > MAX_SKILL_NAME_LENGTH:
        print(f"[ERROR] 技能名过长（{len(skill_name)} > {MAX_SKILL_NAME_LENGTH} 字符）")
        return 1
    if skill_name != args.skill_name:
        print(f"提示: 技能名已规范化 '{args.skill_name}' -> '{skill_name}'")

    resources = parse_resources(args.resources)
    return 0 if init_skill(skill_name, Path(args.path), resources) else 1


if __name__ == "__main__":
    sys.exit(main())
