# 相互作用（绑定 / 耦合 / 嵌入 / 接触 / 连接器 / 约束方程） — 参考文档（结构·混合路线）


## 概述

**覆盖范围**：`Binding`（绑定）、`Coupling`（耦合）、`Embeded`（嵌入）、
`ContactSet`+`Contactor`+`ContactPair`（接触面与接触对）、`ConnectorSection`/`Connector`（连接器）、
`DofSlave`（主从约束）、`ConstrEqua`（标准约束方程）、`SurfaceFEM`/`ContactFEM`/`RigidWall`。
本文**自包含**：混合路线在 `FemModel.fromViewer()` 之后就是有限元侧的工作，所需的全部细节写在这里，
不需要再去查别的技能。

### ★ 路线结论（2026-10-12 实测，pypcae 2.1.0）

1. 本文所有类的入参**只接受节点号 / 单元号 / 集合号**（`tarNodes`/`srcNodes`/`tarElems`/`srcElems`/
   `start`/`end`/`slave`/`master`/`att`），**没有一个接受构件号** → 相互作用**只能写在
   `FemModel.fromViewer()` 之后**；**纯几何路线（`examples/stru/`）布置不了相互作用**，
   需要相互作用就必须走混合路线；
2. 几何阶段建的相互作用**不会**随网格带入；`fromViewer()` 之后创建才注册成功
   （实测 `Binding.all()` 计数 +1、`Binding.all()[0].tarNodes` 可读回）；
3. **集合号一律是负数**：`Nset`/`Elset`/`ContactSet` 的 `.id` 实测为 `-2`、`-3`…，
   序列化时负号就表示"这是集合引用"（同理 `Fixed.gnids=[-3]`、`Elload.geids=[-2]`）。
   传集合时用 `[ns.id]`（列表里放负号集合号），不要手工加负号；
4. 网格后编号一律重新取：`Node.all()`（`.x/.y/.z`）、`Element.all()`（`.dimension` = 1 梁 / 2 壳 / 3 实体），
   或用几何阶段 `Elset` 派生出的 `xxx(elem)` / `xxx(node)` 集合（见 `shared_api.md` 阶段划分总表）。

### 选型速查

| 需求 | 用哪个 | 主从对象 |
|---|---|---|
| 两部件永不分离（焊接 / 胶接 / 螺栓等效） | **`Binding`** | 节点↔节点、节点↔面（面↔面暂不开放） |
| 一片区域跟随一个参考点（加载点 / 刚域 / 端面板） | **`Coupling`** | 1 个主节点 ↔ 多个从节点 |
| 钢筋、嵌入件埋入实体 | **`Embeded`** | 从 = Link/壳单元，主 = 实体单元 |
| 可分离 / 可滑移界面（挤压、碰撞、开挖） | **`ContactPair`**（+ `ContactSet`/`Contactor`） | 靶面 ↔ 源面 |
| **两点之间**的弹簧 / 阻尼连接 | ★ **`Connector`**（2026-10-15 实机验证可用，#115） | 见 §5 |
| **接地**弹簧（节点 ↔ 大地） / 隔震 | `ElasSupport` / `IsolationBearing` | ⛔ `ElasSupport` **只能接地**，无法连接两个节点；两点连接必须用 `Connector` |
| 自由度线性方程（u_A = c·u_B、u_A + u_B = 0） | **`DofSlave`** / **`ConstrEqua`** | 从自由度 ↔ 主自由度 |

## 核心 API

### 0. 实测签名总表（pypcae 2.1.0，构造一律关键字传参）

```python
Binding(tarNodes=None, srcNodes=None, type=2, iKey=0, iTol=1, tol=-1)
Coupling(tarNode=None, srcNodes=None, type=0, iKey=0, iDofs=None)        # ★ tarNode 单数
Embeded(tarElems=None, srcElems=None, type=0, iKey=0, tol=-1)
ContactSet(name='', contactors=None)                                     # 接触面（一组 Contactor）
Contactor(att=None, side=None, nids=None)                                # att=单元号, side=面号
ContactPair(tarElems=None, srcElems=None, type=0, iMethod=0, penalty=0.1, slipTol=0, mu=0)
Connector(start=None, end=None, iDofs=None, iSects=None, iCoord=0, vy=None, vx=None)
#   ★ 2026-10-30 版手册：vy/vx = 局部 Y/X 轴方向向量；两者都缺省→自动算局部系；仅缺 vx→按起止节点连线算 vx；
#     并称 iCoord=ConnCoordType.Global（固定总体系）时 vx/vy 不生效（⚠️ 该枚举成员本机运行时缺失，见 ERRATA #161）
ConnectorSection(name='', iType=0, keyStiff=0, consElas=0.0,
                 elastics=None, m=0.0, plastics=None,        # ★ 2026-10-16 版手册新增（刚度非线性本构）
                 keyDamp=0, consDamp=0.0, dampCoefs=None,    # ★ 2026-10-22 版手册新增（阻尼本构）
                 keyFriction=0, keyFail=0, keyLock=0)        # ★ 运行时签名实测一致（2026-10-22 inspect.signature）
DofSlave(slave=None, master=None, coef=None)                             # master 是 list[list]
ConstrEqua(dofEqua=None, coef=None)
SurfaceFEM()   ContactFEM()   RigidWall()                                # 无参构造，属性后置
Nset(name='', ids=None)   Elset(name='', ids=None)
```

枚举实测成员（`enums.md` 同步收录）：
`BindingType`: `SurfToSurf` / `NodeToSurf` / `NodeToNode`（默认 2）；
`CouplingType`: `Rigid` / `Flexible`；`EmbededType`: `NodeToElem` / `NodeToNode`；
`ContactType`: `ElasToElas` / `RigidToElas`；`ContactMethod`: `NodeToSurf` / `SurfToSurf`；
`DofMode`: `Both` / `Translation` / `Custom`（`Custom` 仅耦合有效）；
`ConnSectType`: `Translation` / `Rotation`；`ConnCoordType`: `Auto` / `Fixed` / `Follow`；
`ConnDampType`: `Off` / `Constant` / `Nonlinear`（★ 2026-10-22 版手册补齐配对：`Constant`→`consDamp`、`Nonlinear`→`dampCoefs`）；
`ContactMethodCtrl`: `Lagrange` / `SuperElement` / `EquivalentTied`（全局设置用）。

### 1. 绑定 `Binding`（最常用，重点）

| 参数 | 含义与取值 |
|---|---|
| `tarNodes` | **靶（主）**：节点号列表，或 `[Nset.id]`（负号集合号）。实测两种都接受 |
| `srcNodes` | **源（从）**：同上。★ 主从次序**不可反**（界面的"交换靶/源"= 互换这两个列表） |
| `type` | `BindingType.NodeToNode`（点-点，默认 2）/ `NodeToSurf`（点-面）/ `SurfToSurf`（面-面，**手册注明暂不开放**，脚本优先点-点、点-面） |
| `iKey` | `DofMode.Both`（平动+转动，默认 0）/ `DofMode.Translation`（仅平动） |
| `iTol` | 容差模式：`-1` 强制绑定 / `0` 自动 / `1` 自定义（默认 1） |
| `tol` | 自定义容差值；`<0` 表示自动（默认 -1） |

