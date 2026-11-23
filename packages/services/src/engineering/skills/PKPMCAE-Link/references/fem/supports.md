# 支座 — 参考文档




## 概述

四类支座：固定支座 `Fixed`、弹性支座 `ElasSupport`、隔震支座 `IsolationBearing`、
人工边界 `VSABoundary`。约束不足是"zero pivot/矩阵奇异"的首因，写完约束先用 §验证清单 自查。

## 核心 API

### 固定支座 Fixed

```python
Fixed(gnids: list[int] = None, dof: list[int] = None, type: int = FixedType.Default)
```

- `gnids`：节点号列表；
- `dof`：`Dof.Ux/Uy/Uz/Phx/Phy/Phz/Uxyz/All`；
- `type`：本技能只用 `FixedType.Default`（点约束，`gnids` = 节点号）。
  （枚举中的 `BaseLine`/`BaseLineGeom` 为几何模型线约束，属 `pypcae-stru-modeling` 技能范围。）

### 弹性支座 ElasSupport

```python
ElasSupport(gnids=None, type: int = ElasSupportType.Lateral,
            kx: float = 0, ky: float = 0, kz: float = 0,
            vx: list[float] = None, vz: list[float] = None)
```

- `type`：`Soil`（土弹簧，单向侧移）/ `Lateral`（普通侧移）/ `Rotational`（转角）；
- `kx/ky/kz`：弹簧刚度；`vx`/`vz`：弹簧坐标系 x/z 轴方向余弦。

### 隔震支座 IsolationBearing

```python
IsolationBearing(gnids=None, type: int = IsolationBearingType.General)
# type: General / GeneralRubber / PlumbumRubber / DampingRubber / FrictionRubber / SlideRubber
```

### 人工边界 VSABoundary（仅有限元模型）

```python
# ★ 运行时签名（inspect.signature 实测 2026-10-28）；参数顺序与手册不同 —— 一律关键字传参
VSABoundary(alphaT=0.67, alphaN=1.33, geids=None, sides=None, R=-1, src=None, Rtype=0)
```

- `geids`/`sides`：实体单元号与其**表面号**（面号规则同 `Wpload`，见 `loads.md` 面号表）；
- `Rtype`：0 自动（按 `src` 波源位置算距离）/ 1 自定义（用 `R`）；`R=-1` = 自动。
- `alphaT`/`alphaN`：切向/法向粘弹性人工边界**修正系数**（默认 0.67 / 1.33）；其**适用工况属波动问题的
  工程判断**，脚本层不判定 —— 按项目地震动输入条件由工程师定。

★★ **实体表面运行态已实测（2026-10-28，`references/fem/known_issues.md` #152）**：
`1×1×1 m` 实体块（2×2 平面网格、4 个 8 节点单元），底面 `face 1` 施加 VSA、顶面加 1000 Pa：

- `sep-modelcheck` → `>>Info: 模型检查通过!`；求解 `success:true`、`genfea @complete`；
- 落盘 **`33_VSABoundary.inp`**（本技能落盘核对表原先**没有登记这个文件**）：

  ```
  *VSABoundary 1
  1 0.67 1.33 4        ← iNum, alphaT, alphaN, nElem（默认值原样写入）
  -1 0 0 0             ← R=-1（自动）、src(3)
  1 2 3 4              ← iElems
  1 1 1 1              ← iSurfs（面号）
  ```

- 同时 `40_GlobalAnaly.inp` 增设 `*VSABoundaryCtrl 0`（`VSAType`：**0 = 集中粘弹性人工边界 / 1 = 一致粘弹性人工边界**），
  脚本侧无对应形参 ⇒ **只能取默认的"集中"型**；
- 该模型**一个 `Fixed` 都没有**（`31_DofFixed.inp` = `*dofFixed 0`）仍能求解，位移量级 `1.5e-8 m`
  ⇒ VSA 自身提供刚度、静态下等价于很硬的支承（**dashpot 分支在静力中不贡献**，别拿静力位移评估边界效果）。
- ★ **显式动力下同样可运行（2026-10-28 补验，#158）**：`AnaType.EXPLICIT` + `ExAnaMethod.HalfStep`
  （软材料 `E0=1e7`/`ρ=1000`、`stepLen=1e-3`、`sTime=0.02`）⇒ `success:true`、四个阶段全 `@complete`、
  `33_VSABoundary.inp` 照常落盘、`31_DofFixed.inp` 仍为 `*dofFixed 0`（无任何 `Fixed` 也能算）。
  结果目录是 **`OutExDyna/`**。⚠️ 本次加载时窗内位移量级与"无 VSA 自由飞行"的对照模型几乎相同
  （`2.11e-4 m` vs `2.11e-4 m`）——这属**结果层面判断**（VSA 的效果取决于刚度/阻尼系数与波速、时窗），
  脚本层只确认"建上了、算完了"，**不得据此评价边界效果**。
- ⚠️ 仍属**未验证/工程判断**：`alphaT/alphaN` 取值的适用性、"仅支持有限元模型"（脚本层无法反向证明几何模型不支持）、
  显式动力下的稳定时间步与边界反射效果。

## 代码模板

### 模板 1：简支梁两端约束

```python
Fixed(gnids=[n_left.id],  dof=[Dof.Ux, Dof.Uy, Dof.Uz, Dof.Phx])   # 固定铰
Fixed(gnids=[n_right.id], dof=[Dof.Uy, Dof.Uz, Dof.Phx])           # 滑动铰（释放 Ux）
```

### 模板 2：框架柱脚固结

```python
Fixed(gnids=[n.id for n in base_nodes], dof=[Dof.All])
```

