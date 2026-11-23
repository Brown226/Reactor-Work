# 荷载 — 参考文档




## 概述

PyPCAE 共 15 种荷载类，统一经 `LoadCase("工况名").add(荷载)` 装载，
再由 `LoadCaseCombine(工况id, 系数)` 组合进 `Step`。工况拆分原则见
`script_standard.md`（DL/LL/WL/TEM 独立，禁止混装）。

## 选型速查

| 物理场景 | 荷载类 | 单位（SI） |
|---|---|---|
| 集中力/力矩 | `Cload` | N / N·m |
| 支座沉降/强迫位移 | `Cdisp` | m |
| 梁上均布/集中/梯形 | `Elload` | N/m |
| 板壳面压（风/雪/楼面） | `Esload` | N/m² |
| 板边线荷载 | `Eslload` | N/m |
| 体力（重力外的体积力） | `Ebload` | N/m³ |
| 体表面压力 | `Ebsload` | N/m² |
| 静水压力（水池/坝） | `Wpload` | Pa |
| 动力波（地震动输入） | `Wload` | 按 wType |
| 全场节点温度 | `Ctem` | **标量值**（℃） |
| **自重/惯性力** | `Emload` | m/s²（加速度） |
| 管内外压 | `PipeLoad` | Pa |
| 单元温度 | `Etem` | ℃ |
| 温度梯度（梁/壳） | `EtemGrads` | ℃ |
| 杆索初拉力 | `ElemPrestressLoad` | 按 type |

## 核心 API 与模板

### 工况容器与装配范式

```python
lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=[e.id for e in all_elems], value=9.81, dir=[0, 0, -1]))

lc_ll = LoadCase("LL")
lc_ll.add(Elload(geids=[e.id for e in beams], type=LoadDistributionType.Uniform,
                 subType=LoadSubType.Force, value=[20000.0], dir=[0, 0, -1]))

step_dl  = Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0))
step_ll  = Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0))
step_all = Step("Step_ALL")                    # 包络步：最不利组合
step_all.add(LoadCaseCombine(lc_dl.id, 1.0)).add(LoadCaseCombine(lc_ll.id, 1.0))

analy = Analy("StaticAnalysis")
analy.add(step_dl); analy.add(step_ll); analy.add(step_all)
```

### Cload 节点力/力矩

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
> 详见 `references/fem/known_issues.md` #140/#142（另一技能 #134/#136）。
Cload(gnids=None, dof=None, value=None, timeHist=None)   # ★ timeHist: list[list[float]]，N 行 × 2 列（[t, 荷载系数]）
Ctem(gnids=None, value=0.0, timeHist=None)               # ★ value 是**标量温度值**；timeHist 同为 N×2（[t, 温度系数]）
# dof: FDof.Fx/Fy/Fz/Mx/My/Mz；gnids 可传 Nset 集合号
lc.add(Cload(gnids=[n.id], dof=[FDof.Fz], value=[-10000.0]))
```

> ℹ️ 官方示例曾写作 `Cload(FDof.Fy, -1, node.id)`（与签名顺序不符），**2026-09-23 版手册已
> 修正为 `Cload(node.id, FDof.Fy, -1)`**。歧义虽已在源头消除，本库仍要求**关键字传参**
>（见 `references/fem/known_issues.md` #2）。

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
- ✅ **2026-10-26 实机验证通过**（构建 PkpmCAE v2026.10.1.14_4 / pypcae 2.2.0；`references/fem/known_issues.md` #141/#143）：
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

### Elload / Esload 分布荷载

```python
Elload(geids=None, type=LoadDistributionType.Uniform, subType=LoadSubType.Force,
       value=None, iCoord=CSYS.GlobalSystem, coord=None, dir=None)
Esload(...)   # 参数同 Elload，作用于面单元，value 单位 N/m²
```

- `type`：`Concentrated / Uniform / Nonuniform / BodyForce`
- `dir`：**方向矢量**（不是自由度名）：竖向向下 `dir=[0, 0, -1]`
- `coord`：非均布荷载位置描述（距离）

```python
lc.add(Elload(geids=beam_ids, type=LoadDistributionType.Uniform,
              subType=LoadSubType.Force, value=[30000.0], dir=[0, 0, -1]))
