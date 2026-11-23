# 脚本生成标准（结构 / 混合路线） — 参考文档


## 概述

任何 `save_script` 产出的结构（几何）/ 混合路线脚本**必须**遵循本标准：固定骨架、固定铁律、
固定自检。目的只有一个——**一次写对，可直接运行**。

> 本技能不使用 `generate_script` 的 spec 通道（spec 只覆盖有限元建模）；结构路线与混合路线
> 一律 `save_script` 手写 Python。

## 骨架 A：结构（几何）路线（10 段，顺序不可乱）

```python
# -*- coding: utf-8 -*-
# 路线: 结构（几何）
# 建模模式: [建筑结构模型（梁柱撑/墙/板） / 通用几何模型（线/面/体）]
# 模型描述: [一句话]
# 用户输入参数: BAY=6.0(m) 开间; N_BAY=2; FLOOR_H=3.0(m); N_FLOOR=3; MESH_SIZE=0.5(m)
#   ★ 文档驱动建模时：逐参数标来源与是否[估算]，并另附「参数溯源表」交付（铁律 21）
# 假设: [做出的假设列表；★ 离散点之间的插值/过渡函数形式必须在此列明（铁律 21）]

# ========== 0. 导入（clc 紧随其后） ==========
# ⛔ 只允许 pypcae.* 与标准库（math）；禁止 numpy/scipy/pandas —— 内嵌 Python 无 numpy（铁律 20）
from pypcae.enums import *
from pypcae.comp import *
from pypcae.query import *            # 查询类在独立模块（2026-10-30 版手册导入表已列）
from pypcae.stru import StruModel     # 结构路线：不导入 FemModel，不调 init_ctx
import math                           # 按需

clc()                                 # 清空已有模型数据：import 之后、建模之前

# ========== 1. 参数定义（顶部常量，带单位注释；含网格尺寸） ==========
BAY = 6.0          # m，开间
MESH_SIZE = 0.50   # m，全局网格尺寸（构件特征尺寸的 1/4~1/10）

# ========== 2. 材料（标准牌号走 MatDB.load() + assemble(setting=setting)） ==========
# ========== 3. 截面（线构件 SectionType.Line / 面构件 Surface / 体构件 Solid） ==========
# ========== 4. 节点（连接点共享同一 Node 对象） ==========
# ========== 5. 构件（BeamColumn/Wall/Plate 或 Line/Surf/Solid，必须挂 sid） ==========
# ========== 6. 集合（Nset/Elset，按需；只接受整数 id） ==========
# ========== 7. 支座/相互作用（线约束用 FixedType.BaseLine / BaseLineGeom） ==========
# ========== 7b. 荷载工况（几何阶段布置时：geids 传构件号） ==========
# ========== 8. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
# ★ 模式用软件默认（强制口径）：体网格六面体主导 + 六面体扫掠 + 面网格四边形主导
#   六面体精度高、单元数量少、能有效避免应力奇异；四边形面网格优于三角形
# ★ MESH_SIZE 不得一刀切：按模型总体尺度与单位制、最小特征尺寸（最薄板厚/最小截面边长）、
#   分析目的（位移可粗、应力需细）、预估单元规模与耗时综合判断；相邻区域尺寸比 ≤ 2:1 且逐级过渡
#   （取值依据与预估单元数写进「建模规格核对表」；大模型先与用户确认）
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="sweepAndTMesh",     # 体网格：六面体主导（复杂区自动补四面体）
           hexMeshPattern="sweepOnly",      # 六面体类型：扫掠网格
           hexFtPattern="FT",               # 边界恢复（扫掠时不生效）
           toQuad="true")                   # 面网格：四边形主导（字符串，不是布尔值）
# 几何过于复杂、扫掠无法生成时才降级：meshPattern="tMeshOnly"（首次失败后改属交付缺陷类修复，
# 须记重试台账；用户已指定模式后再改属物理类变更，必须先问）——详见 mesh.md「★ 单元类型与网格模式选型」

# ========== 9. 收口（不可省） ==========
StruModel.toViewer()                  # 几何模型可视化（同时快照网格参数）
# ========== 9b. 几何清理（可选；★ 只能在 toViewer() 之后，方向与网格设置相反） ==========
# StruModel.dedupCoincident(dedupPoint=True, dedupLine=True, dedupSurf=True, tol=DEDUP_TOL)
#   归并重合点/线/面（2026-10-14 版手册新增）：移植/迭代既有模型时用；三个开关默认全 False，
#   要归并必须显式传 True；tol 随单位制（SI 0.005=5mm / mm-t 0.005=0.005mm）必须换算。
#   ⚠️ 归并后编号是否重排、是否需二次 toViewer() 未实测（references/stru/known_issues.md #71）；
#   ⛔ 属物理类变更，用户没要求不要主动加。它治不了 save_script 的"节点坐标重复定义"（#48）。
StruModel.submitAndMesh()             # 自动划分网格（按需；成功不终止脚本，失败 sys.exit(-1)）
```

