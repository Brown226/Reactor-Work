# 支座与约束（结构 / 混合路线） — 参考文档


## 概述

**覆盖范围**：`Fixed`（固定约束，含几何模型的**线约束**）、`ElasSupport`（弹性支座）、
`IsolationBearing`（隔震支座）、`VSABoundary`（人工边界）、`Cdisp`（强迫位移）；
以及"几何阶段布的约束能不能随网格带入有限元模型"的实测规则。
主从约束 `DofSlave` / 约束方程 `ConstrEqua` 见 `interactions.md`。

**何时使用**：任何要"约束住模型"的场合。**先看这张路线判定表**：

| 约束类型 | 几何阶段（`toViewer` 前） | 有限元阶段（`fromViewer` 后） | 备注 |
|---|---|---|---|
| `Fixed` 点约束 | ✅ 传节点号，**随网格带入** | ✅ 传节点号 | 最常用，两条路线都行 |
| `Fixed` 线约束 `BaseLine` | ✅ 传构成线的**点编号**（建筑结构构件） | — | 网格后自动展开成该线上的节点集合 |
| `Fixed` 线约束 `BaseLineGeom` | ✅ 传**线构件号**（通用几何模型） | — | 同上，实测自动展开 |
| `ElasSupport` 弹性支座 | ⚠ **实测不随网格带入** | ✅ 必须在这里建 | 弹簧/土弹簧支承一律放 FEM 阶段 |
| `IsolationBearing` 隔震支座 | ⚠ 同上（未实测，按同类处理） | ✅ | — |
| `VSABoundary` 人工边界 | ❌ 仅有限元模型支持 | ✅ | 波动/无限域问题；★ 实体表面运行态已实测（2026-10-28，见下 `core API` 后） |
| `Cdisp` 强迫位移 | 可建，但**不要与 `Fixed` 给同一自由度** | ✅ | 见常见错误 |

## 核心 API

实测签名（pypcae 2.1.0）：

```python
Fixed(gnids=None, dof=None, type=0)
ElasSupport(gnids=None, type=1, kx=0.0, ky=0.0, kz=0.0, vx=None, vz=None)
IsolationBearing(gnids=None, type=0)
VSABoundary(alphaT=0.67, alphaN=1.33, geids=None, sides=None, R=-1, src=None, Rtype=0)
Cdisp(gnids=None, dof=None, value=None)

> ★★ **`VSABoundary` 实体表面运行态实测（2026-10-28，与 fem #154 同源）**：`1×1×1 m` 实体块
> （4 个 8 节点单元）底面 `face 1` 施加 VSA、顶面 1000 Pa ⇒ modelcheck `>>Info: 模型检查通过!`、
> 求解 `success:true`、`genfea @complete`。落盘 **`33_VSABoundary.inp`**
> （`*VSABoundary 1` / `1 0.67 1.33 4`（默认系数原样写入）/ `-1 0 0 0`（`R=-1` 自动）/ 单元号 / 面号），
> 并在 `40_GlobalAnaly.inp` 增设 **`*VSABoundaryCtrl 0`**（0 集中 / 1 一致粘弹性人工边界；**脚本侧无形参 ⇒ 只能取"集中"型**）。
> ★ 该模型**一个 `Fixed` 都没有**（`31_DofFixed.inp` = `*dofFixed 0`）仍能求解、位移量级 `1.5e-8 m`
> ⇒ **静态下 VSA 等价很硬的支承，dashpot 分支不贡献**（别用静力位移评估边界效果）。
> ★ **显式动力下同样可运行（2026-10-28 补验，与 fem #158 同源）**：`EXPLICIT`+`HalfStep`（软材料、`stepLen=1e-3`、`sTime=0.02`）
> ⇒ `success:true`、`33_VSABoundary.inp` 落盘、`*dofFixed 0`（无 `Fixed` 也能算），结果在 **`OutExDyna/`**。
> ⚠️ 仍属工程判断：`alphaT(0.67)`/`alphaN(1.33)` 的适用工况；显式动力下的稳定时间步与边界反射效果（脚本层只确认"建上了、算完了"）。

> ⛔ **2026-10-22 实测**：`Cdisp`（强迫位移/支座沉降）与 `Cload` **同一构造形状、同一「多值」语义**——一条记录里的多个值会被**施加到 `gnids` 的每个节点并累加（Σ）**：`Cdisp(gnids=[2 节点], dof=[Ux,Ux], value=[1e-3, 3e-3])` ⇒ **两节点位移都是 4e-3**。⇒ 逐节点不同沉降必须**逐节点各写一条**（另见 `references/stru/known_issues.md` #142 / #136）。
```

