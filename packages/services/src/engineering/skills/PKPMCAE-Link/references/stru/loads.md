# 荷载与工况（结构 / 混合路线） — 参考文档


## 概述

**覆盖范围**：几何阶段与有限元阶段各自的荷载写法、荷载随网格划分的传递规则、工况（`LoadCase`）
组织、各类荷载类的实测签名与读回方式。

**何时使用**：任何要"加荷载"的场合。**先看这张路线判定表**：

| 你要做的事 | 写在哪个阶段 | `geids`/`gnids` 传什么 |
|---|---|---|
| 只要几何模型（`examples/stru/` 路线） | 可以不布荷载；要布也只能布**构件级**荷载，求解在界面提交 | **构件号**（`Line`/`Surf`/`Solid`/`BeamColumn`… 的 `.id`），或 `Elset` 集合号 |
| 混合路线，荷载跟着构件走（自重、均布、温度…） | **几何阶段**（`StruModel.toViewer()` 之前）最省事 | **构件号** 或 `Elset` 号；网格划分时自动映射成单元号 |
| 混合路线，荷载必须精确落在网格后的某些单元/节点上 | **有限元阶段**（`FemModel.fromViewer()` 之后） | **单元号 / 节点号**（用 `Node.all()`/`Element.all()` 重新筛） |
| 相互作用、接触、连接器、弹性支座 | **只能在有限元阶段** | 节点号 / 单元号（见 `interactions.md`、`supports.md`） |

## 核心 API

### 选型速查（16 类荷载，全部实测存在于 pypcae 2.1.0）

| 物理场景 | 荷载类 | 作用对象参数 | 单位（SI / mm-t） | 可用阶段 |
|---|---|---|---|---|
| 集中力 / 力矩 | `Cload` | `gnids` 节点号（可 `Nset` 号） | N / N·m | 几何 ✅（节点号会正确映射）· FEM ✅ |
| 支座沉降 / 强迫位移 | `Cdisp` | `gnids` | m / mm | 几何 ✅ · FEM ✅ |
| **自重 / 惯性力** | `Emload` | `geids` 构件号/单元号，**留空=全局** | ★ 加速度 9.81 / **9810** | 几何 ✅ · FEM ✅ |
| 梁（线）上均布/集中/梯形 | `Elload` | `geids` | N/m | 几何 ✅（构件号）· FEM ✅（单元号） |
| 板壳面压（风/雪/楼面） | `Esload` | `geids` | N/m² | 几何 ✅ · FEM ✅ |
| 板边线荷载 | `Eslload` | ★ **`esides`** = `[[单元号, 边号], ...]` | N/m | **仅 FEM**（需单元号+边号） |
| 体力（重力外的体积力） | `Ebload` | `geids` | N/m³ | 几何 ✅ · FEM ✅ |
| 体表面压力 | `Ebsload` | ★ **`esides`** = `[[单元号, 面号], ...]` | N/m² | **仅 FEM** |
| 静水压力（水池/坝/仓内物料） | `Wpload` | ★ **`esides`** | Pa | **仅 FEM** |
| 动力波（地震动输入） | `Wload` | `gnids` | 按 `wType` | 建议 **FEM**（节点号虽会映射，但时程分析本就在 FEM 侧装配） |
| 全场节点温度 | `Ctem` | `gnids` | **标量值**（℃） | 几何 ✅ · FEM ✅ |
| 单元温度 | `Etem` | `geids` | ℃ | 几何 ✅ · FEM ✅（★ 全位置传参） |
| 温度梯度（梁/壳） | `EtemGrads` | `geids` | ℃ | 几何 ✅ · FEM ✅ |
| 管内外压 | `PipeLoad` | `geids`（仅圆管截面构件/单元） | Pa | 几何 ✅（圆管构件）· FEM ✅ |
| 杆索初拉力 | `ElemPrestressLoad` | `geids` | 按 `type` | 几何 ✅ · FEM ✅ |
| 预应力 / 初应变（分析对象） | `PreStress` | `geids` | Pa | FEM（挂 `Analy(preStresses=[...])`；需几何非线性才起作用） |

### 实测签名（pypcae 2.1.0；★ = 与手册/直觉不同处）

