# 相互作用 — 参考文档




## 概述

覆盖绑定 `Binding`、耦合 `Coupling`、嵌入 `Embeded`、接触对 `ContactPair`、
连接器 `ConnectorSection`/`Connector`、主从约束 `DofSlave`、标准约束 `ConstrEqua`。

**选型速查**：

| 需求 | 用哪个 |
|------|--------|
| 两部件永不分离（焊接/胶接） | `Binding` |
| 一片区域跟随一个参考点（加载点/刚域） | `Coupling` |
| 钢筋/嵌入件埋入实体（仅 Link/壳嵌入实体） | `Embeded` |
| 可分离/可滑移界面（挤压、破坏） | `ContactPair` |
| 弹簧/阻尼/隔震类连接 | `Connector` |
| 自由度线性方程（u_A + u_B = 0 等） | `DofSlave` / `ConstrEqua` |

## 核心 API 与模板

### 1. 绑定 Binding

```python
Binding(tarNodes=None, srcNodes=None,
        type: int = BindingType.NodeToNode,      # SurfToSurf / NodeToSurf / NodeToNode
        iKey: int = DofMode.Both,                # Both / Translation
        iTol: int = 1, tol: float = -1)          # iTol: -1强制 0自动 1自定义；tol<0 自动
```

```python
master_ns = Nset("beam_ends", [n1.id, n2.id])
slave_ns  = Nset("slab_ends", [n3.id, n4.id])
Binding(tarNodes=[master_ns.id], srcNodes=[slave_ns.id],
        type=BindingType.NodeToNode, iKey=DofMode.Both)
```

### 1.1 绑定判定与容差细则（用户手册 §1.2.2.7.3.1 整理）

- **绑定类型** `BindingType`：`NodeToNode` 点-点 / `NodeToSurf` 点-面 / `SurfToSurf` 面-面
  （手册注明**面-面暂不开放**；脚本优先点-点、点-面）。
- **绑定自由度** `iKey`：`DofMode.Both` 平动及转动 / `DofMode.Translation` 仅平动。
- **靶(主)/源(从)**：两侧均可传节点集合号（`Nset.id`）或拾取节点；主从次序不可反；
  界面「交换靶节点与源节点」等价于互换 `tarNodes`/`srcNodes` 两列表。
- **容差模式** `iTol`：`-1` 强制绑定 / `0` 自动 / `1` 自定义 `tol`。
- **点-点判定**：搜索与源(从)节点距离 d 最小的靶(主)节点，d<tol 才绑定；
  自动容差 tol = 靶(主)面单元尺寸平均值的一半。
- **点-面判定**：源(从)节点投影搜索最近靶(主)单元，d<tol 才绑定；投影在单元内 d=点到面距离，
  投影在单元外 d=min(点到单元边距离, 点到单元顶点距离)；自动容差 tol = l/10，
  l=单元特征长度（四边形取两对角线均值，三角形取三边均值）。
- **TIPS（手册原文）**：① 绑定时注意主、从节点次序；② 同一个节点不能为两个绑定的从节点；
  ③ 从节点不能作为固定支座。

- ★ **容差一律用默认**（2026-10-29 口径）：`Binding` 的 `iTol` 保持默认（＝自动），**不要自定义 `tol`**；
  确有必要时先在小模型上试跑，并把实测结果写进交付包。
  ⚠️ 唯一必须做的自查：**未绑定时不会报错**——从节点会变成孤立点、加在其上的荷载被静默忽略
  （`o11` 全 0、`run_script` 仍返回 `success:true`）。⇒ 建完绑定后核对「从节点有荷载时位移是否为 0」。
- **焊接模拟实测做法**（见 `examples/fem/silo_industrial_hydrostatic_modal.py`）：环板/竖撑内缘按
  **与仓壁同坐标的独立节点**建模，再 `Binding(type=NodeToNode, iKey=DofMode.Both)`；点-点距离为 0
  恒小于 tol，无需担心容差；同坐标独立节点+绑定还规避了保存期"连通性异常"启发式警告。
- **多任务提交实测**：`submitAndSolve()` 每次仅计算 JobManager 指定的当前分析任务；★ 2026-10-22 更正：
  同脚本内多次调用**各自跑一条完整管线**（旧「第二次静默无效」已推翻），但返回码**只反映最后一次**（ERRATA #125）；
  同模型多任务仍**推荐**用 `CUR_TASK` 常量切换后分次提交（见上例与 `examples/fem/gravity_dam_multi_task.py`）。

### 2. 耦合 Coupling

```python
Coupling(tarNode=None, srcNodes=None,
         type: int = CouplingType.Rigid,        # Rigid 刚性 / Flexible 分布
         iKey: int = DofMode.Both,              # Both 全部 / Translation 平动 / Custom 指定
         iDofs: int = None)                     # 指定自由度(Dof 六自由度)，Custom 时必给
```

```python
# 梁端面全部节点耦合到参考点，集中力施加在参考点上（避免应力奇异）
rp = Node(x, y, z)
Coupling(tarNode=rp.id, srcNodes=[end_ns.id],
         type=CouplingType.Rigid, iKey=DofMode.Both)
lc.add(Cload(gnids=[rp.id], dof=[FDof.Fz], value=[-P]))
```

### 2.1 耦合定义细则（用户手册 §1.2.2.7.1.2 整理）

- **耦合自由度**（`iKey`）：可选“**全部自由度**”（`DofMode.Both`）、“**平动自由度**”
  （`DofMode.Translation`）和“**指定自由度**”（`DofMode.Custom`，仅对耦合有效）。
  选择“指定自由度”时，自由度可在 Ux、Uy、Uz、Rotx、Roty、Rotz 六个自由度中选择
  （对应 `Dof.Ux/Uy/Uz/Phx/Phy/Phz`），且**指定自由度不能为空**（`iDofs` 必给）。
- **主节点**（`tarNode`）：**只有一个**，传单个节点号（界面只能通过拾取节点定义，不能为空）。
- **从节点**（`srcNodes`）：**可以有多个**，可传节点号列表或选择现有节点集合号（`Nset.id`）。
- **TIPS（手册原文）**：① 耦合的主节点可以是悬空的某个节点，也可以是单元节点
  （独立建悬空节点作加载参考点即此用法）；② 一个节点不能同时存在于同一个耦合的主、从节点。