```

### Emload 自重（固定写法）

```python
lc_dl.add(Emload(geids=[e.id for e in all_elems], value=9.81, dir=[0, 0, -1]))
```

> `density` 不产生重力，自重必须靠 `Emload`；`geids` 为空 = 全局。
> **`value` 是加速度，随单位制**：SI(m) 用 `9.81`；mm 制用 `9810`。

### Cdisp 支座沉降

```python
Cdisp(gnids=[n.id], dof=[Dof.Uz], value=[-0.01])   # m；dof 不适用 All/Uxyz
```

### Wpload 静水压力（水池/坝）

```python
Wpload(esides=[(e.id, 2)], type=WaterPressureType.SolidSurface,
       value=20000.0, h0=2.0, h=0.0)
# esides = [(单元号, 面号), ...] —— 二元组列表（本轮实测用【元组】通过；
#          本技能另一处文档写作 [[单元号, 面号], ...]，两写法未做等价性对照，择一即可）
# value=参考点水压力(Pa)；h0=水面坐标；h=参考点（压力已知点）坐标
```

★ **面号与方向语义已实机核校（2026-10-28，`references/fem/known_issues.md` #151）** —— 单块 `2×1×1 m` 8 节点实体单元、
`x=0` 面全固定、逐面各加 1000 Pa，读 `o62_ReactionForce.out` 反力合力：

| 面号 | 手册面号表（8 节点六面体） | 该面（本模型） | 面积 | ΣR 实测 | ⇒ 荷载方向 |
|---|---|---|---|---|---|
| Face 1 | `4-3-2-1` | `z=0` 底 | 2 m² | `Rz=−2000` | **+z**（压入体内） |
| Face 2 | `5-6-7-8` | `z=1` 顶 | 2 m² | 未单测 | 推断 −z（未实测，按内法向规律） |
| Face 3 | `1-2-6-5` | `y=0` | 2 m² | `Ry=−2000` | **+y** |
| Face 4 | `2-3-7-6` | `x=2` | 1 m² | `Rx=+1000` | **−x** |
| Face 5 | `3-4-8-7` | `y=1` | 2 m² | `Ry=+2000` | **−y** |
| Face 6 | `4-1-5-8` | `x=0` | 1 m² | —（本次该面被固定，未单测） | +x |

⇒ 三条可依赖的口径：
1. **面号 = 手册附录《体单元面号》的节点组合**（8 节点六面体如上表；4/5/6 节点单元另有表）；
   面单元（壳）面号：`Face1 = 1-2-3-4`（按节点顺序）、`Face2 = 4-3-2-1`（反向）。
2. **压力方向 = 该面的内法向（压向结构内部）**，与节点绕序无关，不需要自己判断正负号。
   ★ **手册口径（最新版已细化，见 `references/fem/known_issues.md` #163）**：「`value` 为参考点水压力值，
   **如果作用对象为体表面，静水压力指向体内部**」——与上表实体逐面实测一致；
   **面（壳）表面另按"选正面 / 选反面"区分**（`WaterPressureType.ShellSurface`）：
   · 选**正面**（面单元 Face 1，节点顺序 `1-2-3-4`）⇒ 压力方向 = **面法向的反向**；
   · 选**反面**（面单元 Face 2，节点顺序反序 `4-3-2-1`）⇒ 压力方向 = **面法向的正向**。
   ⇒ 即"水在壳的哪一侧"直接用 **Face1/Face2** 表达，不必再反推法向；建完仍建议按本节方法做一次符号核对。
3. **数值规律 `p(z) = value · (h0 − z) / (h0 − h)`**（`h0`=水面坐标、`h`=参考点坐标、`z`=当前点坐标）。
   实测（面积 1 m²、高 1 m 的竖直面，沿高度积分得合力 = ΣRx）：

   | `value` | `h0` | `h` | 解析 `∫p dA` | 实测 ΣRx |
   |---|---|---|---|---|
   | 1000 | 1.0 | 0.0 | `1000(1−z)` → 500 N | **500.00** |
   | 1000 | 2.0 | 0.0 | `500(2−z)` → 750 N | **750.00** |
   | 1000 | 2.0 | 1.0 | `1000(2−z)` → 1500 N | **1500.00** |

   ⇒ **要"均匀水压"就取 `h0` 远大于结构高度**（如 `h0=1e6`，实测 ΣR = `value×A` 逐位吻合）；
   ⛔ 不要把 `h0` 与 `h` 传成同一个值（按上式出现 `0/0`）。
4. 落盘核对：`52_ElemLoad.inp` 里该记录 `iType=9`（水压力），`value`、`coord=[h0, h]`，
   `iCoords` 逐单元写面号（与脚本 `esides` 一一对应）。

### Etem / EtemGrads 温度

```python
lc_tem = LoadCase("TEM")
lc_tem.add(Etem(elem_ids, 25.0))                    # ⚠️ 全位置参数！关键字传参触发 0xc0000409
# 温度梯度：EtemGrads(geids=..., iType=EtemType.BeamTempGrads, tem=[...])
```

> **前置条件**：材料必须填 `expansion`，否则温度应力恒为 0。

> ⚠️ **Etem 是关键字传参铁律的例外**（同 `Tube`/`IShape`）：实测 `Etem(geids=..., tem=...)`
> 会触发原生层崩溃 `0xc0000409`，平台 save_script 校验直接拦截，必须 `Etem(elem_ids, 25.0)`。

### Wload 动力波（地震动）

```python
Wload(gnids=base_ids, wType=WaveType.Acceleration, iType=WaveActionType.Boundary,
      value=1.0, timeHist=[[t1, a1], [t2, a2], ...], dir=[1, 0, 0])