```python
> ⛔ **2026-10-22 实机更正（四种"节点类"荷载的「多值」语义实测）**：**一条记录只给一个分量；逐点/逐单元不同值一律逐条写**
>
> | 荷载类 | 一条记录里给多个值会怎样 | 实测 |
> |---|---|---|
> | `Cload` | **每个节点吃 Σvalues** | `gnids=[2 节点], dof=[Fx,Fx], value=[1000,1000]` ⇒ 该节点实受 **2000 N**；`[1000,500]` ⇒ **1500 N**（n 个节点配 n 个值 ⇒ 放大 n 倍） |
> | `Cdisp` | **同 `Cload`：每个节点吃 Σvalues** | `Cdisp(gnids=[2 节点], dof=[Ux,Ux], value=[1e-3,3e-3])` ⇒ **两节点 ux 均 4.000e-3**（=Σ） |
> | `Ctem` | **只接受标量；给列表 ⇒ `sep-modelcheck` 崩溃 `0xc0000409`**（★ 2026-10-28 复测仍如此，且不产生 compute 目录） | 标量 ✓（整杆 100 ⇒ **1.200e-3**，偏差 0.0000%）；`value=[100,0]` ✗ 崩溃 |
> | `Etem` | **列表只有第一个值生效**（应用到全部列出单元） | `Etem([e2,e3],[100,50])` ⇒ 两单元都按 **100** 算（逐单元不同温度须逐条写） |
>
> ✅ **安全写法**：`Cload(gnids=[一串节点], dof=[Fx], value=[1000])` / `Cdisp(gnids=[一串节点], dof=[Ux], value=[-0.01])` /
> `Ctem(gnids=[一串节点], value=100.0)` / `Etem([一个单元], [温度])`（逐单元循环）。
> 无 Σ 风险的荷载：`Elload`/`Esload`（分布型）、`Emload`（加速度）、`Ebsload`/`Wpload`（标量面压）。
> 详见 `references/stru/known_issues.md` #140/#142（另一技能 #134/#136）。
Cload(gnids=None, dof=None, value=None, timeHist=None)     # 节点力/力矩；★ timeHist: list[list[float]]，N 行 × 2 列（[t, 荷载系数]）
Cdisp(gnids=None, dof=None, value=None)                    # 强迫位移；★ dof 不适用 All/Uxyz
Emload(geids=None, value=0, type=0, dir=None, orgin=None)  # ★ 形参拼写是 orgin（不是 origin）
Elload(geids=None, type=1, subType=0, value=None, iCoord=0, coord=None, dir=None)
Esload(geids=None, type=1, subType=0, value=None, iCoord=0, coord=None, dir=None)
Ebload(geids=None, value=0.0, iCoord=0, dir=None)
Eslload(esides=None, type=1, subType=0, value=None, iCoord=0, coord=None, dir=None)
Ebsload(esides=None, value=0.0, iCoord=0, dir=None)
Wpload(esides=None, type=0, value=0, h0=0, h=0)            # 静水压力：value 参考点水压、h0 液面坐标、h 参考点坐标
Wload(gnids=None, wType=0, iType=0, value=0, timeHist=None, dir=None)   # 动力波
Ctem(gnids=None, value=0.0, timeHist=None)                 # 全场/节点温度；★ value 是**标量温度值**；timeHist: list[list[float]]，N 行 × 2 列
Etem(geids=None, tem=None)                                 # ★ 必须全位置：Etem(eids, 25.0)
EtemGrads(geids=None, iType=1, tem=None)
PipeLoad(geids=None, type=0, value=None)
ElemPrestressLoad(geids=None, type=0, value=0.0)           # 与 PreStress 同签名（两个名字都在）
PreStress(geids=None, type=0, value=0.0)
InitialVelo(gnids=None, velo=0)                            # 初速度（仅动力；签名标注 float，实际按 [vx,vy,vz] 传）
LoadCase(name='')                                          # 工况容器，.add(荷载对象)
```

枚举实测成员：`LoadDistributionType`: `Concentrated / Uniform / Nonuniform / BodyForce`；
`LoadSubType`: `Force / Moment`；`WaveType`: `Acceleration / Velocity / Displacement`；
`WaveActionType`: `Boundary`（位移加载）/ `Force`（等效惯性力）；
`WaterPressureType`: `SolidSurface / ShellSurface`；
`EtemType`: `BeamTempGrads / ShellTempGrads / TempLoad`；
`PreStressType`: `Stress / Strain`；`FDof`: `Fx Fy Fz Mx My Mz`；`Dof`: `Ux Uy Uz Uxyz Phx Phy Phz All`。
★ 手册附录列的 `LoadType` 在 2.1.0 **不存在**（`NameError`）——别照手册枚举名当类名/参数值用。