### 模板 3：桥墩底铰接（约束全部平动）

```python
Fixed(gnids=[n_pier_bot.id], dof=[Dof.Ux, Dof.Uy, Dof.Uz])
```

### 模板 4：弹性地基（侧移弹簧）

```python
ElasSupport(gnids=[n.id for n in raft_nodes],
            type=ElasSupportType.Lateral, kz=2.0e7)     # N/m，按基床系数换算
```

## 约束完备性速查

| 结构 | 必须 | 易漏 |
|------|------|------|
| 简支梁 | 一端 Ux+Uy+Uz+Phx；另端 Uy+Uz+Phx | Phx（防扭转刚体模态） |
| 连续梁/桥 | 每墩位竖向 Uz；一端给 Ux | 纵向约束全缺 → 刚体滑移 |
| 拱 | **拱脚 Ux** + Uz，宜加 Phx | 缺 Ux 必奇异（水平推力无约束） |
| 框架 | 柱脚 All 或平动+转动组合 | 只约束 Uz |
| 板壳 | 边界 Uz + 至少一点 Ux+Uy | 面内刚体平移 |
| 悬挑/悬臂 | 固定端 All | 固结端只给平动 |
| ★ **实体单元模型：轴压 / 竖向受力** | ① 底面**全部**节点 `Uz`；② 底面**形心一点** `Ux+Uy+Uz`；③ ★ 底面 `y=0`（或 `x=0`）边上**一个非形心节点**补 `Uy`（或 `Ux`） | **漏掉 ③** → `zero pivot`（见下节，#111） |
| ★ **实体单元模型："简支"** | 两端**只约束端面底边**（z=0）节点的 `Uz`；一端底边中点补 `Ux+Uy`、另一端补 `Uy` | **把整个端面约束 `Ux`** → 端部转角被抑制 → 该端**静默变成接近固端**（反力 62.4/37.6 而非 50/50） |
| ★ **`Coupling(Rigid)` 的悬空参考点** | 支承侧 `Fixed(dof=[Dof.All])`（**6 个自由度全约束**） | 只约束 3 个平动 → 3 个刚体转动无约束 → **反力全 0 的静默奇异解** |

### ★ 实体模型的最小约束：必须显式消除全部 6 个刚体自由度（2026-10-14 实测，#111）

**实体单元节点只有 3 个平动自由度**，**刚体转动只能靠"位移场分布"来拦**，不能靠约束某个点的转动。
典型漏项是**绕竖直轴（Z）的转动**：其位移场为 `u_x = −θ·y`、`u_y = θ·x`，
而**形心 / 轴线上点（x=y=0）绕 Z 转动位移恒为 0** ⇒ 约束形心的 `Ux,Uy` **拦不住它** ⇒ 总刚奇异：

```text
[ genfea ] ...线性方程求解：主对角元为零（zero pivot）...
[ genfea ] Pardiso:矩阵分解有错
[ genfea ] **Error:solveLinearEquaOne出错      exit status 0xffffff9c
```

**最小侵入配方（实测一次生效）**：

```python
Fixed(gnids=bot_uz_only, dof=[Dof.Uz])                   # 底面竖向支承，横向自由
Fixed(gnids=bot_antirot, dof=[Dof.Uz, Dof.Uy])           # ★ 抗绕 Z 转动：底面 y=0 边上一个"非形心"节点
Fixed(gnids=bot_center,  dof=[Dof.Ux, Dof.Uy, Dof.Uz])   # 形心：水平定位
```

只多加 **1 个节点的 1 个自由度**，**不抑制底面其余节点的横向泊松变形**。
实测 `neq` 由 14740 → **14739**（正好少 1），3 荷载步全收敛、无 warning。

**落盘核对** `31_DofFixed.inp`（掩码语义 **0=约束、1=放开**）：`1 79 1 1 0 1 1 1`（79 节点仅约束 Uz）、
`2 1 1 0 0 1 1 1`（1 节点约束 Uy+Uz，★ 抗转动点）、`3 1 0 0 0 1 1 1`（形心约束 Ux+Uy+Uz）；
`79+1+1 = 81 = 9×9` 底面节点，账目吻合。

**自查**：`nNode × 3 − neq` 应等于「约束自由度数 + 嵌入/耦合消除数」——
核账法详见 `error_diagnosis.md`「`neq` 差值核账法」（#110）。

> ⚠️ 三条"实体边界"坑要一起记：**约束过少**（本条，绕 Z 转动无约束 → `zero pivot`）、
> **约束过多**（整端面约束 `Ux` → 静默变固端）、**耦合参考点欠约束**（只约束平动 → 反力全 0）。
> 三者都属**静默缺陷**：`run_script` 可能仍返回成功、模型检查仍无 error。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| zero pivot / 刚度奇异 | 约束不足（刚体模态） | 按上表补齐；用模态分析跑 6 阶找刚体方向 |
| 拱计算发散/奇异 | 拱脚缺 Ux | 拱脚加 `Dof.Ux` |
| 反力为 0 | 约束加错节点（节点号不对/集合为空） | 回读脚本核对 gnids；用 Nset 管理 |
| 弹性支座无效果 | 刚度单位错（kN/m 当 N/m） | 核对单位制 |

## 验证清单

- [ ] 每个刚体自由度（3 平动 + 3 转动）都有约束路径
- [ ] 拱脚含 Ux；墩底含竖向约束
- [ ] 简支端释放了应释放的方向（不过约束）
- [ ] 约束施加在正确的节点/集合上（回读脚本核对）
- [ ] 弹性支座刚度单位与项目单位制一致
