# 网格设置（几何模型） — 参考文档


> 📖 **手册锚点**：API 签名与参数语义的权威定义见内置手册 `../manual/README.md`（**2026-10-26 版**）
> §二.2.12「网格设置」（`LoadToMassSetting`/`MeshSetting`/`Size`/`MeshParams`）、
> §二.1.2「模块函数」（`submitAndMesh()`；★ 同节 2026-10-14 版新增 `dedupCoincident` 几何清理，
> 见本文「★ 网格前几何清理」与 `stru_model.md` §核心 API 2b）、§三.2 附录 `MeshType`。
> 本文只承载手册**没有**的内容：生效范围、参数落盘机制、执行时序、日志标记与坑位。
> 结构（几何）建模与混合流程见 `stru_model.md`。
> ℹ️ 2026-10-14 版手册已把 `MeshParams.meshGen` 正文默认值由 1 改为 **0**（与同段预定义形参一致），
> 原「口径不一致」条目结案（`references/stru/known_issues.md` #73）——**但本库实测结论不变**：模型含 `Solid` 时
> `StruModel.toViewer()` 仍会自动置 1（Tmesh），故脚本仍**不要手工写 `meshGen`**。

## 概述

**生效范围**：网格设置**仅在几何模型（StruModel）中生效**——有限元模型是手工布置节点/单元，
不走自动网格。因此本节内容只用于「结构（几何）路线」与「混合路线」。

**触发方式**：`StruModel.submitAndMesh()`。它把几何模型交给软件网格管线，产出网格后的
有限元模型；混合路线中 `FemModel.fromViewer()` 读取的正是该产物。

**★ 时序铁律（最易错，源码核实）**：所有网格设置对象必须在 **`StruModel.toViewer()` 之前**创建。

```text
MeshParams / Size / MeshSetting / LoadToMassSetting   ← 先建
StruModel.toViewer()      ← 此刻把它们序列化进 pypcae.stru，并把 MeshParams 快照给 StruModel.mesh_params
StruModel.submitAndMesh() ← 用的是上面那份快照，之后再改 MeshParams 不会被采用
```

> 换句话说：`toViewer()` 之后再 `MeshParams(...)` 或改尺寸**静默无效**（不报错），
> 必须重新 `toViewer()` 才会刷新快照。`StruModel.fromViewer()` 则从模型文件里读回网格参数。

**★ 旧结论作废**：早期文档称 `submitAndMesh()` 内部 `sys.exit(0)` 会终止脚本进程、
"划网格与求解必须分两个脚本"。**2026-10-12 版已不成立**：成功路径正常返回，脚本可继续执行
（混合流程正依赖这一点）；仅在任一环节**失败**时 `sys.exit(-1)` 终止进程。见 `references/stru/known_issues.md` #12。

## ★ 单元类型与网格模式选型（强制默认策略：六面体主导 + 四边形主导 + 扫掠）

> **一句话口径**：**体网格以六面体主导、面网格以四边形主导、六面体类型用扫掠网格——这就是软件默认设定**
> （`meshPattern="sweepAndTMesh"`、`toQuad="true"`、`hexMeshPattern="sweepOnly"`）。
> 脚本里**显式写出**这三项（便于用户核对与日后调整），但**不要随意改掉**；只有几何复杂到扫掠划不出来时
> 才降级为四面体主导（`tMeshOnly`）。**总体网格尺寸 `basicSize` 不能一刀切、不能照抄示例值**，
> 必须按 §7 综合判断，并把依据写进「建模规格核对表」的网格行。

### 1. 默认设定（照抄即可，改它要有理由）

| 参数 | 默认值 | 含义 | 什么时候才改 |
|---|---|---|---|
| `meshPattern` | `"sweepAndTMesh"` | **体网格六面体主导**：可扫掠区生成六面体，复杂区自动补四面体 | 几何过于复杂、扫掠反复失败 → `"tMeshOnly"`（四面体主导），见 §3 |
| `hexMeshPattern` | `"sweepOnly"` | **六面体类型＝扫掠网格**（沿截面/拉伸方向扫掠生成） | 扫掠方向不唯一、截面沿程剧烈变化 → 试 `"hexOctreeOnly"`（八叉树）或 `"sweepAndHexOctree"`（扫掠+八叉树）；属建模设定变更，用户已指定时须先问（`execution_contract.md` §6） |
| `hexFtPattern` | `"FT"` | 边界恢复（保几何边界特征）；**六面体为扫掠网格时该参数不生效** | 改用八叉树且边界特征丢失时，再试 `"NOFT"` 对比 |
| `toQuad` | `"true"`（**字符串**，不是布尔值） | **面网格四边形主导**（残留少量三角形） | 一般不改；`"false"` 为三角形网格，仅在四边形主导反复失败或面域极不规则时考虑，并告知用户 |
| `meshGen` | **0**（2026-10-14 版手册正文与预定义形参已统一为 0）；但含 `Solid`（体构件）时 `StruModel.toViewer()` **自动置 1（Tmesh）** | 三维实体划分器：0 Femesh / 1 Tmesh | 无需手工设置；显式写 `0` 会与自动置 1 的行为打架，别写（#73） |

### 2. 为什么优先六面体与四边形（工程依据）

