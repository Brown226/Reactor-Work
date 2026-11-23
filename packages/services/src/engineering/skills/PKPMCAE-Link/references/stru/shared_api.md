# 通用 API 索引 + 阶段划分总表（结构 / 混合路线） — 参考文档


> 📖 **手册锚点**：签名与参数语义的权威定义见内置手册 `../manual/README.md`
> （§二.2.1 材料、§二.2.2 截面、§二.2.3 节点、§二.2.4 单元、§二.2.5 工具、§二.2.6 支座、
> §二.2.7 相互作用、§二.2.8 荷载、§二.2.9 分析、§二.2.10 全局设置、§二.1.3 MatDB）。
> 用 `../scripts/manual_search.py` 检索原文（禁止整本读入）。
>
> ★ **本文已按专题拆分**（2026-10-12），细节去对应文档，本文只留"哪一步写在哪个阶段"的总表、
> 节点与单元、混合路线全流程骨架：
>
> | 想查什么 | 去哪个文档 |
> |---|---|
> | 材料库 / 单位制 / 截面形状 / 壳截面 / 实体截面 | **`material_section.md`** |
> | 支座与约束（`Fixed` 点/线约束、弹性支座、隔震、人工边界、强迫位移） | **`supports.md`** |
> | 荷载与工况（各类荷载签名、构件号 vs 单元号、随网格传递规则） | **`loads.md`** |
> | 分析装配（`Step`/`Analy`/`AnalySetting`/`Job`/`JobManager`/`LoadToMassSetting`） | **`analysis.md`** |
> | 相互作用（绑定/耦合/嵌入/接触/连接器/主从约束） | **`interactions.md`** |
> | 构件（`BeamColumn`/`Wall`/`Plate`/`Line`/`Surf`/`Solid`）、混合流程、界面刷新、★ 几何清理 `dedupCoincident` | `stru_model.md`（§核心 API 2b） |
> | 网格设置与网格管线日志 | `mesh.md` |
> | 结果核对与理论解基准 | `verification.md` |
> | 报错诊断 | `error_diagnosis.md` |

## 概述

结构（几何）路线与混合路线共用的 API 总入口。**核心难点不是 API 本身，而是"哪一步必须写在哪个阶段"**——
混合路线里 `FemModel.fromViewer()` 内部会先 `clc()`，几何阶段的构件对象与 id **全部作废**，
而节点/单元由网格重新编号；写错阶段的对象会静默丢失或错位。

## ★ 阶段划分总表（最重要，先查这张表）

| 要写的东西 | 几何阶段（`StruModel.toViewer()` 之前） | 有限元阶段（`FemModel.fromViewer()` 之后） | 实测结论 |
|---|---|---|---|
| `Material`/`MatDB`/`Setting` | ✅ 必须 | 已带入，不必重建 | `setting.iTypeSI` 决定单位制（默认 0） |
| `Section` 截面 | ✅ 必须 | 已带入 | 截面类型必须与构件维度匹配 |
| `Node` / 构件（`BeamColumn`/`Wall`/`Plate`/`Line`/`Surf`/`Solid`） | ✅ 必须 | ❌ 构件不存在了（只剩单元） | `fromViewer()` 后 id 全部作废 |
| `Nset` / `Elset` 集合 | ✅ 建议（便于整组加载） | ✅ 也可新建 | ★ 网格后自动派生：`Elset("x")` → `x(elem)`（单元集合）+ `x(node)`（节点集合） |
| 网格设置 `MeshParams`/`Size`/`MeshSetting`/`LoadToMassSetting` | ✅ **只能在这里** | ❌ 无效 | 写在 `toViewer()` 之后静默无效（#19） |
| ★ 几何清理 `StruModel.dedupCoincident`（归并重合点/线/面） | ❌ 写了不生效 | ⚠️ **只能写在 `StruModel.toViewer()` 之后**（混合路线即第 1 步之后、`submitAndMesh()` 之前） | 2026-10-14 版手册新增；**方向与网格设置相反**（网格设置在 toViewer 之前、归并在之后）。归并后编号是否重排、是否需二次 `toViewer()` 未实测（#71）。仅几何模型有此函数 |
| `Fixed`（点约束 / 线约束） | ✅ 推荐 | ✅ 也可 | ★ 随网格带入；`gnids` 变负号集合引用、`dof` 变 6 位掩码（0=约束） |
| `ElasSupport` / `IsolationBearing` | ⚠ 可建但**不带入** | ✅ **必须在这里** | 实测几何阶段的弹性支座网格后 `all()`=0、inp 数据段为空 |
| `VSABoundary` 人工边界 | ❌ | ✅ 仅有限元支持 | — |
| 荷载（`Emload`/`Elload`/`Esload`/`Cload`/`Etem`…） | ✅ 推荐（`geids`=**构件号**或 `Elset` 号） | ✅（`geids`=**单元号**、`gnids`=节点号） | ★ 几何阶段荷载**会随网格带入且构件号自动展开为单元号**；读回是 **dict** |
| 相互作用（`Binding`/`Coupling`/`Embeded`/`ContactPair`/`Connector`/`DofSlave`） | ❌ 只认节点号/单元号 | ✅ **只能在这里** | 实测几何阶段建的不会带入 |
| 模型修正（`NodeJoint`/`NodeOffset`/`NodeMass`/`ElemMass`/`ElemSuppress`/`ElemPenalCoef`/`ElemSectOffcenter`） | 构件号口径可建 | ✅ 单元号口径 | 混合路线建议放 FEM 阶段 |
| `LoadCase` 工况 | ✅ 可与荷载一起建 | ✅ 也可新建/追加 | 实测工况名与顺序完整带入（`['DL','LL','PL']`） |
| `Step`/`Analy`/`Job`/`JobManager` | ❌ 不要建 | ✅ **只能在这里** | 实测几何阶段建的分析网格后只剩默认「分析-1」 |
| `FemModel.toViewer()` / `submitAndSolve()` | ❌ | ✅ 收口 | 五步时序不可颠倒 |