**判定与容差细则**（手册 §1.2.2.7.3.1 整理）：

- **点-点**：对每个源（从）节点，搜索距离 `d` 最小的靶（主）节点，`d < tol` 才绑定；
  自动容差 `tol` = **靶（主）面单元尺寸平均值的一半**；
- **点-面**：源（从）节点投影搜索最近靶（主）单元，`d < tol` 才绑定；投影落在单元内 → `d` = 点到面距离；
  投影落在单元外 → `d` = min(点到单元边距离, 点到单元顶点距离)；自动容差 `tol = l/10`，
  `l` = 单元特征长度（四边形取两对角线均值，三角形取三边均值）；
- **三条硬性 TIPS（手册原文）**：① 注意主、从节点次序；② **同一个节点不能作为两个绑定的从节点**；
  ③ **从节点不能作为固定支座**（会被约束冲突吃掉）；
- 实测实例属性（`Binding.all()[0]`）：`tarNodes / srcNodes / tarElems / srcElems / type / iKey /
  iTol / tol / mu / slipTol / iSubType`——★ `Binding` 与 `ContactPair` 共用底层类，
  因此也带 `mu`/`slipTol`/`tarElems`/`srcElems`；绑定不需要它们，保持默认。

**★ 混合路线的"焊接模拟"标准做法**（v2026.8.2 起实测有效，2.1.0 同样适用）：

1. **几何阶段**：把要焊接的部件（环板、竖撑、加劲肋、节点板…）的内缘/端部按
   **与被焊面同坐标的独立节点**建模——即刻意**不共享** `Node` 对象（各建各的，坐标相同）；
2. 网格划分后（`fromViewer()` 之后）用 `Binding(type=NodeToNode, iKey=DofMode.Both)` 把它们绑起来；
3. 好处：① 点-点距离为 **0**，恒小于任何 `tol`，不用担心容差；② 部件之间网格可以各自独立加密；
   ③ 规避保存期的"连通性异常"启发式警告；④ 想改成"不焊"只要删掉 Binding，几何不用重建。
   ⚠ 与 #48（同坐标重复建点会被 `save_script` 判"几何错误"）冲突时：**优先共享节点**，
   只有确实需要"可拆装的焊接关系"才用独立节点 + 绑定，并在脚本注释里写明原因。

### 2. 耦合 `Coupling`

| 参数 | 含义与取值 |
|---|---|
| `tarNode` | ★ **单数**：**一个**主节点（实测传标量 `mid[0]` 或单元素列表 `[mid[0]]` 都可）；可以是**悬空节点**（独立建的加载参考点），也可以是单元节点 |
| `srcNodes` | 从节点：可多个，节点号列表或 `[Nset.id]` |
| `type` | `CouplingType.Rigid`（刚性，默认 0）/ `Flexible`（分布/柔性） |
| `iKey` | `DofMode.Both`（全部自由度）/ `Translation`（仅平动）/ `Custom`（指定自由度） |
| `iDofs` | `iKey=Custom` 时**必给且非空**：从 `Dof.Ux/Uy/Uz/Phx/Phy/Phz` 中选 |

- 典型用途：**把端面/加载区所有节点耦合到一个参考点，集中力施加在参考点上**——
  比直接在单个节点上加集中力更真实，且避免应力奇异；
- 约束冲突：**同一节点不能同时出现在同一个耦合的主、从节点**；
- ★ **主节点（参考点）必须连转动一起约束（实测坑）**：`Coupling` 的主节点带 **6 个自由度**，只 `Fixed`
  它的 3 个平动时，绕"过该点的 X/Y/Z 轴"的 3 个刚体转动**不被任何约束阻止**（转动不移动该点本身）
  → **总刚奇异** → 解里带虚假刚体转动、`o62` 反力**全为 0**，而 `run_script` 仍返回 success、日志仍写
  "任务执行成功!"（静默奇异解，`references/stru/known_issues.md` #69）。做法：**加载侧参考点留空、支承侧参考点写
  `Fixed(gnids=[rp.id], dof=[Dof.All])`**；自查用"ΣR = 总荷载" + 对网格节点做刚体运动最小二乘拟合
  （残余转角应在 1e-6 rad 量级）；
- 混合路线里参考点要在 `fromViewer()` 之后 `Node(x, y, z)` 新建（几何阶段建的节点号已作废）。

### 3. 嵌入 `Embeded`

| 参数 | 含义 |
|---|---|
| `tarElems` | **主（宿主）单元号**：必须是**实体单元** |
| `srcElems` | **从（被嵌入）单元号**：★ 仅支持 **Link 单元、壳单元** 嵌入实体；其余组合不要生成嵌入 |
| `type` | `EmbededType.NodeToElem`（节点嵌入单元，**目前只支持这种**）/ `NodeToNode`（点点绑定） |
| `iKey` | `DofMode.Both` / `Translation` |
| `tol` | 嵌入容差，**暂时保留，保持默认 `-1`** |

- 建模要点：从单元（钢筋 Link、预埋件壳）**直接建在主单元（实体）内部区域**即可，
  程序按位置关系自动完成节点绑定，不需要手工配对；
- ~~混合路线里钢筋可以在几何阶段用 `Line` + `SectionType.Line`（小直径圆截面）建~~
  **★ 2026-10-14 实机更正（P0，旧写法必然失败，见下条）**；
- 网格后仍按 `Element.all()` 的 `dimension==1` 取钢筋单元、`==3` 取实体单元（**筛选方式不变**）。

#### ★ 钢筋嵌入实体的构件选型（2026-10-14 实测，pypcae 2.1.0）——旧指引与上表自相矛盾，以本条为准

`Embeded` 的从单元**只接受 Link（二力杆）与壳单元**，求解器在 **genfea 阶段**用 `judgeEmbedElemType` 校验，
不合格**直接终止**：

```text
[ genfea ] **Error:judgeEmbedElemType出错: 不允许梁单元嵌入,可在界面放开该限制
[ genfea ] exit status 0xffffff9c
[任务日志] @failure
taskService @Start returns: success->false retMsg->:sep-processor
```

因此几何阶段的钢筋**必须**写成 `BeamColumn(iMark=ComponentType.TRUSS, sid=<SectionType.Line + Circle>)`，
**不能**写 `Line(...)`——后者网格后是**梁单元**，会被拒绝：

```python
# ✗ 失败：Line + 圆截面 → 网格后为梁单元 → "不允许梁单元嵌入"
Line(start=n_a.id, end=n_b.id, sid=sec_rebar.id, normal=[1, 0, 0])

# ✓ 成功：BeamColumn(TRUSS) + 圆截面 → 网格后为 Link 二力杆 → Embeded 接受
BeamColumn(nids=[n_a.id, n_b.id], iMark=ComponentType.TRUSS,
           sid=sec_rebar.id, normal=[1, 0, 0])
```