### 3. 嵌入 Embeded

```python
Embeded(tarElems=None, srcElems=None,
        type: int = EmbededType.NodeToElem,    # NodeToElem 点嵌入单元 / NodeToNode
        iKey: int = DofMode.Both, tol: float = -1)
```

### 3.1 嵌入支持范围与机制细则（用户手册整理）

- **支持范围**：仅支持 **Link 单元、壳单元**嵌入到**实体**中；其余单元组合不要生成嵌入。
- **嵌入机制**：目前只支持**节点嵌入单元**（`EmbededType.NodeToElem`），即通过将从单元两端的节点
  与主单元的节点**自动绑定**实现嵌入功能；`EmbededType.NodeToNode` 为点点作用（节点-节点绑定）。
- **建模要点**：从单元（Link/壳）直接建在主单元（实体）内部区域即可，程序按位置关系自动完成节点绑定；
  `tol`（嵌入容差）暂时保留，保持默认 `-1`。

### 4. 接触对 ContactPair（需配合 ContactSet 表面）

```python
ContactPair(tarElems=None, srcElems=None,             # 主/从 ContactSet 号
            type: int = ContactType.ElasToElas,       # ElasToElas / RigidToElas
            iMethod: int = ContactMethod.NodeToSurf,  # NodeToSurf 破坏接触 / SurfToSurf 挤压
            penalty: float = -1, slipTol: float = 0, mu: float = 0)
```

```python
cs_a = ContactSet("SurfA", [Contactor(att=e1.id, side=2)])
cs_b = ContactSet("SurfB", [Contactor(att=e2.id, side=1)])
ContactPair(tarElems=[cs_a.id], srcElems=[cs_b.id],
            type=ContactType.ElasToElas, iMethod=ContactMethod.SurfToSurf, mu=0.3)
```

### 4.1 接触对定义细则（用户手册 表4.12 整理）

接触通过**接触对**定义：接触对指定**存在接触关系的接触面**（靶面、源面，即 `ContactSet`）
并定义接触参数。

- **离散类型**（`iMethod`）：可选“**点-面接触**”（`ContactMethod.NodeToSurf`）和
  “**面-面接触**”（`ContactMethod.SurfToSurf`）。
- **靶面与源面**（`tarElems`/`srcElems`）：从**已定义的接触面**（`ContactSet`）中选择。
  **注意：接触面方向要相对**（两侧 `Contactor.side` 法向相对，方向反了会接触不闭合，见「常见错误」）。
- **源面补充节点**：离散类型为“点-面接触”时，可定义**源面补充节点**（允许为空）；
  该项为界面拾取操作，脚本侧 `ContactPair` 无对应形参。
- **相关参数**：包括作用间隙、罚系数与摩擦系数定义，见下表。

| 参数 | 形参 | 说明 | 默认值 |
|---|---|---|---|
| 作用间隙 | `slipTol` | 接触面距离在作用间隙内，判定为接触 | 0 |
| 罚系数 | `penalty` | 接触刚度的折减系数 | 0.1 |
| 摩擦系数 | `mu` | 接触面切向摩擦系数 | 0 |

> 注：脚本 `ContactPair` 预定义形参为 `penalty=-1`、`slipTol=0`、`mu=0`；需显式控制罚系数时
> 按上表默认值 0.1 传入。

### 5. 连接器

```python
# ★ 手册两轮扩展：2026-10-16 版加 elastics / m / plastics（刚度非线性）；2026-10-22 版再加 consDamp / dampCoefs（阻尼）
# ★ 运行时签名与新版手册完全一致（2026-10-22 实机 inspect.signature 实测，见 references/fem/known_issues.md #132）
ConnectorSection(name: str,                        # 唯一必填
                 iType: int = ConnSectType.Translation,   # Translation / Rotation
                 keyStiff: int = ConnStiffType.Linear,    # Linear / Nonlinear / MetalPlastic
                 consElas: float = 0,                     # 常刚度（keyStiff=Linear 时用）
                 elastics: list[list[float]] = None,      # 非线性弹性「荷载-位移」表
                 m: float = 0,                            # 混合硬化参数（0 随动 / 1 等向 / 0<m<1 混合）
                 plastics: list[list[float]] = None,      # 金属弹塑性「屈服荷载-塑性位移」表
                 keyDamp=ConnDampType.Off,                # Off / Constant / Nonlinear
                 consDamp: float = 0,                     # ★新（10-22 版手册）常阻尼（keyDamp=Constant 时用）
                 dampCoefs: list[list[float]] = None,     # ★新（10-22 版手册）阻尼力-速度表（Nonlinear 时用）
                 keyFriction=ConnFrictionType.Off,
                 keyFail=ConnFailType.Off, keyLock=ConnLockType.Off)

Connector(start=None, end=None,                    # 起止节点号（★ 该处不支持集合）
          iDofs=None, iSects=None,                 # 自由度号 ↔ 连接器截面号（一一对应）
          iCoord: int = ConnCoordType.Auto,        # Auto / Fixed / Follow（手册另列 Global，见下）
          vy=None, vx=None)                        # 局部 Y / X 轴方向向量
# ★ 2026-10-30 版手册口径：vy = 局部 Y 轴方向向量、vx = 局部 X 轴方向向量；
#   两者都缺省 → 程序自动算局部系；仅缺省 vx → 程序按【开始/结束节点连线】算 vx；
#   手册另称 iCoord=ConnCoordType.Global（固定总体系）时 vx/vy 不生效。
```