## 骨架 B：混合路线（几何 → 网格 → 有限元 → 计算）

```python
# -*- coding: utf-8 -*-
# 路线: 混合（几何 → 网格 → 有限元）
# 分析类型: [静力/模态/谱分析/...]
# 模型描述 / 用户输入参数 / 假设: 同骨架 A

# ========== 0. 导入（混合路线五行；init_ctx 紧随其后、clc 之前） ==========
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx
import math                           # 按需

init_ctx(mode=ExecutionMode.MIXED)    # ★ 形参名固定 mode；缺省则无法几何+有限元共同执行
clc()

# ========== 1. 参数定义（顶部常量，带单位注释；含网格尺寸） ==========
# ========== 2. 材料 ========== 
# ========== 3. 截面 ==========
# ========== 4. 节点 ==========
# ========== 5. 构件（必须挂 sid） ==========
# ========== 6. 集合（按需） ==========
# ========== 7. 支座（几何阶段可用点约束/线约束） ==========
# ========== 8. 网格设置（★ 必须在 StruModel.toViewer() 之前） ==========
# ★ 模式用软件默认（强制口径）：体网格六面体主导 + 六面体扫掠 + 面网格四边形主导
#   六面体精度高、单元数量少、能有效避免应力奇异；四边形面网格优于三角形
# ★ MESH_SIZE 不得一刀切：按模型总体尺度与单位制、最小特征尺寸（最薄板厚/最小截面边长）、
#   分析目的（位移可粗、应力需细）、预估单元规模与耗时综合判断；相邻区域尺寸比 ≤ 2:1 且逐级过渡
#   （取值依据与预估单元数写进「建模规格核对表」；大模型先与用户确认）
MeshParams(sizer=Size(isBasic=True, basicSize=MESH_SIZE),
           meshPattern="sweepAndTMesh",     # 体网格：六面体主导（复杂区自动补四面体）
           hexMeshPattern="sweepOnly",      # 六面体类型：扫掠网格
           hexFtPattern="FT",               # 边界恢复（扫掠时不生效）
           toQuad="true")                   # 面网格：四边形主导（字符串，不是布尔值）
# 几何过于复杂、扫掠无法生成时才降级：meshPattern="tMeshOnly"（首次失败后改属交付缺陷类修复，
# 须记重试台账；用户已指定模式后再改属物理类变更，必须先问）——详见 mesh.md「★ 单元类型与网格模式选型」

# ========== 9a. 几何收口 + 网格划分 + 读回有限元模型 ==========
StruModel.toViewer()                  # 1 几何模型可视化
# StruModel.dedupCoincident(dedupPoint=True, dedupLine=True, dedupSurf=True, tol=DEDUP_TOL)
#   ↑ 1b 可选几何清理：只能在 toViewer() 之后、submitAndMesh() 之前；归并后编号是否重排未实测（#71）
StruModel.submitAndMesh()             # 2 网格划分 → 生成 pypcae.fem.in（仅 MIXED 模式）
FemModel.fromViewer()                 # 3 读入有限元模型（内部先 clc()，几何对象与 id 作废）

# ========== 9b. 有限元阶段（编号重新取！） ==========
all_eids = [e.id for e in Element.all()]
# ========== 10. 支座 / 荷载工况（DL/LL/WL/TEM 各自独立 LoadCase） ==========
# ========== 11. 荷载步与分析（Step → Analy，非静力必配 AnalySetting；含 Step_ALL 包络步） ==========
# ========== 12. 分析任务（多任务时 Job/JobManager + CUR_TASK 开关，单任务可省） ==========

# ========== 13. 收口（不可省） ==========
FemModel.toViewer()                   # 4 有限元模型可视化
FemModel.submitAndSolve()             # 5 模型检查 + 提交计算
```