配套要点（本次全部实测）：
- 截面仍用 `SectionType.Line` + `Circle(mid=<钢筋材料>.id, d=<直径>)`，**不变**；
- `normal` 仍须给且**不得与杆轴平行**（竖向纵筋给 `[1,0,0]`、水平箍筋边给 `[0,0,1]`，同 #30）；
- 嵌入调用不变：`Embeded(tarElems=solid_eids, srcElems=rebar_eids, type=EmbededType.NodeToElem,
  iKey=DofMode.Both, tol=-1)`——实测 128 个 Link 单元 / 136 个钢筋节点**全部嵌入成功**；
- **建筑材料与构件体系可与通用几何构件共存**：实测 `Solid`（通用几何）与 128 个 `BeamColumn(TRUSS)`
  （建筑结构）**同模型混合建模、正常划网格、正常求解**；
- ⚠️ **该错误不在建模 / 网格 / 模型检查阶段暴露**：三者全部通过（`ModelCheckResult.json` =
  `{"error":{},"warning":{}}`）、`18_Embedding.inp` 也正常写出（19543 B），**只在求解器读入时才报**，
  且 `run_script` 的 `msg` 会误指向 `:sep-processor`（见 `error_diagnosis.md`「`msg` 不可作为定位起点」）；
- ⚠️ **TRUSS 构件的网格分段不受 `basicSize`/`beamSize` 控制**（每构件仅 1 单元），
  须据此重估单元规模——详见 `mesh.md` §10；
- ★ **验证 `Embeded` 是否真的生效**（嵌入不生效时**不报错**、`18_Embedding.inp` 照样写出，只能这样验）：
  **钢筋节点数 × 3 应恰好等于 `neq` 的减少量**（本例 136 × 3 = 408）——
  见 `error_diagnosis.md`「`neq` 差值核账法」。

### 4. 接触：`ContactSet` + `Contactor` + `ContactPair`（三件套，缺一不可）

```python
# ① 先定义接触面：一个 ContactSet = 一组 Contactor（单元号 + 面号）
cs_a = ContactSet(name="surf_A", contactors=[Contactor(att=eid, side=2) for eid in face_a_eids])
cs_b = ContactSet(name="surf_B", contactors=[Contactor(att=eid, side=1) for eid in face_b_eids])
# ② 再定义接触对：tarElems/srcElems 传的是 **ContactSet 号**（负数），不是单元号
ContactPair(tarElems=[cs_a.id], srcElems=[cs_b.id],
            type=ContactType.ElasToElas, iMethod=ContactMethod.SurfToSurf,
            penalty=0.1, slipTol=0.0, mu=0.3)
```

| 参数 | 含义与取值 |
|---|---|
| `Contactor.att` | **单元号** |
| `Contactor.side` | ★ **面号，必须显式给**：面单元"正面 1 / 反面 2"；体单元面号见手册附录「体单元面号」。用 `Contactor(nids=[...])` 让程序自动识别面号会触发 `identifySideByCell` 内部 `IndexError: list index out of range`，脚本阶段即崩溃（v2026.8.2 实测 #38） |
| `ContactPair.tarElems` / `srcElems` | 靶面 / 源面 = **`ContactSet` 的 `.id`**（负号集合号） |
| `type` | `ContactType.ElasToElas`（弹-弹，默认 0）/ `RigidToElas`（刚-弹） |
| `iMethod` | 离散方式：`ContactMethod.SurfToSurf`（面-面，**挤压类优先**）/ `NodeToSurf`（点-面，破坏/穿透类） |
| `penalty` | 罚系数 = 接触刚度折减系数；**手册默认 0.1**，但脚本预定义形参是 `-1` → 需要控制时**显式传 0.1** |
| `slipTol` | **作用间隙**：接触面距离在此间隙内才判定为接触；默认 0 |
| `mu` | 摩擦系数；默认 0（无摩擦） |

- ★ **两侧接触面法向必须相对**（`side` 一个取正一个取反）；法向同侧会导致接触不闭合、算出穿透或"不接触"；
- **两个层级不要混淆**：全局接触处理方式在 `Setting(iContactMethod=ContactMethodCtrl.Lagrange /
  SuperElement / EquivalentTied)`；接触对内部的离散方式是 `ContactPair.iMethod`（`ContactMethod`）；
- 点-面接触时界面上还能定义"源面补充节点"，**脚本侧 `ContactPair` 无对应形参**（需要时用面-面）；
- 接触是**非线性**：必须配 `AnalySetting(iNLType=...)`、多 `Step` 分级加载（`nSubstep` 不生效），
  并建议先 `mu=0` 无摩擦试算跑通再加摩擦（见 `analysis.md`）。

### 5. 连接器 `ConnectorSection` + `Connector`（★ 2026-10-15 实机验证可用，原"不可用"结论已推翻）

> **历史结论作废**：原记载（v2026.8.2）"含 `Connector` 的模型在 `sep-modelcheck` 崩溃 `0xc0000409`"
> **已在同版本环境复测推翻**——`sep-modelcheck` 正常 `@complete`、`ModelCheckResult.json` =
> `{"error":{},"warning":{}}`、求解正常结束、连接器内力有输出，且**与串并联弹簧理论解偏差 ≤0.0002%**。
> 详见 `references/stru/known_issues.md` **#115**。
> ★ **2026-10-22 修订版手册复核（`references/stru/known_issues.md` #145）**：手册 §2.7.5「连接器截面」/ §2.7.6「连接器」
> 与 `ConnSectType`/`ConnStiffType`/`ConnDampType`/`ConnFrictionType`/`ConnFailType`/`ConnLockType`/`ConnCoordType`
> 七组枚举**与上一版逐字节一致**（`ConnectorSection` 仍为 12 形参、`Connector` 仍为 7 形参）⇒ **连接器内容无失效**。

```python
# ★ 手册两轮扩展：2026-10-16 版加 elastics / m / plastics（刚度非线性）；2026-10-22 版再加 consDamp / dampCoefs（阻尼）
# ★ 运行时签名与新版手册完全一致（2026-10-22 实机 inspect.signature 实测）
ConnectorSection(name='', iType=ConnSectType.Translation, keyStiff=ConnStiffType.Linear,
                 consElas=0.0,
                 elastics=None, m=0.0, plastics=None,        # 刚度：非线性弹性表 / 混合硬化参数 / 弹塑性表
                 keyDamp=ConnDampType.Off, consDamp=0.0, dampCoefs=None,   # 阻尼：常阻尼 / 阻尼力-速度表
                 keyFriction=ConnFrictionType.Off,
                 keyFail=ConnFailType.Off, keyLock=ConnLockType.Off)
Connector(start=<节点号>, end=<节点号>, iDofs=[...], iSects=[...],
          iCoord=ConnCoordType.Auto, vy=None, vx=None)
```