| 单元 | 优势 | 代价 / 风险 |
|---|---|---|
| **六面体（体，优先）** | 同精度下**单元数量少**（常为四面体的 1/5~1/10）、位移与应力精度高、刚度矩阵性态好、**能有效避免应力奇异现象**，对弯曲/剪切主导问题（梁板壳类结构）表现更稳 | 对几何要求高：需要可扫掠的规则拓扑；碎面、短线、回转体易失败 |
| 四面体（体，兜底） | 对任意复杂几何都能划出（Tmesh） | 低阶四面体偏刚、单元数暴涨；应力集中区易出现奇异与振荡 |
| **四边形（面，优先）** | 精度一般优于三角形，弯曲问题表现好，单元数少 | 复杂面域、多开洞时需要较多过渡单元 |
| 三角形（面，兜底） | 适应任意面域 | 易过刚；**歪斜（skew）单元显著劣化精度**；数量多 |

### 3. 何时降级为四面体主导（`tMeshOnly`）

**判据（几何过于复杂、六面体无法生成）**：碎面与短线多、回转体与球面（`SurfType.Cone/Crown/Ring`）、
多开洞、非规则拓扑、扫掠方向不唯一、截面沿程剧烈变化。
本库实测走 `tMeshOnly` 的算例：实心球（两个 `Crown` 球冠拼合）、圆柱+圆锥组合体、混凝土圆柱劈裂试件
（6 段圆弧拼 8 面闭合圆柱）。

**处置纪律**：

- 首次划分失败后改 `tMeshOnly` → 属**交付缺陷类修复**，可直接改，但必须记入重试台账（`execution_contract.md` §6）；
- 用户**已指定**网格模式后再想改 → 属**物理类变更**，**必须先问用户**（给日志证据 + 2~3 个方案及影响）；
- ⛔ 不得因为"想让结果更好看 / 单元更少 / 算得更快"而自行切换网格模式。

### 4. "重要区域六面体、复杂区域四面体"的混合策略 —— ⚠️ 能力边界

- **`MeshParams` 是全局单例**（全脚本只保留最后一次设置），**`MeshSetting` 只能设局部尺寸或分段数**
  （`iType=MeshType.Size/Divisions`，`ids`=构件号）——**两者都不能按构件或区域切换六面体/四面体模式**；
- 因此"分区混用"在本软件的落地方式只有一条：**整体用默认 `meshPattern="sweepAndTMesh"`**，
  由划分器**自动**在可扫掠区生成六面体、在复杂区补四面体（这正是默认值取 `sweepAndTMesh`
  而不是 `sweepOnly` 的原因）；
- ★ **可行解法（2026-10-15 实机验证，原"未验证能力"已结案）：用「实体分割」间接实现分区网格。**
  关键认识：**网格模式是全局单例、无法按区域切换；但几何拆成多个实体构件后，各实体是独立划分的**——
  因此"分区网格"可以通过**几何分割**间接达成：可扫掠的实体 → 六面体；含孔 / 复杂实体 → 四面体。

  **实测（3.0 m 长 H 形梁，全局网格 20 mm）**：

  | 方案 | 单元总数 | 六面体 | 四面体 | 可扫掠体识别数 | tmesh 告警 |
  |---|---|---|---|---|---|
  | 无孔、整体 | 20964 | 20264（96.7%） | 0 | 14 | 无 |
  | 开孔、**未分割** | 51515 | 13148（**25.5%**） | 37923（73.6%） | 13 | 有"扭曲四边形网格" |
  | 开孔、**分割为"含孔段 + 无孔段"** | **26948** | **20560（76.3%）** | 5650（21.0%） | **14** | **无** |

  **做法**：沿构件轴线在孔群之外切开，含孔段保留（四面体），其余段作为无孔棱柱（扫掠六面体），
  两段之间用 `Binding(NodeToSurf)` 绑定连接（分割面同坐标的三条出路见 `stru_model.md` §5，
  推荐"留 1 mm 间隙 + 显式 `tol` 绑定"）。

  **两条快速健康判据（建议写进交付包）**：
  · `tmesh` 日志的**"模型识别扫掠体个数"**是"分割是否奏效"的直观指标（本例 13 → 14）；
  · `tmesh` 的 **`Distorted Quadrilateral Mesh（surfaceId …）`** 告警在分割后消失
    ⇒ 说明该告警主要来自"含孔/复杂实体被强行扫掠"，**而非网格尺寸问题**（不要靠调尺寸去消它）。

- 附带用途：**局部加密也只能靠分割**。`MeshSetting` 只能对**整构件**设尺寸，无法只加密孔周边一小片；
  要做"孔边 5~8 mm 局部加密"，须先把含孔区**分割成独立实体**，再对该实体设小尺寸（与本节同一手段）。
- ⚠️ 仍需说明的边界：分割改变了几何拓扑（引入界面），界面上靠 `Binding` 等效连续；
  "1 mm 间隙 + 绑定"与"共享 `Node`"两种做法的**力学差异未实测**（已登记 ERRATA 第 2 区），
  用于承载力评估前应向用户说明并请其确认。

### 5. 过渡区（六面体—四面体交界）—— ⚠️ 脚本不可控，如实上报

- **工程通则**：交界处宜用**金字塔单元**实现节点协调，过渡层厚度控制在 **1~2 个单元**，
  并采用渐进式尺寸变化，避免相邻单元尺寸比过大；
- **但本软件无法照此指定**：`ElementType` 的 25 个成员中**没有金字塔（pyramid）与楔形（wedge）单元类型**
  （只有 `Solid`/`SolidLaStrain` 等三维实体），脚本无法选择过渡单元；交界处的过渡单元由网格划分器
  **内部生成**，其类型、节点协调性、过渡层数均**不可控**（已登记 `references/stru/known_issues.md` 第 2 区）；