**`dir` 是方向矢量，不是自由度名**：竖向向下 `dir=[0, 0, -1]`；`iCoord=CSYS.GlobalSystem`（或局部坐标系号）。
**`esides` 是"单元号 + 面号/边号"的成对列表**：`[[eid, side], ...]`（面号/边号规则见手册附录
「单元面编号规则」；体单元用 `nids` 让程序自动识别面号会 `IndexError` 崩溃，必须显式给 `side`）。

`LoadCase` 实例的荷载**按类型分属性存放**（实测 `dir()`）：
`cloads / cdisps / ctems / emloads / elloads / esloads / eslloads / ebsloads / ebloads /
etems / etemgrads / pipeloads / wloads / wploads / vibloads / moveloads / tendonloads /
epreloads / creeploads / trainloads`。
★ **没有 `.loads` 这个属性**——想核对荷载要看对应类型的列表（`lc.emloads` 等）。

### ★ 时程荷载 `timeHist`（2026-10-23 版手册新增：`Cload` 节点力 + `Ctem` 节点温度）

**手册新增（2026-10-23 版）**：`Cload` 与 `Ctem` 各增一个 `timeHist` 形参 —— 手册原文：
「`timeHist` 为时程荷载数据表，**第一维为采样点数，第二维长度为 2，分别记录时间和系数**」
（`Cload` 是**荷载系数**、`Ctem` 是**温度系数**）；`Wload.timeHist` 的说明同步细化为
「第一维为采样点数、第二维长度为 2，分别记录**时间和波幅**」。

```python
# 节点力时程：实际荷载 = value × 荷载系数(t)
lc_th = LoadCase("TH")
lc_th.add(Cload(gnids=[n.id], dof=[FDof.Fx], value=[1000.0],
                timeHist=[[0.0, 0.0], [0.5, 1.0], [1.0, 0.0]]))   # 0→1→0（系数列按峰值归一）
# 节点温度时程：实际温度 = value × 温度系数(t)（材料须填 expansion，否则温度应力恒为 0）
lc_th.add(Ctem(gnids=[n.id], value=100.0,
               timeHist=[[0.0, 0.0], [0.5, 1.0], [1.0, 0.0]]))
```

- **⚠️ 形状红线（`Cload`/`Ctem`/`Wload` 通用，2026-10-28 本机复核）**：`timeHist` 必须是 **N 行 × 2 列**
  （第一维 = 采样点数、第二维恰好 2 列：`[时间, 系数]`）。写成**把时间与系数分成两行的 2×N 形状不报错、静默得到全 0 响应**
  （实测 10 帧 ux 全为 0），比报错更危险 ⇒ 写完自查「行数 = 采样点数、每行长度 = 2」。
- **`Ctem.value` 是标量温度值（float），不是数组**；时程信息**只能**通过 `timeHist` 表达。
  实测：标量 `value=100.0` 整杆 ⇒ `ux = 1.200e-3 m`（对标 `α·ΔT·L`，偏差 **0.0000%**）；
  `value=[100,0]` ⇒ `sep-modelcheck` 崩溃 `0xc0000409`、**不产生 `genfea-compute-*` 目录**。
  ★ 2026-10-28 复核数据：N×2 写法 10 帧 `ux` = 0.240 / 0.479 / 0.719 / 0.959 / **1.198** / 0.959 / 0.720 / 0.480 / 0.241 / 0.000（×1e-3 m），
  与 0→1→0 系数曲线逐帧吻合；同一模型换成 2×N 写法 ⇒ 10 帧全 0。
- **`timeHist` 是二维表**（第一维 = 采样点数；第二维长度 2：`[t, 系数]`）—— 与 `Wload.timeHist`、
  连接器 `dampCoefs`/`elastics`/`plastics` 同形状；⛔ **不要写扁平一维表**（扁平表在连接器阻尼上已实测
  会导致 `sep-modelcheck` 崩溃 `0xc0000409`，见 `interactions.md` §5）。