```

- `wType` 作用**类型**（加速度/速度/位移）；`iType` 作用**方式**（Boundary 位移加载 / Force 等效惯性力）；
- `value` 为峰值（加速度按单位制取 m/s² 或 mm/s²）；`timeHist` 第二列填**归一化值**——
  幅值只由 `value` 缩放，不要重复乘；
- 时间列必须覆盖 `AnalySetting` 的 `sTime`；用整数除法或 `round(t, 6)` 生成时间列，
  避免 `i*dt` 累积浮点长尾。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `0xc0000409` | Emload/Esload/Elload 用了纯位置参数 | 全改关键字传参 |
| 位移/内力全 0 | 荷载没 add 进 LoadCase / 工况没进 Step / 值为 0 | 沿装配链逐环检查 |
| 自重缺失 | 未用 Emload | 补 `Emload(value=9.81, dir=[0,0,-1])` |
| 温度应力恒 0 | 材料缺 expansion | 补热膨胀系数 |
| 面荷载方向错 | dir 当自由度名用了 | dir 是矢量，竖向向下 `[0,0,-1]` |
| 边线/体表面荷载位置错 | 面号/边号规则错 | 查《PyPCAE 手册》附录面号表 |
| 工况混乱 | 一个 LoadCase 混装多种性质荷载 | 按 DL/LL/WL/TEM 拆分 |

## 验证清单

- [ ] 每种物理荷载一个独立 LoadCase
- [ ] 每个 LoadCase 都进了某个 Step（且有 Step_ALL 包络步）
- [ ] 竖向荷载方向为 -Z（`FDof.Fz` 负值或 `dir=[0,0,-1]`）
- [ ] 自重用 Emload 且 geids 覆盖全部单元（或留空=全局）
- [ ] 温度荷载材料已填 expansion
- [ ] 荷载量级经常识核对（楼面 kN/m² 级、自重 9.81）
- [ ] 用 `timeHist` 做时程荷载时（`Cload`/`Ctem`/`Wload`）：**N 行 × 2 列**（行数=采样点数，每行 `[t, 系数]`；写成 2×N 会静默全 0）、时间覆盖 `sTime`、幅值只由 `value` 缩放，且分析类型是**动力/时程**；`Ctem.value` 必须是**标量**（不是 list）