- **可做的替代措施**：
  1. 尽量让同一实体内部网格模式单一，减少不必要的六面体—四面体交界（几何上避免把规则体与复杂体混在一个 `Solid`）；
  2. 用 §6 的尺寸渐变降低交界处的尺寸跳变（尺寸比小，过渡单元的歪斜也小）；
  3. 划完后统计单元类型分布（`pcaestru-mesh/fe_modelSource.json` 按单元节点数分类计数），
     把交界位置、各类单元数如实写进交付包「未决问题」，**交用户判断**
     （⛔ 不自行评判"过渡是否可接受"，见 `execution_contract.md` §4b）。

### 6. 尺寸渐变与相邻尺寸比（避免尺寸跳变）

- **落地手段**：`Size(basicSize / beamSize / wallSize / plateSize)` 分级控尺 +
  `MeshSetting(name, iType, size, ids=构件号)` 局部尺寸 + `densifyLevel`（墙梁加密等级）；
- **工程要求**：相邻区域尺寸比**不宜超过 2:1**；加密区到常规区应**逐级过渡**
  （如 0.25 → 0.5 → 1.0，不要 0.25 → 2.0）；局部加密只放在孔口、支座、应力集中区，**不整体加密**；
- ⚠️ 软件是否内部自动做尺寸平滑/渐变，手册未说明（**未验证**，已登记 ERRATA）——所以尺寸台阶要由脚本自己排布；
- **核对手段（存在性核对，不做评判）**：`pcaestru-mesh/UserMeshParameter.txt` 的 `*meshSize` 行与脚本一致；
  `fe_modelSource.json` 统计单元尺寸分布与三角形占比（实测立式料仓：1330 个四边形 + 12 个三角形）；
  三角形占比偏高或恰好位于关键受力区 → 写进「未决问题」问用户，⛔ 不自行改几何、不自行改网格；
- **面网格残留三角形的歪斜（skew）同样不可直接控制**（`toQuad="true"` 下由划分器决定），
  只能按上条统计并如实上报；用户明确要求时才做质量评估。

### 7. ★ 总体网格尺寸 `basicSize` 必须按整体模型综合判断（不得一刀切）

`basicSize` 没有"通用正确值"：**必须结合整体模型综合判断**，并把判断依据与预估单元规模写进
「建模规格核对表」的网格行（`execution_contract.md` §2）。

| 判断维度 | 怎么看 | 判错的后果 |
|---|---|---|
| 模型总体尺度与单位制 | 总长/总宽/总高；SI 制为 m、mm-t 制为 mm | 单位填错（把 mm 值填进 m 制项目）→ 网格爆炸或直接划失败 |
| **最小特征尺寸** | 最薄板厚、最小截面边长、最小开洞/倒角/垫条尺寸 | `basicSize` 大于最薄构件厚度 → 板与薄壁划不出或严重畸变；一般取 ≤ 最小特征尺寸 |
| 构件类型分级 | 梁柱撑 `beamSize`、墙 `wallSize`、板 `plateSize`（`isBasic=True` 才启用构件级尺寸） | 只用统一 `basicSize` → 细构件过粗、大构件过密 |
| 分析目的 | 位移/自振频率（可较粗）；应力与应力集中（需细）；接触、局部屈曲、开裂（更细） | 目的与尺寸不匹配 → 结果不可用或规模失控 |
| **规模与耗时** | `basicSize` 减半 → 单元数约增至 2~4 倍（实体可到 8 倍）；先估总单元数 | 规模爆炸、计算超时；**大模型必须先与用户确认再提交**（黄金法则 7） |
| 几何复杂度 | 碎面/短线/回转体/多开洞多 → 需放粗或降级 `tMeshOnly` | 太细易划失败、产生畸变单元 |

**推荐流程（与执行契约一致）**：

```text
① 按上表估一个起点尺寸
② 写进「建模规格核对表」网格行（尺寸 + 依据 + 预估单元数与耗时）
③ 规模大 / 关键结果 / 用户已给精度指标 → 先与用户确认再提交
   （⛔ 不自行加密、不自行做多套尺寸对比）
④ 划分后用产物核对实际单元数、尺寸分布、三角形占比（存在性核对，不评判好坏）
⑤ 需要更细或做网格无关性研究 → ⛔ 问用户；用户明确要求后才执行
   （execution_contract.md §4b / §9；verification.md 第 2 层）
```

**参考起点（仅起点，必须按维度表重新判断；SI = m）**：

| 结构类型 | 起点建议 | 本库实测参照 |
|---|---|---|
| 多层框架（梁柱 0.3~0.6 m 截面、板厚 0.12 m） | `beamSize` 0.3~0.5、`plateSize` 取板厚量级、`basicSize` 0.5 | 2 开间×3 层：2019 节点 / 2322 单元（1728 壳 + 594 梁），8.5 s |
| 墙、板为主的房屋结构 | `wallSize`/`plateSize` 取墙厚、板厚的 1~2 倍内，且不大于层高/开间的 1/8 | — |
| 大体积实体（球、坝、基础、大直径筒） | 特征尺寸的 1/8 ~ 1/20 | 实心球 R=1 m、`basicSize=0.2` → 约 880 节点 / 4200 四面体 |
| 局部精细分析（劈裂、节点区、接触、垫条） | 特征尺寸的 1/20 以下 | R=75 mm 圆柱、`basicSize=0.0125` → 1479 节点 / 7219 四面体 |
| 壳体工业结构（料仓、筒仓、桁架节点） | 板厚的 5~10 倍 | mm-t 制：料仓 600 → 1342 壳；桁架节点 150 → 1068 壳；斜拉桥 1500 → 5174 单元 |