- **系数列是「归一化系数」，幅值由 `value` 缩放**（与 `Wload` 同口径：不要重复把幅值乘进系数列）。
- **时间列必须覆盖分析时长**（`AnalySetting.sTime`）；生成时间列用 `round(t, 6)` 或整数除法，
  避免 `i*dt` 的浮点长尾。
- ✅ **必须配时程/动力分析**（`AnalySetting(anaType=AnaType.IMPLICIT, iType=ImpAnaMethod.Direct, sTime=…, stepLen=…)`，
  或显式动力）—— 静力分析下"系数随时间变化"没有承载它的时间轴（2026-10-26 实测：隐式直接积分下系数按曲线精确生效）。
- ✅ **2026-10-26 实机验证通过**（构建 PkpmCAE v2026.10.1.14_4 / pypcae 2.2.0；`references/stru/known_issues.md` #147/#149）：
  ① **运行时签名与手册一致**（`inspect.signature` 实测）：`Cload(gnids, dof, value, timeHist: Union[List[List[Any]], None] = None)`、
  `Ctem(gnids, value, timeHist=…)`、`Wload(…, timeHist=…, dir=…)`；
  ② **二维表原样读回**：`timeHist = [[0, 0], [0.5, 1], [1, 0]]`；
  ③ **端到端（隐式直接积分 1 s / 步长 0.01 s、`OutImDyna` 输出 10 帧）响应严格按系数曲线缩放** ——
  | 时刻 t | 0.1 | 0.2 | 0.3 | 0.4 | **0.5** | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | 系数曲线 | 0.2 | 0.4 | 0.6 | 0.8 | **1.0** | 0.8 | 0.6 | 0.4 | 0.2 | 0.0 |
  | 节点力 `ux/峰值` | 0.200 | 0.400 | 0.600 | 0.800 | **1.000** | 0.800 | 0.599 | 0.399 | 0.199 | −0.000 |
  | 节点温度 `ux/峰值` | 0.200 | 0.400 | 0.600 | 0.800 | **1.000** | 0.800 | 0.599 | 0.399 | 0.199 | −0.000 |
  —— **逐帧吻合到 3 位小数**；节点温度峰值 `1.200120e-3 m` 对标自由膨胀 `α·ΔT·L = 1.2e-5×100×1.0 = 1.200000e-3 m` ⇒ **偏差 +0.0100%**。
- ⚠️ **实测踩到的坑**：`AnaDampType` **没有 `Off` 成员**（只有 `RatioToMass`/`RatioToProportional`/`Rayleigh`），
  写 `iDampType=AnaDampType.Off` 会在**脚本运行期**抛 `AttributeError`（`exit status 1`，不在 modelcheck 暴露）；
  不要阻尼就写 `iDampType=AnaDampType.RatioToMass, dampRatio=0.0`，或干脆省略 `iDampType`。

### 荷载随网格划分的传递（★ 2026-10-12 实测，此前是 ERRATA 第 2 区未验证项）

结论：**几何阶段布置的 `LoadCase` 与荷载会完整随 `submitAndMesh()` 带入有限元模型，且构件号自动展开为单元号。**

| 项 | 几何阶段写入 | `fromViewer()` 之后读回 |
|---|---|---|
| 工况 | `LoadCase("DL"/"LL"/"PL")` | 名称与顺序完整保留：`['DL','LL','PL']` |
| 自重 `Emload` | `geids=[l1.id, l2.id]`（2 个**构件号**）、`value=9.81`、`dir=[0,0,-1]` | `{'geids': [0..11], 'value': 9.81, 'dir': [0.0,0.0,-1.0], 'type': 0, 'coord': [], 'disable': False}` ← **12 个单元号** |
| 线荷载 `Elload`（传 `Elset` 号） | `geids=[es.id]` → 序列化为 **`[-2]`**（负号 = 集合引用） | `{'geids': [0], 'value': [5000.0], 'type': 1, 'subType': 0, 'iCoord': 0, 'coord': [], 'dir': [...]}`；`Elset` 也同步变成 `beam_set(elem)`（12 个单元） |
| 节点力 `Cload` | `Cload(gnids=[n2.id], dof=[FDof.Fz], value=[-10000.0])` | `{'gnids': [1], 'dofs': [3], 'values': [-10000.0], 'iCoord': 0, 'phase': 0.0, 'timeHist': [], 'disable': False}` ← ★ 键名变成复数 **`dofs`/`values`**，节点号已重编 |
| 落盘证据 | — | 网格阶段 femesh 就写出了 `pcaestru-mesh/51_NodeLoad.inp`、`52_ElemLoad.inp`（无荷载时日志会打印"**Warning:结构中没有荷载，不输出荷载工况组合系数**"） |