## 铁律（违反即错）

> ⚠️ **官方手册中的示例代码禁止照抄**（★ 2026-10-14 版手册示例已重写，本条口径同步更新）：
> 新版附录示例（§三.3 有限元：梁/壳/实体/重力坝/悬索桥；§三.4 结构：开洞立方体/喇叭花网架/
> 搭接节点/空间网架/罐体筒仓）**已升级为完整可运行脚本**——带 `MatDB.load()` + `Setting()` 单位制、
> DL/LL 工况拆分、`Step_ALL` 包络步、`Analy`/`AnalySetting`、`FemModel.toViewer()` + `submitAndSolve()`，
> 重力坝与悬索桥两例还给出了 `Job` + `JobManager` + `CUR_TASK` 多任务写法
> （★ **等于上游印证了本库 #51 的处置口径**）。这些可以作为**流程与装配链的参照**。
>
> 但**仍然禁止照抄**，四处与本技能铁律冲突：
> ① **通篇位置传参**（`Line(a, b)`、`Surf([...])`、`Solid([...])`、`Fixed(node.id, Dof.Uxyz)`、
> `Section("x", SectionType.Solid, SolidSect(mid))`）——生成脚本时**一律关键字传参**
> （`Surf(outer=[...])`、`Fixed(gnids=..., dof=[...])`），例外只有 `Tube`/`IShape`（必须全位置）
> 与 `Etem`（实测关键字传参触发 `0xc0000409`，写 `Etem(elem_ids, 25.0)`）；
> ② `MatDB.assemble(..., type=MaterialType.Steel, ...)` 用了 `type=` 别名——统一写 **`iType=`**（#49）；
> ③ 结构类示例一律 **mm-t 制**（`setting.iTypeSI = 2`、自重加速度 9810）——用户未指定单位制时
> 本技能默认 **SI(m)**，照抄会把 mm 值填进 m 制项目（网格爆炸或量级错 1e6）；
> ④ 示例是**演示几何**，尺寸/网格/边界不代表工程取值——`basicSize` 必须按 `mesh.md` §7 维度表重判。