> ⚠️ 上表数值来自本库实测算例，**不是默认值也不是推荐值**；换模型必须重新按维度表判断，
> 交付时说明"尺寸取值依据 + 实际单元数 + 划分耗时"，并把"是否需要更细"作为**未决问题**交给用户。

### 8. ★ 网格前几何清理（重合点 / 重合线 / 重合面）——`StruModel.dedupCoincident`

网格划分失败（`mesh:failed`）与网格质量差的最常见几何成因就是**碎面、短线、自交、重合对象**
（见本文「常见错误」与 `error_diagnosis.md` 表 B）。2026-10-14 版手册在 §二.1.2「模块函数」新增了一个
专门的事后清理手段：

```python
StruModel.dedupCoincident(dedupPoint=False, dedupLine=False, dedupSurf=False, tol=0.005)
```

| 项 | 口径 |
|---|---|
| 作用 | 自动归并**重合的点、线、面**，仅几何模型（`StruModel`）有此函数 |
| ★ 时序 | **只能写在 `StruModel.toViewer()` 之后**（手册原文："在 `StruModel.toViewer()` 结束之后才能生效"）——**方向与网格设置相反**（`MeshParams` 等必须在 `toViewer()` 之前） |
| 开关 | 三个 `dedup*` 默认全 `False`（不处理），要归并**必须显式传 `True`** |
| ★ `tol` 单位陷阱 | 随项目单位制：SI(m) 制下默认 `0.005` = **5 mm**（可能误并近距离节点）；mm-t 制下 = **0.005 mm**（几乎归并不掉任何东西）。必须换算后再传 |
| 定位 | **移植 / 迭代既有几何模型**的补救手段（如厂商示例遗留的 53 个重合节点、相邻板重复建的边线）；**不能替代**"建模时共享同一 `Node`、相邻面共用同一条边线"的铁律，也**治不了** `save_script` 的"节点坐标重复定义"（#48，校验在保存阶段） |

**推荐时序**（`toViewer` 之前配网格、之后做归并）：

```text
MeshParams / Size / MeshSetting        ← 网格设置：必须在 toViewer() 之前（#19）
StruModel.toViewer()                   ← 1 几何可视化 + 快照网格参数
StruModel.dedupCoincident(...)         ← 2 几何清理（只能在此之后）
StruModel.submitAndMesh()              ← 3 网格划分（✅ 2026-10-22 实测：能直接吃到归并结果）
```

> ★ **2026-10-22 实机结案（`references/stru/known_issues.md` #123，原 #71 的 5 项待核对全部有结论）**：
> ① **不需要第二次 `toViewer()`** —— `dedupCoincident()` 自身即把归并结果写回 `pypcae/pypcae.stru`
>   （实测 4 节点/2 条重合线 → 2 节点/1 条线）；
>   ⛔ ★ **反过来说：归并之后**再**调 `toViewer()` 会把归并结果覆盖掉**（文件恢复为未归并版本）
>   ⇒ **`toViewer() → dedupCoincident() → submitAndMesh()`，中间不要再调 `toViewer()`**；
> ② **编号会重排（压缩）**：被归并的对象删除、其后编号前移，线的 `pts` 引用被同步改写；
>   而**内存对象不更新**（`Node.all()` 仍返回旧数量）⇒ 归并后**必须重新取编号**，⛔ 不要再用几何阶段捕获的 `.id`；
> ③ **`submitAndMesh()` 能直接吃到归并结果**：实测归并后 1 条线 → 网格 **7 节点 / 6 个梁单元**（未归并会是 12 个）；
> ④ **部分重合不归并**：共线但端点不同的两条线（0–6 与 3–9）归并后仍为 2 条；
> ⑤ **`tol` 随单位制**：SI 制下 `tol=1e-6` 只并**精确重合**点、`tol=0.01`（10 mm）才并 0.5 mm 近点
>   ⇒ 默认 `0.005` = 5 mm 的量级判断成立（mm-t 制同一数值 = 0.005 mm，务必换算）；
> ⑥ 可**反复调用、逐次累积**（源码：每次调用都跑一次外部进程 `sep-modelcleanup`，操作对象就是 `pypcae.stru`）。
>
> ⛔ 归并会改变模型拓扑与编号，属**物理类变更**：用户没要求不要主动加；网格划分首次失败后
> 想用它修几何，按 §3「处置纪律」记入重试台账，并把归并参数与计数变化写进交付包
> （`execution_contract.md` §6）；**不自行评判归并后几何对不对**（§4b 硬禁令）。

---

### 9. ★ 回转面（圆柱/圆台）分段与过渡带规律（2026-10-15 实测，新增）

回转壳（筒壁、锥斗、环腹板）的周向分段数**脚本无法强制**，规律如下（实测依据：D18×H30 筒仓整圆面模型）：

| # | 情形 | 实测行为 | 工程结论 |
|---|---|---|---|
| 规律一 | 圆台面**底边自由**（不被其他面共享） | 网格器自动把底边周向分段**对齐到顶边**（实测 30/30、全四边形） | ⇒ **完全规整的结构化网格**，锥斗尽量做成单一整圆台面 |
| 规律二 | 圆台面**底边被相邻面共享** | 上/下边分段数按各自**弧长 ÷ 网格尺寸独立取整**（实测 54/30），面内出现**波浪状过渡行** | 仍全四边形、无重合节点，但**节点线锯齿、观感差**；必须分层时接受"除最下层外每层一条过渡带"，并把**分层数降到最低** |
| 规律三 | `MeshSetting(iType=MeshType.Divisions, size=N, ids=[整圆线])` 与逐线 `MeshSetting(iType=MeshType.Size, size=2*pi*r/N)` | **均不生效**（分段数不变，`UserMeshParameter.txt` 亦无记录） | ⇒ **脚本无法强制周向分段一致**；不要靠局部网格设置去"对齐周向分段"，只能靠几何分带（规律一） |

