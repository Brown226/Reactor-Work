# -*- coding: utf-8 -*-
"""
插件校验：清单能不能被解析、表单画不画得出来、参数是不是真的接到了 main.py。

用法:
    python validate_plugin.py "<插件目录绝对路径>"

校验目标 = 这个插件能出现在「插件」页、表单渲染正确、点运行真的把参数传了进去。
与 PKPMAgent.plugin_kit.paths 同款规则（frontmatter 正则、封闭类型集合），
检查可静态识别的清单、界面与 argparse 契约；业务是否使用参数仍需试跑确认。
"""

import ast
import json
import math
import re
import sys
from pathlib import Path

import yaml

try:
    from .ui_schema import validate_ui
except ImportError:
    from ui_schema import validate_ui

# 用户插件目录（与 init_plugin.py 一致；相对路径时以此为基准）
PLUGINS_DIR = Path.home() / "AppData" / "Local" / "PKPM" / "LLMEnv" / "plugins"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

PARAM_TYPES = {"int", "float", "str", "bool", "enum", "path", "file"}
PARAM_KEYS = {"key", "label", "type", "unit", "default", "min", "max", "help", "group", "options"}
PLUGIN_KEYS = {"entry", "icon", "params"}
# 早期版本写过的键，现已无意义。仍然容忍（老插件不该突然校验失败），但提醒删掉。
DEPRECATED_PLUGIN_KEYS = {"agent_visible"}
TOP_KEYS = {"name", "description", "plugin", "allowed-tools", "license", "metadata"}

MAX_DESC = 90
NO_GROUP_THRESHOLD = 6  # 参数不超过 6 个时不必分组


def _load_text(path: Path, errors: list[str]) -> str | None:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        why = (
            "frontmatter 将无法解析，插件会从列表中消失"
            if path.suffix.lower() == ".md"
            else "执行时首字符 U+FEFF 会直接引发语法错误"
        )
        errors.append(f"{path.name} 带 UTF-8 BOM：{why}。请以无 BOM 的 UTF-8 重新保存")
        raw = raw[3:]
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        errors.append(f"{path.name} 不是 UTF-8 编码（疑似 GBK/ANSI）：系统按 UTF-8 读取，中文会乱码")
        return None


def _check_param(p, index, errors, warnings) -> str | None:
    """校验单条参数，返回它的 key（不合法时返回 None）。"""
    where = f"params[{index}]"
    if not isinstance(p, dict):
        errors.append(f"{where} 不是字典（应形如 {{key: L, label: 长轴, type: float}}）")
        return None

    unknown = set(p) - PARAM_KEYS
    if unknown:
        errors.append(f"{where} 含未知键: {', '.join(sorted(unknown))}（允许: {', '.join(sorted(PARAM_KEYS))}）")

    key = str(p.get("key") or "").strip()
    if not key:
        errors.append(f"{where} 缺少 key")
        return None
    if not KEY_RE.match(key):
        errors.append(f"{where} key '{key}' 不是合法标识符：它会成为 main.py 里的变量名，只能用字母/数字/下划线且不以数字开头")
    if key == "help":
        errors.append(f"{where} key 不能叫 '{key}'：与 argparse 自带的 -h/--help 冲突，脚本一启动就报错")
    where = f"参数 {key}"

    ptype = str(p.get("type") or "").strip().lower()
    if ptype not in PARAM_TYPES:
        errors.append(f"{where} type '{p.get('type')}' 不在封闭集合 {sorted(PARAM_TYPES)} 内")
        return key

    if not str(p.get("label") or "").strip():
        warnings.append(f"{where} 没写 label：表单会直接显示 key，设计师看不懂")

    if "group" in p and not str(p.get("group") or "").strip():
        errors.append(f"{where} group 是空字符串：要么写组名，要么整个删掉")

    default = p.get("default")
    if ptype == "enum":
        options = p.get("options")
        if not isinstance(options, list) or not [o for o in options if str(o).strip()]:
            errors.append(f"{where} 是 enum 但没有 options：画不出下拉框")
        elif default is not None and str(default) not in [str(o) for o in options]:
            errors.append(f"{where} default '{default}' 不在 options 内")
    elif ptype in ("int", "float"):
        lo, hi = p.get("min"), p.get("max")
        valid = {}
        for label, value in (("default", default), ("min", lo), ("max", hi)):
            if value is None:
                continue
            try:
                finite = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            except OverflowError:
                finite = False
            if not finite:
                errors.append(f"{where} {label} '{value}' 不是有限数字")
            elif ptype == "int" and int(value) != value:
                errors.append(f"{where} {label} '{value}' 不是整数")
            else:
                valid[label] = value
        if "min" in valid and "max" in valid and lo > hi:
            errors.append(f"{where} min({lo}) 大于 max({hi})")
        if default is None:
            warnings.append(f"{where} 没写 default：表单初值为空，用户面对空框会不知道填什么")
        elif "default" in valid:
            if "min" in valid and default < lo:
                errors.append(f"{where} default({default}) 小于 min({lo})：一打开就是非法值")
            if "max" in valid and default > hi:
                errors.append(f"{where} default({default}) 大于 max({hi})：一打开就是非法值")
        if not str(p.get("unit") or "").strip():
            warnings.append(f"{where} 没写 unit：工程参数不带单位，用户得猜是 m 还是 mm")
    elif ptype == "bool":
        if default is not None and not isinstance(default, bool):
            errors.append(f"{where} default '{default}' 不是 true/false")

    return key


