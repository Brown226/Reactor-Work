---
name: bimbase-parametric-component
description: 指导使用 pyp3d 编写 Python 参数化建模脚本。识别到用户要建参数化组件、用自然语言描述几何模型、要求生成建模脚本、或任何涉及 pyp3d 函数库的编写任务时，必须及时调用此 SKILL，即使用户只是说"创建一个圆柱"或"生成这个形状的脚本"。用户说"跑一下这段脚本""执行这个 .py""在 BIMBase/PKPM-BIM 里布置"时同样调用本 SKILL——它自带 BIMBase 内嵌 Python 解释器的自动定位与执行脚本，无需手工填写解释器路径。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# pyp3d 参数化组件开发指导

本 Skill 指导如何正确使用 BIMBase MCP Server 的检索工具链，产出符合规范的 pyp3d 参数化组件脚本。
当用户意图是"创建/修改/重构参数化组件"时，必须先执行本 Skill 的工作流，再进入编码。


## 何时必须调用

- 用户要求创建参数化几何、参数化构件、BIM 参数化组件
- 用户给出几何需求并要求可调参数、参数联动、参数约束
- 用户要求使用 `pyp3d`、`Component`、`Attr`、`replace()` 等模式实现模型
- 用户要求对现有参数化组件做功能扩展、性能优化或几何修复

## 首要工作流（必须完成才能写代码）

**pyp3d 的 API 与任何已知 Python 库都不同，严禁凭记忆或经验猜测函数名与参数。**

1. **规划**：调用 `get_skill_manifest()`，阅读返回 JSON 中各 symbol 的 description，确定本次任务需要哪些函数（symbol）。
2. **取文档**：调用 `get_skill_bundle(symbols=[...])` 一次性获取所有将使用函数的文档正文（会自动附带编码规范 `basic_writing_style`）。**凡是文档中未出现的函数、参数、用法，一律禁止写进代码。**
3. **未命中处理**：若某个 symbol 拼错或不存在，工具不会报死错，而是在响应中返回 `candidates`（全部可用函数的精简清单）。此时直接从 `candidates` 中选择语义最接近的标准 symbol 重试，不要反复尝试拼写变体，更不要臆造函数名。
4. 明确组件目标、参数清单、参数范围、几何约束、异常输入边界。

若以上任一步未完成，不进入具体代码实现。
输出代码后自动运行代码,向用户清晰介绍建模思路，无需展示代码细节，提示用户在 BIMBase系列软件，例如PKPM-BIM里查看布置模型

## 规范底线（绝对不能违反）

- 顶部必须包含 `from pyp3d import *`
- 文件中只能定义一个继承自 `Component` 的类
- 参数用 `self['参数名'] = Attr(...)` 显式定义；造型逻辑写在带 `@export` 装饰器的 `replace(self)` 方法中；最终几何赋给 `show=True` 的输出槽位
- 在 `if __name__ == "__main__":` 下实例化并 `place(实例)` 输出
- 参数名与代码中**禁止特殊符号和角标/下标**（如 `（`、`-`、`x₁`）；中文变量名用 `_` 连接、不用空格，标点一律用英文
- **并集/合并一律用 `Combine`，禁止用 `Bool` 做并集**（Bool 并集网格质量差）；Bool 仅用于减（差集）、交（交集）
- 其余编码细则（Section 装填类型、Arc 方向、Vec2/Vec3 维度一致、单位 mm 等）以 bundle 返回的 `basic_writing_style` 文档为准

## 最小模板

```python
from pyp3d import *

class pythonModel(Component):
    def __init__(self):
        Component.__init__(self)
        # 定义参数及其默认值
        self['长'] = Attr(1000, obvious=True, combo=[500,1000,2000,3000,4000])
        self['宽'] = Attr(300.0, obvious=True)
        self['高'] = Attr(500, obvious=True)
        self['长方体'] = Attr(None, show=True)
        self.replace()

    @export
    def replace(self):
        L = self['长']
        W = self['宽']
        H = self['高']
        TestCube = scale(L,W,H) * Cube()
        self['长方体'] = TestCube

if __name__ == "__main__":
    FinalGeometry = pythonModel()
    place(FinalGeometry)
```

## 运行代码：解释器由脚本自动定位，禁止写死路径