> 一句话记忆：**几何阶段管"形状 + 网格 + 跟着构件走的东西（Fixed/荷载/集合）"；
> 有限元阶段管"网格后才存在的东西（单元级荷载、相互作用、分析、任务）"。**

## 核心 API

### 构件侧 vs 有限元侧的写法差异（速查）

完整表见 `stru_model.md` §6；最常踩的四条：

| 主题 | 有限元模型 | 结构（几何）模型 |
|---|---|---|
| 荷载 `geids` | 单元号 | **构件号**（或 `Elset` 号，序列化为负号引用） |
| 非均布荷载 `coord` | 位置 = **距离** | 位置 = **百分比** |
| 线约束 | — | 建筑结构 `FixedType.BaseLine`（点编号）/ 通用几何 `FixedType.BaseLineGeom`（线构件号） |
| `PipeLoad` | 仅圆管单元 | 仅圆管截面构件 |

### 节点与单元

```python
n1 = Node(0.0, 0.0, 0.0)                       # 按创建顺序自动编号，引用一律 n1.id
e  = Element(nids=[n1.id, n2.id], type=ElementType.BeamEuler, sid=sec.id)   # 仅 FEM 阶段
```

- **相连构件在连接点必须共享同一个 `Node` 对象**：同坐标重复建点会产生零长度单元、网格失败，
  且 `save_script` 会直接判"几何错误: 节点坐标重复定义"（#48）；
