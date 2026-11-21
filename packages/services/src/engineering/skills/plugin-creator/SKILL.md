---
name: plugin-creator
description: 将成功的对话流程或已有 Python 脚本制作成带参数表单的插件，或修改已有插件的参数、动态界面和实现。适用于“制作成插件”“新建插件”“让 Agent 修改/修复”，以及插件格式和存放位置的咨询。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# 插件创建与修改

插件是用户在「插件」页填写参数后直接运行的 Python 工具，执行过程不经过模型。
它借用 skill 的目录格式，但不是 skill；`use_skill` 不能定位插件。
插件的 `SKILL.md` 正文写用途、参数含义、前置条件和限制，供今后修改时独立理解；
实现放在 `scripts/`，不依赖原始对话。

## 文件与参数契约

插件放在 `%LOCALAPPDATA%\PKPM\LLMEnv\plugins\<插件目录名>\`：

```text
<插件目录>/
├── SKILL.md          # 参数清单与使用说明
├── scripts/main.py   # argparse 入口与实现；需要时拆同级模块
├── ui.json           # 可选：显示条件、布局与文案
├── references/       # 可选：算法依据、长表格
└── assets/           # 可选：图标、模板
```

```yaml
---
name: 索网参数化建模
description: 在 PKPM 中生成双曲抛物面索网屋盖，含外部压环。
plugin:
  entry: scripts/main.py
  params:
    - {key: L, label: 长轴, type: float, unit: m, default: 198, min: 50, max: 400}
    - {key: mesh, label: 网格间距, type: float, unit: m, default: 4, min: 1, max: 10}
    - {key: H, label: 高 H, type: float, unit: mm, default: 600, group: 外部压环}
    - {key: B, label: 宽 B, type: float, unit: mm, default: 1200, group: 外部压环}
---
```

`name` 是显示名，插件目录名是唯一标识。`description` 用一句话，不换行。
`plugin.icon` 可指定插件目录内的图标相对路径；未提供时显示首字占位。
`entry` 与 `icon` 均使用目录内相对路径。

参数是扁平列表，每项有唯一 `key`、清楚的 `label` 和以下七种类型之一：

| type | 控件与取值 |
| --- | --- |
| `int` / `float` | 数字输入，可带 `unit`、`min`、`max` |
| `str` | 文本输入 |
| `bool` | 开关；默认值写 YAML 布尔值 `true` / `false` |
| `enum` | 必须有非空 `options`；≤3 项用单选，其余用下拉；选项和默认值写字符串 |
| `path` | 目录路径，浏览按钮选择目录 |
| `file` | 文件路径，浏览按钮选择文件 |

可选参数属性为 `unit`、`default`、`min`、`max`、`help`、`group`，枚举另有 `options`。
`key` 使用 ASCII 标识符 `[A-Za-z_][A-Za-z0-9_]*`，不用 Python 关键字或 `help`。
默认值与类型、范围和枚举选项一致；物理量写明单位，跨参数关系由脚本校验。
连续且 `group` 相同的参数形成默认分组；按业务对象分组，不为少量参数强行分组。

不需要显示条件或宽度覆盖的简单表单省略 `ui.json`，应用自动排版。
存在截面类型、计算模式等分支时，提供显示条件，只展示当前分支所需参数。
新界面优先保证标签、选项和输入值可读，不以最小宽度或最多并排数量为目标。
需要生成或修改界面时，先读
`use_skill('plugin-creator', file='references/ui-schema.md')`；
界面协议只在该参考文档维护。

## 从素材生成插件

### 确定要保留的流程与输入

- 从对话制作：提取最终生效的调用，移除被覆盖的早期版本、报错调用和探索代码，
  补齐独立运行需要的连接、初始化与保存。
- 从已有脚本制作：先读原文件，保留业务行为；初始化器只提供初稿，不会自动完成参数化。
- 空白新建：缺少业务目标、输入输出或目标软件时，用 `ask_user_question` 补齐关键信息。

把用户会反复调整的尺寸、数量、材料/模式和路径做成参数。
目录用 `path`，具体文件用 `file`；有限选项用 `enum`。
单位换算和算法内部常量通常保留在代码中；用户明确希望调整的容差或迭代次数可以暴露。
默认值沿用已成功运行的取值，或使用能解释清楚的合理初值。

名称、参数和行为已经明确时直接生成。仍有业务选择时，先给出具体草案，
仅询问会改变结果的关键问题；不重复确认用户已决定的内容。

### 创建并完成文件

```text
use_skill('plugin-creator', run='scripts/init_plugin.py', run_args='"<显示名>"')
```

已有脚本加 `--from-script "<脚本绝对路径>"`；需要界面骨架加 `--with-ui`。
初始化器输出实际插件目录，重名自动加后缀，不覆盖旧插件。
随后用 `python_executor` 完成文件，统一写 UTF-8 无 BOM，替换全部 TODO。
`--with-ui` 仅生成布局骨架，参数调整后还需同步字段引用与显示条件。

入口按同名命令行选项接收参数，不改写源文件。以下仅示意声明写法：

```python
import argparse