| 参数 | 含义与实测要点 |
|---|---|
| `ConnectorSection.iType` | `ConnSectType.Translation`（平动）/ `Rotation`（转动）。★ **2026-10-28 实测两者均可用**：平动的 `iDofs` 写 `[Dof.Ux]`、转动的写 `[Dof.Phx]`（写别的自由度**静默零**）；转动 `consElas` 单位 = N·m/rad（详见 fem 技能 `interactions.md` §5，#149） |
| `ConnectorSection.keyStiff` | `ConnStiffType.Linear`（线弹性，**2026-10-15 已实机验证**）/ `Nonlinear` / `MetalPlastic`（后两者**手册已给形参，但未实机验证**，见下「刚度本构三选一」） |
| `ConnectorSection.consElas` | **常刚度**，单位随单位制（SI = N/m）。★ `keyStiff=Linear` 时**必须填实际刚度，填 0 = 无刚度**（等于没建） |
| ★ `ConnectorSection.elastics` | **2026-10-16 版手册新增**：`keyStiff=Nonlinear`（非线性弹性）时的**荷载–位移**数据表，`[[F1,u1],[F2,u2],…]`——第一维为采样点数、第二维长度 **2**（第 1 列荷载、第 2 列位移）。落盘为 `19_ConnectSect.inp` 的 `numElas` + `elasCoefs(:,1:2)`。**未实机验证** |
| ★ `ConnectorSection.m` | **2026-10-16 版手册新增**：`keyStiff=MetalPlastic` 时的**混合硬化参数**——**0 = 随动硬化 / 1 = 等向硬化 / 0<m<1 = 混合硬化**（默认 0）。落盘为 `19_ConnectSect.inp` 的 `M`。**未实机验证** |
| ★ `ConnectorSection.plastics` | **2026-10-16 版手册新增**：`keyStiff=MetalPlastic` 时的数据表。⚠️ **列义与 `elastics` 不同**——求解器表头明确为「**屈服荷载 - 塑性位移**曲线（第 1 列屈服荷载，第 2 列**塑性**位移）」，**不是总位移**；按总位移填会得到偏硬的骨架曲线。落盘为 `numPlas` + `plasCoefs(:,1:2)`。**未实机验证**（`references/stru/known_issues.md` #119） |
| ★ `ConnectorSection.keyDamp` | `ConnDampType.Off`（默认）/ `Constant`（常系数阻尼）/ `Nonlinear`（非线性阻尼）——**2026-10-22 版手册补齐**了它与下面两个形参的配对关系（此前文档只有枚举名、无配对，见 `references/stru/known_issues.md` #119） |
| ★ `ConnectorSection.consDamp` | **2026-10-22 版手册新增**：**常阻尼**，`keyDamp=Constant` 时生效（标量，单位随单位制）。落盘为 `19_ConnectSect.inp` 的 `consDamp`。⚠️ **未实机验证** |
| ★ `ConnectorSection.dampCoefs` | **2026-10-22 版手册新增**：`keyDamp=Nonlinear` 时的**阻尼力–速度**数据表，`[[F1,v1],[F2,v2],…]`——第一维为采样点数、第二维长度 **2**（**第 1 列阻尼力、第 2 列速度**，注意与刚度表的「荷载-位移」列义不同）。落盘为 `numDamp` + `dampCoe…(:,1:2)`。⚠️ **未实机验证** |
| `Connector.iDofs` / `iSects` | 自由度号 ↔ 连接器截面号，**一一对应**（`iDofs` 用 `Dof.Ux` 等枚举；落盘 `19_ConnectElem.inp` 里 `iDofs=1` 即 Ux） |
| `Connector.iCoord` | `ConnCoordType.Auto`（总体系）/ `Fixed` / `Follow`。★ **2026-10-28 实测**：`Auto` 与 **`Fixed`+`vy` 可用**（结果与 Auto 逐位相同；**`vx` 会被丢弃**，`19_ConnectElem.inp` 只写 `cNum=1` + 局部 y）；**`Follow` 不可用** —— genfea 报 `**Error:setConnectionElem有错`（#150） |
| `start` / `end` | 两个**节点号**（★ 该处**不支持集合**，见 `19_ConnectElem.inp` 头注释 `iNodes(2) ! 连接单元节点号(该处不支持集合)`） |

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
> 以求解器表头为准（`references/stru/known_issues.md` #119）。

**★ 阻尼三选一：`keyDamp` 决定该填哪组参数（2026-10-22 版手册补齐）**

| `keyDamp` | 阻尼模型 | 必填参数 | 数据表含义 | 求解器侧字段（`19_ConnectSect.inp` 表头） | ★ 2026-10-22 实机结论 |
|---|---|---|---|---|---|
| `ConnDampType.Off`（0，默认） | 无阻尼 | — | — | `keyDamp=0` | 起点（对照）|
| `ConnDampType.Constant`（1） | 常系数阻尼 | ★ **`consDamp`**（标量） | 常阻尼系数 | `keyDamp`、`consDamp` | ⛔ **2026-10-22 实机：能落盘但无作用**（与无阻尼对照**位级相同**，`1e4`/`1e6` 两量级均如此；#139） |
| `ConnDampType.Nonlinear`（2） | 非线性阻尼 | ★ **`dampCoefs`** | **阻尼力–速度**表：`[[F1,v1],[F2,v2],…]`，第一维=采样点数，第二维长度 **2**（**第 1 列阻尼力、第 2 列速度**） | `keyDamp`、`numDamp`、`dampCoefs(:,1:2)` | ⛔ **2026-10-22 实机：脚本层不可用**——2 维表**构造期报 `ValueError: 维度超标`**（源码 `normalize_numbers_to_list` 默认 `expected_dims=1`）、扁平表使 **`sep-modelcheck` 崩溃 `0xc0000409`**（#139） |

> ⛔ **2026-10-22 实机验证结论（务必先读，`references/stru/known_issues.md` #139）**：**整个"连接器阻尼"目前都不能用于脚本侧动力分析**——
> `consDamp` 落盘正确（`19_ConnectSect.inp` → `1 1000000 0`）却**对响应毫无影响**（同模型内"无阻尼"对照子体系**位级相同**；
> 隐式直接积分 + 显式 HalfStep 两条路径、`consDamp=1e4`/`1e6` 两种量级均如此；同模型改**分析级阻尼**则时程明显变化，排除测量失灵）；
> `dampCoefs` **两种形状都不通**（2 维表构造期 `ValueError`；扁平表 `sep-modelcheck` 崩溃 `0xc0000409`）。
> ⇒ **需要阻尼请用分析级阻尼**（`AnalySetting(iDampType=AnaDampType.RatioToMass, dampRatio=…)`）或在界面定义；本库示例/模板不得依赖连接器阻尼。

> ⚠️ **别把三张表的列义搞混**：`elastics`/`plastics` 是「**荷载–位移**」（第 2 列是位移，`plastics` 特指**塑性**位移），
> `dampCoefs` 是「**阻尼力–速度**」（第 2 列是**速度**）。