> ★ **可用性状态（2026-10-15 实机验证，`references/fem/known_issues.md` #119）**：
> 原记载"含 `Connector` 的模型在 `sep-modelcheck` 崩溃 `0xc0000409`、三种构型均复现"
> **已在同版本环境复测推翻**——modelcheck 正常 `@complete`、`ModelCheckResult.json` =
> `{"error":{},"warning":{}}`、求解正常结束、`o63_ConnectForce.out` 有内力输出，
> 且**与串并联弹簧理论解偏差 ≤0.0002%**。**连接器可用。**
> ★ **2026-10-22 修订版手册复核（`references/fem/known_issues.md` #139）**：手册 §2.7.5「连接器截面」/ §2.7.6「连接器」
> 与 `ConnSectType`/`ConnStiffType`/`ConnDampType`/`ConnFrictionType`/`ConnFailType`/`ConnLockType`/`ConnCoordType`
> 七组枚举**与上一版逐字节一致**（`ConnectorSection` 仍为 12 形参、`Connector` 仍为 7 形参）⇒ **连接器内容无失效**。

**★ 刚度本构三选一：`keyStiff` 决定该填哪组参数（2026-10-16 版手册新增形参）**

| `keyStiff` | 本构 | 必填参数 | 数据表含义 | 求解器侧字段（`19_ConnectSect.inp` 表头，权威） |
|---|---|---|---|---|
| `ConnStiffType.Linear`（0，默认） | 线弹性 | **`consElas`** = 常刚度（SI: N/m） | 单值刚度 | `keyStiff=0`、`consElas` |
| `ConnStiffType.Nonlinear`（1） | 非线性弹性 | ★ **`elastics`** | **荷载–位移**曲线：`[[F1,u1],[F2,u2],…]`，第一维=采样点数，第二维长度 **2**（第 1 列荷载、第 2 列位移） | `keyStiff=1`、`numElas`（点数，0=常数弹性）、`elasCoefs(:,1:2)` |
| `ConnStiffType.MetalPlastic`（2） | 金属弹塑性 | ★ **`plastics`** + **`m`** | **屈服荷载–塑性位移**曲线：`[[Fy1,up1],…]`；`m` = 混合硬化参数（**0 随动硬化 / 1 等向硬化 / 0<m<1 混合**，默认 0） | `keyStiff=2`、`M`、`numPlas`（0=忽略塑性）、`plasCoefs(:,1:2)` |

> ⚠️ **`plastics` 的列义与 `elastics` 不同，手册表述易误读**：手册正文对两者都写"荷载–位移数据表"，
> 但求解器侧 `19_ConnectSect.inp` 表头明确区分——
> `elasCoefs` 是「**荷载-位移**曲线（第1列荷载，第2列位移）」，
> `plasCoefs` 是「**屈服荷载-塑性位移**曲线（第1列屈服荷载，第2列**塑性**位移）」。
> ⇒ **`plastics` 第 2 列是塑性位移（不可恢复部分），不是总位移**；按总位移填会得到偏硬的骨架曲线。
> 以求解器表头为准（`references/fem/known_issues.md` #123）。

**★ 阻尼三选一：`keyDamp` 决定该填哪组参数（★ 2026-10-22 版手册补齐）**

| `keyDamp` | 阻尼模型 | 必填参数 | 数据表含义 | 求解器侧字段（`19_ConnectSect.inp` 表头） | ★ 2026-10-22 实机结论 |
|---|---|---|---|---|---|
| `ConnDampType.Off`（0，默认） | 无阻尼 | — | — | `keyDamp=0` | 起点（对照）|
| `ConnDampType.Constant`（1） | 常系数阻尼 | ★ **`consDamp`**（标量） | 常阻尼系数 | `keyDamp`、`consDamp` | ⛔ **2026-10-22 实机：能落盘但无作用**（对照子体系**位级相同**；#139） |
| `ConnDampType.Nonlinear`（2） | 非线性阻尼 | ★ **`dampCoefs`** | **阻尼力–速度**表：`[[F1,v1],[F2,v2],…]`，第一维=采样点数，第二维长度 **2**（**第 1 列阻尼力、第 2 列速度**） | `keyDamp`、`numDamp`、`dampCoefs(:,1:2)` | ⚠️ **2026-10-28 复核更正**：#139 的「两段式失败」已过时——**二维表能构造、能落盘**（`expected_dims=2`），**但动力中静默无作用**（A/B 两子系统逐帧差 `0.000e+00`）；**扁平表**在构造期报 `ValueError: 维度不足`。⛔ 仍不可用于减震（#146） |

> ⛔ **2026-10-22 实机验证结论（见 `references/fem/known_issues.md` #133）**：**连接器阻尼目前不能用于脚本侧动力分析**——
> `consDamp` 落盘正确（`19_ConnectSect.inp` → `1 1000000 0`）却**对响应毫无影响**（同一模型内"无阻尼"对照子体系**位级相同**；
> 隐式直接积分 + 显式 HalfStep、`1e4`/`1e6` 两量级均如此；同模型改**分析级阻尼**则时程明显变化 ⇒ 非测量失灵）；
> `dampCoefs` 两种形状都不通。⇒ **需要阻尼请用分析级阻尼**（`AnalySetting(iDampType=AnaDampType.RatioToMass, dampRatio=…)`）或在界面定义。

> ⚠️ **三张表列义别混**：`elastics`/`plastics` 是「**荷载–位移**」（`plastics` 特指**塑性**位移），
> `dampCoefs` 是「**阻尼力–速度**」（第 2 列是**速度**）。