_p = argparse.ArgumentParser(description="生成索网屋盖")
_p.add_argument("--L", type=float, default=198, help="长轴，m")
_p.add_argument("--strict", action=argparse.BooleanOptionalAction,
                default=False, help="严格校验")
_a = _p.parse_args()
```

- 每个清单 `key` 对应 `--key`，不要用 `dest` 改名。
- `int` / `float` 用对应内置类型；`str` / `enum` / `path` / `file` 用 `str`。
- `bool` 用 `argparse.BooleanOptionalAction`，兼容界面传来的 `--key` 与 `--no-key`。
- argparse 默认值与清单一致；隐藏参数不传入命令行，因此条件参数不能 `required=True`。
- 参数只在入口解析一次，向业务函数传值；按当前业务分支校验和计算，忽略其他分支。

实现简单时保留一个入口文件。出现独立职责或重复逻辑时拆同级模块，
直接 `from geometry import build_surface`，不修改 `sys.path`，模块不再解析命令行。
软件接口沿用对应软件技能或已验证脚本，不从示意范例猜测 API。
生成前按需要读 `use_skill('plugin-creator', file='references/examples.md')`：
包含可独立运行的动态截面示例及模块拆分方式。

### 校验与交付

```text
use_skill('plugin-creator', run='scripts/validate_plugin.py', run_args='"<插件目录绝对路径>"')
```

修复全部错误；对警告逐项判断。校验器检查清单、界面定义、argparse 对应关系及阻塞调用，
不能证明界面可读、参数已参与业务计算或算法正确，仍需检查布局并用有预期结果的输入试跑。
动态表单逐个检查模式，只传当前有效参数，确认隐藏分支的空值不影响运行。

交付时给出实际插件路径，告诉用户到「插件」页核对表单和结果。
用户可原位拖动、调整宽度和修改文字；新增参数、分组或显示条件由 Agent 修改。

## 修改已有插件

1. 用 `python_executor` 读取用户指定目录的 `SKILL.md`、入口及相关模块；
   存在 `ui.json` 时重新读取磁盘上的当前文件，不凭上次内容修改，不使用 `use_skill` 定位插件。
2. 业务参数变更同步清单和 argparse；保留既有 key，只有含义确实改变时才改名。
   纯文案或布局修改只改 `ui.json`：解析 JSON，按稳定 key / id 修改，保留用户的其他设置。
3. 增删参数时同步界面引用；删除控制参数时明确调整依赖条件，
   不通过丢弃条件把原本隐藏的参数变成始终生效。
4. 写后重新读取，核对目标变更和其余设置，再跑校验及相关分支；目标未找到或替换未命中时先查明原因，
   不把无变化当作完成。默认值或参数含义改变时，提醒用户按需「恢复默认参数」：
   最近取值由应用单独记忆，不应写回清单或由 Agent 直接修改。

修复报错时先按堆栈定位。参数范围确实不合理才调整 `min` / `max` / `default`，
不要用放宽范围掩盖计算错误。

## 执行与调试

用 `python_executor` 指定入口与命令行参数试跑：

```text
python_executor(file_path=r"C:\Users\...\plugins\索网参数化建模\scripts\main.py",
                args=["--L=150", "--mesh=4"])
```

`use_skill(run=...)` 用于本技能的辅助脚本，不能运行用户插件。
插件页运行的是一次性子进程，脚本目录已加入 `sys.path`，
MCP/COM 接口函数已注入；需要软件连接时，入口自行调用
`connect_to_server(...)`，不要 import 注入的接口函数。
纯计算或文件处理插件不需要软件连接。

`python_executor` 使用会话命名空间：现有连接可能掩盖初始化遗漏，
`sys.modules` 缓存也可能让改过的同名模块未重新加载。
核对入口是否自带初始化；涉及连接或模块改动时，以插件页的新进程运行为准。

结果用 `print` 输出，错误明确说明原因。不要调用 `input()` 或 `plt.show()`；
绘图保存到输出目录。单位按目标软件 API 或计算方法的约定换算，
不要假定所有软件都使用同一套工程单位。