> ★★ **`dampCoefs` 的正确写法与「两段式失败」（2026-10-22 实机复核，`references/stru/known_issues.md` 技能二 #139/#146）**
> - **手册形状 = 二维表**：`dampCoefs=[[F1,v1],[F2,v2],[F3,v3]]`（第一维 = 采样点数；第二维长度 **2**：
>   第 1 列**阻尼力**、第 2 列**速度**）⇒ 落盘 `19_ConnectSect.inp` 的 `numDamp` + `dampCoefs(:,1:2)`。
>   ⛔ **不是**扁平一维表 `[F1,v1,F2,v2,…]`——那不是手册形状，不能当「等价写法」。
> - **现状（构建 v2026.10.1.14_4，2026-10-22 实测）**：
>   ① **二维表**（正确写法）在**构造期**即抛 `ValueError: 维度超标: 在深度 1 处遇到了列表，但期望在深度 1 处结束`
>      —— `comp/connector.py` 对 `elastics`/`plastics`/`dampCoefs` 一律调 `normalize_numbers_to_list(x)`，
>      该函数默认 `expected_dims=1` ⇒ **厂商侧缺陷**，`elastics`/`plastics` 同族；
>   ② **扁平表**能通过 Python 构造并落盘，但会让 `sep-modelcheck` 崩溃 `exit status 0xc0000409`
>      （**不产生** `genfea-compute-*` 目录，更难排查）。
> - ⇒ **两条路都不可用，也都不要写进交付脚本**：⛔ 别为了「绕过构造报错」改传扁平表（只是把错误推迟到 modelcheck 崩溃）；
>   需要阻尼请用**分析级阻尼**（上方 ✅ 写法）或在**界面中定义**非线性阻尼。
> - ⚠️ 构造 `ConnectorSection` **失败时不要继续引用 `cs.id`**（会抛 `NameError`，把真正的构造异常盖掉）：
>   先 `cs = None`，失败则回退或直接收口 —— 见「常见错误」。

> ⛔ **2026-10-22 实机定位：连接器的传力方向 = 它自己的轴向，`iDofs` 必须写 `Dof.Ux`(1)**
> 9 次运行矩阵：轴向 X/Y/Z 三种布置下，**只要 `iDofs=[Ux]` 都能沿该轴传力**（轴 Y + Fy ⇒ uy=6.18e-3/7.18e-3、Ry=−1000；
> 轴 Z + Fz ⇒ uz=6.18e-3/7.18e-3、Rz=−1000）⇒ **`iDofs=1` 的语义是「沿连接器轴向的平动弹簧」，与全局 X 无关**。
> · `iDofs=[Dof.Uy]`(2) ⇒ **静默零**（位移/反力全 0、无报错、`neq` 仍计入该 DOF）；· `iDofs=[Ux,Uy]` ⇒ **只有第一项有效**（Y 向静默零）；
> · `iDofs=[Dof.Uz]`(3) ⇒ **同样不建弹簧**：多数布局**静默**，自由度成对悬空时升级为 **`zero pivot` 硬失败**（`solveLinearEquaOne出错`）。
> ⇒ **要哪个方向传力就把连接器沿哪个方向布置**；要 X+Y 就建两个连接器；⛔ 不要用 `iDofs` 指望去耦合多个方向。
> 自查：某方向「荷载无响应、无位移、无反力」→ 先查该连接器轴向与 `19_ConnectElem.inp` 的 `iDofs`；
> ⚠️ `neq` **不能**用来判断弹簧是否建立（详见 `references/stru/known_issues.md` #141；另一技能 #135）。

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

> ★★ **连接器能力总表（2026-10-28 实机复核，构建 `pypcae 2.2.1` / `last release 20261030`；两路线共用同一套连接器类）**
>
> | 能力 | 状态 | 关键结论 |
> |---|---|---|
> | 平动 + 线弹性 + `consElas` + `Auto` + 静力 | ✅ | ±1000 N 全量传力、偏差 +0.0002%（#115） |
> | `elastics`（`Nonlinear`） | ✅ | **逐点守表**（`ux` 1.50062e-3 / 5.00309e-4 / ≈0）（fem #145） |
> | `plastics`+`m`（`MetalPlastic`） | ✅ | 加载 = `F/K`+`up`（3.00062e-3）、卸载残余 = 塑性位移（2.000e-3）且内力 0（fem #145） |
> | `ConnSectType.Rotation` | ✅ | `Phx` 与串联解析逐位吻合；`iDofs=[Dof.Phx]`（fem #149） |
> | `iCoord=Fixed`+`vy` | ✅ | 结果同 `Auto`；**`vx` 被丢弃**（fem #150） |
> | `iCoord=Follow` | ⛔ | genfea `**Error:setConnectionElem有错`（fem #150） |
> | `keyDamp=Constant/Nonlinear` | ⚠️ | 能构造能落盘，**动力中静默无作用**；`dampCoefs` 只有二维表合法（扁平表构造期 `ValueError: 维度不足`）（fem #146） |
> | `keyFriction`/`keyFail`/`keyLock` | ⚠️ | 限值（`frictCoef`/`dispFail`/`dispLock`）**只能构造后属性赋值**；⛔ 只置 `On` 不给限值 → **`sep-processor` 崩 `0xc0000005`**；线性静力下 lock/fail 不触发（fem #151） |
> | 动力（隐式 Direct）传力 | ✅ | `OutImDyna/o63` 有非零内力（首帧 ≈1.996e3 N）（fem #152） |
>
> ⚠️ **仍未验证**：这三个开关的**触发语义**（限值参考系、`iFricTag/iFailTag/iLockTag` 描述方式，手册未给）。> 如 `consDamp`/`dampCoefs`/`frictCoef`/`dispFail`/`lockStiff`，但脚本侧形参能否正确落盘未测）。

**★ 三条硬约束（实测得出，违反即失败）**：

1. **模型至少要有一个单元**——只有"节点 + 连接器"的**零单元模型**会在 `genfea` 报
   `**Error:readElemLoadInfo出错:*elemLoad:-1`（`exit status 0xffffff9c`）而失败；
   且 `sep-modelcheck` 会先给出前兆信号 `**Error:模型未定义截面!` / `**Error:模型未定义材料!`
   （没单元 → 没截面/材料被引用），**别误判成材料截面写错**（#116）；
2. **连接器两端节点要有约束兜住其余自由度**——本例只放开 `Ux`，故对中间节点写
   `Fixed(gnids=[...], dof=[Dof.Uy, Dof.Uz])`；否则未约束自由度会导致总刚奇异；
3. **只能写在 `FemModel.fromViewer()` 之后**（只认节点号，几何阶段建的不会带入，见 `shared_api.md`）。

**★ `Connector` vs `ElasSupport` 选型（两者不是替代关系）**：

| 需求 | 用哪个 | 原因 |
|---|---|---|
| **两个节点之间**的弹簧 / 阻尼 | ★ **`Connector`** | `ElasSupport` **只能接地**（节点 ↔ 大地），无法连接两个节点 |
| 节点 ↔ **大地**的弹簧（土弹簧、侧移弹簧） | `ElasSupport` | 写法更简、`kx/ky/kz` 直接给 |
| 隔震支座 | `IsolationBearing` | 专用类型 |

**落盘核对（存在性核对，不评判结果）**：

| 文件 | 内容 |
|---|---|
| `genfea-compute-*/19_ConnectSect.inp` | `*connectSect` 段：`iNum, iType, nameStr` / `keyStiff, consElas, M, numElas, elasCoefs(:,1:2), numPlas, plasCoefs(:,1:2)` / `keyDamp, consDamp, numDamp, dampCoefs` / `keyFriction, frictCoef, frictRadius, relaDof, numFrict, iFricTag, extruForce` / `keyFail, iFailTag, dispFail(1:2)` / `keyLock, lockStiff, iLockTag, dispLock(1:2)`。★ **表头注释即各参数权威语义来源**（本次即据此判定 `plastics` 第 2 列是塑性位移） |
| `genfea-compute-*/19_ConnectElem.inp` | `*connectElem nNum` 段：`iNum, iType, iNodes(1:2), mDof, iCoord` / `iDofs` / `iSects` / `cNum, coords` |
| `genfea-compute-*/OutStatic/o63_ConnectForce.out` | **连接器内力**（总体系）：`*connectForce nStep nConn` → 每步 `iStep, time` → `iConn, m(=2)` → 每节点 `iNode, Fx,Fy,Fz,Mx,My,Mz` |

