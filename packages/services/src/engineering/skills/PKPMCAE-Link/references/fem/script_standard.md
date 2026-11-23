# 脚本生成标准 — 参考文档




## 概述

任何 `save_script` 产出的 PyPCAE 脚本**必须**遵循本标准：固定骨架、固定铁律、
固定自检。目的只有一个——**一次写对，可直接运行**。

## 脚本骨架（12 段，顺序不可乱）

```python
# -*- coding: utf-8 -*-
# 分析类型: [静力/模态/谱分析/...]
# 模型描述: [一句话]
# 用户输入参数: SPAN=6.0(m) 跨度; ...
# 假设: [做出的假设列表]

# ========== 0. 导入（固定三件套，clc 紧随其后） ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.fem import FemModel      # 唯一允许的模型接口（本技能只做有限元路线）
import math                          # 按需

clc()                                # 清空已有模型数据：import 之后、建模之前

# ========== 1. 参数定义（顶部常量，带单位注释） ==========
SPAN = 6.0        # m
N_SPAN = 1        # 跨数
# ...

# ========== 2. 材料 ==========
# ========== 3. 截面 ==========
# ========== 4. 节点 ==========
# ========== 5. 单元 ==========
# ========== 6. 集合（Nset/Elset，按需） ==========
# ========== 7. 支座/相互作用 ==========
# ========== 8. 荷载工况（DL/LL/WL/TEM 各自独立 LoadCase） ==========
# ========== 9. 荷载步与分析（Step → Analy，非静力必配 AnalySetting） ==========
# ========== 10. 分析任务（多任务时 Job/JobManager，单任务可省） ==========
# ========== 11. 收口（不可省） ==========
FemModel.toViewer()
FemModel.submitAndSolve()
```

## 铁律（违反即错）

> ⚠️ **官方 README 中的示例代码禁止照抄**（★ 2026-10-14 版手册示例已重写，本条口径同步更新）：
>
> **旧口径已部分失效**：原写"示例大量使用位置参数（`Fixed(nods[0].id, Dof.All)`、
> `Cload(nods[2].id, FDof.Fy, -1)`）与无量纲演示值（`E0=1`）"——2026-10-14 版手册里
> **`E0=1` / `Material("test")` / `Fixed(nods[0].id, Dof.All)` / `Cload(nods[2].id, ...)` 均已 0 处残留**
> （仅剩的两个纯无量纲演示例「网壳」「双曲抛物面」已被上游移除，#74）。
> 新版 §三.3 五个示例（梁 / 壳 / 实体 / 重力坝 / 悬索桥）**均为完整可运行脚本**：
> `MatDB.load()` + `MatDB.assemble(iType=..., iMark=..., setting=setting)`（★ 用的是**正解 `iType=`**，
> 不是 `type=` 别名）+ `Setting()` 单位制 + DL/LL 工况拆分 + `Step_ALL` 包络步 + `Analy`/`AnalySetting`
> + `FemModel.toViewer()` + `submitAndSolve()`；重力坝与悬索桥两例还给出 `Job` + `JobManager` +
> `CUR_TASK` 多任务写法（★ **等于上游印证了本库"必须指派分析任务 + 多任务用 `CUR_TASK` 分次提交"的口径**，
> 见 `references/fem/known_issues.md` 第 3 区）。**这些可以作为流程与装配链的参照**（#74）。
>
> **但仍然禁止照抄**——新版示例**残留位置传参**（实测计数）：
> `Section("名", SectionType.Line, Rectangle(...))` **11 处**、`Step("名").add(...)` **10 处**、
> `LoadCaseCombine(工况id, 系数)` **19 处**、`Job("名", main=N)` **5 处**、
> `Fixed(node.id, Dof.Uxyz)` **1 处**、`Element([...])` **1 处**。
> 生成脚本时**一律关键字传参**（`Section(name=..., type=..., sub=...)`、`Fixed(gnids=..., dof=[...])`、
> `Element(nids=[...], type=..., sid=...)`、`LoadCaseCombine(lid=..., coef=...)`）；
> 例外只有 `Tube`/`IShape`（必须全位置）。照抄位置传参可能参数错位——轻则静默算错，
> 重则原生层崩溃（实测 `Emload`/`Esload`/`Elload` 纯位置参数触发过 `0xc0000409`，#1）。
> 另：示例的尺寸 / 网格 / 边界是**演示几何**，不代表工程取值，按用户规格重新取。
>
> 🚦 **技能范围**：本技能只做有限元路线——**模型类只允许 `from pypcae.fem import FemModel`**（不许 `pypcae.stru`），
> **禁止调用几何模型接口**（构件级建模、自动网格划分、网格设置、几何转有限元）；两类接口同脚本互斥，
> 混用会被执行模式锁定机制拦下并抛错。用户提出这类需求时告知属 `pypcae-stru-modeling` 技能范围
>（见 `references/fem/guide.md` §1「技能范围」）。
>
> ★ **允许（且手册推荐的）导入集合**（2026-10-30 版手册 §二.1）：`pypcae.enums`、`pypcae.comp`、
> **`pypcae.query`**（查询类 `NodeQuery`/`ElemQuery`/`SectionQuery`/`MaterialQuery` 在独立模块，`comp` 不导出）、
> `pypcae.fem`（仅 `FemModel`）、`import math`；`from pypcae.base import init_ctx` 仅混合路线需要。
> ⇒ 本条只限制**模型类**，不限制上述基础模块；`from pypcae.stru import StruModel` 仍属范围外。


