# 动态截面插件完整示例

这是可独立运行的纯计算插件：选择矩形时显示宽、高，选择圆形时只显示直径。
三个文件齐备，无需工程软件或软件接口。这里只演示分支输入与面积计算；
其他截面的公式与限制由具体业务决定，不照搬未验证的 API。

## SKILL.md

```markdown
---
name: 截面面积
description: 计算矩形或圆形截面的面积，尺寸单位为 mm。
plugin:
  entry: scripts/main.py
  params:
    - {key: section_type, label: 截面类型, type: enum, default: 矩形, options: [矩形, 圆形]}
    - {key: rect_b, label: 宽 b, type: float, unit: mm, default: 200, min: 1, group: 矩形截面}
    - {key: rect_h, label: 高 h, type: float, unit: mm, default: 400, min: 1, group: 矩形截面}
    - {key: circle_D, label: 直径 D, type: float, unit: mm, default: 300, min: 1, group: 圆形截面}
---

# 截面面积

先选择截面类型，再填写当前分支的尺寸。尺寸为正数，输出面积的单位为 mm²。
切换类型保留此前输入，隐藏分支不参与本次计算。纯计算，不写入工程或文件。
```

## ui.json

条件按字段 key 配置，分组只负责布局。新类型增加自己的参数和条件即可，
不需要把所有分支同时显示。示例分组默认整行、数值字段占两档，为标签和输入留出空间；
若用户要求紧凑排布，再按实际内容缩窄，宽度换算与选择见 `references/ui-schema.md`。

```json
{
  "version": 1,
  "fields": {
    "rect_b": {
      "when": {
        "mode": "all",
        "rules": [{"param": "section_type", "op": "eq", "value": "矩形"}]
      }
    },
    "rect_h": {
      "when": {
        "mode": "all",
        "rules": [{"param": "section_type", "op": "eq", "value": "矩形"}]
      }
    },
    "circle_D": {
      "when": {
        "mode": "all",
        "rules": [{"param": "section_type", "op": "eq", "value": "圆形"}]
      }
    }
  },
  "sections": [
    {
      "id": "selector",
      "title": "",
      "items": [{"id": "field:section_type", "type": "field", "key": "section_type", "width": "full"}]
    },
    {
      "id": "rectangle",
      "title": "矩形截面",
      "collapsible": true,
      "items": [
        {"id": "field:rect_b", "type": "field", "key": "rect_b", "width": 2},
        {"id": "field:rect_h", "type": "field", "key": "rect_h", "width": 2}
      ]
    },
    {
      "id": "circle",
      "title": "圆形截面",
      "collapsible": true,
      "items": [{"id": "field:circle_D", "type": "field", "key": "circle_D", "width": 2}]
    }
  ]
}
```

## scripts/main.py

条件参数均有默认值，且不设置 `required=True`。
进入业务分支后才校验该分支的尺寸；直接运行时使用清单里的默认值。

```python
import argparse
import math

_p = argparse.ArgumentParser(description="计算矩形或圆形截面面积")
_p.add_argument("--section_type", type=str, choices=["矩形", "圆形"], default="矩形")
_p.add_argument("--rect_b", type=float, default=200, help="矩形宽度，mm")
_p.add_argument("--rect_h", type=float, default=400, help="矩形高度，mm")
_p.add_argument("--circle_D", type=float, default=300, help="圆形直径，mm")
_a = _p.parse_args()


def require_positive(*values):
    if any(not math.isfinite(value) or value <= 0 for value in values):
        _p.error("当前截面的尺寸须为有限正数")


if _a.section_type == "矩形":
    require_positive(_a.rect_b, _a.rect_h)
    area = _a.rect_b * _a.rect_h
else:
    require_positive(_a.circle_D)
    area = math.pi * _a.circle_D ** 2 / 4

print(f"{_a.section_type}截面面积：{area:.2f} mm²")
```

## 验证方式

生成文件后运行本技能的 `validate_plugin.py`，再用 `python_executor` 分别传入：

| args | 预期输出 |
| --- | --- |
| `[]` | 矩形截面面积：80000.00 mm² |
| `["--section_type=矩形", "--rect_b=100", "--rect_h=200"]` | 矩形截面面积：20000.00 mm² |
| `["--section_type=圆形", "--circle_D=300"]` | 圆形截面面积：70685.83 mm² |

在插件页切换类型，确认只显示对应字段。把矩形尺寸清空后切到圆形，
运行仍应成功；切回矩形应保留空值，并在运行前提示需要填写。
这里的空值只留在完整表单状态中，不把它拼进圆形分支的命令行。

不需要动态界面的插件可省略 `ui.json`，清单和 argparse 契约相同。

## 需要拆模块时

按独立职责拆分，入口仍只解析一次参数。业务模块通过函数入参拿数据，
不依赖入口的 `_a`、会话全局变量或另一次 `parse_args()`：

```python
# scripts/areas.py
import math


def circle_area(diameter):
    return math.pi * diameter ** 2 / 4
```

入口用 `from areas import circle_area` 后传入已校验的尺寸。
软件插件的模块同样显式接收已取得的模型/客户端或所需接口函数；
入口注入的函数不会自动成为导入模块的全局变量。