| 参数 | 含义与规则（★ = 实测） |
|---|---|
| `Fixed.gnids` | 几何阶段 = **节点号**（点约束）或**线构件号 / 构成线的点编号**（线约束）；★ 网格后读回是**负号集合引用**（如 `[-3]` = 引用 `BaseNodeSet-1`） |
| `Fixed.dof` | `Dof.Ux/Uy/Uz/Phx/Phy/Phz`，或 `Dof.All`；★ 网格后读回是 **6 位掩码，`0`=约束、`1`=放开**（如 `[1,1,0,1,1,1]` 表示只约束 Uz） |
| `Fixed.type` | `FixedType.Default`（点约束）/ `BaseLine`（建筑结构线约束，传**点编号**）/ `BaseLineGeom`（通用几何线约束，传**线构件号**）；★ 网格后 `type` 一律变 `0`（已退化为点约束） |
| `ElasSupport.type` | `ElasSupportType.Soil`（土弹簧，单向侧移）/ `Lateral`（普通侧移弹簧，默认 1）/ `Rotational`（转角弹簧）——★ **没有 `Spring` 这个成员** |
| `ElasSupport.vx` / `vz` | 弹簧局部坐标系 **x / z 轴方向余弦**（需要斜向弹簧时给；不给则按总体系） |
| `IsolationBearing.type` | `IsolationBearingType`：`General`（默认 0）/ `GeneralRubber` / `PlumbumRubber`（铅芯）/ `DampingRubber`（阻尼）/ `FrictionRubber`（摩擦）/ `SlideRubber`（滑移）；具体参数在界面/属性里补，脚本只给类型 |
| `VSABoundary.geids` / `sides` | 人工边界所在的**单元号**与其**表面号**（面号规则见手册附录「体单元面号」）；`alphaT=0.67`/`alphaN=1.33` 切向/法向系数；`Rtype=0` 自动（按 `src` 波源位置算距离）/ `1` 自定义（用 `R`） |
| `Dof` 全部成员 | `Ux / Uy / Uz / Uxyz`（三平动组合）/ `Phx / Phy / Phz / All`；★ `Cdisp` 的 `dof` **不适用 `All`/`Uxyz`**，必须逐自由度给 |
| `ElasSupport.kx/ky/kz` | 三向弹簧刚度（单位随单位制：SI N/m，mm-t 制 N/mm）；`vx`/`vz` 方向向量（需要斜向弹簧时给） |
| `VSABoundary.geids/sides` | 人工边界所在**单元号**与**面号**；`alphaT/alphaN` 切向/法向人工边界系数 |
| `Cdisp.value` | 强迫位移值（**位移本身就是约束**，该自由度不要再给 `Fixed`） |

### 约束随网格传递的实测细节（2026-10-12，pypcae 2.1.0）

一个混合算例：几何阶段建 `Fixed(gnids=[n1.id], dof=[Dof.All])` +
`Fixed(gnids=[l2.id], dof=[Dof.Uz], type=FixedType.BaseLineGeom)`，`basicSize=0.5` 划分 6 m 梁（13 节点）。

| 读回项 | 结果 | 说明 |
|---|---|---|
| `Fixed.all()` 数量 | 2 组（两组都带过来了） | 点约束与线约束都传递 |
| 点约束 | `gnids=[-3]`、`dof=[0,0,0,0,0,0]`、`type=0` | `-3` = 引用 `BaseNodeSet-1`（1 个节点）；全 0 = 6 个自由度全约束 |
| 线约束 | `gnids=[-4]`、`dof=[1,1,0,1,1,1]`、`type=0` | `-4` = 引用 `BaseNodeSet-2`（**7 个节点** = 该线构件上的全部网格节点）；只有第 3 位是 0 = 只约束 Uz |
| `Nset.all()` | `[('beam_set(node)',13), ('BaseNodeSet-1',1), ('BaseNodeSet-2',7)]` | ★ 约束会自动派生 `BaseNodeSet-N` 节点集合；`Elset` 也派生 `xxx(elem)` / `xxx(node)` |
| `ElasSupport.all()` | `0` 个；`33_ElasSupport.inp` 数据段为空 | ★ **弹性支座没有随网格带入** |
| 落盘证据 | `31_DofFixed.inp`：`1 1 0 0 0 0 0 0` + `-2`（iNum、nNode、dofFixed 6 位、节点集合引用） | 可直接读 inp 核对 |