> **实测数据（构型 C：连接器为唯一传力路径，最硬判据）**：n3 不挂任何单元、荷载 100% 经连接器 →
> `o63_ConnectForce.out` 内力 = **±1000 N（= 全部施加荷载）**、`ux(n3) = 1.00062e-3 m`
> （串联通刚度理论解 `1.000618e-3`，偏差 **+0.0002%**）、n1 反力 `−1000 N` 平衡。
> ⇒ **连接器确实参与总刚组装并传力**，不是"写了不报错但不起作用"。
> 端到端示例：`../examples/mixed/connector_spring_series.py`。

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

**★ 已收口的验证范围（2026-10-28，两轮）**：平动/转动两种 `iType`、Linear/Nonlinear/MetalPlastic 三种刚度本构、
`Auto`/`Fixed` 两种坐标系、静力（线性 + 材料非线性）、**隐式动力与显式动力**均已实机跑过（fem #145~#158）；
`Follow` 坐标系（不可用）、连接器阻尼（无作用）均有明确结论。

**⛔ 三个开关的最终口径（2026-10-28 补验，fem #157）**：`keyLock`/`keyFail` 的 `dispLock`/`dispFail`
**不是"达到该位移才触发"的阈值** —— `dispLock` 取 `5e-4` 与 `2e-3` 结果**逐位相同**（`ux` 均 `1.0062e-4`、
卸载后 `1.0000e-4`）；`keyFail` 的 `dispFail=2e-3`（**大于**实际相对位移 `1e-3`）仍**立即断开**（`o63` 内力 0、
受荷节点位移放大到 `5.655e5 m` 量级）；`keyLock` 单子步锁死时 `o63` 内力 `±5.0e11 N`（= `lockStiff(1e15)×5e-4`）。
⇒ **交付脚本一律不用这三个开关**；需要"拉断/限位"用界面定义或多分析步手工等效（改约束/改刚度/`ElemDeathLive`）。

**★ `iCoord` 与 `vy`/`vx` 的手册口径 vs 运行实况（2026-10-29，ERRATA #161）**

| 项 | 手册（2026-10-30 版） | 本机 `pypcae 2.2.1` 实测 |
|---|---|---|
| `vy`/`vx` | 局部 **Y / X 轴方向向量**；都缺省→自动算局部系；**仅缺 `vx`→按起止节点连线算 `vx`** | `iCoord=Fixed` 下**只落 `vy`**（`cNum=1`、`coords=局部 y`），**`vx` 被丢弃**；`Follow` 下写 `cNum=2` 但 genfea 报 `setConnectionElem有错`（不可用） |
| `ConnCoordType.Global`（固定总体系） | 枚举新增；`Global` 时 `vx`/`vy` 不生效 | **运行时枚举无该成员**（`hasattr=False`）⇒ 写成员抛 `AttributeError`；**传裸值 `iCoord=3` 可跑通**（落盘 `iCoord=3`、`cNum=0`） |

⇒ 需要"局部 y"用 `Fixed`+`vy`，不要指望 `vx`；要 `Global` 先 `hasattr` 核对，缺失时在交付包注明（可临时用裸值 3）。

**★ `Binding` 容差一律用默认**（2026-10-29 口径）：`iTol` 保持默认（＝自动），**不要自定义 `tol`**。
⚠️ 未绑定时**不报错**：从节点变孤立点、其上的荷载被静默忽略（`o11` 全 0、`run_script` 仍 `success:true`）
⇒ 建完绑定核对「从节点有荷载时位移是否为 0」。

### 6. 主从约束与约束方程

```python
DofSlave(slave=[...], master=[[...]], coef=[...])       # ★ master 是 list[list]
ConstrEqua(dofEqua=[[dof, nid], ...], coef=[...])       # 标准约束方程
```
- `DofSlave`：从自由度 = 主自由度的线性组合（如 `u_s = 1.0 × u_m`）；
- `ConstrEqua`：一般约束方程（如 `u_A + u_B = 0`），`dofEqua` 按 `[[dof, 节点号], ...]` 组织、
  `coef` 一一对应；层级写错会直接报错；
- 与 `Fixed` 冲突时优先只保留一种（同自由度既约束又方程 → 奇异）。

## 代码模板

### 模板 1：焊接/搭接（混合路线标准做法，`Binding` + 派生集合）

```python
init_ctx(mode=ExecutionMode.MIXED); clc()
# —— 几何阶段：两块板各自建模，交接处**刻意**用同坐标独立节点；并给两块板各建一个 Elset ——
plate_a_set = Elset(name="plate_a", ids=surf_a_ids)
plate_b_set = Elset(name="plate_b", ids=surf_b_ids)
MeshParams(sizer=Size(isBasic=True, basicSize=0.05), toQuad="true")
StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# —— 有限元阶段：网格后 Elset 自动派生 plate_a(node)/plate_a(elem) ——
nsets = {x.name: x for x in Nset.all()}            # 网格后派生的 plate_a(node) / plate_b(node)
b_nodes = set(nsets["plate_b(node)"].ids)
binding_src = [n.id for n in Node.all()
               if n.id in b_nodes and abs(n.x - X_WELD) < 1e-6]   # 从：板 B 落在焊缝位置的节点
Binding(tarNodes=[nsets["plate_a(node)"].id], srcNodes=binding_src,   # 主：整块板 A 的节点集合
        type=BindingType.NodeToNode, iKey=DofMode.Both, iTol=0)   # iTol=0 自动容差
# 核对：len(Binding.all()) == 1；同一节点不得重复作为从节点
```

### 模板 2：端面耦合到参考点加载（`Coupling` + `Cload`，避免应力奇异）

```python
# fromViewer() 之后
end_nids = [n.id for n in Node.all() if abs(n.x - X_END) < 1e-6]
rp = Node(X_END, 0.0, 0.0)                                  # 悬空参考点（FEM 阶段新建）
Coupling(tarNode=[rp.id], srcNodes=end_nids,
         type=CouplingType.Rigid, iKey=DofMode.Both)         # 或 iKey=Custom + iDofs=[Dof.Uz]
lc = LoadCase("PL")
lc.add(Cload(gnids=[rp.id], dof=[FDof.Fz], value=[-50000.0]))
```

### 模板 3：接触对（三件套 + 非线性设置）