| # | 铁律 | 说明 |
|---|------|------|
| 1 | import + `clc()` 位置 | `enums`/`comp` 恒定；结构路线加 `StruModel`，混合路线再加 `FemModel` + `init_ctx`；`clc()` 在全部 import（及 `init_ctx`）之后、建模语句之前 |
| 2 | 混合路线开关 | `init_ctx(mode=ExecutionMode.MIXED)` 必须在 `clc()` 之前；形参名固定 `mode`，取值用枚举不写裸数字；★ **手册 2026-10-26 版明确：参数必须关键字传入，位置传入不允许**；**纯结构路线不要调它** |
| 3 | 关键字传参 | 构造类一律关键字；例外 `Tube`/`IShape` 全位置、`Etem` 全位置 |
| 4 | 无 print / 无中文标识符 | ★ **2026-10-22 更正**：`print()` **运行时可用**（输出进 `pserver.log`/`task-log`），**不会崩**；被拦的是 `save_script` **平台校验**（报「脚本包含 N 处 print() 调用」，见 `references/stru/known_issues.md` #125）——**交付脚本仍不写 print**；变量名/函数名只用英文（模型/截面名称字符串可中文） |
| 5 | 引用一律 `.id` | 节点、构件、截面、材料、集合都用 `.id`，禁止硬编码数字 |
| 6 | 共享节点 | 相连构件在连接点必须用**同一个** `Node` 对象；同坐标重复建点会产生零长度单元/网格失败 |
| 7 | 构件必须挂截面 | 所有构件给 `sid`（`-1` 的构件网格后无属性）；线构件 `SectionType.Line`、面构件 `Surface`、体构件 `Solid` |
| 8 | 构件几何硬约束 | `BeamColumn` 用 `iMark=`；`Wall.nids` 左下→右下→右上→左上；`Plate.nids` 右手螺旋向上；`Surf.outer`/`inners` 传**线 id**、`Solid.outer` 传**面 id**；圆柱/圆锥/球面用 `bottom`/`top`/`center`；圆弧 `Line` 必传 `center`+`kp` |
| 9 | `normal` 不与杆轴平行 | X 向梁 `[0,1,0]`、Y 向梁 `[1,0,0]`；平行会导致网格/modelcheck 报"单元法向有错" |
| 10 | 网格设置在 `toViewer()` 之前 | `MeshParams`/`Size`/`MeshSetting`/`LoadToMassSetting` 写在 `StruModel.toViewer()` 之前（toViewer 序列化并快照），写在其后**静默无效** |
| 11 | 混合路线编号重取 | `FemModel.fromViewer()` 内部先 `clc()`：节点号/单元号、荷载、工况与分析一律写在它**之后** |
| 12 | 收口完整（按路线） | 结构：`StruModel.toViewer()`（+ `submitAndMesh()`）；混合：五步全齐。漏 `toViewer()` 视同未交付 |
| 13 | 单位一致 | 材料库为 m 制（SI）：用户指定单位制时查库参数换算一致；未指定默认 m 制并提示；全脚本（含网格尺寸）不混用 |
| 14 | 自重显式 | `Emload(geids=[...], value=9.81, dir=[0,0,-1])`；`density` 不自动产生重力；几何阶段 `geids` 传构件号或留空＝全局 |
| 15 | 温度先填 expansion | 用 `Etem`/`Ctem` 前材料必须给 `expansion` |
| 16 | 不依赖子步出结果 | 子步仅为内置分段，不影响结果显示；静力要力-位移曲线须建多个 `Step` 逐级加载 |
| 17 | ★ **网格模式用软件默认** | **体网格六面体主导 + 六面体扫掠 + 面网格四边形主导**：`meshPattern="sweepAndTMesh"`、`hexMeshPattern="sweepOnly"`、`hexFtPattern="FT"`、`toQuad="true"`（字符串）——显式写出便于核对，**不得随意改**；只有几何复杂到扫掠划不出（碎面/回转体/球面/多开洞）才降级 `tMeshOnly`（改动理由写进规格核对表）。**能力边界**：不能按区域切换六面体/四面体（`MeshParams` 全局单例、`MeshSetting` 只管局部尺寸）；`ElementType` 中无金字塔/楔形过渡单元，交界过渡由划分器内部生成、不可指定（见 `mesh.md` §4~§5） |
| 18 | ★ **`basicSize` 综合判断** | 无通用值、不得照抄示例：按模型总体尺度与单位制、**最小特征尺寸**（最薄板厚/最小截面边长）、分级尺寸（`beamSize`/`wallSize`/`plateSize`）、分析目的、预估单元规模与耗时（尺寸减半 → 单元 2~4 倍、实体可达 8 倍）、几何复杂度综合判断；**相邻区域尺寸比 ≤ 2:1 且逐级过渡**（0.25 → 0.5 → 1.0）；取值依据与预估单元数写进规格核对表；⛔ 加密与网格无关性研究须用户明确要求后才做（见 `mesh.md` §6~§7） |
| 20 | ★ **禁止 import 任何第三方库（numpy / scipy / pandas 等）** | PkpmCAE 内嵌 Python **没有 numpy**（2026-10-15 实测）：探针脚本 `import numpy` 在网格完成之后抛 `ModuleNotFoundError` → `run_script` 返回 `success:false`、`task-log` 记 `@failure`，**但网格产物已落盘**（极易误判为"网格失败"）。**纪律**：建模脚本内只用标准库（`math` 可用）；一切后处理（读 `fe_modelSource.json`、统计单元/方向校核/画图）**一律在 Agent 本地 `python_executor` 环境完成**，不写进 PyPCAE 脚本 |
| 21 | ★ **文档驱动建模：参数必须可溯源**（2026-10-15 新增） | 输入是设计文档（Word/PDF 参数表）时：① **参数溯源表**列为交付物——逐行给「参数名 / 取值 / 单位 / 来源（文档章节或表号）/ 是否 [估算]」；② 严格区分**"文档明给"与"须估算"**——文档只给离散点+名称（如只给翼型族名与相对厚度、不给型线坐标）时，替代模型必须显式标注 **[估算]** 并写进「未决问题」，⛔ 不得静默当成"文档数据"；③ **离散点之间的过渡函数 = 假设**——文档给"根部 22°/尖部 0.5°""最大弦长位于 0.20R"这类端点与峰值时，中间过渡是自由量，**任何未在文档中给出的插值/过渡函数（幂次、光滑方式）都必须作为假设列出**，并在脚本顶部注释写明函数形式 |
| 19 | ★ **几何清理只能在 `toViewer()` 之后**（2026-10-14 版手册新增） | `StruModel.dedupCoincident(dedupPoint, dedupLine, dedupSurf, tol)` 归并重合点/线/面，手册明确"**在 `StruModel.toViewer()` 结束之后才能生效**"——**方向与铁律 10（网格设置在 `toViewer()` 之前）相反**，别记混；三个 `dedup*` 默认全 `False`，要归并必须显式传 `True`；`tol` 随单位制（SI 0.005 = 5 mm / mm-t 0.005 = 0.005 mm）必须换算。定位是**移植/迭代既有模型**的补救，**不替代**铁律 6（共享同一 `Node`），也治不了 `save_script` 的"节点坐标重复定义"（#48）。归并后编号是否重排、是否需二次 `toViewer()` **未实测**（#71）；属物理类变更，用户没要求不要主动加（见 `mesh.md` §8、`stru_model.md` §核心 API 2b） |