## 约束完备性速查（写完约束先自查这张表）

| 结构 | 必须约束 | 最易漏 |
|---|---|---|
| 简支梁（**梁单元**；实体模型见下"实体简支梁"行） | 一端 `Ux+Uy+Uz+Phx`；另一端 `Uy+Uz+Phx`（释放 `Ux`） | `Phx`（防扭转刚体模态） |
| 连续梁 / 桥 | 每个墩位竖向 `Uz`；**至少一端给 `Ux`** | 纵向约束全缺 → 刚体滑移 |
| 拱 | **拱脚 `Ux`** + `Uz`，宜加 `Phx` | 缺 `Ux` 必奇异（水平推力无约束） |
| 框架 | 柱脚 `Dof.All`，或平动+转动组合 | 只约束 `Uz` |
| 板壳 | 边界 `Uz` + **至少一点 `Ux+Uy`** | 面内刚体平移 |
| 悬臂 / 悬挑 | 固定端 `Dof.All` | 固结端只给平动 |
| 实体（球/坝/筒仓） | 底面或极区一组节点 `Dof.All`；对称面可用法向约束 | 只约束一个点 → 应力奇异 + 刚体转动 |
| ★ **实体轴压柱 / 竖向受力实体**（"理想铰接"边界） | ① 底面**全部**节点 `Uz`（竖向支承，横向自由）；② 底面**形心一点** `Ux+Uy+Uz`（防水平平移）；③ ★ 底面 `y=0`（或 `x=0`）边上**一个非形心节点**补 `Uy`（或 `Ux`）→ **消除绕 Z 刚体转动** | **漏掉 ③**：形心点 `x=y=0`，绕 Z 转动在该点**位移恒为 0**，约束形心的 `Ux,Uy` 拦不住它 → `zero pivot`（见下「实体最小约束」节） |
| ★ **实体简支梁**（`Solid` 矩形截面梁） | 两端**只约束端面底边**（z=0）节点的 `Uz`；左端底边中点补 `Ux+Uy`、右端底边中点补 `Uy`（实体节点**无转动自由度**，每个节点只约束一次） | **把整个端面约束 `Ux` → 端部转角被抑制 → 该端静默变成接近固端**：实测反力 62.4%/37.6%（≈5/8:3/8）、左端 −89358 N·m 自平衡水平力偶（ΣRx≈0、\|Rx\|max=48434 N），而日志与模型检查全部"成功"（`references/stru/known_issues.md` #70）。自查：左右端 ΣRz 是否 **50/50** + Σ(z−h/2)·Rx 是否为 **0**；见 `../examples/mixed/solid_beam_simply_supported.py` |

> 快速判据：跑一次**模态**，前 6 阶出现 ≈0 频率 ⇒ 存在刚体模态（约束不足），
> 看振型就知道缺哪个方向；静力则表现为 `zero pivot` / 矩阵奇异 / 位移异常大。
> 混合路线里约束写在几何阶段（`Fixed`）会随网格带入，写在有限元阶段则要按坐标重筛节点
> （网格保留几何阶段的原始节点编号、新增节点往后追加，见 `loads.md` 的映射规则实测）。

### ★ 实体模型的最小约束：必须显式消除全部 6 个刚体自由度（2026-10-14 实测）

**实体单元节点只有 3 个平动自由度**，**刚体转动只能靠"位移场分布"来拦**，不能靠约束某个点的转动。
典型漏项是**绕竖直轴（Z）的转动**：其位移场为 `u_x = −θ·y`、`u_y = θ·x`，
而**形心 / 轴线上点（x=y=0）绕 Z 转动位移恒为 0** ⇒ 约束形心的 `Ux,Uy` **拦不住它**。

后果（日志原文）：