★ **节点号/单元号的映射规则（实测，很重要）**：网格划分**保留几何阶段的原始节点编号**，
新增的网格节点在其后追加编号。实测 6 m 梁分 2 段（几何节点 0/1/2 在 x=0/3/6），`basicSize=1.0`
划分后 `Node.all()` = `[(0,0.0), (1,3.0), (2,6.0), (3,1.0), (4,2.0), (5,4.0), (6,5.0)]`——
原几何节点号与坐标一一对应不变，新节点从 3 起；几何阶段的 `Cload(gnids=[1])` 网格后仍准确落在
x=3.0 的节点上，`Nset` 同样正确映射（`mid_node → [1]`）。
> 结论：几何阶段按**节点号**布的 `Cload`/`Cdisp`/`Ctem`/`Fixed`/`Nset` 会正确落到同一物理点；
> 但**新增节点的编号不可预知**，所以有限元阶段仍然必须用 `Node.all()`/`Element.all()` +
> 坐标或 `dimension` 重新筛（不要沿用几何阶段的变量），也不要把"编号恰好没变"当成规律来依赖。

★ **两条必须记住的读回规则**：
1. `fromViewer()` 之后，`LoadCase` 里的荷载是 **`dict`**（不是原来的类实例）——
   `lc.emloads[0]['geids']` 可以，`lc.emloads[0].geids` 会 `AttributeError`；
2. **构造参数名 ≠ 读回键名**：`Cload(dof=, value=)` → 读回是 `dofs` / `values`。

### ★ 2026-10-22 实机补充：几何阶段**只对「线/梁构件集合」**布 `Elload` 才跑得通（`docs/ERRATA.md` #129）

同一圆柱壳几何、五组对照实测：

| 组 | 荷载情况 | 结果 |
|---|---|---|
| A | 无荷载 | ✅ 网格成功（14 周向分段 / 84 壳单元） |
| C | 建了「壳 + 梁混装」`Elset`，**不布载** | ✅ 网格成功（集合正常展开：面单元 27~90 + 线单元 1~6） |
| E | **梁构件集合** + `Elload(Uniform, Force)` | ✅ 网格成功（12 梁单元，`52_ElemLoad.inp` 有记录，印证上节） |
| D | **壳构件集合** + `Elload(Uniform, Force)` | ❌ `femesh` 报 `整理StruData.txt数据信息有错`（`-6`）、`exit status 0xfffffffa` |
| B | **壳 + 梁混装集合** + `Elload` | ❌ 同上 |

⇒ **三条口径**：① `Elset` 里同时装面构件与线构件**合法**（网格阶段正常展开，见上表 C 组）；
② 但**几何阶段对面/壳构件（或含面构件的集合）布 `Elload` 目前跑不通** ⇒ 面构件的荷载请**改到 FEM 阶段**按网格
单元号施加（见本文「节点级面压模板」），或改用面专用的 `Wpload`（壳面静水压力）；③ 报错时 `run_script` 的 `msg`
仍可能只给 `:sep-processor`（#80），定位一律读 `pserver.log` 尾部；④ ⚠️ 根因未定位（是否与「面荷载需要面号/side」
有关未验证）——遇同类报错先按上表缩小范围。

### 其它路线差异（与有限元侧同源，但取值口径不同）

| 主题 | 有限元模型 | 结构（几何）模型 |
|---|---|---|
| `geids` | 单元号 | **构件号**，也可传 `Elset` 集合号（序列化为负号） |
| 非均布荷载 `coord` | 位置 = **距离** | 位置 = **百分比** |
| `PipeLoad` | 仅圆管**单元** | 仅圆管截面**构件** |
| 自重 `Emload.value` | 加速度：SI 用 9.81 | 同左，但 **mm-t 制用 9810** |
| `VSABoundary` 人工边界 | 支持 | **不支持**（仅有限元） |
| 相互作用/接触 | 支持 | **不支持**（只认节点号/单元号，见 `interactions.md`） |