> ★★ **`dampCoefs` 的正确写法与实测现状（2026-10-28 复核，**更正** 2026-10-22 的「两段式失败」口径；`references/fem/known_issues.md` #146）**
> - **手册形状 = 二维表**：`dampCoefs=[[F1,v1],[F2,v2],[F3,v3]]`（第一维 = 采样点数；第二维长度 **2**：
>   第 1 列**阻尼力**、第 2 列**速度**）⇒ 落盘 `19_ConnectSect.inp` 的 `numDamp` + `dampCoefs(:,1:2)`。
> - **现状（构建 `pypcae 2.2.1` / `last release 20261030`，2026-10-28 实测）**：
>   ① **二维表能构造、能落盘**——源码 `comp/connector.py` 现为
>      `normalize_numbers_to_list(elastics/plastics/dampCoefs, expected_dims=2)`；
>      实测 `dampCoefs=[[0,0],[2000,1],[8000,4]]` → 落盘 `2 0 3` + `0 0` / `2000 1` / `8000 4`。
>      （旧记录的「二维表构造期 `ValueError: 维度超标`」在**本机构建上已不成立**。）
>   ② **扁平一维表** `[0,0,2000,1,…]` 在**构造期**即被拒：
>      `ValueError: 维度不足: 在深度 1 处遇到了数据，但期望在深度 2 处。`
>      ⇒ 只有二维表这一种合法写法，⛔ 不要再写扁平表。
>   ③ ★ **但动力分析中静默无作用**：同一模型内两套完全相同的单自由度子系统（错开 Y 坐标），
>      A 套 `keyDamp=Nonlinear + dampCoefs=[[0,0],[2000,1],[8000,4]]`、B 套 `keyDamp=Off`，
>      隐式 Direct、`sTime=1.0 / stepLen=0.005`、**分析级 `dampRatio=0`** ⇒
>      **10 帧逐帧最大绝对差 = `0.000e+00`**，峰值同为 `1.998040e-3 m`（= 无阻尼阶跃的 2 倍静位移）。
>      ⇒ **写进去了，但没参与求解**。
> - ⇒ **结论不变、原因要写对**：⛔ 不得用连接器阻尼减震（`consDamp` 与 `dampCoefs` 均实测无作用）；
>   需要阻尼请用**分析级阻尼**（`AnalySetting(iDampType=AnaDampType.RatioToMass, dampRatio=…)`）或在界面中定义。
> - ⚠️ 构造 `ConnectorSection` **失败时不要继续引用 `cs.id`**（会抛 `NameError`，把真正的构造异常盖掉）：
>   先 `cs = None`，失败则回退或直接收口 —— 见「常见错误」。
> ⛔ **2026-10-22 实机定位：连接器的传力方向 = 它自己的轴向，`iDofs` 必须写 `Dof.Ux`(1)**
> 9 次运行矩阵：轴向 X/Y/Z 三种布置下，**只要 `iDofs=[Ux]` 都能沿该轴传力**（轴 Y + Fy ⇒ uy=6.18e-3/7.18e-3、Ry=−1000；
> 轴 Z + Fz ⇒ uz=6.18e-3/7.18e-3、Rz=−1000）⇒ **`iDofs=1` 的语义是「沿连接器轴向的平动弹簧」，与全局 X 无关**。
> · `iDofs=[Dof.Uy]`(2) ⇒ **静默零**（位移/反力全 0、无报错、`neq` 仍计入该 DOF）；· `iDofs=[Ux,Uy]` ⇒ **只有第一项有效**（Y 向静默零）；
> · `iDofs=[Dof.Uz]`(3) ⇒ **同样不建弹簧**：多数布局**静默**，自由度成对悬空时升级为 **`zero pivot` 硬失败**（`solveLinearEquaOne出错`）。
> ⇒ **要哪个方向传力就把连接器沿哪个方向布置**；要 X+Y 就建两个连接器；⛔ 不要用 `iDofs` 指望去耦合多个方向。
> 自查：某方向「荷载无响应、无位移、无反力」→ 先查该连接器轴向与 `19_ConnectElem.inp` 的 `iDofs`；
> ⚠️ `neq` **不能**用来判断弹簧是否建立（详见 `references/fem/known_issues.md` #141；另一技能 #135）。

```python
# ⛔ 2026-10-22 实机验证后：以下两种写法都**只有"能写进去"的形式意义，没有动力学效果**，故不作为模板推荐
# ① 常阻尼：能构造、能落盘（inp → keyDamp=1, consDamp=…），但对响应无影响（#139）
csec_damp = ConnectorSection(name="Conn_ConstDamp",
                             iType=ConnSectType.Translation,
                             keyStiff=ConnStiffType.Linear, consElas=1.0e6,
                             keyDamp=ConnDampType.Constant, consDamp=1.0e4)
# ② 非线性阻尼：2 维表在构造期即报 ValueError（维度超标）；扁平表会让 sep-modelcheck 崩溃
#    —— 见 ERRATA #139，脚本层暂不可用，请在界面中定义

# ✅ 需要阻尼时用「分析级阻尼」（全结构通用，已实测有效）：
st = AnalySetting(anaType=AnaType.IMPLICIT, iType=ImpAnaMethod.Direct,
                  sTime=1.0, stepLen=0.001,
                  iDampType=AnaDampType.RatioToMass, dampRatio=0.20)   # 0.20 明显改变时程
```

```python
# 非线性弹性：荷载–位移表（点数 = 第一维长度）
csec_nl = ConnectorSection(name="Conn_Nonlinear",
                           iType=ConnSectType.Translation,
                           keyStiff=ConnStiffType.Nonlinear,      # ★ 选非线性弹性
                           elastics=[[0.0, 0.0], [500.0, 0.0005], [1000.0, 0.0015]])

# 金属弹塑性：屈服荷载–塑性位移表 + 混合硬化参数
csec_mp = ConnectorSection(name="Conn_MetalPlastic",
                           iType=ConnSectType.Translation,
                           keyStiff=ConnStiffType.MetalPlastic,   # ★ 选金属弹塑性
                           m=0.0,                                 # 0 随动 / 1 等向 / 0<m<1 混合
                           plastics=[[800.0, 0.0], [1000.0, 0.001], [1200.0, 0.004]])
```