```text
[ genfea ] 开始生成自由度信息...  nNode:5077
[ genfea ] 开始求解静力方程.....  neq:14740
[ genfea ] ...线性方程求解：主对角元为零（zero pivot）...
[ genfea ] Pardiso:矩阵分解有错
[ genfea ] **Error:solveLinearEquaOne出错
[ genfea ] exit status 0xffffff9c
```

**轴压 / 竖向受力实体模型的最小约束配方（实测一次生效）**：在底面 `y=0` 边上补 **1 个非形心节点**约束 `Uy`
（该点 `x ≠ 0`，绕 Z 转动时 `u_y = θ·x ≠ 0`）：

```python
bot_antirot = [nid for nid in bot_other
               if abs(node_pos[nid][1]) <= TOL
               and abs(node_pos[nid][0] - MESH_SIZE) <= TOL]   # 取 (MESH_SIZE, 0, 0)
bot_uz_only = [nid for nid in bot_other if nid not in bot_antirot]

Fixed(gnids=bot_uz_only, dof=[Dof.Uz])                   # 底面竖向支承，横向自由
Fixed(gnids=bot_antirot, dof=[Dof.Uz, Dof.Uy])           # ★ 抗绕 Z 转动
Fixed(gnids=bot_center,  dof=[Dof.Ux, Dof.Uy, Dof.Uz])   # 形心：水平定位
```

该配方只多加 **1 个节点的 1 个自由度**，**不抑制底面其余节点的横向泊松变形**，
是"理想轴压"边界的**最小侵入**实现。修复后 `neq` 由 14740 → **14739**（正好少 1 个自由度），
3 个荷载步全部收敛、无 warning。

**落盘核对** `31_DofFixed.inp`（掩码语义 **0=约束、1=放开**）：

```text
*dofFixed 3
1 79 1 1 0 1 1 1      → 79 个节点，仅约束 Uz
   <79 个节点号>
2 1 1 0 0 1 1 1       → 节点 468，约束 Uy + Uz（★ 抗转动点）
   468
3 1 0 0 0 1 1 1       → 节点 461，约束 Ux + Uy + Uz（形心点）
   461
```

`79 + 1 + 1 = 81 = 9×9` 底面节点，账目吻合。

**与既有两条记录的关系（三条合起来才是完整的"实体边界避坑"图景）**：

| 记录 | 讲的是 | 症状 |
|---|---|---|
| #70「实体简支不能约束整个端面」 | **约束过多** | 端部转角被抑制 → 静默变固端（反力 62.4/37.6） |
| #69「`Coupling(Rigid)` 主节点必须 `Dof.All`」 | **耦合参考点**（带 6 自由度） | 3 个刚体转动奇异 → 反力全 0 |
| **本节** | **实体自身的最小约束缺一个抗转动项** | `zero pivot` / `solveLinearEquaOne出错` |

**自查手段**：`nNode × 3 − neq` 应等于「约束自由度数 + 嵌入/耦合消除数」；
修复后 `neq` 的变化量应与新增约束数**逐个对上**（核账法详见 `error_diagnosis.md`「`neq` 差值核账法」）。

> ⚠️ **规则冲突消解**：修"约束奇异"**必然要增加约束**，与"改支座须先问用户"冲突时按
> `execution_contract.md` §6「规则冲突消解」执行——**交付缺陷优先、允许自动修，但必须最小侵入**
> （只补数学上必需的自由度，不改变用户已确认的力学意图），并写进重试台账 + 交付包「未决问题」请用户追认。

### ⚠️ `Fixed(type=FixedType.BaseLineGeom)` 传多条线只展开一条（2026-10-15 实测，静默缺陷）

实测：`Fixed(gnids=[24 条弧线 id], dof=[Dof.All], type=FixedType.BaseLineGeom)`
网格后 `31_DofFixed.inp` **只含 1 条弧线的 4 个节点**（`o62` 的 `nFix=4`）⇒ 约束严重不足、
位移达 **15 m 量级**，而 `run_script` 与模型检查**仍报成功**（与 #51/#52/#53/#69/#70 同类**静默缺陷**）。