补充实测：**锥斗下口周向分段数由网格器自定**（本次 10 段），弦矢高可达 ~0.05 m ⇒
**任何基于"形心"的几何判据，容差必须大于该弦矢高**，否则漏选/误选；更稳的做法是**逐节点判定**
（见 `loads.md`「Wpload 壳面静水压力模板」的湿面筛选）。

> ⚠️ 环肋 / 环撑只能设在**面边界圆**上（`stru_model.md` §5「环向加劲肋的拓扑要求」），
> 这天然限制了分层位置——两条约束要一起考虑，先定环肋标高，再定分带。

### 10. ★ `Size.beamSize` 对 `ComponentType.TRUSS` 构件不生效；**分段要用逐构件 `MeshSetting`**（2026-10-14 实测；★ 2026-10-22 实机结案 `references/stru/known_issues.md` #124）

实测 0.4×0.4×3.0 m 混凝土实体 + 128 条 TRUSS 钢筋构件，
`Size(isBasic=True, basicSize=beamSize=wallSize=plateSize=0.050)` 下：

| 对象 | 预期 | **实测** |
|---|---|---|
| 混凝土实体 0.4×0.4×3.0 m | 8×8×60 = 3840 六面体 | **3840，完全吻合**（0 个四面体） |
| 8 根纵筋（各 3.0 m） | 各 60 段 = 480 | **各 1 段 = 8** |
| 120 条箍筋边（各 0.352 m） | 各约 7 段 ≈ 840 | **各 1 段 = 120** |
| 合计 | ≈ 5160 | **3968 = 3840 + 128** |

⇒ **每条 `ComponentType.TRUSS` 构件只划出 1 个单元**，`basicSize` 与 `beamSize` 对它都没起作用；
求解器另报"总体单元特征尺寸 `0.651E-01`"，也与设定的 0.050 m 不符（疑为体积等效统计量，未深究）。

★ **2026-10-22 实机结案（`references/stru/known_issues.md` #124）——分段是可控的**：同一"实体 + 3 根 3.0 m TRUSS 钢筋"模型
（`basicSize=0.1`）实测：

| 做法 | 实测单元数（每根钢筋） |
|---|---|
| 不设 `MeshSetting`（只有全局 `basicSize`） | **1 个**（z 节点仅 0 / 3.0） |
| `MeshSetting(name=..., iType=MeshType.Divisions, size=6, ids=[构件号])` | **6 个**（z 节点 0/0.5/1.0/…/3.0）✅ |
| `MeshSetting(name=..., iType=MeshType.Size, size=0.5, ids=[构件号])` | **6 个**（同上）✅ |

⇒ **需要分辨钢筋沿长度方向的内力/应力分布时，逐构件写 `MeshSetting` 即可**（`ids` 传**构件号**；两种
`MeshType` 都有效）。⛔ 不得再写"软件无法控制 TRUSS 分段"。

**必须遵守的三条**：
1. **重估单元规模**：**未设 `MeshSetting`** 时钢筋按"**构件数 × 1**"计（否则预估会明显偏大，本例预估 5200 / 实测 3968）；
   **设了 `MeshSetting`** 则按 `size` 或分段数折算；
2. 若分析需要分辨**钢筋沿长度方向的内力/应力分布**，须**先验证分段控制手段**
   （待实测：`MeshSetting(iType=MeshType.Divisions, size=<分段数>, ids=[构件号])` 能否强制 TRUSS 分段；
   或 TRUSS 是否只在 `MeshType.Size` 下按局部尺寸分段），并在核对表中写明**实际分段数**；
3. 分段不足属**已如实上报的未决问题**，⛔ 不得自行加密网格绕过（`execution_contract.md` §5）。

### 11. ★ 极端长细 / 超薄局部特征的尺寸判断（2026-10-15 实测，新增）

适用：模型**最薄处 ≪ 总体尺度**（跨 2~3 个数量级），如风机叶片（59 m 长 × 3.5 m 弦长 × **0.04 m** 最薄处）、
薄壁箱梁、壳体加劲结构。

1. **★ `basicSize` ≠ 实际特征尺寸，必须读日志核对**：自动网格器会在**薄壁 / 尖角 / 小特征**处自行局部加密。
   实测脚本设 `basicSize = 0.35 m`，日志回报 **"总体单元特征尺寸: 0.203 m"**（明显小于请求值）。
   ⇒ 交付记录一律以**日志中的实际特征尺寸与单元数**为准，**不要照抄脚本里的 `basicSize`**；
2. **最小特征尺寸决定量级**：优先按"**最薄处**"决定网格尺寸量级，再按总体尺度估规模，
   并把**预估单元数**写进「建模规格核对表」的网格行；
3. **★ 单元数由薄端主导，而非长度**：实测 59 m 叶片（28948 单元）与 11 m 验证算例（26597 单元）
   **几乎同量级** ⇒ 不能按"长度翻 5 倍就把网格放大 5 倍"估规模，这条经验可避免数量级误判。

### 12. 圆弧段数 N 与全局网格尺寸的配合（2026-10-15 实测口径）

- 实测 Ø26 孔取 N=16（弦长约 5.1 mm）、全局网格 20 mm：**mesher 会为服从弧段断点自动局部细化**，
  未出现"划不出来"，但**孔边单元尺度远小于全局尺寸**——属"被迫细化"，非脚本可控的平滑过渡；