## 工况拆分原则（强制）

| 工况 | 内容 | 实现 |
|------|------|------|
| DL 恒载 | 自重 + 永久荷载 | `Emload`（自重）+ 其他 |
| LL 活载 | 使用/人群/车辆 | `Elload`/`Esload`/`Cload` |
| WL 风载 | 仅室外结构 | `Esload` |
| TEM 温度 | 均匀温升降 | `Etem`（材料先填 expansion） |

- **禁止创建零荷载工况**；用户没明确要求的工况不要擅自添加；室内物品只需 DL+LL，**禁止建 WL**；
- 混合路线的分析中除单工况步外，加一个 `Step_ALL` 包络步纳入全部实际工况；
- 几何阶段的荷载 `geids` 传**构件号**、非均布 `coord` 用**百分比**（有限元阶段才是单元号/距离）。

## 约束方向要点

| 场景 | 写法 |
|------|------|
| 柱脚/墩底固结 | `Fixed(gnids=[...], dof=[Dof.All])` |
| 简支梁端（混合路线有限元阶段） | 固定铰 `[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx]`；滑动铰 `[Dof.Uy, Dof.Uz, Dof.Phx]`（释放纵向） |
| 拱脚 | **必须含 `Dof.Ux`**（水平推力，缺则矩阵奇异） |
| 建筑结构线约束 | `Fixed(gnids=[构成线的点编号], dof=[...], type=FixedType.BaseLine)` |
| 通用几何线约束 | `Fixed(gnids=[线构件号], dof=[...], type=FixedType.BaseLineGeom)` |
| 板边简支 | 边 `[Dof.Uz]`、角点 `[Dof.Ux, Dof.Uy, Dof.Uz]` |

## 多版本与保存

- 不同方案另存新文件，title 加区分后缀（`_mesh0.25`/`_v2`）；
- 同模型微调 `save_script(folder=原目录)`；
- 保存前 `browse_generated_files()` 查重；发现旧文件不得拒绝生成。

## 输出前自检清单

见 `references/stru/guide.md` §5（23 项），逐项核对后才允许回复"已完成"。