**处置（二选一）**：
1. **线约束每条线一个 `Fixed` 组**（逐条建，不要一次传多条线 id）；
2. ★ **更稳（实测采用）**：在 **FEM 阶段按坐标重筛节点**做点约束——
   `Fixed(gnids=[n.id for n in Node.all() if <判据>], dof=[Dof.All])`，完全绕开线约束的展开限制。

**自查**：`31_DofFixed.inp` 的 `nNode` 计数 / `o62_ReactionForce.out` 的 `nFix` 是否与**预期固接圈节点数**相符；
位移出现**米级量级**先查这里（见 `verification.md` 第 0 层）。

## 代码模板

### 模板 1：几何阶段约束（纯几何路线 / 混合路线通用）

```python
# 点约束：底层柱脚全固定（建筑结构构件）
Fixed(gnids=[n.id for n in bottom_nodes], dof=[Dof.All])

# 线约束（通用几何模型）：把一条边线整体约束住 Uz —— 传线构件号
Fixed(gnids=[edge_line.id], dof=[Dof.Uz], type=FixedType.BaseLineGeom)

# 线约束（建筑结构构件）：传构成线的点编号
Fixed(gnids=[n_a.id, n_b.id], dof=[Dof.Uy, Dof.Uz], type=FixedType.BaseLine)
```

### 模板 2：混合路线 —— 几何阶段点约束 + FEM 阶段弹性支座，并核对带入情况

```python
init_ctx(mode=ExecutionMode.MIXED); clc()
# —— 几何阶段：只用 Fixed（它会随网格带入）——
Fixed(gnids=[n_bottom.id], dof=[Dof.All])
MeshParams(sizer=Size(isBasic=True, basicSize=0.5), toQuad="true")
StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# —— 有限元阶段：核对带入的约束，再补弹性支座 ——
fx = Fixed.all()                       # 实测 gnids 变成负号集合引用、dof 变成 6 位掩码（0=约束）
base_nids = [n.id for n in Node.all() if n.z < 1e-6]
ElasSupport(gnids=base_nids, type=ElasSupportType.Lateral, kx=0.0, ky=0.0, kz=1.0e7)  # N/m（SI）
# 之后：荷载 / Step / Analy / Job + JobManager（见 analysis.md）→ FemModel.toViewer() → submitAndSolve()
```

## 最佳实践

1. **几何阶段只用 `Fixed`**（点约束或线约束）——它可靠传递；弹性/隔震支座、人工边界一律放
   `fromViewer()` 之后按网格节点/单元号建；
2. 线约束优先用 `BaseLineGeom`（通用几何，传线构件号）：网格加密后约束自动跟着扩展
   （实测 6 m 梁 0.5 m 网格 → 自动选中 7 个节点），不用重算节点号；
3. `Fixed.dof` 用**明确的自由度列表**，不要图省事全给 `Dof.All`——梁单元端部全固结会抑制真实转动，
   需要铰接时用 `NodeJoint`（模型修正）或按对释放；
4. 读回约束时按实测格式解析：`gnids` 负号 = 集合引用（去 `Nset.all()` 里找同名 `BaseNodeSet-N`）、
   `dof` 是 6 位掩码且 **0=约束 / 1=放开**；
5. 弹性支座刚度单位随单位制（SI N/m、mm-t 制 N/mm），填错量级会让结构"软得离谱"或"硬得像固结"；
6. 约束不足会出现**前 6 阶 ≈0 频率**（刚体模态）或静力求解 `zero pivot`；
   约束过多则位移异常小、反力异常大——都要用 ΣRz = 总荷载复核；
7. ★ **弹簧连接的选型（2026-10-15 更正）**：原记载"`Connector` 崩溃 `0xc0000409`、`ElasSupport` 是唯一替代"
   **已复测推翻**——`Connector` 现可正常使用（`references/stru/known_issues.md` #115）。二者**不是替代关系，分工不同**：
   · **节点 ↔ 大地**（接地弹簧：土弹簧、侧移弹簧）→ `ElasSupport`（写法更简，`kx/ky/kz` 直接给）；
   · **节点 ↔ 节点**（两点之间的弹簧/阻尼）→ ★ **必须用 `Connector`**，
     `ElasSupport` **只能接地、无法连接两个节点**；
   · 隔震 → `IsolationBearing`。
   用 `Connector` 的三条硬约束见 `interactions.md` §5（模型至少 1 个单元、其余自由度要有约束兜住、
   只能写在 `fromViewer()` 之后）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 几何阶段建了 `ElasSupport`，算出来像没支承 | ★ 弹性支座不随网格带入（实测 `all()`=0、inp 数据段为空） | 移到 `FemModel.fromViewer()` 之后重建 |