| # | 铁律 | 说明 |
|---|------|------|
| 1 | 三件套 import + `clc()` 位置 | `clc()` 在全部 import 之后、建模语句之前 |
| 2 | 关键字传参 | 构造类一律关键字；**例外**：`Tube`/`IShape` 必须全位置 |
| 3 | 无 print | ★ **2026-10-22 更正**：嵌入式 Python **可以 `print()`**（输出进 `pserver.log`/`task-log`，不会崩）；被拦截的是 `save_script` 的**平台校验**（见 `references/fem/known_issues.md` #124）——**交付脚本仍不写 print** |
| 4 | 无中文标识符 | 变量名/函数名只用英文；模型/截面名称字符串可用中文 |
| 5 | 节点引用 `.id` | `Element(nids=[n1.id, n2.id], ...)`，禁止硬编码数字（spec 模式除外） |
| 6 | 共享节点 | 相连构件在连接点必须用**同一个** `Node` 对象；同坐标重复建点 → 零长度单元 |
| 7 | 收口完整 | `FemModel.toViewer()` + `FemModel.submitAndSolve()`，缺一不可。★ 手册 **2026-10-26 版**把 `saveModel` 签名修正为**无参 `saveModel()`**（旧版写作 `saveModel(softwarePath)`）；且 `submitAndSolve()` 已自动保存，**不必手动调** |
| 8 | 单位一致 | 材料库为 m 制（SI）：用户指定单位制时查库参数换算一致；**用户未指定时默认 m 制**（SI，无需改 Setting）并向用户提示；全脚本不混用 |
| 9 | 自重显式 | `Emload(geids=[...], value=9.81, dir=[0,0,-1])`；density 不自动产生重力 |
| 10 | 温度先填 expansion | 用 `Etem`/`Ctem` 前材料必须给 `expansion` |
| 11 | 不依赖子步出结果 | 子步对静力/动力均不生效（仅内置分段）；静力要力-位移曲线须建多个 Step 逐级加载；隐式动力输出帧数由「结果输出间隔」决定，而非计算步数 |
| 12 | ★ **禁止 import 任何第三方库（numpy / scipy / pandas 等）** | PkpmCAE 内嵌 Python **没有 numpy**（2026-10-15 实测，#107）：`import numpy` 会在**建模/求解完成之后**抛 `ModuleNotFoundError` → `run_script` 返回 `success:false`、`task-log` 记 `@failure`，但**产物已落盘**（极易误判为计算失败）。**纪律**：脚本内只用标准库（`math` 可用）；一切后处理（读结果文件、统计、方向校核、画图）**一律在 Agent 本地 `python_executor` 完成** |
| 13 | ★ **文档驱动建模：参数必须可溯源**（2026-10-15 新增） | 输入是设计文档（Word/PDF 参数表）时：① **参数溯源表**列为交付物——逐行给「参数名 / 取值 / 单位 / 来源（章节或表号）/ 是否 **[估算]**」；② 严格区分**"文档明给"与"须估算"**——文档只给离散点+名称时，替代模型必须标 **[估算]** 并写进「未决问题」，⛔ 不得静默当成"文档数据"；③ **离散点之间的过渡函数 = 假设**——任何未在文档中给出的插值/过渡（幂次、光滑方式）都必须列为假设，并在脚本顶部注释写明函数形式 |

## 工况拆分原则（强制）

| 工况 | 内容 | 实现 |
|------|------|------|
| DL 恒载 | 自重 + 永久荷载 | `Emload`（自重）+ 其他 |
| LL 活载 | 使用/人群/车辆 | `Elload`/`Esload`/`Cload` |
| WL 风载 | 仅室外结构 | `Esload` |
| TEM 温度 | 均匀温升降 | `Etem`（材料先填 expansion） |

- **禁止创建零荷载工况**；用户没明确要求的工况不要擅自添加；
- 室内物品（家具/设备）只需 DL+LL，**禁止建 WL**；
- 分析中除单工况步外，加一个 `Step_ALL` 包络步纳入全部实际工况。

## 约束方向要点

| 场景 | dofs |
|------|------|
| 固定铰（梁端） | `[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx]` |
| 滑动铰（梁端） | `[Dof.Uy, Dof.Uz, Dof.Phx]`（释放纵向） |
| 固结（柱脚/墩底） | `[Dof.All]` |
| 拱脚 | **必须含 `Dof.Ux`**（水平推力，缺则矩阵奇异） |
| 简支板边 / 板角 | `[Dof.Uz]` / `[Dof.Ux, Dof.Uy, Dof.Uz]` |

## 多版本与保存

- 不同方案另存新文件，title 加区分后缀（`_undamped`/`_v2`）；
- 同模型微调 `save_script(folder=原目录)`；
- 保存前 `browse_generated_files()` 查重；发现旧文件不得拒绝生成。

## 输出前自检清单

见 `references/fem/guide.md` §5（19 项），逐项核对后才允许回复"已完成"。