```python
# fromViewer() 之后：按坐标/法向筛出两个接触面的单元
body_a = [e.id for e in Element.all() if e.dimension == 3 and <属于 A 的判据>]
body_b = [e.id for e in Element.all() if e.dimension == 3 and <属于 B 的判据>]
cs_a = ContactSet(name="cont_A", contactors=[Contactor(att=e, side=2) for e in face_a])  # 法向朝 B
cs_b = ContactSet(name="cont_B", contactors=[Contactor(att=e, side=1) for e in face_b])  # 法向朝 A
ContactPair(tarElems=[cs_a.id], srcElems=[cs_b.id],
            type=ContactType.ElasToElas, iMethod=ContactMethod.SurfToSurf,
            penalty=0.1, slipTol=0.0, mu=0.0)          # 先无摩擦试算
# 非线性静力：AnalySetting(iNLType=NLType.GeoMaterNonlinear)（接触常配几何+材料非线性）
#            + 多个 Step 分级加载（nSubstep 不生效）；跑通后把 mu 调到 0.3
```

### 模板 4：钢筋嵌入实体（`Embeded`）★ 2026-10-14 实测通过的完整写法

```python
# —— ① 几何阶段：钢筋必须用 BeamColumn(TRUSS)，不能用 Line（Line → 梁单元 → 被 judgeEmbedElemType 拒绝）——
MatDB.load()
mat_conc = MatDB.assemble("C30",    iType=MaterialType.Concrete, iMark=ConcreteType.C30,   setting=setting)
mat_rebar= MatDB.assemble("HRB400", iType=MaterialType.Rebar,    iMark=RebarType.HRB400,   setting=setting)
# ★ Section 用 type=（不是 iType=！iType= 是 MatDB.assemble 的，写错会 TypeError，#117）
sec_solid = Section(name="SolidSect", type=SectionType.Solid, sub=[SolidSect(mat_conc.id)])
sec_bar   = Section(name="Rebar20",   type=SectionType.Line,  sub=[Circle(mat_rebar.id, 0.020)])
sec_stir  = Section(name="Stirrup8",  type=SectionType.Line,  sub=[Circle(mat_rebar.id, 0.008)])

Solid(outer=[...6 个面 id...], sid=sec_solid.id)               # 混凝土实体（通用几何构件）
for (na, nb) in rebar_pairs:                                   # 纵筋 / 箍筋各边
    BeamColumn(nids=[na.id, nb.id], iMark=ComponentType.TRUSS,  # ★ TRUSS → 网格后是 Link 二力杆
               sid=sec_bar.id, normal=[1, 0, 0])                # normal 不得与杆轴平行（#30）
# ★ 同坐标必须复用同一 Node 对象（用 get_nid(x,y,z) 坐标缓存字典统一管理，#9/#48）
# ★ 网格设置（MeshParams/Size）必须写在 StruModel.toViewer() 之前（#19）
#   ⚠️ TRUSS 构件每构件只划 1 个单元，估规模按"构件数×1"计（mesh.md §10）

StruModel.toViewer(); StruModel.submitAndMesh(); FemModel.fromViewer()

# —— ② 有限元阶段：按 dimension 重筛编号后嵌入 ——
link_eids  = [e.id for e in Element.all() if e.dimension == 1]     # 钢筋 Link 单元（从）
solid_eids = [e.id for e in Element.all() if e.dimension == 3]     # 混凝土实体（主）
Embeded(tarElems=solid_eids, srcElems=link_eids,
        type=EmbededType.NodeToElem, iKey=DofMode.Both, tol=-1)    # tol 保持默认 -1

# —— ③ 约束：实体最小约束必须消除全部 6 个刚体自由度（含抗绕 Z 转动，supports.md）——
# —— ④ 自查：钢筋节点数×3 应等于 neq 的减少量（验证嵌入真生效，error_diagnosis.md）——
```

> 端到端实测示例：`../examples/mixed/rc_column_axial_compression.py`
> （C30 400×400×3000 mm 实体 + 8Φ20 纵筋 + Φ8@100 箍筋 = 128 条 TRUSS 构件 → 128 个 Link 单元，
> 136 个钢筋节点全部嵌入；5077 节点 / 3968 单元 / `neq` 14739 / 3 荷载步全收敛 /
> 模型检查 `{"error":{},"warning":{}}`）。

## 最佳实践

1. **一律写在 `FemModel.fromViewer()` 之后**，编号用 `Node.all()`/`Element.all()`/派生集合重新取；
2. **int 参数必须取 `enums` 里的枚举值，不要传裸数字**（`type=2` 这种写法可读性差且易错）；
3. 主从方向别反：`tar*` 为主（靶）、`src*` 为从（源）；绑定的从节点**不能**再作固定支座，
   也**不能**同时是另一个绑定的从节点；
4. **能用共节点就不用绑定**：建模时共享 `Node` 是最干净的连接；`Binding` 用于"网格不连续但力学上要连"
   （焊接、新旧混凝土、部件装配）；
5. 容差策略：同坐标独立节点 → 距离 0，`iTol=0`（自动）即可；网格尺寸差异大的两面 →
   `iTol=1` + `tol` 取**较粗网格特征尺寸的 1/10~1/2**，绑完用"绑定对数 / 界面节点数"判断是否漏绑；
6. 集中力优先"耦合到参考点"再加载，不要直接怼在单个节点上；且**支承侧参考点必须 `Dof.All`
   全约束**（只约束平动 → 3 个刚体转动奇异、反力全 0，#69）；
7. 接触：面号用 `side=` 显式给；两侧法向相对；先 `mu=0` 跑通再加摩擦；`penalty` 从 0.1 起调；
   分级加载（多 `Step`），别指望 `nSubstep`；
8. ★ **连接器已可用（2026-10-15 实机验证，#115）**：**两点之间**的弹簧/阻尼用 `Connector`；
   **接地**弹簧才用 `ElasSupport`（`supports.md`）——⛔ `ElasSupport` 只能节点↔大地，**无法连接两个节点**，
   两者不是替代关系。用 `Connector` 时记住三条硬约束：模型至少 1 个单元（#116）、
   两端节点其余自由度要有约束兜住、只能写在 `fromViewer()` 之后；
9. 布置完立刻做**平衡复核**（ΣRz = 总荷载）与**变形连续性检查**（界面两侧位移是否一致）；
   相互作用失效的典型表现是"位移异常大 / 约束不住 / 两部分各自变形"；