| `ElasSupportType.Spring` 报 AttributeError | 枚举只有 `Soil`/`Lateral`/`Rotational` | 用 `ElasSupportType.Lateral`（或省 `type`，默认 1） |
| 读 `Fixed` 的 `gnids` 得到 `[-3]` 以为是负节点号出错 | 负号 = 引用 `Nset`（`BaseNodeSet-N`） | 去 `Nset.all()` 里按号找对应节点集合 |
| 读 `dof` 得到 `[1,1,0,1,1,1]` 以为"1=约束" | ★ 掩码语义相反：**0=约束、1=放开** | 按 `31_DofFixed.inp` 的注释理解 |
| `位移加载不能施加在固定约束节点` | 同一自由度既给了 `Fixed` 又给了 `Cdisp` | 该自由度只给 `Cdisp`（强迫位移本身即约束） |
| 线约束没生效（构件还能移动） | 建筑结构构件用了 `BaseLineGeom`（应传线构件号）或通用几何用了 `BaseLine`（应传点编号） | 通用几何 → `BaseLineGeom` + 线构件号；建筑结构 → `BaseLine` + 点编号 |
| 静力求解 `zero pivot` / 模态前 6 阶为 0 | 约束不足（刚体位移） | 补约束；梁端改 `Dof.All` 或成对释放（释放平动时同时释放对应面内转动） |
| 网格加密后约束"少了一半节点" | 用的是几何阶段写死的节点号 | 改线约束（`BaseLineGeom`），或在 FEM 阶段按坐标重筛节点 |
| 拱 / 索结构计算发散、`zero pivot` | 拱脚缺 `Ux`（水平推力无约束） | 拱脚补 `Dof.Ux` |
| 弹性支座"没效果"或结构软得离谱 | 刚度单位错（kN/m 当 N/m；mm-t 制应为 N/mm） | 按单位制核对 `kx/ky/kz` 量级 |
| 反力为 0 | 约束加错了节点（集合为空 / 节点号作废） | 用 `Fixed.all()` 读回组数与 `gnids`（负号=集合引用），再去 `Nset.all()` 核对集合内容 |
| 施工模拟里想"后装"支座 | 弹性支座/接触/绑定可以按施工阶段生死 | `Step(changes=[Change(type=ChangeType.Add, chType=ChangeChType.ElasSupport, geids=[...])])`；`ChangeChType` 实测有 `Element / ElasSupport / Contact / Connect / IsolationBearing` 五种（见 `analysis.md` 模板 5） |

## 验证清单

- [ ] `Fixed` 写在几何阶段（会随网格带入）；`ElasSupport`/`IsolationBearing`/`VSABoundary` 写在 `fromViewer()` 之后
- [ ] 线约束类型与模型种类匹配（`BaseLineGeom` ↔ 通用几何线构件号；`BaseLine` ↔ 建筑结构点编号）
- [ ] `dof` 明确列出，未与 `Cdisp` 在同一自由度上冲突
- [ ] 网格后用 `Fixed.all()` 核对组数，并按"负号=集合引用、掩码 0=约束"解析
- [ ] `31_DofFixed.inp`（约束）与 `33_ElasSupport.inp`（弹性支座）数据段非空
- [ ] 对照「约束完备性速查」逐条检查（拱脚 `Ux`、简支端 `Phx`、板壳一点 `Ux+Uy`…）
- [ ] ★ 实体模型的"简支"**未把整个端面约束 `Ux`**（会抑制端部转角、静默变成接近固端，见「约束完备性速查」实体简支梁行与 `references/stru/known_issues.md` #70）；已用"左右端 ΣRz 是否 50/50 + Σ(z−h/2)·Rx 是否为 0"自查
- [ ] `Cdisp` 的 `dof` 逐自由度给（未用 `All`/`Uxyz`），且未与 `Fixed` 冲突
- [ ] 求解后 ΣRz ≈ 总竖向荷载；模态分析前 6 阶不为 0（除非故意做自由模态）