- **建议区间**：N 取"**使弧弦长不小于全局尺寸的 1/2**"较稳（Ø26 孔 + 20 mm 网格时 **8~12 段已足够**）；
  追求"几何真圆 + 更圆网格"再加大 N，并把由此产生的局部细化与单元数增量写进交付包；
- **粗网格 + 小孔（孔径 < 全局网格尺寸）**：实测孔仍被完整划出（**边界断点被强制成为网格节点**）；
  若要"孔边局部加密"，只能对**整构件**用 `MeshSetting` 设尺寸 ⇒ 需先把含孔区**分割成独立实体**
  （见 §4「用实体分割间接实现分区网格」，同一手段）。

---

## 核心 API

### 构件网格尺寸 `Size`

```python
Size(isBasic=False,        # 是否启用构件级尺寸（False 时只用 basicSize）
     basicSize=1.0,        # 全局网格尺寸（随项目单位制，SI 为 m）
     beamSize=1.0,         # 梁柱撑构件尺寸
     wallSize=1.0,         # 墙构件尺寸
     plateSize=1.0,        # 板构件尺寸
     densifyLevel=0)       # 墙梁网格加密等级
```

> 落盘形式：写入网格目录 `UserMeshParameter.txt` 的 `*meshSize basicSize beamSize wallSize plateSize densifyLevel` 一行。

### 局部网格 `MeshSetting`

```python
MeshSetting(name="", iType=MeshType.Size, size=1.0, ids=None)
# iType: MeshType.Size（按尺寸）/ MeshType.Divisions（按分段数）
# ids:   构件号列表（★ 不是节点号、不是单元号）
```

### 网格划分参数 `MeshParams`

```python
MeshParams(sizer=Size(),
           meshPattern="sweepAndTMesh",   # 体网格：sweepAndTMesh 六面体主导 / tMeshOnly 四面体主导
           hexMeshPattern="sweepOnly",    # 六面体：sweepOnly 扫掠 / hexOctreeOnly 八叉树 / sweepAndHexOctree
           hexFtPattern="FT",             # 边界恢复：FT / NOFT（扫掠网格时不生效）
           toQuad="true",                 # 面网格：字符串 "true" 四边形主导 / "false" 三角形
           meshGen=0)                     # 三维实体划分器：0 Femesh / 1 Tmesh
```

| 参数 | 注意 |
|---|---|
| `toQuad` | **字符串**，不是布尔值；`"true"` → 内部 `mesh=0`（四边形+三角形），其他值 → `mesh=1`（三角形） |
| `meshGen` | 手册默认 **0**（2026-10-14 版正文已改，原写 1 属口径不一致，#73 结案）；模型含 `Solid`（体构件）时 `StruModel.toViewer()` 会**自动置 1（Tmesh）**，无需手工设置 |
| `sizer` | 传 `Size` 实例（`MeshParams(sizer=Size(isBasic=True, ...))`） |
| `MeshParams` 是单例容器 | 全脚本只保留最后一次的设置（`clc()` 会重置为默认 `MeshParams()`） |
| ★ **默认值即推荐值** | `meshPattern="sweepAndTMesh"`（体网格**六面体主导**）、`hexMeshPattern="sweepOnly"`（**扫掠**）、`hexFtPattern="FT"`、`toQuad="true"`（面网格**四边形主导**）——显式写出便于核对，但**不要随意改**；选型依据与降级条件见本文「★ 单元类型与网格模式选型」§1~§3 |

### 荷载转质量 `LoadToMassSetting`

```python
LoadToMassSetting(loadToMassParas=[[工况id, 系数], ...])   # 索引号与系数成对出现
```

- 仅支持**部分荷载类型的整体 Z 向荷载**转为质量（用于模态/地震分析的质量源）；
- 内部固定 `direction=7`、`keepLoads=False`；`clc()` 会把它重置为 `None`；
- 需要在 `StruModel.toViewer()` 之前创建（随几何模型一并序列化）。

## 代码模板

### 模板 1：建筑结构模型网格（梁柱板分别控尺）

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel

clc()

# ... 材料 / 截面 / 节点 / BeamColumn / Wall / Plate / Fixed 见 stru_model.md 模板 1 ...

MeshParams(sizer=Size(isBasic=True, basicSize=0.50, beamSize=0.30,
                      wallSize=0.40, plateSize=0.30, densifyLevel=0),
           toQuad="true")                       # 板墙四边形主导

StruModel.toViewer()                            # ★ 网格参数必须在 toViewer 之前
StruModel.submitAndMesh()                       # 划网格；成功后脚本继续（纯几何路线到此为止）
```

### 模板 2：通用几何体 + 局部加密（含实体，meshGen 自动切 Tmesh）

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel

clc()

# ... Line / Surf / Solid 见 stru_model.md 模板 2 ...

MeshSetting(name="hole_refine", iType=MeshType.Size, size=0.05,
            ids=[c_hole_1.id, c_hole_2.id])     # ★ ids 是构件号：洞口周边局部加密
MeshParams(sizer=Size(isBasic=True, basicSize=0.30),
           meshPattern="tMeshOnly", toQuad="true")   # 实体为主 → 四面体主导

StruModel.toViewer()
StruModel.submitAndMesh()
```

### 模板 3：混合路线中的网格 + 荷载转质量（模态分析）

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)
clc()

# ... 几何建模（材料/截面/节点/构件/约束）见 stru_model.md 模板 3 ...

