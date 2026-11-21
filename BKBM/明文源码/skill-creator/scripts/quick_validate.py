# -*- coding: utf-8 -*-
"""
技能快速校验：SKILL.md 的编码、frontmatter 格式、必填字段与命名规则。

用法:
    python quick_validate.py <技能目录>

校验目标 = 系统能正确解析并把技能列入清单：frontmatter 正则与
PKPMAgent.skill_kit.paths 同款；BOM/非 UTF-8/空字段等会导致「技能隐身」
的问题在这里全部报错。
"""

import re
import sys
from pathlib import Path

import yaml

MAX_SKILL_NAME_LENGTH = 64
MAX_BODY_LINES = 500
# 与 PKPMAgent.skill_kit.paths._FRONTMATTER_RE 保持一致：校验通过 ⇔ 中间件可解析
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
ALLOWED_KEYS = {"name", "description", "allowed-tools", "license", "metadata"}


def validate_skill(skill_path) -> tuple[list[str], list[str]]:
    """返回 (errors, warnings)。errors 非空即校验失败。"""
    skill_dir = Path(skill_path)
    errors: list[str] = []
    warnings: list[str] = []

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return [f"未找到 {skill_md}"], warnings

    raw = skill_md.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        errors.append(
            "SKILL.md 带 UTF-8 BOM：frontmatter 将无法解析，技能会从清单中消失。请以无 BOM 的 UTF-8 重新保存"
        )
        raw = raw[3:]
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        errors.append("SKILL.md 不是 UTF-8 编码（疑似 GBK/ANSI）：系统按 UTF-8 读取，中文会乱码。请转存为 UTF-8")
        return errors, warnings

    m = FRONTMATTER_RE.match(content)
    if not m:
        errors.append("文件开头缺少 frontmatter（--- ... --- 块），或格式不符")
        return errors, warnings

    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        errors.append(f"frontmatter 不是合法 YAML: {e}")
        return errors, warnings
    if not isinstance(fm, dict):
        errors.append("frontmatter 必须是 YAML 字典（key: value）")
        return errors, warnings

    unexpected = set(fm) - ALLOWED_KEYS
    if unexpected:
        errors.append(
            f"frontmatter 含未知字段: {', '.join(sorted(unexpected))}（允许: {', '.join(sorted(ALLOWED_KEYS))}）"
        )

    name = fm.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append("name 缺失或为空：系统会静默跳过该技能")
    else:
        name = name.strip()
        if not re.fullmatch(r"[a-z0-9-]+", name):
            errors.append(f"name '{name}' 须为小写连字符（仅小写字母/数字/连字符）")
        elif name.startswith("-") or name.endswith("-") or "--" in name:
            errors.append(f"name '{name}' 不能以连字符开头/结尾或含连续连字符")
        if len(name) > MAX_SKILL_NAME_LENGTH:
            errors.append(f"name 过长（{len(name)} > {MAX_SKILL_NAME_LENGTH} 字符）")
        dir_name = skill_dir.resolve().name
        if name.lower() != dir_name.lower():
            warnings.append(
                f"frontmatter name '{name}' 与目录名 '{dir_name}' 不一致：use_skill 按目录名解析、清单按 name 展示，建议保持一致"
            )

    desc = fm.get("description")
    if not isinstance(desc, str) or not desc.strip():
        errors.append("description 缺失或为空：系统会静默跳过该技能；它也是触发技能的唯一依据")
    elif len(desc) > 1024:
        warnings.append(f"description 较长（{len(desc)} 字符）：它常驻系统提示，建议压缩到 1024 字符内")

    body_lines = content[m.end():].count("\n") + 1
    if body_lines > MAX_BODY_LINES:
        warnings.append(f"正文约 {body_lines} 行（建议 <{MAX_BODY_LINES}）：考虑把细节拆到 references/ 按需加载")

    return errors, warnings


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: python quick_validate.py <技能目录>")
        return 1
    errors, warnings = validate_skill(sys.argv[1])
    for w in warnings:
        print(f"[WARN] {w}")
    if errors:
        for e in errors:
            print(f"[ERROR] {e}")
        print(f"\n校验未通过（{len(errors)} 处错误），修复后重跑")
        return 1
    print("[OK] 校验通过：frontmatter 可被正确解析，技能将出现在清单中")
    return 0


if __name__ == "__main__":
    sys.exit(main())