`pyp3d` **只存在于 BIMBase 自带的内嵌 Python 3.7.9 里**，系统 `python` 一定会报
`ModuleNotFoundError`。但内嵌解释器的绝对路径每台机器都不同（盘符、版本年份、
是否装在中文目录都不一样），所以本 skill 不写死路径，改为调用随附脚本自动定位并运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<SKILL_DIR>\scripts\run_pyp3d.ps1" "<你的脚本.py>"
```

`<SKILL_DIR>` 是本 SKILL.md 所在目录。脚本会按
**BIMBASE_PYTHON 环境变量 → 本机缓存 → 正在运行的 BIMBase 进程 → 注册表 → 按目录名扫盘**
的顺序找到内嵌解释器，用它执行目标脚本，并把 stdout/stderr 原样回传。
首次约 1 秒，之后走缓存；软件升级换了目录会自动重新解析（也可加 `-Refresh` 强制刷新）。

- 只想知道解释器在哪：加 `-PrintPython`（不传脚本路径）。
- 脚本退出码即目标脚本的退出码，报错时**完整 traceback 直接呈现给用户**。
- 聊天里贴的代码片段：**先存成 `.py` 文件再跑**，不要用 `python -c "..."`
  —— 引号、换行、中文经 shell 转义极易被悄悄破坏。
- 若返回"未找到 BIMBase 内嵌 Python"：让用户设环境变量 `BIMBASE_PYTHON`
  指向 `...\PythonScript\python-3.7.9-embed-amd64\python.exe`（或 `BIMBASE_HOME`
  指向安装目录）后重试，**绝不退回系统 python，也不要把用户代码改写成能在系统 python 上跑**。
- `import pyp3d` 需要 **BIMBase.exe 正在运行**（它靠 IPC 桥连活动进程）。软件没开时报
  `RuntimeError: BIMBASE.exe not found`，这是环境问题、不是解释器找错了——提示用户先打开
  BIMBase 即可，不要因此换解释器。
  涉及含反斜杠+数字的 Windows 路径时，优先用 shell_executor 并加双引号包裹路径，避免 run_args 对路径做转义处理。
  不需要告诉用户你用的内嵌解释器
  
## 实现要点

- **参数设计**：区分主尺寸参数与派生参数，优先"基准参数 + 公式派生"维持几何一致性；加入输入校验，防止零长度、负半径、自交等退化几何
- **几何构建**：先建基准几何（点/线/弧/截面），再做变换（平移/旋转/缩放），最后做成形（Loft/Sweep/Extrusion）或布尔（减/交）操作；复杂模型按"结构分区"分段实现
- **参数化绑定**：在 `replace()` 中读取参数生成最终几何，不将数值写死

## 输出代码要求

- 代码按"几何结构部分"清晰分段，段与段之间保留空行，每段注明生成对象与参数关系
- 错误处理给出可读反馈，便于定位参数问题（如负半径报错）

## 同一处改到第二次还不对就停手

**触发条件：同一个部件的位置或尺寸，已按用户反馈改过两次仍不对。第三次不许再动代码。**

改两次还不对，说明错的不是某个数字，而是对某个基准的理解——继续微调只会把本来对的部分也搅乱，而且每轮都要用户重新看一遍模型。此时应当：

1. **停止改代码**，把当前所有拿不准的量列出来：基准点在哪、截面是形心还是角点定位、拉伸朝哪个方向、相对坐标换算是否正确。
2. 以「我现在的理解 vs 请确认」表格发给用户：

   | 项 | 我现在的理解 | 当前代码里的值 | 对吗？ |
   |---|---|---|---|
   | 箱体基准点 | 底面角点 | (0, -426.78, -176.78) | ？ |
   | 出水管拉伸方向 | 沿 -Z 拉 100 | 终点 z = -276.78 | ？ |

3. 用户逐项确认后**一次改到位**，不要再试探性微调。

排查优先级：**先怀疑锚点语义**（`Cube`/`Box` 是角点不是中心），再查 `Vec2`/`Vec3` 维度混用与弧度/角度混用，最后才是数值本身。拿不准就回到 `get_skill_bundle` 重取该函数文档核对，不要凭印象改。

## 响应策略

- 先给出参数化方案，再给可运行代码
- 修改现有组件时优先保持原有接口稳定
- 用户要求创建模型时，必须新建一个 python 文件，不能覆盖当前已有的 Python 模型文件