> ★★ **可用性总表（2026-10-28 实机复核，构建 `pypcae 2.2.1` / `last release 20261030`）**
>
> | 连接器能力 | 状态 | 证据/出处 |
> |---|---|---|
> | 平动 + 线弹性 + `consElas` + `Auto` + 静力 | ✅ 可用 | #119（±1000 N 全量传力、偏差 +0.0002%） |
> | `elastics`（`ConnStiffType.Nonlinear`） | ✅ **可用、逐点守表** | 下「非线性本构」(#145) |
> | `plastics` + `m`（`MetalPlastic`） | ✅ **可用**，残余 = 塑性位移 | 下「非线性本构」(#145) |
> | `ConnSectType.Rotation` 转动连接器 | ✅ **可用**（`iDofs=[Dof.Phx]`） | 下「转动连接器」(#147) |
> | `iCoord=Fixed` + `vy` | ✅ 可用（**`vx` 被丢弃**） | 下「局部坐标系」(#148) |
> | `iCoord=Follow` | ⛔ **不可用**：genfea `**Error:setConnectionElem有错` | 下「局部坐标系」(#148) |
> | `keyDamp=Constant/Nonlinear`（`consDamp`/`dampCoefs`） | ⚠️ 能写进去、**动力中无作用** | 上「阻尼三选一」(#146) |
> | `keyFriction`/`keyFail`/`keyLock` | ⚠️ 开关能落盘，**限值只能构造后赋值**；空限值 → `sep-processor` 崩溃 `0xc0000005`；线性静力下 lock/fail 不触发 | 下「三个开关」(#149) |
> | 动力（隐式 Direct）下的传力 | ✅ 可用（`o63` 有非零内力） | 下「动力下的连接器」(#150) |
> | 动力（**显式** HalfStep）下的传力 | ✅ 可用（`OutExDyna/o63` 有非零内力） | 下「动力下的连接器」(#158) |
> | `Binding(NodeToSurf)` 容差 | ✅ **用默认容差**（`iTol` 默认＝自动）；⛔ 不自定义 `tol`；未绑定不报错、须核对 | §1.1 |
>
> ⚠️ **仍未验证**：`Binding(NodeToSurf)` 带间隙的容差稳定区间（属另一技能 #108）；`alphaT/alphaN` 类
> 波动问题的工程取值（属判断，不属接口验证）。
> 如 `consDamp`/`dampCoefs`/`frictCoef`/`dispFail`/`lockStiff`，但脚本侧形参能否正确落盘未测）。

**★ 三条硬约束（实测得出，违反即失败）**：

| # | 约束 | 违反后果 |
|---|---|---|
| 1 | **模型至少要有一个单元** | 零单元模型（只有节点 + 连接器/约束/荷载）在 `genfea` 报 `**Error:readElemLoadInfo出错:*elemLoad:-1`（`exit status 0xffffff9c`）失败（#120）。**前兆信号**：`sep-modelcheck` 报 `**Error:模型未定义截面!`/`**Error:模型未定义材料!`（没单元 → 没截面/材料被引用），**别误判成材料截面写错** |
| 2 | **两端节点的其余自由度要有约束兜住** | 只放开连接器作用的那个自由度（如 `Ux`），其余用 `Fixed(dof=[Dof.Uy, Dof.Uz])` 约束，否则未约束自由度 → 总刚奇异 |
| 3 | `consElas` **必须填实际刚度** | 填 `0` = 无刚度，等于没建（不报错，静默无效） |

**★ `Connector` vs `ElasSupport` 选型（不是替代关系）**：

| 需求 | 用哪个 | 原因 |
|---|---|---|
| **两个节点之间**的弹簧 / 阻尼 | ★ **`Connector`** | `ElasSupport` **只能接地**（节点↔大地），无法连接两个节点 |
| 节点 ↔ **大地**的弹簧（土弹簧、侧移弹簧） | `ElasSupport` | 写法更简，`kx/ky/kz` 直接给 |
| 隔震 | `IsolationBearing` | 专用类型 |

**落盘核对（存在性核对）**：

| 文件 | 内容 |
|---|---|
| `genfea-compute-*/19_ConnectSect.inp` | `*connectSect`：`iNum, iType, nameStr` / `keyStiff, consElas, M, numElas, elasCoefs(:,1:2), numPlas, plasCoefs(:,1:2)` / `keyDamp, consDamp, numDamp, dampCoefs` / `keyFriction, frictCoef, frictRadius, relaDof, numFrict, iFricTag, extruForce` / `keyFail, iFailTag, dispFail(1:2)` / `keyLock, lockStiff, iLockTag, dispLock(1:2)`。★ 表头注释即各参数权威语义来源 |
| `genfea-compute-*/19_ConnectElem.inp` | `*connectElem nNum`：`iNum, iType, iNodes(1:2), mDof, iCoord` / `iDofs` / `iSects` / `cNum, coords`（★ 头注释明写 `iNodes(2) ! 连接单元节点号(该处不支持集合)`） |
| `genfea-compute-*/OutStatic/o63_ConnectForce.out` | **连接器内力**（总体系）：`*connectForce nStep nConn` → 每步 `iStep, time` → `iConn, m(=2)` → 每节点 `iNode, Fx,Fy,Fz,Mx,My,Mz` |

**★ 实测验证（构型 C「连接器为唯一传力路径」，最硬判据）**：
受荷节点**不挂任何单元**、荷载 100% 经连接器传递 →
`o63_ConnectForce.out` 内力 = **±1000 N（= 全部施加荷载）**、`ux = 1.00062e-3 m`
（串联通刚度理论解 `1.000618e-3`，偏差 **+0.0002%**）、固定端反力 `−1000 N` 平衡
⇒ **连接器确实参与总刚组装并传力**，不是"写了不报错但不起作用"。
端到端示例：`../examples/fem/connector_spring_series.py`。

**★ 已收口的验证范围（2026-10-28）**：平动/转动两种 `iType`、Linear/Nonlinear/MetalPlastic 三种刚度本构、
`Auto`/`Fixed` 两种坐标系、静力（线性 + 材料非线性）与隐式动力两条分析路径均已实机跑过；
`Follow` 坐标系、连接器阻尼、`keyLock/keyFail/keyFriction` 的**触发语义**仍有明确结论（见上表）。
跨版本升级后仍需按本表第一条重跑小模型复核。——**本次只验证「平动 + 线弹性 + 常刚度 + `Auto` 坐标系 + 静力」这一条最常用路径**。

#### ★ 非线性本构实测：`elastics` 与 `plastics`+`m`（2026-10-28，`references/fem/known_issues.md` #145）

模型（两例共用骨架）：`n1`（`Dof.All` 全固定）—`Link` Φ100 Q345（`k=EA/L=1.6179e9 N/m`）— `n2` ═ `Connector(Ux, k=1e6)` ═ `n3`
（`n3` **不挂单元**，荷载 100% 经连接器传递）。

| 本构 | 参数 | 加载实测 | 卸载实测 |
|---|---|---|---|
| `elastics`（`Nonlinear`） | `elastics=[[0,0],[500,5e-4],[1000,1.5e-3]]`、`consElas=1e6`（故意给线刚度作区分） | 1000 N → `ux(n3)=1.50062e-3`（表值 `1.5e-3` + 杆伸长 `6.18e-7`）<br>500 N → `5.00309e-4`（`5e-4` + `3.09e-7`） | 0 N → `−3.3e-19` ≈ 0 |
| `plastics`+`m`（`MetalPlastic`） | `consElas=1e6`、`plastics=[[800,0],[1000,2e-3]]`、`m=0` | 1000 N → `3.00062e-3` = `F/K`(`1.0e-3`) + `up`(`2.0e-3`) | 0 N → `2.000e-3`，且 `o63` 内力 **0**（残余 = 塑性位移） |

- 若 `elastics` 例真被 `consElas` 接管，应得 `1.0e-3`；实测 `1.50062e-3` ⇒ **表确实生效，且路径无关（逐点守表）**。
- 落盘：`19_ConnectSect.inp` → `2 1000000 0 0 2`（`keyStiff, consElas, M, numElas, numPlas`）+ `800 0` / `1000 0.002`。
- 非线性分析配 `AnalySetting(iNLType=NLType.MaterNonlinear)`；★ `NLType` **没有 `Linear` 成员**
  （只有 `ALinear=1` 等），**线性静力直接不传 `iNLType`**，不要写 `NLType.Linear`。

**★ 卸载写法对照（2026-10-29 实测，同一串联模型 `Link` Φ100 + `Connector` k=1e6，加载 1000 N）**

| 本构 | 加载步 `ux(n3)` | 卸载写法 | 卸载步 `ux(n3)` | `o63` 内力 |
|---|---|---|---|---|
| `Linear` | `1.000620e-3` | 系数 `0.0`/继承 0（**`nSubstep=1` 也行**） | `0.000000e+00` | 1000 → 0 |
| `Linear` | 同上 | 继承 1 + 系数 `-1.0` | `0.000000e+00` | 1000 → 0 |
| `Linear` | 同上 | 继承 **0** + 系数 `-1.0` | `-1.000620e-3`（反向加载） | 1000 → −1000 |
| `elastics` | `1.500620e-3` | 系数 `0.0` / 继承 0 | ❌ 不收敛 `iIter:501` | — |
| `elastics` | 同上 | 继承 1 + 系数 `-1.0`，`nSubstep=2/3/10/100` | `≈0`（−2.7e-20） | 1000 → 0 |
| `elastics` | 同上 | 继承 1 + 系数 `-1.0`，**`nSubstep=1`** | ❌ 不收敛 | — |
| `elastics` | 同上 | 继承 1 + 系数 `-0.5` | `5.003090e-4` | 1000 → 500 |
| `plastics` | `3.000620e-3` | 系数 `0.0` / 继承 0 | `2.000000e-3`（残余 = 塑性位移） | 1000 → 0 |
| `plastics` | 同上 | 继承 1 + 系数 `-1.0` | `2.000000e-3`（与上行**逐位相同**） | 1000 → ≈0 |

⇒ 口径与模板见 `analysis.md`「★ 卸载 / 回弹（按本构分档）」；**线性本构不必折腾继承与 −1**，
折线弹性（`elastics`）**必须** `keyInherit=1` + 系数 `-1.0` + 子步 ≥2。

#### ★ 转动连接器 `ConnSectType.Rotation`（2026-10-28 实测可用，#147）

模型：`n1` 全固定 —`BeamEuler` Φ100、L=1（`k_φ=GJ/L=7.778e5 N·m/rad`）— `n2` ═转动连接器 `consElas=1e5 N·m/rad`═ `n3`，
`n3` 加 `Mx=1000 N·m`（其余自由度约束）。

| 量 | 实测 | 串联解析 |
|---|---|---|
| `Phx(n2)` | `1.2856e-3` | `M/k_beam = 1000/7.778e5 = 1.2857e-3` |
| `Phx(n3)` | `1.1286e-2` | `1.2856e-3 + 1000/1e5 = 1.1286e-2` |

- `consElas` 单位 = **N·m/rad**；`19_ConnectSect.inp` 第 2 列 `iType=1`。
- ★ **`iDofs` 必须写该类型自己的第一自由度**：转动连接器用 `iDofs=[Dof.Phx]`(4)；写 `[Dof.Ux]`(1) ⇒
  **静默零**（位移全 0、无报错）。与平动连接器「只认 `Dof.Ux`(1)」是同一条规律（#135）。

#### ★ 局部坐标系 `iCoord`：`Fixed` 可用、`Follow` 不可用（2026-10-28，#148）

| `iCoord` | 传参 | 结果 |
|---|---|---|
| `Auto`（默认） | — | ✅ `ux(n3)=1.000620e-3`（基准） |
| `Fixed` | `vx=[1,0,0], vy=[0,0,1]` | ✅ 与基准逐位相同；`*connectElem` 写 `1 0 2 3 1 1` ⇒ **`iCoord=1`、`cNum=1`、`coords=(0,0,1)`**（只记局部 y；**`vx` 被丢弃**，源码 `if iCoord==Fixed: coords=[[0,0,0]]; if vy: coords[0]=vy`） |
| `Follow` | `vy=[0,0,1]`（或 `vx`+`vy`） | ⛔ **不可用**：modelcheck 与 sep-processor 都 `@complete`，但 genfea 报 `**Error:setConnectionElem有错`、`exit status 0xffffff9c` |

⇒ 需要局部系时**只用 `Fixed` + `vy`**；`Follow` 在脚本层不可用，且 `run_script` 的 `msg` 仍指向 `:sep-processor`（#106 同款误导）。

★ **手册 2026-10-30 版新增口径与运行实况的差异（#160）**：

| 项 | 手册（2026-10-30 版） | 本机运行实况（2.2.1，2026-10-29 实测） |
|---|---|---|
| `vy` / `vx` | 「局部 Y / X 轴方向向量」；两者都缺省→自动算局部系；仅缺 `vx`→按**起止节点连线**算 `vx` | `Fixed` 下**只落 `vy`**（`cNum=1`、`coords=局部 y`），**`vx` 被丢弃**（源码 `if iCoord==Fixed: coords=[[0,0,0]]; if vy: coords[0]=vy`）；`Follow` 下写 `cNum=2` 但 genfea 报错 |
| `ConnCoordType.Global`（固定总体系） | 枚举新增该成员，且「`Global` 时 `vx`/`vy` 不生效」 | **运行时枚举里没有该成员**（`hasattr(ConnCoordType,'Global')=False`）⇒ 写 `ConnCoordType.Global` 抛 `AttributeError`；**传裸值 `iCoord=3` 可跑通**（`*connectElem` 写 `iCoord=3`、`cNum=0`，本例结果与 `Auto` 相同） |

⇒ **口径**：① 需要"局部 y"就用 `Fixed`+`vy`，不要指望 `vx`；② 想用 `Global` 之前先
`hasattr(ConnCoordType, "Global")` 核对，缺失时**如实写进交付包**（可临时用裸值 `iCoord=3`，但属绕过枚举，
语义仅手册声明、未做力学差异验证）。

#### ★ `keyFriction` / `keyFail` / `keyLock`：⛔ 不是"达到位移才触发"的阈值，脚本层不可用（2026-10-28，#149 / #157）

- 这三个开关**没有对应的限值形参**：`frictCoef`/`frictRadius`/`relaDof`/`extruForces`/`dispFail`/`dispLock`/
  `iFricTag`/`iFailTag`/`iLockTag`/`lockStiff` 都是**构造后属性**（默认 `0/0/0/[]/[]/[]/0/0/0/1e15`）。
- ⛔ **只把开关置 `On`、不给限值 ⇒ `sep-processor` 崩溃 `exit status 0xc0000005`**（modelcheck 已 `@complete`、
  且**不产生**本次的 `19_ConnectElem.inp`）。⚠️ 此时 `run_script` 的 `msg` 是 **`:sep-modelcheck`**，与真实崩溃阶段不符
  —— 又一次印证 #106：`msg` 只当"失败了"的信号，定位一律读 `pserver.log` 尾部。
- ✅ 构造后赋值可正常落盘：

```python
cs = ConnectorSection(name="CS_Lock", iType=ConnSectType.Translation,
                      keyStiff=ConnStiffType.Linear, consElas=1.0e6,
                      keyLock=ConnLockType.On)
cs.dispLock = [5.0e-4, 5.0e-4]        # → 19_ConnectSect.inp: 1 1e+15 0 0.0005 0.0005
# cs.dispFail  = [5.0e-4, 5.0e-4]     # → 1 0 0.0005 0.0005
# cs.frictCoef = 0.3                  # → 1 0.3 0 0 0 0
```

- **实测行为（同一串联模型：`Link` Φ100 + `Connector` `k=1e6`，加载 1000 N 时相对位移 `1e-3 m`）**：

| 配置 | 线性静力 | 材料非线性静力（`nSubstep=10`） | `o63` 内力 |
|---|---|---|---|
| `keyLock=On`，`dispLock=[5e-4,5e-4]` | 不触发（`ux=1.000620e-3`） | `ux` → `1.0062e-4`，卸载后 `1.0000e-4` | 单子步加载时 **`±5.0e11 N`**（= `lockStiff(1e15) × 5e-4`） |
| `keyLock=On`，`dispLock=[**2e-3**,2e-3]` | — | **与 5e-4 结果完全相同**（`1.0062e-4` / `1.0000e-4`） | 同上量级 |
| `keyFail=On`，`dispFail=[**2e-3**,2e-3]`（大于实际相对位移 `1e-3`） | 不触发 | **立即失效**：`o63` 内力 **0**，受荷节点位移放大到 `5.655e5 m` 量级 | 0 |
| `keyFriction=On`，`frictCoef=0.3` | 纯轴向加载下与无摩擦相同（切向未受力，属预期） | — | — |

  ⇒ **`dispLock`/`dispFail` 的数值大小不影响是否触发**（`5e-4` 与 `2e-3` 结果逐位相同；`dispFail` 甚至大于实际相对位移也照样失效）；
  开关一置 `On`，连接器就按"**立即锁死（`lockStiff`）** / **立即断开**"处理，锁死后内力达 `1e11 N` 量级、多子步结果自相矛盾
  （`6.18e-7` 与 `1.0e-3`）⇒ **这些开关不具备可用的"阈值触发"语义**。
- ⇒ **口径**：**交付脚本一律不用**这三个开关。确需"拉断 / 限位"时：① 在界面中定义并人工核对；
  ② 用**多分析步手工等效**（到目标位移后改约束 / 改连接器刚度 / 用 `ElemDeathLive`）。⛔ 不要指望用 `dispLock`/`dispFail` 控制触发点。

#### ★ 动力分析下的连接器（2026-10-28，#150 / #158）

**隐式直接积分**（`AnaType.IMPLICIT` + `ImpAnaMethod.Direct`、`sTime=1.0`、`stepLen=0.005`、`dampRatio=0`），
`Fx=1000 N` 阶跃作用于**只经连接器传力**的节点：

- `OutImDyna/o11_NodeDisp.out` 位移峰值 `1.998040e-3 m`（= 无阻尼阶跃的 2 倍静位移）；
- `OutImDyna/o63_ConnectForce.out` 有非零内力（首帧 ≈ `1.996e3 N`，1.0 s 时 `44.9 N`）。

**显式动力**（`AnaType.EXPLICIT` + `ExAnaMethod.HalfStep`、`sTime=0.2`、`stepLen=1e-4`，同一模型）：

- `success:true`，`sep-modelcheck` / `sep-processor` / `genfea` / `result-processor` 全 `@complete`；
- ★ 结果落在 **`OutExDyna/`**（不是 `OutImDyna/`）：`o11` 两帧（`t=0.1/0.2 s`）`ux(n3)=1.970e-3 m`、
  `o63_ConnectForce.out` 内力 `−1.969e3 N`。

⇒ **连接器在隐式与显式动力下都参与总刚/质量组装并传力**，不是"只有静力有效"。
⛔ 显式步长按**最高频率**取（本例 `Link` Φ100 与 50 kg 组合 `ω≈5.7e3 rad/s`，稳定步长 ≈`3.5e-4 s`）；
⛔ 显式结果目录是 `OutExDyna/`，按 `OutImDyna/` 找会读到**上一次隐式运行的旧文件**（实测踩到）。

### 6. 约束方程### 6. 约束方程

```python
DofSlave(slave=None, master=None, coef=None)       # 主从约束：slave/master=自由度+节点，coef=系数
ConstrEqua(dofEqua=None, coef=None)                # 标准约束方程
```

## 最佳实践

0. **int 参数必须取 `enums` 中对应枚举类的值，不要传裸数字**；
1. 主从方向别反：`tar*` 为主（靶），`src*` 为从（源）；
2. 耦合 + 参考点是施加面内集中力的推荐做法，优于单点直接加载；
3. 接触分析优先 `SurfToSurf`（挤压类）；`NodeToSurf` 用于破坏/穿透类；
4. 全局接触处理方式由 `Setting(iContactMethod=...)` 控制
   （`ContactMethodCtrl.Lagrange / SuperElement / EquivalentTied`），与接触对的
   `ContactMethod` 是两个层级，勿混淆。
5. 嵌入仅支持 Link/壳单元嵌入实体，且目前仅节点嵌入单元（`EmbededType.NodeToElem`）；
6. 接触对参数按用户手册取值：作用间隙 `slipTol`（默认 0）、罚系数 `penalty`（默认 0.1）、
   摩擦系数 `mu`（默认 0）；离散类型为点-面接触时源面可补充节点（允许为空）。
7. 耦合 `tarNode` 为单个主节点号、`srcNodes` 可多个（节点号或 `Nset.id`）；`iKey=DofMode.Custom` 时 `iDofs` 不能为空；同一节点不得同时作一个耦合的主、从节点。
8. ★ **做多子系统对照模型（自核查 / 参数对照）时**：各子系统在空间上**错开坐标**、节点编号互相独立——既满足「同坐标必须共享 `Node`」的平台校验，又不会让子系统互相干扰（2026-10-22 复核）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 绑定不生效 | tar/src 传了节点号而类型选了 SurfToSurf | 类型与对象层级匹配（点-点/点-面/面-面） |
| 耦合后约束异常 | `iKey=Custom` 但没给 `iDofs` | 给 iDofs 或改 Both/Translation |
| 接触不闭合 | 表面法向反了 | 检查 Contactor 的 side（面单元正 1 反 2） |
| 连接器无刚度 | ConnectorSection 的 consElas=0 | 填实际刚度值 |
| `NameError: name 'cs' is not defined`（紧跟 `Connector(... iSects=[cs.id])`） | 截面对象在 `try:` 内创建、构造**失败**后 `try` 外仍引用 `cs.id` ⇒ 真正的构造异常被 NameError 盖掉（2026-10-22 实机踩到） | `cs = None` → `try` 内构造 → 失败则**回退合法截面或直接收口**，再统一用 `cs.id`；结论文件里要能区分「构件层构造失败」与「modelcheck 结果」 |
| 平台校验报 `几何错误: 节点坐标 (x,y,z) 重复定义`（多子系统自对照模型） | 各子系统之间坐标重叠（如三个子系统都用 `(1,0,0)` 当接缝点） | 各子系统在空间上**错开坐标**（错开 10 m 量级；保持节点创建顺序即可）；⛔ 不要靠「共享同一 `Node`」合并——那会把独立子系统连成一个结构、改变力学行为。另：此类模型的 `save_script`「连通性异常」警告属**预期假阳性**（#114） |
| 约束方程报错 | dofEqua 结构层级错 | 按 `[[dof, nid], ...]` 结构核对 |
| 嵌入不生效/报错 | 从单元非 Link/壳，或主单元非实体 | 嵌入仅支持 Link、壳单元嵌入实体，且仅节点嵌入单元 |
| 接触判定异常（漏判/误判） | `slipTol`（作用间隙）取值不当 | 接触面距离在作用间隙内才判定为接触，默认 0 |
| 耦合约束自冲突 | 同一节点同时出现在主、从节点 | 一个节点不能同时存在于同一个耦合的主、从节点 |

## 验证清单

- [ ] 主从方向正确（tar 主 / src 从）
- [ ] 集合用 Nset/Elset 的 `.id`
- [ ] 接触对两侧 ContactSet 法向相对
- [ ] 嵌入从单元仅为 Link/壳、主单元为实体（节点嵌入单元）
- [ ] 接触对 `slipTol`/`penalty`/`mu` 按作用间隙/罚系数/摩擦系数显式取值
- [ ] 耦合 `tarNode` 为单节点号且不在 `srcNodes` 中；`iKey=Custom` 时 `iDofs` 非空
- [ ] 每个 Connector 的 iDofs 与 iSects 一一对应
- [ ] 交付脚本**未用连接器阻尼减震**（`consDamp`/`dampCoefs` 实测无作用，见 §5「阻尼三选一」）；阻尼改用**分析级阻尼**
- [ ] 非线性本构（`elastics`/`plastics`）配 `iNLType=NLType.MaterNonlinear`（**不是** `NLType.Linear`，该成员不存在）
- [ ] 转动连接器 `iDofs` 写 `[Dof.Phx]`；平动连接器写 `[Dof.Ux]`（写别的自由度**静默零**）
- [ ] `iCoord` 只用 `Auto` 或 `Fixed`+`vy`（`Follow` 会让 genfea 报 `setConnectionElem有错`）；需要局部系时别指望 `vx`
- [ ] `keyFriction`/`keyFail`/`keyLock` **一律不用**（空限值 → `sep-processor` 崩 `0xc0000005`；给了限值也不按阈值触发：`dispLock`/`dispFail` 的数值大小不影响结果，一开即"锁死/断开"）
- [ ] `Binding` 用**默认容差**（`iTol` 默认＝自动，⛔ 不自定义 `tol`）；建好后核对「从节点有荷载却位移全 0」⇒ 绑定没建上（不报错、`success:true`）
- [ ] 显式动力结果在 **`OutExDyna/`** 取（`OutImDyna/` 会残留上一次隐式运行的旧文件）
- [ ] 截面/单元对象构造失败时不继续引用 `.id`（先置 `None` + 收口），结论文件区分「构件层失败」与「modelcheck 结果」