10. 相互作用会显著增加规模与非线性风险：大模型先与用户确认再提交。
11. ★ **做多子系统对照模型（自核查 / 参数对照）时**：各子系统在空间上**错开坐标**、节点编号互相独立——既满足「同坐标必须共享 `Node`」的平台校验，又不会让子系统互相干扰（2026-10-22 复核）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 几何阶段写 `Binding(...)` 后网格划分报错 / 对象丢失 | 相互作用只认节点号、单元号；几何阶段还没有网格 | 移到 `FemModel.fromViewer()` 之后 |
| `NameError: name 'Binding' is not defined` | 只 import 了 `pypcae.stru` | `from pypcae.comp import *`（恒定导入）即含 `Binding`/`ContactSet`/`Contactor` |
| `Binding` 传了集合号却"没绑上" | 集合号是**负数**（`Nset.id` 实测 -2、-3），且要放在列表里 | `Binding(tarNodes=[ns.id], srcNodes=[...])`；核对读回的 `tarNodes` 是否为负号 |
| 绑定/嵌入完全不起作用（两部分各自变形） | `tol` 太小、`iKey` 只绑了平动、或从节点同时被 `Fixed` 约束 | 放大 `tol`；用 `DofMode.Both`；从节点不要做固定支座 |
| 面-面绑定无效 | `BindingType.SurfToSurf` **手册注明暂不开放** | 改用 `NodeToNode` / `NodeToSurf` |
| `Coupling(tarNodes=...)` 报 TypeError | ★ 形参名是 **`tarNode`**（单数） | `Coupling(tarNode=[rp.id], srcNodes=[...])` |
| 耦合后约束异常 / 报错 | `iKey=DofMode.Custom` 但 `iDofs` 为空 | 给 `iDofs=[Dof.Uz, ...]`，或改 `Both`/`Translation` |
| 同一节点耦合冲突 | 该节点同时出现在同一耦合的主、从节点 | 主从分离 |
| 位移不为 0 但 `o62` 反力**全为 0**，位移场带虚假刚体转动 | ★ `Coupling` 主节点只 `Fixed` 了 3 个平动，绕过该点的 3 个刚体转动无约束 → 总刚奇异 | 主节点改 `Fixed(dof=[Dof.All])`（#69）；用"ΣR = 总荷载"复核 |
| `Contactor(att=…, nids=…)` 崩溃 `IndexError: list index out of range` | 用 `nids` 自动识别面号（`identifySideByCell` 内部越界） | 改用 `side=` 直接给面号（#38） |
| 接触不闭合 / 相互穿透 | 两侧 `Contactor.side` 法向同侧（没相对） | 一个取正面 1、一个取反面 2；面单元正 1 反 2 |
| 接触判定漏判/误判 | `slipTol`（作用间隙）取值不当（默认 0） | 按初始间隙显式给 `slipTol` |
| 接触算不动/刚度异常 | `penalty` 用了脚本默认的 `-1` | 显式 `penalty=0.1` 起调 |
| 接触不收敛 | 一步加载、摩擦太大、初始穿透 | 多 `Step` 分级；先 `mu=0`；`AnalySetting(iNLType=...)` |
| ~~`sep-modelcheck` 崩溃 `0xc0000409`~~ | ~~模型里用了 `Connector`~~ **2026-10-15 已复测推翻**：连接器不再导致 modelcheck 崩溃（#115） | 连接器可正常使用；若仍见 `0xc0000409`，先查荷载类是否误用位置传参（#1）、`Etem` 是否未全位置（#7） |
| `**Error:readElemLoadInfo出错:*elemLoad:-1`（genfea 阶段） | **模型零单元**——只有节点 + 连接器/约束/荷载，没有任何 `Element` | 补至少 1 个单元（#116）。前兆信号：`sep-modelcheck` 报 `**Error:模型未定义截面!`/`**Error:模型未定义材料!`（没单元→没截面/材料被引用），**别误判成材料截面写错** |
| `TypeError: __init__() got an unexpected keyword argument 'iType'`（写在 `Section(...)` 上） | `Section` 的关键字是 **`type=`**，`iType=` 是 `MatDB.assemble` 的（两者**相反**） | 改 `Section(name=..., type=SectionType.Line, sub=[...])`（#117）；属**执行类**错误，不消耗物理类额度 |
| 连接器无刚度 | `ConnectorSection.consElas=0` | 填实际刚度 |
| `NameError: name 'cs' is not defined`（紧跟 `Connector(... iSects=[cs.id])`） | 截面对象在 `try:` 内创建、构造**失败**后 `try` 外仍引用 `cs.id` ⇒ 真正的构造异常被 NameError 盖掉（2026-10-22 实机踩到） | `cs = None` → `try` 内构造 → 失败则**回退合法截面或直接收口**，再统一用 `cs.id`；结论文件里要能区分「构件层构造失败」与「modelcheck 结果」 |
| 平台校验报 `几何错误: 节点坐标 (x,y,z) 重复定义`（多子系统自对照模型） | 各子系统之间坐标重叠（如三个子系统都用 `(1,0,0)` 当接缝点） | 各子系统在空间上**错开坐标**（错开 10 m 量级；保持节点创建顺序即可）；⛔ 不要靠「共享同一 `Node`」合并——那会把独立子系统连成一个结构、改变力学行为。另：此类模型的 `save_script`「连通性异常」警告属**预期假阳性**（#114） |
| 嵌入报错/不生效 | 从单元不是 Link/壳，或主单元不是实体；或用了 `NodeToNode` | 仅"Link/壳 → 实体"且 `EmbededType.NodeToElem` |
| `ConstrEqua` 报错 | `dofEqua` 层级写错 | 按 `[[dof, nid], ...]` + `coef=[...]` 一一对应 |
| `FemModel.fromViewer()` 之后 `Binding.all()` 为 0 但脚本没报错 | 在几何阶段建的，没随网格带入 | 在 FEM 阶段重建；用 `*.all()` 或 `18_Binding.inp`/`18_Coupling.inp`/`18_Embedding.inp` 核对 |

## 验证清单

- [ ] 全部相互作用写在 `FemModel.fromViewer()` **之后**，用的是网格后的节点号/单元号/集合号
- [ ] 集合号用 `.id`（负数）且放在列表里；未手工加负号
- [ ] `type`/`iKey`/`iMethod`/`iTol` 全部取枚举值，未传裸数字
- [ ] `Binding`：主从未反；无节点重复作从节点；从节点未被 `Fixed`；`SurfToSurf` 未使用
- [ ] `Coupling`：`tarNode` 单数、不在 `srcNodes` 中；`Custom` 时 `iDofs` 非空
- [ ] `Coupling` 主节点（支承侧参考点）已 `Dof.All` 全约束，未留下 3 个刚体转动（否则反力全 0，#69）
- [ ] `Embeded`：从 = Link/壳、主 = 实体、`type=NodeToElem`、`tol=-1`
- [ ] `ContactPair`：先建 `ContactSet`+`Contactor(side=)`；两侧法向相对；`penalty=0.1` 显式给；
      `tarElems/srcElems` 传的是 ContactSet 号
- [ ] 弹簧连接选型正确：**两点之间**用 `Connector`、**接地**用 `ElasSupport`（#115）
- [ ] 用 `Connector` 时：模型**至少含 1 个单元**（#116）；`consElas` 填了实际刚度（非 0）；
      `iDofs` 与 `iSects` **一一对应**；两端节点的其余自由度已有约束兜住；写在 `fromViewer()` 之后
- [ ] 交付脚本**未使用连接器非线性阻尼**（`keyDamp` 只允许 `Off`；`consDamp`/`dampCoefs` 见 §5「两段式失败」）
- [ ] 截面/单元对象构造失败时不继续引用 `.id`（先置 `None` + 收口），结论文件区分「构件层失败」与「modelcheck 结果」
- [ ] `Section` 用 `type=`、`MatDB.assemble` 用 `iType=`（两者相反，#117）
- [ ] 接触/非线性分析已配 `AnalySetting(iNLType=...)` + 多 `Step` 分级加载
- [ ] 布置后用 `*.all()` 与 `18_Binding.inp`/`18_Coupling.inp`/`18_Embedding.inp`/`19_ConnectElem.inp`
      确认写入；求解后做 ΣRz 平衡 + 界面位移连续性检查（`verification.md` 第 0/3 层）