lc_dl = LoadCase("DL")                          # 几何阶段的恒载工况（用于转质量）
lc_dl.add(Emload(geids=all_comp_ids, value=9.81, dir=[0, 0, -1]))
LoadToMassSetting(loadToMassParas=[[lc_dl.id, 1.0]])
MeshParams(sizer=Size(isBasic=True, basicSize=0.50), toQuad="true")

StruModel.toViewer()
StruModel.submitAndMesh()
FemModel.fromViewer()                           # 读网格后的有限元模型（内部先 clc()）

# ... 有限元阶段：核对/补充荷载、Step、Analy（模态必配 nModal）见 analysis.md ...

FemModel.toViewer()
FemModel.submitAndSolve()
```

## 最佳实践

1. **尺寸量级**：取构件特征尺寸的 1/4 ~ 1/10；梁柱按 `beamSize`、墙按 `wallSize`、板按 `plateSize`
   分别控制（`isBasic=True` 才启用构件级尺寸）；
2. **局部加密**：孔口、支座、应力集中区用 `MeshSetting`（`ids` = 构件号），不要整体加密；
3. **单元类型选型（强制口径）**：**体网格六面体主导、面网格四边形主导、六面体用扫掠网格**——
   即 `meshPattern="sweepAndTMesh"` + `toQuad="true"` + `hexMeshPattern="sweepOnly"`，**正是软件默认设定**，
   显式写出但不要随意改；只有几何复杂到扫掠划不出（碎面/回转体/球面/多开洞）才降级 `tMeshOnly`
   （详见本文「★ 单元类型与网格模式选型」§1~§3；能力边界见 §4~§5：不能按区域切换模式、不能指定金字塔过渡单元）；
4. **单位一致**：网格尺寸随项目单位制（SI 为 m）；从规范/图纸取 mm 值先 ÷1000；
5. **★ `basicSize` 按整体模型综合判断**：依次看模型总体尺度与单位制、**最小特征尺寸（最薄板厚/最小截面边长）**、
   构件分级尺寸（`beamSize`/`wallSize`/`plateSize`）、分析目的（位移可粗、应力需细）、预估单元规模与耗时、
   几何复杂度——**不得一刀切、不得照抄示例值**，判断依据与预估规模写进「建模规格核对表」（详见 §7 维度表）；
6. **先粗后细**：先用中等尺寸跑通全流程（确认几何与管线没问题）；⛔ 但**网格收敛性研究不得自行发起**——
   仅在用户明确要求"做网格无关性/加密重算"后，才按 `verification.md` 第 2 层执行（事先复述尺寸套数与预估规模）；
7. **规模预估**：网格划分后单元数可能远超构件数；`basicSize` 减半，单元数可能翻 2~4 倍（实体可到 8 倍）——
   大模型先与用户确认再提交（`references/workflow.md` 黄金法则 7）；
8. **尺寸渐变**：相邻区域尺寸比**不宜超过 2:1**，加密区到常规区逐级过渡（0.25 → 0.5 → 1.0，
   不要 0.25 → 2.0）；局部加密只放孔口、支座、应力集中区（详见 §6）；
9. **混合路线**：网格设置在几何阶段一次配齐；有限元阶段不要再试图改网格（改不了，需回到几何阶段重划）。

## 网格管线与日志（诊断用）

`submitAndMesh()` 内部按序调用软件管线，任一环节失败即 `sys.exit(-1)` 终止脚本：

| 顺序 | 环节（pserver job） | 作用 | 日志标记 | 失败提示 |
|---|---|---|---|---|
| 1 | 文件准备 | 把 `pypcae.stru` 复制为工作目录下的 `StruDataSource.json` | `save:begin` → `save:end:stru` | `缺少几何模型文件：StruDataSource.json！`（＝没先调 `StruModel.toViewer()`） |
| 2 | `sep-processor` | 几何模型转网格输入（生成 `pcaestru-mesh/StruData.txt`、`TrStruData.txt`） | — | `重写inp失败，请先检查模型文件！` |
| 3 | `tmesh` | 三维实体网格（仅当存在 `TrStruData.txt`，即模型含体构件） | `mesh:begin` → `mesh:end` | `网格分析失败！` / `mesh:failed` |
| 4 | `femesh` | 写 `UserMeshParameter.txt`（`*meshSize`/`*meshGen`/`*meshPattern`/`*mesh`）并划分梁墙板网格 | `mesh:begin` → `mesh:end` | `网格分析失败！` / `mesh:failed` |
| 5 | `sep-processor` | 网格结果转有限元模型 `fe_modelSource.json`，拷回工作目录；**MIXED 模式**下再生成 `pypcae.fem.in` | `mesh-save:begin` → `mesh-save:end` | `读取inp失败，请先检查模型文件！` / `生成文件pypcae.fem.in失败！` |

- 网格工作目录：`<项目目录>/pcaestru-mesh/`；产物：`StruDataSource.json`、`StruData.txt`、
  `TrStruData.txt`、`UserMeshParameter.txt`、`fe_modelSource.json`；
- 日志前缀随执行环境变化：软件内执行 `pcae:...`，外部/Agent 执行 `custom:...`；
- **两套日志、别搞混（实测 #54）**：上表的 `save:*` / `mesh:*` / `mesh-save:*`（含 `mesh:failed`）
  只在 **安装目录** `resources/pserver.log`（★**UTF-8**，2026-10-14 实测更正）里；**项目目录** `task-log/<uuid后6位>.txt`（UTF-8）
  用的是 `@complete:sep-processor` → `@complete:tmesh`/`@complete:femesh` → `已完成网格划分!`，
  末尾 `任务执行成功!`（失败为 `@failure` + `任务执行失败!`）；
- **`run_script` 返回 success 只代表脚本没抛异常（#53）**：0 个单元、0 结果都会"成功"。
  网格跑完必须复核：`pcaestru-mesh/fe_modelSource.json` 的 `len(cells) > 0`；实体模型再做
  **单元体积求和 ≈ 理论体积**（球体示例实测 4.0851 vs 4.1888 m³，−2.48%；体积只有一半说明
  几何其实没闭合，如两个 Crown 共用一条整圆线，见 `references/stru/known_issues.md` #52/#58）；
- 读日志的方法与编码注意（GBK / UTF-8 分工见 #56）见 `error_diagnosis.md`。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| 改了网格尺寸但网格没变化（无报错） | `MeshParams` 建在 `StruModel.toViewer()` **之后**，`submitAndMesh()` 用的是 toViewer 时的快照 | 网格设置全部移到 `toViewer()` 之前；已改则重新 `toViewer()` 再 `submitAndMesh()` |
| `toQuad` 不生效 | 传了布尔值 `True` | 传字符串 `"true"` / `"false"` |
| 局部网格无效 | `MeshSetting.ids` 传了节点号/单元号 | 传**构件号**（`BeamColumn`/`Wall`/`Plate`/`Line`/`Surf`/`Solid` 的 `.id`） |
| `缺少几何模型文件：StruDataSource.json！` | 没调 `StruModel.toViewer()` 就直接 `submitAndMesh()` | 先 `toViewer()` 再 `submitAndMesh()` |
| `生成文件pypcae.fem.in失败！` / `FemModel.fromViewer()` 读不到模型 | 未设置 `init_ctx(mode=ExecutionMode.MIXED)`，该文件只在 MIXED 模式生成 | 混合脚本补 `init_ctx(mode=ExecutionMode.MIXED)` |
| 网格划分失败（`mesh:failed`） | 几何有碎面/短线/自交、**重合点线面**、构件未挂截面、尺寸远小于构件特征尺寸 | 简化几何、给全部构件挂 `sid`、放大 `basicSize` 重试；移植/迭代模型可试 ★ `StruModel.dedupCoincident`（写在 `toViewer()` **之后**，见 §8）；按上表读日志定位环节 |
| 脚本跑到 `submitAndMesh()` 就结束、后续代码没执行 | 网格管线某环节**失败**触发 `sys.exit(-1)`（成功路径不会终止） | 读 `pserver.log` 尾部与 `pcaestru-mesh/` 产物定位失败环节，不要误判为"必须分两个脚本" |
| 实体构件网格划分器不对 | 手工设了 `meshGen=0`，但模型含 `Solid` | 含体构件时 `toViewer()` 会自动置 `meshGen=1`（Tmesh）；如需强制，写在 `toViewer()` 之前 |
| 模态分析质量偏小 | 没做荷载转质量，只有自重质量 | 几何阶段加 `LoadToMassSetting(loadToMassParas=[[工况id, 系数]])` |
| 结果随网格变化大 | 网格未收敛 | 按 `verification.md` 做 2~3 套尺寸收敛性检查 |

## 验证清单

- [ ] 网格设置全部写在 `StruModel.toViewer()` **之前**
- [ ] `Size` 尺寸与构件特征尺寸同量级，单位与项目单位制一致
- [ ] `MeshSetting.ids` 为构件号；`iType` 与 `size` 语义匹配（Size 按尺寸 / Divisions 按分段数）
- [ ] `toQuad` 用字符串；含 `Solid` 时确认 `meshGen`（自动 1 或显式指定；手册默认已统一为 0，#73）
- [ ] 如用了 `dedupCoincident`：写在 `StruModel.toViewer()` **之后**、显式传 `True`、`tol` 按单位制换算，
      归并前后节点/线/面计数已核对（未实测项见 §8 与 `references/stru/known_issues.md` #71）
- [ ] ★ **体网格六面体主导**（`meshPattern="sweepAndTMesh"`）、**面网格四边形主导**（`toQuad="true"`）、
      **六面体为扫掠**（`hexMeshPattern="sweepOnly"`）＝软件默认设定；若有改动（如降级 `tMeshOnly`、
      改八叉树），已在规格核对表写明理由与依据
- [ ] ★ `basicSize` 与分级尺寸已按 §7 维度表逐项综合判断（总体尺度与单位制、最小特征尺寸、分析目的、
      预估单元规模、几何复杂度），依据与预估单元数已写进规格核对表；规模大时已先与用户确认
- [ ] 相邻区域尺寸比 ≤ 2:1，加密区到常规区逐级过渡（无 0.25 → 2.0 这类跳变）
- [ ] 已知悉能力边界：**不能按区域切换六面体/四面体**、**不能指定金字塔/楔形过渡单元**；
      单元类型分布与三角形占比已如实统计，异常写进「未决问题」交用户判断（未自行评判好坏）
- [ ] `LoadToMassSetting` 的工况 id 与系数成对，且该工况确实存在
- [ ] 收口顺序正确：`toViewer()` → `submitAndMesh()`（混合路线再接 `FemModel.fromViewer()`）
- [ ] `submitAndMesh()` 成功（安装目录 `pserver.log` 见 `mesh:end` 与 `mesh-save:end`；
      项目 `task-log/*.txt` 见 `@complete:femesh`/`@complete:tmesh` + `任务执行成功!`）
- [ ] `fe_modelSource.json` 的单元数 > 0；实体模型单元体积求和 ≈ 理论体积（#53）
- [ ] ⛔ 网格收敛性检查是**用户明确要求后**才做的（未自行发起、未自行加密重算）；如已做，事先复述过尺寸套数与预估规模