### ★ Wpload 壳面静水压力实施要点（2026-10-15 实测，新增模板）

`Wpload` **仅有限元阶段**可用；壳面静水压力的完整写法：

```python
Wpload(esides=(eids, sides),                       # ★ 元组：(单元号列表, 面号列表)，二者一一对应
       type=WaterPressureType.ShellSurface,        # 壳面；体单元用 SolidSurface
       value=GAMMA * (H0 - H_BOT),                 # 参考点水压力值
       h0=H0,                                      # 液面坐标（z）
       h=H_BOT)                                    # 参考点坐标（z）
# 压力分布 p(z) = value * (h0 - z) / (h0 - h)
# 取 h = 最低浸湿点、value = gamma*(h0-h) ⇒ 即标准静水压力分布
```

**★ 面号（`side`）指向约定——与直觉相反，务必按实测口径并做方向校核**：

| 赋值口径 | 实测结果 |
|---|---|
| "形心沿单元法向偏移 10 mm 落点在**流体内部** → `side=1`" | ✗ 仓壁径向位移**向内**（方向错误） |
| **"流体内部 → `side=2`"**（★ 翻转后） | ✓ 仓壁径向位移**向外**（正确） |

⇒ 手册附录「面单元面号」给的是**节点序**（四节点单元 Face1 = `1-2-3-4`、Face2 = `4-3-2-1`）。

★★ **2026-10-28 定量复核（补齐"不能凭直觉"这一半，见 fem #153）**——在**实体单元表面**上做单块逐面加载实测：

- **面号 = 手册附录节点组合表**（8 节点六面体 F1=`4-3-2-1`…F6=`4-1-5-8`），四面体/五面体另有表；
- **压力方向 = 该面的内法向（压向结构内部）**，与节点绕序无关 —— 逐面加载 1000 Pa，反力合力方向分别为
  `Rz=−2000`(底) / `Ry=−2000`(y=0) / `Ry=+2000`(y=1) / `Rx=+1000`(x=2)，全部指向"压入体内"；
- **`p(z) = value·(h0−z)/(h0−h)` 已被逐位证实**：面积 1 m²、高 1 m 的竖直面，
  `(value,h0,h)=(1000,1,0)/(1000,2,0)/(1000,2,1)` ⇒ ΣRx 实测 `500.00 / 750.00 / 1500.00`，与解析积分完全一致；
  要"均匀水压"取 `h0` 远大于结构高度（`h0=1e6` 实测 ΣR = `value×A`）；`h0=h` 会 `0/0`。

★ **手册口径（最新版已细化，见 `references/stru/known_issues.md` #163）**：「`value` 为参考点水压力值，
**如果作用对象为体表面，静水压力指向体内部**」——与实体逐面实测一致；
**面（壳）表面改为按"选正面 / 选反面"区分**（`WaterPressureType.ShellSurface`）：
· 选**正面**（Face 1，节点顺序 `1-2-3-4`）⇒ 压力方向 = **面法向的反向**；
· 选**反面**（Face 2，节点顺序反序 `4-3-2-1`）⇒ 压力方向 = **面法向的正向**。
⇒ 与本节的壳面实测**完全吻合**：仓内流体在 `side=2`（反面）时仓壁径向位移**向外**（= 沿法向正向），
而 `side=1`（正面）时位移**向内**（= 法向反向）——这两组实测正是"正面/反面"规则的反向验证。

⇒ 面号选择仍要按上面两张口径（壳面"流体侧"实测 + 实体面"节点组合表"）确认，**方向不必再靠猜**；
壳面"哪一面朝向流体"仍建议按本节校核法（受压面一圈节点平均径向位移符号）在小模型上过一遍。
**校核手段（存在性/方向核对，不做定量比对）**：单工况步下**受压面一圈节点的平均径向位移符号**
应与内压/外压指向一致（内压 → 向外为正）。

**★ 湿面单元筛选必须逐节点判定**（不能用形心 + 容差）：

- 判据：**单元的全部节点**是否都落在湿面上（容差 1e-6）；
- 原因：用形心会因**曲壳弦效应**漏选——形心相对中面内偏 `r*(1-cos(pi/n))`（n 为周向分段数）。
  实测三次迭代 `58 → 2266 → 2290` 个单元才覆盖全部浸湿面（前两次都是漏选）；