def validate_plugin(plugin_path) -> tuple[list[str], list[str]]:
    """返回 (errors, warnings)。errors 非空即校验失败。"""
    plugin_dir = Path(plugin_path)
    if not plugin_dir.is_absolute():
        plugin_dir = PLUGINS_DIR / plugin_path
    errors: list[str] = []
    warnings: list[str] = []

    skill_md = plugin_dir / "SKILL.md"
    if not skill_md.is_file():
        return [f"未找到 {skill_md}"], warnings

    content = _load_text(skill_md, errors)
    if content is None:
        return errors, warnings

    m = FRONTMATTER_RE.match(content)
    if not m:
        errors.append("SKILL.md 开头缺少 frontmatter（--- ... --- 块），或格式不符")
        return errors, warnings
    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        errors.append(f"frontmatter 不是合法 YAML: {e}")
        return errors, warnings
    if not isinstance(fm, dict):
        errors.append("frontmatter 必须是 YAML 字典（key: value）")
        return errors, warnings

    unknown = set(fm) - TOP_KEYS
    if unknown:
        errors.append(f"frontmatter 含未知字段: {', '.join(sorted(unknown))}（允许: {', '.join(sorted(TOP_KEYS))}）")

    if not str(fm.get("name") or "").strip():
        errors.append("name 缺失或为空：系统会静默跳过该插件")
    desc = str(fm.get("description") or "").strip()
    if not desc:
        errors.append("description 缺失或为空：系统会静默跳过该插件")
    elif "\n" in desc:
        errors.append("description 必须是一句话（不能换行）：插件页标题下只显示一行")
    elif len(desc) > MAX_DESC:
        warnings.append(f"description 有 {len(desc)} 字，插件页上会显得很长，建议压到 {MAX_DESC} 字以内")
    if "TODO" in content:
        errors.append("SKILL.md 里还留着 TODO 占位")

    block = fm.get("plugin")
    if not isinstance(block, dict):
        errors.append("frontmatter 缺少 plugin: 块：没有它就只是一个普通 skill，不会出现在「插件」页")
        return errors, warnings
    deprecated = set(block) & DEPRECATED_PLUGIN_KEYS
    if deprecated:
        warnings.append(f"plugin 块含已废弃的键: {', '.join(sorted(deprecated))}，可以删掉（会被忽略）")
    unknown = set(block) - PLUGIN_KEYS - DEPRECATED_PLUGIN_KEYS
    if unknown:
        errors.append(f"plugin 块含未知键: {', '.join(sorted(unknown))}（允许: {', '.join(sorted(PLUGIN_KEYS))}）")

    entry = str(block.get("entry") or "scripts/main.py").strip().replace("\\", "/").strip("/")
    if ":" in entry or ".." in entry.split("/"):
        errors.append(f"entry '{entry}' 指向插件目录之外：只能写插件目录内的相对路径")
        return errors, warnings
    entry_path = plugin_dir / entry
    if not entry_path.is_file():
        errors.append(f"找不到入口文件 {entry}：点运行会直接失败")
        return errors, warnings
    if "/" not in entry:
        warnings.append(
            f"入口 {entry} 直接放在插件根目录：约定与 skill 一致，.py 放 scripts/ 下"
            "（entry: scripts/main.py），脚本拆成多个文件时不会和 SKILL.md、图标混在一起"
        )

    icon = str(block.get("icon") or "").strip()
    if icon and not (plugin_dir / icon).is_file():
        warnings.append(f"icon '{icon}' 不存在，列表会回落到首字母占位")
    params = block.get("params")
    if params is None:
        params = []
    if not isinstance(params, list):
        errors.append("plugin.params 必须是列表（AI 始终输出扁平列表，分组只靠可选的 group 字符串）")
        return errors, warnings

    keys: list[str] = []
    for i, p in enumerate(params):
        key = _check_param(p, i, errors, warnings)
        if key:
            if key in keys:
                errors.append(f"参数 {key} 重复")
            keys.append(key)

    # The exact same portable schema is used by the running application.
    definition = None
    ui_path = plugin_dir / "ui.json"
    if ui_path.exists():
        ui_text = _load_text(ui_path, errors)
        if ui_text is not None:
            try:
                definition = json.loads(ui_text)
                ui_params = [{**p, "type": str(p.get("type", "str")).lower(),
                              **({"options": [str(o) for o in p.get("options", [])]} if p.get("type") == "enum" else {})}
                             for p in params if isinstance(p, dict) and p.get("key")]
                errors.extend(validate_ui(definition, ui_params))
            except (ValueError, TypeError, RecursionError) as error:
                errors.append(f"ui.json 无法解析：{error}")

    groups = [str(p.get("group") or "").strip() for p in params if isinstance(p, dict)]
    if len(keys) > NO_GROUP_THRESHOLD and not any(groups):
        warnings.append(
            f"共 {len(keys)} 个参数且一个 group 都没有：超过 {NO_GROUP_THRESHOLD} 个建议按物理对象分组，"
            "同一截面 / 同一工况的参数给同一个 group"
        )

    # 插件里所有 .py 读一遍（每个文件只读一次，编码问题不会重复报）
    py_texts = {py: _load_text(py, errors) for py in sorted(plugin_dir.rglob("*.py"))}

    # ── 参数是否真的接到了入口 ──
    # 界面点运行 = 以 --key=value 跑入口，所以「接到了」等价于「声明了同名选项」。
    # 只查入口：拆出去的模块拿的是 main.py 传过去的值，不该再解析一遍命令行。
    entry_text = py_texts.get(entry_path)
    if entry_text is not None:
        try:
            syntax = ast.parse(entry_text)
            declarations = {}
            for node in ast.walk(syntax):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "add_argument"):
                    for argument in node.args:
                        if (isinstance(argument, ast.Constant) and isinstance(argument.value, str)
                                and argument.value.startswith("--")):
                            declarations[argument.value[2:]] = {kw.arg: kw.value for kw in node.keywords}
            ui_fields = definition.get("fields", {}) if isinstance(definition, dict) else {}
            for p in params:
                if not isinstance(p, dict):
                    continue
                key = str(p.get("key") or "").strip()
                if not key:
                    continue
                if key not in declarations:
                    errors.append(f'参数 {key} 在 {entry} 里没有对应的 add_argument("--{key}")：表单上填了也没用')
                    continue
                declaration = declarations[key]
                if str(p.get("type") or "").strip().lower() == "bool":
                    action = declaration.get("action")
                    if not ((isinstance(action, ast.Attribute) and action.attr == "BooleanOptionalAction")
                            or (isinstance(action, ast.Name) and action.id == "BooleanOptionalAction")):
                        errors.append(f"参数 {key} 是 bool，add_argument 必须带 action=argparse.BooleanOptionalAction："
                                      f"开关关闭时界面传的是 --no-{key}，store_true 收不了，脚本会直接报错退出")
                if p.get("default") is not None and "default" not in declaration:
                    errors.append(f"参数 {key} 的 argparse 缺少与清单一致的 default")
                if "default" in p and "default" in declaration:
                    try:
                        actual = ast.literal_eval(declaration["default"])
                    except (ValueError, TypeError):
                        warnings.append(f"参数 {key} 的脚本默认值不是字面量，请核对其与清单一致")
                    else:
                        if actual != p["default"] or (isinstance(actual, bool) != isinstance(p["default"], bool)):
                            errors.append(f"参数 {key} 的 argparse default 与清单不同")
                field = ui_fields.get(key) if isinstance(ui_fields, dict) else None
                if isinstance(field, dict) and field.get("when"):
                    required = declaration.get("required")
                    if isinstance(required, ast.Constant) and required.value is True:
                        errors.append(f"条件参数 {key} 不能在 argparse 中 required=True：隐藏时不会传入")
        except SyntaxError as error:
            errors.append(f"{entry} 存在语法错误：{error}")
    # ── 阻塞调用：入口和它拆出去的模块一起查 ──
    # 实现拆到 scripts/ 下的模块之后，卡死人的那行 input() 多半就不在 main.py 里了。
    for py, text in py_texts.items():
        if text is None:
            continue
        rel = py.relative_to(plugin_dir).as_posix()
        # 前瞻排除属性访问与同后缀标识符：obj.input(/myinput( 不算
        if re.search(r"(?<![\w.])(input|raw_input)\s*\(", text):
            errors.append(f"{rel} 里有 input()：脚本在无人值守的子进程里跑，会直接卡死")
        if re.search(r"plt\s*\.\s*show\s*\(", text):
            errors.append(f"{rel} 里有 plt.show()：会弹窗阻塞，改成 plt.savefig() 存到输出目录")

    return errors, warnings


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: python validate_plugin.py <插件目录>")
        return 1
    errors, warnings = validate_plugin(sys.argv[1])
    for w in warnings:
        print(f"[WARN] {w}")
    if errors:
        for e in errors:
            print(f"[ERROR] {e}")
        print(f"\n校验未通过（{len(errors)} 处错误），修复后重跑")
        return 1
    print("[OK] 静态校验通过：清单、界面和 argparse 契约一致；请继续试跑并在插件页核对")
    return 0


if __name__ == "__main__":
    sys.exit(main())