- 混合路线网格后的节点/单元由 `FemModel.fromViewer()` 重建，**编号一律重新取**：
  `Node.all()`（可读 `.x/.y/.z`）、`Element.all()`（`Element.dimension` = 1 梁 / 2 壳 / 3 实体）；
  也可用 `Nset`/`Elset`（网格后派生的 `xxx(elem)`/`xxx(node)`）或条件查询
  （`from pypcae.query import *`，`NodeQuery`/**`ElemQuery`** + `eq/gt/ge/lt/le/min/max`；★ 2026-10-22 更正：**不存在 `ElementQuery`**，见另一技能 ERRATA #129）定位；
- ★ 可用的核对手段：`Node.all()`/`Element.all()`/`LoadCase.all()`/`Fixed.all()`/`Elset.all()`/
  `Nset.all()`/`Analy.all()`；**`Step.all()` 抛 `not implemented`、`Job` 无 `.all()`**（#57）；
- `Nset`/`Elset` 只接受**整数 id 列表**，`add()` 传单个 int；
- 集合可以分别装面 id 与线 id（实测料仓示例 21 个集合并存）；混装与"按集合布荷载的解释方式"未实测。

### ★ 网格后 `Element` / `Node` 的**可读属性清单**（2026-10-15 实测，写筛选代码前先查这张表）

| 类 | 实测**可用**属性 | 实测**没有**的属性（写了就 `AttributeError`） |
|---|---|---|
| `Element` | `id`、`dimension`（1 梁 / 2 壳 / 3 实体）、**`nids`**（节点号列表）、`sid`、`type`、`iMark`、`mass`、`tid`、`iLayer`、`iTower`、`normal`（**实测返回空列表**，不要依赖它判法向） | **`nodes`**、**`area`**、**`volume`** |
| `Node` | `id`、`x`、`y`、`z`、`mass`、`iType`、`iLayer`、`iTower` | — |

**由 `nids` 能做什么（★ 重要，取代多种近似写法）**：
- **单元面积 / 体积自己算**：四边形拆两三角形求面积、四面体用混合积求体积
  （`V += abs(dot(p1-p0, cross(p2-p0, p3-p0)))/6`）——**不要找 `e.area`/`e.volume`**；
- **节点级面压**：单元面积按节点均分得受荷面积 `A_trib`，逐节点施加 `p(z)·A_trib` 矢量力
  （模板见 `loads.md`「节点级面压模板」），可**完全取代**"周向扇区均布面压"近似；
- **湿面 / 受压面筛选**：按**单元全部节点**是否落在目标面上判定（容差 1e-6）——
  ⚠️ **不要用形心 + 容差**，曲壳弦效应会漏选（`loads.md`「Wpload 壳面静水压力实施要点」）；
- **法向自己算**：`normal` 返回空列表 ⇒ 需要法向时用 `nids` 前三个节点叉乘自行计算。

> ⚠️ **按坐标筛节点前先剔除"孤立节点"**：圆弧/整圆构造的**圆心点与 `kp` 方向点**会出现在网格节点表里
> 但被 **0 个单元引用**（实测某节点模型 74 个）。它们会污染节点统计与按半径/坐标的筛选
> （实测"孔内是否有母材节点"检查中 12 个初判"误判节点"**全部是孤立圆心点**）。
> 统计与剔除方法见 `verification.md`「孤立节点统计」。

## 代码模板：混合路线全流程骨架（★ 每一步的顺序与阶段都对）

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)          # ① 开关：import 之后、clc() 之前
clc()
MatDB.load()
setting = Setting(); setting.iTypeSI = 0    # 单位制（mm-t 制写 2）

# ② 几何阶段：材料 → 截面 → 节点 → 构件 → 集合 → 约束 → 荷载 → 网格设置
mat = MatDB.assemble(name="Q345", iType=MaterialType.Steel, iMark=SteelType.Q345, setting=setting)
sec = Section("b300x600", SectionType.Line, Rectangle(mid=mat.id, b=0.3, h=0.6))
# ... Node / Line / Surf / Solid / BeamColumn ...
comp_set = Elset(name="beam_set", ids=[...])            # 构件集合（网格后派生 (elem)/(node)）
Fixed(gnids=[...], dof=[Dof.All])                       # 只有 Fixed 会可靠带入
lc_dl = LoadCase("DL"); lc_dl.add(Emload(value=9.81, dir=[0, 0, -1]))     # 自重，geids 留空=全局
lc_ll = LoadCase("LL"); lc_ll.add(Elload(geids=[comp_set.id], type=LoadDistributionType.Uniform,
                     subType=LoadSubType.Force, value=[20000.0],
                     iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))
# LoadToMassSetting(loadToMassParas=[[lc_dl.id, 1.0]])  # 模态/谱分析才需要，且必须在这里
MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")        # ★ toViewer 之前

StruModel.toViewer()                        # ③ 1 几何可视化
# StruModel.dedupCoincident(dedupPoint=True, dedupLine=True, dedupSurf=True, tol=...)
#   ↑ 可选几何清理（2026-10-14 版手册新增）：只能在 toViewer() 之后；归并后编号是否重排未实测（#71）
StruModel.submitAndMesh()                   # ④ 2 网格划分（MIXED 才生成 pypcae.fem.in）
FemModel.fromViewer()                       # ⑤ 3 读入有限元模型（内部 clc()，几何 id 作废）

# ⑥ 有限元阶段：编号重取 → 相互作用/弹性支座/单元级荷载 → 分析 → 任务
eids = [e.id for e in Element.all() if e.dimension == 1]
ElasSupport(gnids=[...], type=ElasSupportType.Lateral, kz=1.0e7)          # 必须在这里
# Binding / Coupling / Embeded / ContactPair 也只能在这里（见 interactions.md）
assert len(LoadCase.all()) == 2 and len(lc_dl.emloads) >= 0               # 先核对带入情况
ANALY_NAME = "Static_1"
step_dl = Step(name="Step_DL", loadCases=[LoadCaseCombine(lc_dl.id, 1.0)])
step_all = Step(name="Step_ALL", loadCases=[LoadCaseCombine(lc_dl.id, 1.0),
                                            LoadCaseCombine(lc_ll.id, 1.0)])
analy = Analy(name=ANALY_NAME, steps=[step_dl, step_all])
main_idx = [a.name for a in Analy.all()].index(ANALY_NAME)                # ★ 动态取索引
job = Job(name="Job_1", main=main_idx)
JobManager(main=main_idx, pre=job.pre, uid=job.uid, jobs=[job])           # ★ 漏掉 → 结果全 0

FemModel.toViewer()                         # ⑦ 4 有限元可视化
FemModel.submitAndSolve()                   # ⑧ 5 模型检查 + 提交计算
```

## 最佳实践

1. **先查阶段划分总表再动手**：写错阶段的对象大多不报错，只是静默丢失；
2. 几何阶段能布置的（材料/截面/构件/集合/`Fixed`/荷载/网格设置/荷载转质量）都在几何阶段布置，
   有限元阶段只做"网格后才存在"的事（单元级荷载、相互作用、弹性支座、分析、任务）；
3. `fromViewer()` 之后**先核对再补充**：`LoadCase.all()`（工况名）、`Fixed.all()`（组数与掩码）、
   `Elset.all()`/`Nset.all()`（派生集合）、`len(Element.all())`；
4. 读回几何阶段带入的荷载时记住它已是 **dict**，且键名可能与构造参数不同
   （`Cload(dof=, value=)` → `d['dofs']`/`d['values']`）；
5. 工况拆分与分析装配和有限元侧一致（DL/LL/WL/TEM 独立 + `Step_ALL` 包络）；
6. 求解后先做 `verification.md` 第 0 层自检（步名/单元数/ΣRz），再谈结果对不对。

## 常见错误（跨专题；专题内的见各文档）

| 现象 | 原因 | 修复 |
|---|---|---|
| 位移/反力全 0 但日志"成功" | 没建 `Job`+`JobManager`，算了默认空分析「分析-1」 | 见 `analysis.md`（#51） |
| 网格 0 个单元但日志"成功" | 几何没闭合（如球面两个 `Crown` 共用一条整圆线） | 见 `stru_model.md` §5 与 #52/#53 |
| 弹性支座/相互作用"没生效" | 写在了几何阶段，未随网格带入 | 移到 `fromViewer()` 之后（见 `supports.md`/`interactions.md`） |
| 荷载丢失（femesh 警告"结构中没有荷载"） | `geids` 传了作废的构件号，或 `LoadCase` 没 `.add` | 几何阶段用构件号；FEM 阶段用 `Element.all()` 重取（见 `loads.md`） |
| 网格尺寸改了没变化 | `MeshParams` 写在 `toViewer()` 之后 | 移到之前（#19，见 `mesh.md`） |
| `illegal material category` | 漏 `MatDB.load()` | 见 `material_section.md` |
| 材料刚度量级差 1e6 | `get_material_param`（Pa）与 `assemble`（随单位制）两个出口混用 | 同一材料只按一个出口取数 |
| `0xc0000409` 崩溃 | `Etem`/荷载类用了错误传参方式（★ **原"或用了 `Connector`"已于 2026-10-15 复测推翻**，连接器可用，#115） | `Etem(ids, 25.0)` 全位置；其余荷载类全关键字 |
| `**Error:readElemLoadInfo出错:*elemLoad:-1`（genfea） | **模型零单元**（只有节点 + 连接器/约束/荷载） | 补至少 1 个 `Element`（#116）；前兆信号是 modelcheck 报"模型未定义截面/材料" |
| `zero pivot` / 前 6 阶频率为 0 | 约束不足 | 见 `supports.md` |

## 验证清单

- [ ] 每一项都写在正确的阶段（对照阶段划分总表）
- [ ] 标准牌号材料查库；截面类型与构件维度匹配；纯几何边线未挂截面
- [ ] 连接点共享同一 `Node`；引用一律 `.id`；无同坐标重复点
- [ ] 几何阶段荷载 `geids` 用构件号、`coord` 用百分比；有限元阶段用单元号/距离
- [ ] `Fixed` 在几何阶段、弹性支座/相互作用在有限元阶段
- [ ] 装配链完整到 `JobManager`；非静力分析配了 `AnalySetting`
- [ ] `fromViewer()` 之后用 `*.all()` 核对过带入情况（工况、约束、集合）
- [ ] 求解后完成 `verification.md` 第 0 层（步名/单元数）与第 3 层（ΣRz 平衡）自检