- 同理：**锥斗下口周向分段数由网格器自定**（实测 10 段），弦矢高可达 ~0.05 m ⇒
  任何基于形心的几何判据容差必须大于该值，或直接改逐节点判定（见 `mesh.md` §9）。

### ★ 节点级面压模板（替代"周向扇区均布面压"近似，2026-10-15 实测）

网格后 `Element` 可读 `nids`（见 `shared_api.md`「节点与单元」属性清单），因此可在 FEM 阶段实现
**节点级精确面压**：单元面积（四边形拆两三角形）按节点均分得**受荷面积 `A_trib`**，
逐节点施加 `p(z)·A_trib` 的矢量力（`Cload` 三条：Fx/Fy/Fz）。

**优点（对比扇区近似）**：无带内平均误差、无扇区方向误差，且**与整圆面建模兼容**
（整圆回转面模型见 `stru_model.md` §5，不再需要周向分扇区）。

```python
# 伪代码骨架（在 Agent 侧算好数值后写进脚本；★ 脚本内禁止 import numpy，见 script_standard.md 铁律）
for e in wet_elems:                       # 逐单元
    A = quad_area(node_pos[e.nids])       # 四边形拆两三角形求面积
    for nid in e.nids:
        A_trib[nid] += A / len(e.nids)    # 面积按节点均分
for nid, A in A_trib.items():             # 逐节点施加 p(z)*A 的径向矢量力
    p = p_h(z_of[nid])                    # 侧压按标高取值（如 Janssen / 静水）
    ux, uy = radial_unit(x_of[nid], y_of[nid])
    Cload(gnids=[nid], dof=[FDof.Fx], value=p*A*ux)
    Cload(gnids=[nid], dof=[FDof.Fy], value=p*A*uy)
    Cload(gnids=[nid], dof=[FDof.Fz], value=p_v*A)      # 竖压分量（含摩阻 mu*p_h）
```

> 端到端实测示例：`../examples/mixed/silo_wholecircle_boxrib_wp.py`
> （D18×H30 整圆回转面筒仓 + 闭合矩形环撑 + Janssen 储料压力节点级施加 + 静水压力 `Wpload`）。
> **自查**：`51_NodeLoad.inp` 可直接读出每个工况施加的节点号/自由度/数值
> （比只看日志更硬，见 `verification.md`「荷载确实写对的存在性核对」）。

## 代码模板

### 模板 1：几何阶段布荷载（推荐，构件号 + `Elset` 分组）

```python
clc(); MatDB.load(); setting = Setting()
# ... 材料 / 截面 / 构件 ...
shell_set = Elset(name="hopper", ids=hopper_surf_ids)      # 按部位打包，便于整组加载
Fixed(gnids=[n.id for n in bottom_nodes], dof=[Dof.All])

lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_comp_ids, value=9.81, dir=[0, 0, -1]))   # 自重；geids 留空 = 全局

lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=[beam_set.id], type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[5000.0],          # N/m（SI）
                 iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))
lc_pl = LoadCase("PL")
lc_pl.add(Cload(gnids=[n_top.id], dof=[FDof.Fz], value=[-10000.0]))  # 节点力

MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")  # ★ 网格设置在 toViewer 之前
StruModel.toViewer(); StruModel.submitAndMesh()
```

### 模板 2：混合路线 —— 几何阶段布一部分，有限元阶段补一部分并核对

```python
init_ctx(mode=ExecutionMode.MIXED); clc()
# —— 几何阶段：自重按构件号布（会随网格自动映射）——
lc_dl = LoadCase("DL"); lc_dl.add(Emload(value=9.81, dir=[0, 0, -1]))   # geids 留空 = 全局
MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")
StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# —— 有限元阶段：先核对带过来的东西，再补新荷载 ——
lcs = {c.name: c for c in LoadCase.all()}                 # 实测 ['DL'] 已带入
assert len(lcs["DL"].emloads) == 1                        # dict 形式，别用 .loads
eids = [e.id for e in Element.all() if e.dimension == 1]
lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=eids, type=LoadDistributionType.Uniform, subType=LoadSubType.Force,
                 value=[20000.0], iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))
# 装配与任务指派见 analysis.md（★ 必须 Job + JobManager，否则结果全 0）
```

## 最佳实践

1. **DL / LL / WL / TEM 各自独立 `LoadCase`，禁止混装**——后续要看各荷载单独效应、要做组合都靠它；
2. 几何阶段优先按**构件号 / `Elset`** 布荷载（跟着几何走，网格改了也不用重定位）；
   只有"必须精确落在某些网格单元/节点上"的荷载才放到 `fromViewer()` 之后；
3. **自重 `Emload.value` 是加速度**，随单位制：SI 9.81、mm-t 制 **9810**；`density` 本身不产生重力；
4. `geids` 留空 = 全局（自重常用）；给 `Elset` 号时注意读回是**负号集合引用**；
5. 温度荷载前先给材料填 `expansion`，否则温度应力恒为 0；`Etem` 必须**全位置** `Etem(eids, 25.0)`；
6. 非均布荷载在构件侧 `coord` 是**百分比**（有限元侧是距离），照抄旧脚本前先看路线；
7. 强迫位移 `Cdisp` 与 `Fixed` **不要同时给同一自由度**（会报"位移加载不能施加在固定约束节点"）；
8. 布完荷载必做**平衡复核**：`o62_ReactionForce.out` 的 ΣRz 应 = 总竖向荷载
   （自重工况用 ρ × **网格体积** × g，不是理论几何体积——见 `verification.md`）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `lc.loads` 报 `AttributeError` / 恒为空列表 | ★ `LoadCase` 没有 `.loads`；荷载按类型分属性存放 | 用 `lc.emloads` / `lc.elloads` / `lc.cloads` … |
| `fromViewer()` 之后 `lc.emloads[0].geids` 报 `'dict' object has no attribute` | 读回的荷载是 dict | 改 `lc.emloads[0]['geids']` |
| `Cload` 读回没有 `dof`/`value` | 读回键名是复数 `dofs`/`values` | `d['dofs']`、`d['values']` |
| 日志"**Warning:结构中没有荷载**，不输出荷载工况组合系数" | 荷载没进模型（写在了 `fromViewer()` 之后但用了作废的构件号；或 `LoadCase` 没 `.add`） | 几何阶段用构件号；FEM 阶段用 `Element.all()` 重取的单元号；确认 `LoadCase.all()` 里有工况且 `emloads/elloads` 非空 |
| 自重算出来差 1000 倍 | mm-t 制里 `value` 写了 9.81 | mm-t 制用 **9810** |
| 温度应力恒 0 | 材料没填 `expansion` | 补热膨胀系数（钢 1.2e-5、混凝土 1.0e-5） |
| `Etem(geids=..., tem=...)` 崩溃 `0xc0000409` | 关键字传参 | 全位置 `Etem(eids, 25.0)` |
| `Emload(..., origin=[...])` 报 TypeError | ★ 形参拼写是 **`orgin`** | 按实测签名写，或省略（默认原点） |
| 构件号荷载网格后"跑了位置" | 构件号被自动映射为单元号是**正常**的；位置错通常是构件建错了 | 核对 `pcaestru-mesh/52_ElemLoad.inp` 的单元号与 `fe_modelSource.json` 的单元坐标 |

## 验证清单

- [ ] 每种物理荷载一个独立 `LoadCase`，且都进了某个 `Step`（混合路线含 `Step_ALL` 包络步）
- [ ] 荷载写在正确的阶段：构件号 → 几何阶段；单元/节点号 → `fromViewer()` 之后
- [ ] 自重 `value` 与单位制匹配（9.81 / 9810）；材料 `density` 已填
- [ ] 温度荷载前材料已填 `expansion`；`Etem` 全位置传参
- [ ] `fromViewer()` 之后用 `LoadCase.all()` + 分类属性（`emloads`/`elloads`/`cloads`）核对荷载已带入
- [ ] `pcaestru-mesh/51_NodeLoad.inp`、`52_ElemLoad.inp` 有数据（无荷载时 femesh 会打警告）
- [ ] 用 `timeHist` 做时程荷载时（`Cload`/`Ctem`/`Wload`）：**N 行 × 2 列**（行数=采样点数，每行 `[t, 系数]`；写成 2×N 会静默全 0）、时间覆盖 `sTime`、幅值只由 `value` 缩放，且分析类型是**动力/时程**；`Ctem.value` 必须是**标量**（不是 list）
- [ ] 求解后 ΣRz ≈ 总竖向荷载（比值 ≈1.000），ΣRx/ΣRy ≈ 0（对称结构）
