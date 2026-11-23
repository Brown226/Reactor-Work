# 结构模型（StruModel）与几何→有限元混合流程 — 参考文档


> 📖 **手册锚点**：API 签名与参数语义的权威定义见内置手册 `../manual/README.md`（**2026-10-26 版**）——
> §二.1.1「辅助函数」（`init_ctx`/`clc`）、§二.1.2「模块函数」（含 ★ 新增 `dedupCoincident`）、
> §二.3「建立结构模型」、§二.2.12「网格设置」、
> §三.2 附录枚举（`ExecutionMode`/`ComponentType`/`LineType`/`SurfType`/`SolidType`）、
> §三.4 结构模型示例（开洞立方体 / 喇叭花网架 / 搭接节点 / 空间网架 / 罐体筒仓）。
> 本文只承载手册**没有**的内容：路线选择规则、执行时序、界面行为、工程经验与坑位。
>
> ⚠️ **2026-10-14 版手册已移除 §二.3.3「几何模型与有限元模型的混合流程」整节**——
> 混合能力本身**未被取消**（`init_ctx` 仍在 §二.1.1、`ExecutionMode.MIXED` 仍在 §三.2、
> `submitAndMesh()` 仍在 §二.1.2），只是不再有专门章节讲流程。
> **混合流程的真相源自此转为本文 §混合流程**（五步时序 + 六条铁律 + 界面刷新规则），
> 手册里查不到时不要判为"手册没有＝不支持"。见 `references/stru/known_issues.md` #72。
> 同版手册附录示例亦已重组（§三.3 有限元：梁/壳/实体/重力坝/悬索桥；§三.4 结构：见上），
> 旧的「网壳」「双曲抛物面」「圆柱圆锥」「简单结构」四例已移除（#74）。
> 手册更新后按 `（仓库维护者文档）` 的流程处置。

## 概述

**覆盖范围**：结构（几何）模型的构件级建模（`Edge`/`BeamColumn`/`Wall`/`Plate`/`Line`/`Surf`/`Solid`）、
脚本执行模式（`ExecutionMode` + `init_ctx`）、「几何 → 网格 → 有限元 → 计算」混合流程、
构件侧支座与荷载的差异、界面执行与视图刷新规则。
网格参数（`Size`/`MeshSetting`/`MeshParams`/`LoadToMassSetting`）见 `mesh.md`；
构件枚举见 `enums.md`「构件与几何」「脚本控制」节。

**何时使用（本技能两条路线；先选路再建模）**：

| 用户诉求 | 路线 | 建模对象 | 收口 |
|---|---|---|---|
| 直接要计算结果，结构能用节点+单元描述（杆系/桁架/框架/板壳） | **范围外**——属常规有限元建模，由 `pypcae-fem-modeling` 技能处理（本技能的 `Element` 只出现在混合路线网格之后） | `Node` + `Element` | — |
| 要按构件建模（梁柱撑/墙/楼板/几何线面体）、要软件**自动划分网格**、或只要几何模型不计算 | **结构（几何）** | `Node` + `Component` | `StruModel.toViewer()`（要网格再加 `StruModel.submitAndMesh()`） |
| 要"先建几何模型、划网格后再算"，或几何复杂需借自动网格得到有限元模型 | **混合** | 先 `Component`，网格后转 `Element` | `init_ctx(mode=ExecutionMode.MIXED)` + 五步时序（见 §混合流程） |

结构模型与有限元模型的**材料 / 截面 / 节点 / 支座 / 荷载写法一致**，区别只有两点：
建模对象是**构件**（`Component`）而非**单元**（`Element`）；收口用 `StruModel` 系列函数。
构件必须挂截面（`sid`），网格划分后才能得到带属性的有限元单元。

**两种建模模式**（手册 §二.3）：

- **建筑结构模型**：`BeamColumn`（梁/柱/撑）+ `Wall`（墙）+ `Plate`（楼板）+ `Edge`（特殊边）——
  面向房屋结构，构件带 `ComponentType` 细分类型，网格划分器按构件类型分别控制尺寸；
- **通用几何模型**：`Line`（几何线/线构件）→ `Surf`（几何面/面构件）→ `Solid`（几何体/体构件）——
  面向任意几何体，靠"线 id → 面 → 体"的拓扑引用逐级组装。

---

## 核心 API

### 1. 执行模式 `ExecutionMode` 与 `init_ctx`（混合模式总开关）

| 模式 | 值 | 语义 | 何时用 |
|---|---|---|---|
| `ExecutionMode.DEFAULT` | 1 | 默认：几何脚本与有限元脚本**独立执行**。脚本中**首次**调用模型类函数即把模式锁定为 `STRUONLY` 或 `FEMONLY` | 纯几何脚本、纯有限元脚本（**不要**调 `init_ctx`） |
| `ExecutionMode.STRUONLY` | 2 | 仅执行几何脚本 | 由 DEFAULT 自动锁定，一般不手写 |
| `ExecutionMode.FEMONLY` | 3 | 仅执行有限元脚本 | 由 DEFAULT 自动锁定，一般不手写 |
| `ExecutionMode.MIXED` | 4 | 几何脚本 + 有限元脚本**共同执行** | 混合流程**必须显式设置** |

```python
from pypcae.base import init_ctx
init_ctx(mode=ExecutionMode.MIXED)   # 形参名固定为 mode，不允许改名；取值必须用枚举，禁止裸数字
```

> ★ **手册 2026-10-26 版新增硬性要求**：`init_ctx` 的**参数必须通过关键字方式传入、不能按位置传入** —— 只能写 `init_ctx(mode=ExecutionMode.MIXED)`，去掉 `mode=` 的位置写法**不允许**（手册示例：`init_ctx(mode = ExecutionMode.DEFAULT)`）。

**三条铁律**：

1. `init_ctx` 只在**混合脚本**里调用，位置固定在**全部 import 之后、`clc()` 之前**；
2. 纯路线脚本调了 `init_ctx(mode=ExecutionMode.MIXED)` 不会报错，但会失去"首次调用即锁定"的
   误用保护——**不要调**；
3. 缺省 `init_ctx` 而在同一脚本里混用两个模型类 → 必然抛错，报错原文（用于诊断比对）：

```text
**Error: 禁止在几何模型中执行有限元脚本。     ← 已锁定 STRUONLY 后调用 FemModel 接口
**Error: 禁止在有限元模型中执行几何脚本。     ← 已锁定 FEMONLY 后调用 StruModel 接口
```

### 2. 模块函数（`StruModel` / `FemModel` 各一套）

| 函数 | 作用 | 备注 |
|---|---|---|
| `StruModel.toViewer()` | 几何模型可视化（写出 `pypcae.stru`） | 结构路线收口第 1 步；有 `Solid` 时内部把 `meshParams.meshGen` 置 1 |
| ★ `StruModel.dedupCoincident(dedupPoint, dedupLine, dedupSurf, tol)` | **点线面自动归并**（几何清理，仅几何模型） | **2026-10-14 版手册新增**；手册明确"**在 `StruModel.toViewer()` 结束之后才能生效**"→ 只能写在 `toViewer()` **之后**；四个形参全有默认值（`False/False/False/0.005`），缺省即什么都不归并。详见 §核心 API 2b |
| `StruModel.submitAndMesh()` | 几何模型网格划分（生成网格后的有限元模型） | **成功不终止脚本**，可继续写后续代码；任一环节失败 `sys.exit(-1)` 直接终止；自动保存模型 |
| `StruModel.fromViewer()` | 读回界面上的几何模型（读 `pypcae.stru.in`） | 内部先 `clc()`；用于"在已有几何模型上改" |
| `FemModel.fromViewer()` | 读回有限元模型（读 `pypcae.fem.in`） | 内部先 `clc()`；混合流程中读的是 `submitAndMesh()` 的产物 |
| `FemModel.toViewer()` | 有限元模型可视化（写出 `pypcae.fem`） | 有限元/混合路线收口 |
| `FemModel.submitAndSolve()` | 模型检查 + 提交计算 | 只算 `JobManager` 指向的当前任务；自动保存模型 |
| `*.setPath(dir)` / `*.saveModel()` | 指定软件路径 / 手动保存 | ★ 手册 **2026-10-26 版已把签名修正为无参 `saveModel()`**（旧版手册写作 `saveModel(softwarePath)`）；软件内执行用默认路径；`submitAndMesh`/`submitAndSolve` 已自动保存，**无需再调** |

> ⚠️ **旧结论作废**：早期版本文档称 `submitAndMesh()` 内部 `sys.exit(0)` 会终止进程、
> "划网格与求解必须分两个脚本"。**2026-10-12 版已不成立**（成功路径正常返回，
> 仅失败时 `sys.exit(-1)`），混合流程正是依赖这一点。见 `references/stru/known_issues.md` #12。

### 2b. ★ 点线面自动归并 `dedupCoincident`（几何清理；2026-10-14 版手册新增）

```python
StruModel.dedupCoincident(dedupPoint=False, dedupLine=False, dedupSurf=False, tol=0.005)
```

自动归并**重合的点、线、面**，**仅用于几何模型**（`StruModel` 独有，有限元模型没有此函数）。
四个形参全部有默认值，且默认全为"不处理"——**要归并必须显式传 `True`**。

| 参数 | 默认 | 含义 |
|---|---|---|
| `dedupPoint` | `False` | **节点**重合归并：`True` 归并 / `False` 不处理 |
| `dedupLine` | `False` | **线构件**重合归并：`True` 归并 / `False` 不处理 |
| `dedupSurf` | `False` | **面构件**重合归并：`True` 归并 / `False` 不处理 |
| `tol` | `0.005` | **点重合容差**。★ 随项目单位制：SI(m) 制下 0.005 = **5 mm**；mm-t 制下 0.005 = **0.005 mm**（近乎"完全重合才归并"）——同一默认值在两种单位制下差 1000 倍，必须换算后再传 |

**唯一由手册确定的时序（硬约束）**：

```text
StruModel.toViewer()                         ← 必须先执行
StruModel.dedupCoincident(dedupPoint=True,   ← 手册原文："在 StruModel.toViewer() 结束之后才能生效"
                          dedupLine=True, dedupSurf=True, tol=...)
```

> ⚠️ **方向别记混**：网格设置（`MeshParams`/`Size`/…）必须在 `toViewer()` **之前**；
> 归并必须在 `toViewer()` **之后**。两者时序相反。

**该用它治什么（本库已登记的三个真实痛点）**：

| 痛点 | 出处 | `dedupCoincident` 是否对症 |
|---|---|---|
| 移植厂商示例后遗留大量同坐标节点（料仓 6 道环肋各自建圈 → 53 个重合节点） | `../examples/stru/stru_industrial_silo.py`、`references/stru/known_issues.md` 第 2 区 | ✅ 对症（`dedupPoint=True`）——但**归并效果与对网格/求解的影响未实机验证**（#71） |
| 相邻面/板重复建线导致重叠构件、影响网格；网格失败因"碎面/短线" | 本文 §5「多块板共用边线」、`mesh.md` §常见错误 | ✅ 对症（`dedupLine=True` / `dedupSurf=True`） |
| `save_script` 报"几何错误: 节点坐标重复定义"（#48） | `references/stru/known_issues.md` #48 | ❌ **不对症**：校验发生在**保存脚本**阶段，归并在 `toViewer()` 之后才生效，时序上救不了——必须回建模代码复用同一 `Node` 对象 |

> ★ **归并 ≠ 建模时可以随便重复建点**：铁律「相连构件在连接点必须共享同一个 `Node` 对象」
> （`script_standard.md` 铁律 6）**不变**。`dedupCoincident` 的定位是**移植 / 迭代既有几何模型**时的
> 事后补救手段，不是新建模型的偷懒借口。

**⚠️ 用前必须实机核对的 5 项（手册未说明，已登记 `references/stru/known_issues.md` #71 第 2 区）**：

1. 归并结果**是否需要再调一次 `toViewer()`** 才会写回 `pypcae.stru` 并刷新视图；
2. 归并后**节点号 / 构件号是否重排**——若重排，几何阶段记录的 `.id` 全部作废
   （性质同 `FemModel.fromViewer()` 内部 `clc()`），之后的荷载、约束、集合引用都要重取；
3. **`submitAndMesh()` 能否直接吃到归并后的几何**（`toViewer → dedupCoincident → submitAndMesh`
   一次跑通），还是必须补第二次 `toViewer()`；
4. `dedupLine` / `dedupSurf` 对**部分重合**（共线但长度不同、共面但边界不同）的判定口径；
5. `tol` 的**单位与量级**（见上表）：mm-t 制下默认 0.005 mm 几乎归并不掉任何东西，
   SI 制下默认 5 mm 又可能把**本不该合并**的近距离节点误并——先按单位制换算，
   再用小模型确认归并数量符合预期。

> ⛔ 归并会**改变模型拓扑与编号**，属**物理类变更**：用户没要求时不要主动加；
> 加了必须在交付包写明"归并了哪几类对象、传了什么 `tol`、归并前后的节点/构件计数"，
> 交用户判断（`execution_contract.md` §6）。**不自行评判归并结果对不对**（§4b 硬禁令）。

### 3. 特殊边 `Edge`（圆弧边 / 带中间节点的边）

```python
Edge(id=0, circleCenter=None, middles=None)
```

| 参数 | 含义 |
|---|---|
| `id` | 该边在构件所有边中的编号，**从 0 开始** |
| `circleCenter` | 圆弧边的圆心（节点号），当且仅当该边为圆弧时传 |
| `middles` | 该边上的中间点（节点号列表） |

用于 `BeamColumn(edge=...)` 与 `Plate(edges=[...])`：构件的某条边是圆弧或带中间节点时必须传，
否则网格划分按直边处理、几何失真。

### 4. 建筑结构构件

```python
BeamColumn(nids, iMark=ComponentType.BEAM, sid=-1, normal=None, edge=None)
Wall(nids, sid=-1, circleCenter=None, caveNids=None)
Plate(nids, sid=-1, edges=None)
```

| 类 | 关键参数 | 硬约束（违反即错） |
|---|---|---|
| `BeamColumn` | `nids` 两节点；`iMark` 取 `ComponentType.BEAM/COLUMN/BRACE/RIGID/TRUSS/CABLE...`；`sid` 截面号；`normal` 截面 Y 向；`edge` 特殊边 | 关键字名是 **`iMark`**（手册正文写作"形参 `type`"是笔误，传 `type=` 会 TypeError，见 ERRATA #13）；`normal` **不得与杆轴平行**（同有限元梁单元法向规则）。★ **2026-10-22 版手册明确**：`normal` **缺省或给零向量时程序自动修正**（源码 `stru.py` 会记 `**Warning: 共有 N 个梁柱撑构件未定义局部Y轴，程序自动修正!`）——但这**不等于**可以随便给：**与杆轴平行**的情形不在自动修正范围，仍会 modelcheck 报"单元法向有错"（#30） |
| `Wall` | `nids` 四个角点；`caveNids` 墙洞四角点；`circleCenter` 圆弧墙底边圆心 | 四角点顺序**左下 → 右下 → 右上 → 左上**；洞口角点同序，可与墙节点重合 |
| `Plate` | `nids` 板角点；`edges` 特殊边列表 | 节点绕序**右手螺旋向上**（法向朝上）；反了会导致板法向朝下、面荷载方向反 |

### 5. 通用几何构件

```python
Line(start, end, center=None, kp=None, type=LineType.Straight, sid=-1, normal=None)
Surf(outer=None, inners=None, type=SurfType.Plane, bottom=-1, top=-1, center=-1, sid=-1)
Solid(outer=None, inners=None, type=SolidType.General, sid=-1)
```

> ★ **2026-10-22 版手册补齐的两条通用几何线口径**：
> ① **`sid` 小于零 = 纯几何**（手册原文）——即"只作面/体边界、不生成单元"的几何线就是 `sid<0`；
>    这与本库既有口径"只作边界的几何线**不挂** `sid`"（ERRATA #47）是同一件事，现在有了权威判据；
> ② **`normal` 仅对非纯几何构件生效**，且**缺省或给零向量时程序自动修正**
>    （源码 `stru.py` 记 `**Warning: 共有 N 个通用几何线构件未定义局部Y轴，程序自动修正!`）。
>    ⛔ 但**与杆轴平行**的 `normal` 仍需自行避免（#30 的报错不属自动修正范围）。

| 参数 | 含义与规则 |
|---|---|
| `Line.center` / `Line.kp` | 圆弧（`LineType.Arc`）/整圆（`Circle`）**必须同时传** `center`（圆心节点号）与 `kp`（方向点）：`kp=0` 竖直向上(z+)、`kp=-1` 竖直向下(z-)、`kp=center` 表示按"圆心-起点-终点"自动定向、`kp≠center` 时按两次叉乘定向。**漏传任一会静默退化为直线**（源码 `type` 被改回 `Straight`），不报错——见 ERRATA #14 |
| `Surf.outer` | 外边界**线构件的 id 列表**（不是节点 id） |
| `Surf.inners` | 内边界（开洞），`list[list[int]]`，**每个洞一个子 list**，元素为线 id |
| `Surf.bottom`/`top`/`center` | 圆柱圆台面：`bottom`+`top` 均为**线 id**；圆锥面：`bottom` 为线 id、`top` 为**顶点节点 id**；球冠面 `Crown`：`bottom`+`center`（球心节点号）；球环面 `Ring`：`bottom`+`center`+`top`（`center` 可省略） |
| `Surf.type` | `SurfType.Plane/Cylinder/Cone/TriPatch/Crown/Ring`；**圆柱/圆锥/球面不传 `outer`**（源码会把 `outer` 覆盖为 `[-1,-1]` 再按 `bottom`/`top`/`center` 填充） |
| `Solid.outer` / `inners` | 外表面 / 内腔表面的**面构件 id 列表**；`type=SolidType.General`（通用多面体） |

**实测补充（2026-10-12，PkpmCAE `pypcae` 2.1.0，见 `references/stru/known_issues.md` #44~#58）**：

- **整圆边线**：`Line(start=n.id, end=n.id, center=圆心点号, kp=方向点号, type=LineType.Arc)`——
  起点=终点即为一个整圆（`examples/stru/stru_industrial_silo.py` 的筒身每层只用 1 条整圆线 + 1 个
  `Surf(type=SurfType.Cylinder, top=, bottom=)` 就是一段完整圆柱/圆台面）；
  若起终点是直径两端（如 `(R,0,0)` 与 `(−R,0,0)`）得到的只是**半圆**，围出的实体是半 bodies
  （`examples/stru/stru_solid_geometry.py` 即如此，体积只有整值一半，#58）；
- **★ 球面配方（#52，手册未写）**：整球 = **两个** `Surf(type=SurfType.Crown, bottom=<赤道整圆线 id>,
  center=<球心节点号>)`，且**两个球冠面各自引用一条赤道整圆线、两条线的 `kp` 方向点相反**
  （一条 `kp=北极点`、一条 `kp=南极点`）——上下半球靠 `kp` 朝向区分。
  ✗ 两种失败写法（都只划出 **0 个体单元**、日志仍报"任务执行成功!"）：
  两个 Crown 共用同一条整圆线（序列化后两面完全相同、实体不闭合）；给 Crown 传 `top=`顶点节点号。
  实测 R=1 m + `basicSize=0.2` → 892 节点 / 4277 四面体 / 体积 4.0851 m³（理论 4.1888，−2.48%），
  见 `examples/mixed/sphere_solid_selfweight.py`；
- **`Surf.outer` 的边数与共面**：实测 4 条边（四边形）、5 条边（`stru_solid_geometry` 的侧面）、
  6 条边（`stru_open_web_truss_node` 的 z=−650 六边形板）都可正常建面与划网格；边线必须**首尾相接成闭环**，
  平面面（`SurfType.Plane`）的各边应共面；相邻面**共用同一条边线**（不要重复建线）；
- **`kp`（方向点）的实务取值**：手册给了 `0`（z+）/`−1`（z−）/`=center`（自动定向）/`≠center`（两次叉乘）
  四种语义；实测**统一传一个"z 高于圆心的参考节点"**最稳（料仓、球体示例都这么做：料仓用 `center_dir`、
  球体用北极/南极点）；`kp` 的朝向还决定了 Crown 面取哪一侧半球（见上）；
- **★ 普通圆弧（`start≠end`）凸向的实测判定式**：`凸向 = (kp−center) × (start−center)`（单次叉乘，
  与手册字面的"两次叉乘"表述不同）。推论：`kp` 取"圆心正上方（+z）"的参考节点时，各段弧一律按
  **逆时针**取**劣弧**——所以把圆周切成多段弧时，只要断点角**逆时针递增且每段跨度 < 180°**，
  方向就不会歧义（实测 6 段弧拼 Φ150×150 圆柱，单元体积对标 πR²H 偏差 −0.74%，
  见 `examples/mixed/concrete_splitting_tensile.py`）；⚠ `start=end` 的**整圆线**走的是另一套语义
  （`kp−center` 直接给圆面法向，如球体/料仓示例），不能用上式推；
- **★ 圆周按"功能边界"切段（让局部尺寸成为可控几何量）**：要在圆柱面上按位置筛节点来布荷载/约束
  （劈裂试验的垫条带、局部加载区、支座带…），**不能只用一条整圆线**——粗网格下该带内可能一个节点
  都没有，带宽会静默退化成线荷载。做法：把圆周断点设在功能边界角上（如 ±θ_pad），每段弧 → 一片
  `Surf(type=SurfType.Cylinder, bottom=下端弧, top=上端弧)`；同端各弧围合成
  `Surf(outer=[弧 id...], type=SurfType.Plane)` 圆盘端面；再由全部面拼 `Solid`
  （实测 6 片侧面 + 2 个圆盘 = **8 面闭合**，正常划出 1479 节点 / 7219 四面体）；
- **类名/形参旧写法对照**（读软件自带示例时会遇到）：

  | 自带示例写法 | 手册/实测正解 | 说明 |
  |---|---|---|
  | `Wire(a, b, cid, did, WireType.Arc)` | `Line(start=a, end=b, center=cid, kp=did, type=LineType.Arc)` | `Wire`/`WireType` 仍存在（`Wire is not Line`）且生成的构件同为 `iMark=61`，但手册只登记 `Line`（#45） |
  | `MatDB.assemble("Q345", type=...)` | `iType=...` | 运行时签名 `(name, iType, iMark, iModel=0, setting=None)`；`type=` 也能跑通（别名），统一用 `iType=`（#49） |
  | `Tube(mid, D=1200, d=900)` | `Tube(mid, D, d)` 全位置 | 第三参是**内径 d**（手册与 `list_shapes()` 误作 `t`）；平台校验会拦关键字传参（#44） |
  | `Surf([线 id...], sid=...)` | `Surf(outer=[线 id...], sid=...)` | 位置传参可用，按技能铁律改关键字 |

- **几何边线可不挂 `sid`**：只作为 `Surf`/`Solid` 边界的几何线不需要截面，实测不挂 `sid` 也能正常
  划出壳单元（桁架节点 87 条、料仓 800 条边线全部无截面）；**挂了 `sid` 反而会额外生成梁单元**（#47）；
- **`Elset` 可分别装面 id 与线 id**：实测同一模型里可以既有"装面 id"的集合（`shell_upper`/`hopper`），
  也有"装线 id"的集合（`rib_*_in`/`rib_*_out`）——料仓示例建了 21 个集合并随几何模型正常落盘；
  ⚠ 但"混合装（同一集合同时装线与面）"以及"按集合布荷载时软件如何解释"未实测，布荷载前先用小模型验证；
- **同坐标点必须复用同一 `Node`**：`save_script` 会直接把重复坐标判为"几何错误"（#48）；跨组交点、
  重合边线都要复用同一对象（例外：官方料仓示例的环肋各自独立建圈，遗留 53 个重合节点，
  实测几何路线与网格都能通过，但正式分析前建议合并）；
  ★ 2026-10-14 版手册新增的 `StruModel.dedupCoincident`（见 §核心 API 2b）正是这类**遗留**重合点/线/面的
  事后归并手段，但它**治不了 #48**（校验在保存脚本阶段、归并在 `toViewer()` 之后，时序不搭），
  也**不能替代**建模时共享同一对象；
- **多块板共用边线**：相邻壳板共用同一条 `Line`（`examples/stru/stru_open_web_truss_node.py`），

- **★ 整圆回转面可用（2026-10-14/15 实测更正，此前记录有误）**：
  `Line(start=n.id, end=n.id, center=圆心, kp=方向点, type=LineType.Arc)` 得到的**整圆线** +
  `Surf(type=SurfType.Cylinder, top=上整圆线, bottom=下整圆线)` 得到的**整圆回转面完全可用**：
  实测整圆柱 232 单元、整圆台 246 单元、竖直筒腹板 60 单元，**均全四边形、无退化单元**。
  ⚠️ 仍然不可用的**只有一种**写法：用 `Surf(Cylinder)` 以「**同标高、不同半径**」的两条整圆拼**水平环面**
  → femesh 报 `**Error:边界点夹角有错-2`（每扇区/每面一条）且 **0 单元**。
  **水平环面的正确写法**：`Surf(outer=[外整圆], inners=[[内整圆]], type=SurfType.Plane)`（实测 36/58 单元）。
  **规模与质量对照（同一 D18×H30 筒仓）**：周向 24 扇区版 1026 节点 / 1416 线 / 792 面 → 9655 单元；
  **整圆版 33 节点 / 20 线 / 22 面 → 2930 单元**，且网格规整度显著更好。
  ⇒ **回转壳（筒壁 / 锥斗 / 环腹板）优先整圆面**，扇区弧段仅在"荷载必须按扇区方向施加"等不得已时才用；
- **★ 真圆弧孔（带孔面 + 孔壁）配方（2026-10-15 实机验证：几何 + 网格 + 求解全通过）**：
  ① 在孔的两个端面平面各建一圈断点，断点角**逆时针递增、每段跨度 < 180°**；
  ② 每圈用 N 段 `LineType.Arc` 连成闭环，`center` 与 `kp` **必须同时给**（漏传静默退化为直线，#14）；
  ③ 带孔平面：`Surf(outer=[外环线...], inners=[[N 条弧线...]])`；
  ④ **孔壁用 N 片 `Surf(bottom=低端弧, top=高端弧, type=SurfType.Cylinder)`（不传 `outer`）**；
  ⑤ 两个带孔面 + N 片孔壁一起放进 `Solid(outer=[...])`。
  实测 Ø26 孔、N=16 → 孔壁网格节点半径**严格 13.000000 mm**（对比八边形折面方案每面仅 8 个节点）；
- **★ 真圆柱实体（螺栓 / 圆棒）配方（同上实测）**：N 段弧环（**两端相位必须一致**，否则侧面片扭曲）
  + N 片 `SurfType.Cylinder` 侧面 + 2 个圆盘端面 `Surf(outer=[N 条弧线], type=SurfType.Plane)` → `Solid.outer`。
  实测 Ø24、N=16 → **384 个节点全部落在半径 12.000000 mm**，与 Ø26 孔壁保持单边 1 mm 均匀间隙；
- **★ 几何圆度 vs 网格圆度（固定口径，勿混为一谈）**：
  `几何圆度 ← 曲面类型`（`Plane` 折面 / `Cylinder` 真柱面）；`网格圆度 ← 断点数 N`
  （网格的直线边只能落在断点之间）。"几何已是真圆但网格仍呈多边形"**不是建模错误**，是 N 不够；
- **`kp`（方向点）在非竖直轴圆上的取法（2026-10-15 新增实测）**：既有口径"kp 取圆心正上方（+z）参考点"
  只适用**竖直轴**圆柱；**圆面法向沿 X 时，kp 取"圆心 +X 侧的参考点"同样成立**。
  进一步：**同一孔轴的两个端面圆环可以共用同一个方向点**，只要该点分别落在两个圆心的 +X 方向上
  （即**方向向量同向即可，与距离无关**）。判据仍为：断点角逆时针递增、每段跨度 < 180°；
- **⚠️ 圆弧 / 整圆构造会产生"孤立节点"（2026-10-15 实测）**：**圆心节点与 kp 方向点会出现在
  有限元网格节点表里，但被 0 个单元引用**。实测某节点模型共 **74 个**（18 孔×3 + 6 螺栓×3 + 2 个耦合悬空参考点）。
  影响：① **不致求解失败**（专门小模型 + 正式整模型均正常结束，无 `zero pivot`、模型检查无 error、
  荷载步全收敛）；② 会**污染节点统计**（"节点数"含不承载节点）；③ 会**污染按坐标/半径做的筛选**
  （实测"孔内是否有母材节点"检查中 12 个初判"误判节点"**全部是孤立圆心点**）；④ 视图里可能显示为游离点。
  ⇒ **一切"按坐标筛节点"的检查，都应先剔除孤立节点再判断**；统计方法见 `verification.md`「孤立节点统计」；
- **★ 分割面"同坐标重复定义"的三条出路（2026-10-15 实测取舍）**：把同一构件切成两块时，
  两块在分割面必然出现同坐标节点 → `save_script` 报"节点坐标重复定义"（#48）。现有文档只给了"共享 `Node`"一条：

  | 方案 | 做法 | 优点 | 代价 |
  |---|---|---|---|
  | (a) 共享 `Node` | 第二块复用第一块端面节点 | 拓扑最干净、无几何间隙 | 两块在分割面只有 N 个棱点相连（**远不够**），**仍需绑定**；且该批节点同属主/从集合，筛选时要排除 |
  | **(b) 留 1 mm 几何间隙 + 绑定**（★ 推荐、实测采用） | 第二块起点外移 1 mm，用 `Binding(NodeToSurf, iTol=1, tol=…)` 连接 | **最简单、最稳** | 几何上有发丝缝（由绑定等效连续）；`tol` 要**显式给**（1 mm 可能超过点-面自动容差 `l/10`） |
  | (c) 不分割 | 整体实体 | 无上述问题 | 得不到分区网格（见 `mesh.md`「用实体分割间接实现分区网格」） |

- **★ 几何面原语的能力边界（新建任何几何/混合模型前先对照这张表）**：

  | 目标曲面 | 可用原语 | 结论 |
  |---|---|---|
  | 平面多边形（3~N 边，各边共面闭环） | `SurfType.Plane`（`outer` 传边线闭环） | ✅ 直接可用 |
  | 圆柱 / 圆台 | `SurfType.Cylinder`（`bottom`+`top` 传线 id） | ✅ 直接可用（**整圆线也可**，见上） |
  | 圆锥 | `SurfType.Cone`（`bottom` 传线 id、`top` 传**顶点节点 id**） | ✅ 直接可用 |
  | 球面 / 球环面 | `SurfType.Crown` / `Ring` | ✅ 直接可用（整球配方见 #52） |
  | **三角面片离散面（任意曲面/实体的通用表达）** | `SurfType.TriPatch` | ✅ **已实机破解可用**（2026-10-16，#120~#122）：一个面承载全部三角面片；配方见下条 |
  | 一般放样面 / 直纹面 / Coons 面 / NURBS 曲面；翼型 / 船体 / 机翼 / 风机叶片 / 双曲屋面 / 蜗壳 / 拱坝 / 任意"沿路径扫掠+变截面+扭转"实体 | `SurfType.TriPatch`（无放样原语时的统一出路） | ✅ 离散成三角面片即可建（`Plane` 逐片拼接仍保留为已实测备选，#98） |

  **推论**：凡不是平面 / 回转面 / 球面的曲面，统一出路是**三角面片离散**——
  ★ **2026-10-16 起首选 `SurfType.TriPatch`**（已实机破解，见下条「TriPatch 离散面配方」）；
  旧配方「`Plane` + 3 条边线逐片拼接」保留为已实测备选（#98，面对象数多 2~3 个数量级）。
- **★ `SurfType.TriPatch` 离散面配方（2026-10-16 实机破解，手册无文档，#120~#122）**：

  **定位**：软件几何表达体系里"无解析原语的任意面/体"的统一出路——任意复杂曲面离散成一组三角形，
  **一个面对象**承载全部面片（模型树只有 1 个面）；配 `Solid(General)` 即可围成任意不规则实体。

  **数据结构（实测自 pgm→CAE 导出真值 + 源码核对）**：

  | 组成 | 写法 |
  |---|---|
  | 节点 | 全部离散点（含内部点），`Node(x, y, z)` |
  | 线 | **只需边界线**；内部网格点无需任何内部线 |
  | 面 | `s = Surf(outer=[边界线 id...], type=SurfType.TriPatch, sid=...)`；`s.patches = [[n1,n2,n3], ...]`（★ **构造后赋值属性写入**，构造器无此形参；序列化走 `__dict__` 整体落盘） |
  | `outer` 回路 | 开口面＝边界线闭环（圆柱面实测：接缝 + 底环一周 + 接缝 + 顶环一周）；**闭合面（球）＝一条接缝链"去程+回程"，每条链线出现两次** |
  | `patches` 索引 | **节点 id**（节点先建、id 从 0 连续时与下标一致，否则一律引 `.id`） |

  **两条已实测形态**：

  1. **开口壳面**（圆柱面：双环 96 节点 / 97 线 / 96 面片 → 2016 节点 / 1920 四边形壳单元，
     与 pgm 导出产物网格数字完全一致）——面挂 `SectionType.Surface` 壳截面，
     见 `../examples/stru/cyl_shell_tripatch.py`；
  2. **闭合实体**（球体：266 节点 / 528 面片 / 12 条接缝线 → `Solid(outer=[面])` →
     5092 节点 / 26762 四面体）——面不挂截面，**实体截面挂在 `Solid`**（`SectionType.Solid`），
     见 `../examples/stru/sphere_tripatch_solid_uv.py`。

  **五条硬规则**（都实测过）：① 闭合流形自检：每条边恰好被 2 个三角形引用、欧拉 `F=2V-4`、
  法向一致朝外；② 边界线不挂 `sid`（#47）；③ 混合路线全链路可用（静力 ΣRz 平衡、模态无零频，
  `../examples/mixed/cyl_shell_tripatch_mixed.py`）；④ 网格规模由 `basicSize` 主导而非面片数
  （612 片与 528 片的 R50 球网格规模相当）；⑤ ⚠️ 未实测项：内腔 `inners` 离散面、
  超大面片数（>10 万）、非一致法向的容错——用前先小模型验证。

- **★ 三角面片拼闭合实体（自由曲面 / 放样体的通用配方，2026-10-15 实测通过）**：

  ```text
  给定：NS 个展向剖面，每剖面 NP 个轮廓点（闭合、各剖面点数一致）
  节点     : NODES[s][i]                                          (s=0..NS-1, i=0..NP-1)
  轮廓线   : L_CIRC[s][i] = NODES[s][i]   -> NODES[s][(i+1)%NP]   (每剖面 NP 条)
  展向线   : L_SPAN[s][i] = NODES[s][i]   -> NODES[s+1][i]        (相邻剖面 NP 条)
  对角斜线 : L_DIAG[s][i] = NODES[s][i]   -> NODES[s+1][(i+1)%NP] (相邻剖面 NP 条)

  每个"四边形环带"拆两个三角面（均用 SurfType.Plane）：
    面A = [ L_CIRC[s][i] , L_SPAN[s][(i+1)%NP] , L_DIAG[s][i] ]
    面B = [ L_DIAG[s][i] , L_CIRC[s+1][i]     , L_SPAN[s][i]  ]
  两个端盖：Plane 面，外边界取 L_CIRC[0] / L_CIRC[NS-1]（各自闭环、各自共面）

  实体：Solid(outer = 全部三角面 + 2 个端盖)
  ```

  三条要点（都是实测踩过的）：① **每条线恰好被两个面引用**——相邻面共用同一条边线，不要重复建线；
  ② **节点跨剖面 / 跨环必须复用同一个 `Node` 对象**，否则触发"节点坐标重复定义"（#48）；
  ③ 端盖用**整圈轮廓线**做外边界（闭环 + 共面），不要另建弦线。
  **面片数规模实测（把本库上限推高了一档）**：

  | 模型 | Solid 面片数 | 线数 | 几何节点 | 网格结果 | 结论 |
  |---|---|---|---|---|---|
  | 11 m 验证算例（5 点/侧、12 剖面） | 222 | 340 | 120 | 5442 节点 / 26597 四面体 | ✅ 通过 |
  | **59 m 风电叶片（8 点/侧、23 剖面）** | **706** | **1072** | **368** | **7615 节点 / 28948 四面体** | ✅ 通过 |

  ⇒ 经验值：**单个 `Solid` 挂到数百个平面面片、上千条边线，自动网格（四面体）可以跑通**；
  最耗时环节不是几何生成，而是网格与特征值求解（约 2 s 量级）；
- **环向加劲肋 / 环撑与壳体的共边约束（★ 拓扑要求，2026-10-15 实测）**：
  环肋内圈圆**必须与壳体面的边界圆为同一条 `Line`**，否则环肋与壳体网格**不共节点（悬空）**。
  整圆面模型中若想在**面中部**加肋，必须先把壳面在该标高**拆成两个面**。
  · **闭合矩形截面环撑**（矩形轮廓 b×h 贴壁外挑）= 下翼缘 `Plane` 环面 + 外腹板整圆 `Cylinder` + 上翼缘 `Plane` 环面；
    上、下翼缘的**内孔圆都必须是仓壁边界圆** ⇒ 仓壁需按 `z=r` 与 `z=r+h` 两个标高**拆带**；
  · **L 形环肋**（环带 + 腹板）只需**一个**边界圆；锥面上做闭合矩形环撑会要求锥面额外分层
    （见 `mesh.md`「回转面分段与过渡带」），故**锥面环肋建议保持 L 形**；
  · ⚠️ 壳模型中环肋内圈取壳体**中面半径**会与壳体外半厚重叠，属**壳理想化**，须在脚本注释与交付包中声明；
  重复建线会产生重叠构件并影响网格。

> 端到端示例：几何路线 `examples/stru/stru_industrial_silo.py`（整圆线 + 回转面 + `Elset` 分组）、
> `examples/stru/stru_open_web_truss_node.py`（多块壳板拼节点、共用边线）、
> `examples/stru/stru_cable_stayed_bridge.py`（线构件挂截面 + 壳面板组合、参数化子函数）、
> `examples/stru/stru_solid_geometry.py`（Line→Surf→Solid + 实体网格）；
> 混合路线 `examples/mixed/sphere_solid_selfweight.py`（球面 + 实体网格 + 静力求解）、
> `examples/mixed/stru_to_fem_mixed.py`（杆系 + 理论解对标）、
> `examples/mixed/concrete_splitting_tensile.py`（多段圆弧拼 8 面闭合圆柱实体 + 刚性垫条 `Coupling`
> 力控制 + 弹性理论解对标）。

### 6. 构件侧与有限元侧的写法差异（易错点集中区）

| 主题 | 有限元模型 | 结构（几何）模型 |
|---|---|---|
| 约束 `Fixed` | `type=FixedType.Default`（点约束），`gnids` = 节点号 | 点约束同左；**线约束**：建筑结构用 `type=FixedType.BaseLine`，`gnids` = 构成线的**点编号**；通用几何用 `type=FixedType.BaseLineGeom`，`gnids` = 被约束的**线构件号** |
| 荷载 `geids` | 单元号 | **构件号**（`BeamColumn`/`Wall`/`Plate`/`Line`/`Surf`/`Solid` 的 `.id`），也可传 `Elset` 集合号 |
| 非均布荷载 `coord` | 位置 = **距离** | 位置 = **百分比** |
| `PipeLoad` 管压力 | 仅管**单元** | 仅管截面**构件** |
| `VSABoundary` 人工边界 | 支持 | **仅有限元模型**支持 |
| 网格设置 | 无效（手工划分节点单元） | **仅在几何模型中生效**（`Size`/`MeshSetting`/`MeshParams`/`LoadToMassSetting`，见 `mesh.md`） |
| 自重 `Emload` | `geids` = 单元号，或留空 = 全局 | `geids` = 构件号，或留空 = 全局；`value` 是加速度（SI 用 9.81） |

> 荷载/工况/分析的装配链（`LoadCase.add` → `LoadCaseCombine(lid, coef)` → `Step(loadCases=[...])` →
> `Analy(steps=[...])` → **`Job` + `JobManager`**）两条路线完全相同：
> 荷载见 `loads.md`、装配与任务指派见 `analysis.md`、约束见 `supports.md`、相互作用见 `interactions.md`；
> ★ 最后两步漏掉会去算默认空分析「分析-1」，结果全 0（`references/stru/known_issues.md` #51）。

---

## 混合流程：几何 → 网格 → 有限元 → 计算（★ 时序不可颠倒）

```text
init_ctx(mode=ExecutionMode.MIXED)     ← 0. 开关：不调则第 3 步必被拦
clc()
① 几何阶段：材料 / 截面 / Node / 构件 / 网格设置（Size、MeshSetting、MeshParams）
StruModel.toViewer()                   ← 1. 几何模型可视化（写 pypcae.stru）
StruModel.submitAndMesh()              ← 2. 网格划分，生成网格后的有限元模型（pypcae.fem.in）
FemModel.fromViewer()                  ← 3. 读入有限元模型（内部先 clc()）
② 有限元阶段：荷载 / 工况 / Step / Analy / Job（节点号、单元号此时重新取）
FemModel.toViewer()                    ← 4. 有限元模型可视化
FemModel.submitAndSolve()              ← 5. 模型检查 + 提交计算
```

> ★ **几何清理（可选，2026-10-14 版手册新增）**：移植 / 迭代既有几何模型时，可在第 1 步
> `StruModel.toViewer()` **之后**、`submitAndMesh()` **之前**插入
> `StruModel.dedupCoincident(dedupPoint=True, dedupLine=True, dedupSurf=True, tol=...)`
> 归并重合点线面（详见 §核心 API 2b）。归并后**编号是否重排、`submitAndMesh()` 能否直接吃到归并结果**
> 均未实机验证（#71）——首次使用先在小模型上核对归并前后的节点/构件计数；
> 属物理类变更，**用户没要求不要主动加**，加了要在交付包写明参数与计数变化。

**六条铁律**：

1. **`init_ctx(mode=ExecutionMode.MIXED)` 必须在最前**：`submitAndMesh()` 只在 MIXED 模式下
   生成 `FemModel.fromViewer()` 要读的 `pypcae.fem.in`；★ **2026-10-22 更正**：缺省该文件时 `fromViewer()` **不抛异常**——
   源码 `Viewer.__from()` 只记 `**Error: 找不到文件: <path>` 后返回，**静默得到空模型**（`docs/ERRATA.md` #127）⇒ 用前先查该文件是否存在。
2. **网格设置必须写在 `StruModel.toViewer()` 之前**：`toViewer()` 会把它们序列化进几何模型，
   并把 `MeshParams` 快照交给 `submitAndMesh()`；写在 `toViewer()` 之后**静默无效**（详见 `mesh.md`）。
3. **`FemModel.fromViewer()` 内部会先 `clc()`**：几何阶段的构件对象与其 id **全部作废**，
   节点/单元由网格结果重建；`Node`/`Element` 编号必须在 `fromViewer()` **之后**重新获取
   （`Node.all()` / `Element.all()`，或 `Nset`/`Elset`、条件查询定位）。
4. **有限元阶段的荷载与分析一律写在 `fromViewer()` 之后**：写之前先用 `LoadCase.all()` /
   `Analy.all()` 核对几何阶段的布置是否已随网格带入，缺失或需改动的一律重新定义。
5. **收口按目标决定**：只要网格 → 到 `submitAndMesh()` 为止（`StruModel.toViewer()` 不可省）；
   要计算结果 → 必须补 `FemModel.toViewer()` + `FemModel.submitAndSolve()`。
6. **★ 网格模式走软件默认（六面体主导 + 四边形主导 + 扫掠），总体尺寸按整体模型综合判断**：
   混合流程里 `MeshParams` 必须在第 ① 几何阶段一次配齐，而**软件默认值就是最优起点**——
   `meshPattern="sweepAndTMesh"`（**体网格六面体主导**：可扫掠区出六面体、复杂区自动补四面体）、
   `hexMeshPattern="sweepOnly"`（**六面体＝扫掠网格**）、`toQuad="true"`（**面网格四边形主导**）、
   `hexFtPattern="FT"`；显式写出便于用户核对，但**不要随意改**，只有几何复杂到扫掠划不出
   （碎面/回转体/球面/多开洞）才降级 `tMeshOnly`（属交付缺陷类修复，须记重试台账；
   用户已指定模式后再改则须先问）。**总体尺寸 `basicSize` 不得一刀切、不得照抄示例值**：
   须按模型总体尺度与单位制、最小特征尺寸（最薄板厚/最小截面边长）、分级尺寸
   （`beamSize`/`wallSize`/`plateSize`）、分析目的、预估单元规模与耗时、几何复杂度综合判断，
   相邻区域尺寸比 ≤ 2:1 且逐级过渡；依据与预估规模写进「建模规格核对表」网格行。
   ⛔ 需要更细或做网格无关性研究 → 先问用户，不自行加密、不自行做多套对比。
   能力边界（**不能按区域切换六面体/四面体**、`ElementType` 中**无金字塔/楔形过渡单元**，
   交界过渡由划分器内部生成、不可控）与尺寸判断维度表见 `mesh.md`「★ 单元类型与网格模式选型」§1~§7。

### 界面执行与视图刷新（用户高频疑问，按此回答）

- 几何模型页面与有限元模型页面**都可以执行混合模式脚本**；
- 但**不能**在几何模型页面执行**纯**有限元脚本、也**不能**在有限元模型页面执行**纯**几何脚本
  （执行模式锁定后另一类接口直接抛错，见 §核心 API 1）；
- 视图**只刷新与所在页面相关的部分**：几何页面执行 `StruModel.toViewer()` 会刷新、
  执行 `FemModel.toViewer()` **不会**刷新；有限元页面相反。
  → 脚本执行成功而当前页面没变化属**正常现象**，要看有限元模型或计算结果需切到有限元页面。

---

## 代码模板

### 模板 1：建筑结构模型（单层框架梁柱板，纯几何收口）

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel

clc()

MatDB.load()
setting = Setting()                                   # 默认 m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
col_sec  = Section("col",  SectionType.Line,    Rectangle(mid=mat.id, b=0.5, h=0.5))
beam_sec = Section("beam", SectionType.Line,    Rectangle(mid=mat.id, b=0.3, h=0.6))
slab_sec = Section("slab", SectionType.Surface, SingleLayer(mid=mat.id, t=0.12))

SPAN = 6.0        # m，开间
HEIGHT = 3.0      # m，层高
nb = [Node(ix * SPAN, iy * SPAN, 0.0) for iy in range(2) for ix in range(2)]   # 柱脚
nt = [Node(ix * SPAN, iy * SPAN, HEIGHT) for iy in range(2) for ix in range(2)]  # 柱顶

for i in range(4):                                                            # 柱
    BeamColumn(nids=[nb[i].id, nt[i].id], iMark=ComponentType.COLUMN,
               sid=col_sec.id, normal=[0, 1, 0])
for a, b, nrm in [(0, 1, [0, 1, 0]), (2, 3, [0, 1, 0]),                      # X 向梁：法向取 Y
                  (0, 2, [1, 0, 0]), (1, 3, [1, 0, 0])]:                      # Y 向梁：法向取 X
    BeamColumn(nids=[nt[a].id, nt[b].id], iMark=ComponentType.BEAM,
               sid=beam_sec.id, normal=nrm)                                  # normal 不得与杆轴平行
Plate(nids=[nt[0].id, nt[1].id, nt[3].id, nt[2].id], sid=slab_sec.id)          # 楼板（右手螺旋向上）

Fixed(gnids=[n.id for n in nb], dof=[Dof.All])                                # 柱脚固结

StruModel.toViewer()
```

### 模板 2：通用几何模型（圆柱 + 圆锥组合体，纯几何收口）

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel

clc()

R = 1.0        # m，圆柱半径
H1 = 1.0       # m，圆柱高
H2 = 2.0       # m，圆锥顶点高

n = [Node(0.0, 0.0, 0.0).id, Node(R, 0.0, 0.0).id, Node(-R, 0.0, 0.0).id,
     Node(0.0, 0.0, H1).id, Node(R, 0.0, H1).id, Node(-R, 0.0, H1).id,
     Node(0.0, 0.0, H2).id]

w = [Line(start=n[1], end=n[2], center=n[0], kp=n[6], type=LineType.Arc).id,   # 底圆
     Line(start=n[4], end=n[5], center=n[3], kp=n[6], type=LineType.Arc).id,   # 顶圆
     Line(start=n[2], end=n[1]).id,                                           # 底面母线
     Line(start=n[5], end=n[6]).id,                                           # 锥面母线 1
     Line(start=n[4], end=n[6]).id,                                           # 锥面母线 2
     Line(start=n[2], end=n[5]).id,                                           # 柱面母线 1
     Line(start=n[1], end=n[4]).id]                                           # 柱面母线 2

s = [Surf(bottom=w[0], top=w[1], type=SurfType.Cylinder).id,                   # 圆柱面（不传 outer）
     Surf(bottom=w[1], top=n[6], type=SurfType.Cone).id,                       # 圆锥面（top 是顶点节点号）
     Surf(outer=[w[0], w[2]], type=SurfType.Plane).id,                         # 底面
     Surf(outer=[w[2], w[5], w[3], w[4], w[6]], type=SurfType.Plane).id]       # 锥侧面（母线围合）
Solid(outer=[s[0], s[1], s[2], s[3]])

StruModel.toViewer()
```

### 模板 3：混合流程（几何 → 网格 → 有限元 → 计算）★

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel
from pypcae.fem import FemModel
from pypcae.base import init_ctx

init_ctx(mode=ExecutionMode.MIXED)     # 混合模式开关：import 之后、clc() 之前
clc()

# ========== ① 几何阶段 ==========
MatDB.load()
setting = Setting()                    # m 制（SI）
mat = MatDB.assemble("C30", iType=MaterialType.Concrete,
                     iMark=ConcreteType.C30, setting=setting)
col_sec  = Section("col",  SectionType.Line,    Rectangle(mid=mat.id, b=0.5, h=0.5))
beam_sec = Section("beam", SectionType.Line,    Rectangle(mid=mat.id, b=0.3, h=0.6))
slab_sec = Section("slab", SectionType.Surface, SingleLayer(mid=mat.id, t=0.12))

SPAN, HEIGHT = 6.0, 3.0                # m
nb = [Node(ix * SPAN, iy * SPAN, 0.0) for iy in range(2) for ix in range(2)]
nt = [Node(ix * SPAN, iy * SPAN, HEIGHT) for iy in range(2) for ix in range(2)]
cols, beams = [], []
for i in range(4):
    cols.append(BeamColumn(nids=[nb[i].id, nt[i].id], iMark=ComponentType.COLUMN,
                           sid=col_sec.id, normal=[0, 1, 0]).id)
for a, b, nrm in [(0, 1, [0, 1, 0]), (2, 3, [0, 1, 0]),                      # X 向梁
                  (0, 2, [1, 0, 0]), (1, 3, [1, 0, 0])]:                      # Y 向梁
    beams.append(BeamColumn(nids=[nt[a].id, nt[b].id], iMark=ComponentType.BEAM,
                            sid=beam_sec.id, normal=nrm).id)
slab = Plate(nids=[nt[0].id, nt[1].id, nt[3].id, nt[2].id], sid=slab_sec.id).id

Fixed(gnids=[n.id for n in nb], dof=[Dof.All])                 # 柱脚固结（构件侧可用点约束）
MeshParams(sizer=Size(isBasic=True, basicSize=0.5, beamSize=0.5,
                      wallSize=0.5, plateSize=0.5), toQuad="true")   # 网格设置只在几何阶段生效

StruModel.toViewer()          # 1 几何模型可视化
StruModel.submitAndMesh()     # 2 网格划分 → 生成 pypcae.fem.in
FemModel.fromViewer()         # 3 读入网格后的有限元模型（内部先 clc()，几何对象作废）

# ========== ② 有限元阶段（编号一律重新取） ==========
all_eids = [e.id for e in Element.all()]
base_nids = [n.id for n in Node.all() if n.z == 0.0]           # 柱脚节点（编号重新取，按坐标重筛）
if not Fixed.all():                                            # 几何阶段约束若已随网格带入则无需重复施加
    Fixed(gnids=base_nids, dof=[Dof.All])

lc_dl = LoadCase("DL")
lc_dl.add(Emload(geids=all_eids, value=9.81, dir=[0, 0, -1]))  # 自重（加速度，随单位制）
lc_ll = LoadCase("LL")
lc_ll.add(Esload(geids=[e.id for e in Element.all() if e.dimension == 2],
                 type=LoadDistributionType.Uniform, subType=LoadSubType.Force,
                 value=[2000.0], iCoord=CSYS.GlobalSystem, dir=[0, 0, -1]))

step_dl = Step("Step_DL").add(LoadCaseCombine(lc_dl.id, 1.0))
step_ll = Step("Step_LL").add(LoadCaseCombine(lc_ll.id, 1.0))
step_all = Step("Step_ALL").add(LoadCaseCombine(lc_dl.id, 1.0)) \
                            .add(LoadCaseCombine(lc_ll.id, 1.0))
analy = Analy("StaticAnalysis")
analy.add(step_dl); analy.add(step_ll); analy.add(step_all)

FemModel.toViewer()           # 4 有限元模型可视化
FemModel.submitAndSolve()     # 5 模型检查 + 提交计算
```

### 模板 4：只要几何模型 + 网格（不计算）

```python
# import 与几何建模同模板 1（**不要**调 init_ctx，纯几何路线）
StruModel.toViewer()          # 可视化（不可省）
StruModel.submitAndMesh()     # 划网格；成功后脚本正常结束，求解由用户在界面提交
```

### 模板 5：几何清理——归并重合点线面（移植 / 迭代既有模型时用）★ 2026-10-14 版手册新增

```python
from pypcae.enums import *
from pypcae.comp import *
from pypcae.stru import StruModel

clc()

setting = Setting()                    # 先定单位制：tol 必须随它换算
setting.iTypeSI = 2                    # 例：mm-t 制（长度 mm）
MatDB.load()
mat = MatDB.assemble(name="Q390", iType=MaterialType.Steel,
                     iMark=SteelType.Q390, setting=setting)
sec = Section(name="solid_sec", type=SectionType.Solid, sub=SolidSect(mid=mat.id))

# ... 节点 / Line / Surf / Solid 构件（建模时仍须共享同一 Node 对象、相邻面共用同一条边线，
#     见 script_standard.md 铁律 6；归并是补救手段，不是重复建点的借口）...

MeshParams(sizer=Size(isBasic=True, basicSize=150.0),   # mm-t 制：150 mm
           meshPattern="sweepAndTMesh", hexMeshPattern="sweepOnly",
           hexFtPattern="FT", toQuad="true")            # ★ 网格设置必须在 toViewer() 之前

StruModel.toViewer()                   # 1 几何模型可视化
StruModel.dedupCoincident(dedupPoint=True, dedupLine=True, dedupSurf=True,
                          tol=0.5)     # ★ 只能在 toViewer() 之后；mm-t 制 0.5 mm
                                       #   （SI 制同样想归并 0.5 mm 要写 tol=0.0005）
# ⚠️ 未实机验证（references/stru/known_issues.md #71）：归并后节点/构件号是否重排、是否需要再 toViewer()
#    一次才能划网格、submitAndMesh() 能否直接吃到归并结果——首次使用先在小模型上核对
#    归并前后的节点数 / 线数 / 面数，再用到正式模型，并把计数变化写进交付包
StruModel.submitAndMesh()              # 需要网格时（能否直接吃到归并结果待实测）
```

---

## 最佳实践

1. **先定路线再动手**：用户没明说时按 `references/stru/guide.md` §2 的「路线澄清」**必问一句**
   （结构（几何）/ 混合 二选一），不要默认，也不要因为"要网格"就默认选结构路线——
   要计算结果就是混合路线；只要常规有限元建模则不属本技能；
2. **需要生成单元的构件必须挂截面**：线构件用 `SectionType.Line`、面构件用 `SectionType.Surface`、
   体构件用 `SectionType.Solid`。★ **2026-10-22 版手册明确 `sid<0` = 纯几何构件**（不生成单元，
   只作面/体边界——这正是 #47 的权威判据）：所以**不挂 `sid` 不是漏写**，而“该生成单元却没挂 `sid`”才是白建；
3. **`normal` 不得与杆轴平行**：X 向梁给 `[0,1,0]`、Y 向梁给 `[1,0,0]`（与有限元梁单元同规则，
   否则 modelcheck 报"单元法向有错"）；
4. **拓扑引用用 id 不用对象**：`Surf.outer` 传 `Line` 的 `.id`、`Solid.outer` 传 `Surf` 的 `.id`；
   节点引用一律 `.id`，禁止硬编码数字；
5. **网格尺寸与构件尺寸同量级**：特征尺寸的 1/4 ~ 1/10，孔口/支座处用 `MeshSetting` 局部加密
   （`ids` 是**构件号**）；先中等尺寸试算，再按 `verification.md` 做收敛性检查；
6. **混合流程把"几何阶段"与"有限元阶段"用注释分区**（见模板 3），并在有限元阶段开头
   重新取编号——这是最容易出错的一环；
7. **规模预估**：网格划分后单元数可能远超构件数，`basicSize` 偏小会让模型规模爆炸；
   大模型先与用户确认再提交（`references/workflow.md` 黄金法则 7）；
8. **标准牌号材料一律 `MatDB.load()` + `MatDB.assemble(..., setting=setting)`**，
   禁止手写 `Material(E0=...)` 填数值（规则同有限元路线）。

## 常见错误

| 现象 | 原因 | 修复 |
|---|---|---|
| `**Error: 禁止在几何模型中执行有限元脚本。` | 未调 `init_ctx(mode=ExecutionMode.MIXED)`，首个 `StruModel` 调用已把模式锁定为 STRUONLY | 混合脚本在 import 后、`clc()` 前补 `init_ctx(mode=ExecutionMode.MIXED)` |
| `**Error: 禁止在有限元模型中执行几何脚本。` | 同上（反向）：纯有限元脚本里混入了 `StruModel` 调用 | 删掉几何接口，或改为混合脚本并补 `init_ctx` |
| `FemModel.fromViewer()` ~~报错~~/静默空模型 | `submitAndMesh()` 未执行，或非 MIXED 模式导致 `pypcae.fem.in` 未生成（★ 2026-10-22 更正：缺文件时**不报错**、只记日志后返回空模型，#127） | 按模板 3 的顺序与开关执行；确认 `submitAndMesh()` 成功**且文件存在**（`<项目>/pypcae/pypcae.fem.in`） |
| 混合脚本里荷载/约束"没生效" | 写在了 `FemModel.fromViewer()` 之前，被其内部 `clc()` 清空 | 有限元阶段的荷载、约束、分析一律写在 `fromViewer()` 之后 |
| 有限元阶段引用构件 id 报错或指错对象 | 几何阶段的构件对象与 id 在 `fromViewer()` 后已作废 | 用 `Element.all()`/`Node.all()` 或条件查询重新取编号 |
| 圆弧变成了直线（无报错） | `Line(type=LineType.Arc)` 漏传 `center` 或 `kp`，源码静默改回 `Straight` | 圆弧/整圆必须同时传 `center` 与 `kp` |
| 墙几何错误 / 网格失败 | `Wall.nids` 角点顺序乱 | 左下 → 右下 → 右上 → 左上 |
| 板法向朝下、面荷载方向反 | `Plate.nids` 绕序反了 | 按右手螺旋向上重排 |
| `Surf` 报错或面生成失败 | `outer` 传了节点 id；或圆柱/圆锥面误传 `outer` | `outer` 传线构件 id；圆柱/圆锥/球面改用 `bottom`/`top`/`center` |
| `BeamColumn(type=...)` 抛 TypeError | 手册正文把形参写成 `type`，实际关键字是 `iMark` | 用 `iMark=ComponentType.COLUMN` |
| 网格划分不出来 | 没调 `submitAndMesh()`；或网格设置写在了 `StruModel.toViewer()` 之后 | 网格设置写在 `toViewer()` 之前 + `StruModel.submitAndMesh()` |
| 改了网格尺寸但网格没变（无报错） | `MeshParams` 建在 `toViewer()` 之后，`submitAndMesh()` 用的是 toViewer 时的快照 | 移到 `toViewer()` 之前，或重新 `toViewer()` 再划网格 |
| 结构模型想直接求解 | 误用 `FemModel.submitAndSolve()` 于纯几何脚本 | 纯几何路线到 `submitAndMesh()` 为止；要计算走混合路线 |
| 脚本跑到 `submitAndMesh()` 就中断且无后续日志 | 网格划分某一环节失败，内部 `sys.exit(-1)` 终止进程 | 按 `error_diagnosis.md` 读 pserver.log 尾部与网格日志定位（几何碎面/短线、尺寸过小等） |
| 脚本执行成功但界面没变化 | 在几何页面执行了 `FemModel.toViewer()`（或反之），视图只刷新与本页相关的部分 | 切到对应页面查看；属正常现象，不是失败 |
| `dedupCoincident` 调了但重合点/线/面没归并 | ① 写在了 `StruModel.toViewer()` **之前**（手册明确"toViewer 结束之后才能生效"）；② 四个形参默认全 `False`，没显式传 `True`；③ `tol` 量级与项目单位制不匹配（mm-t 制下默认 `0.005` = 0.005 mm，几乎只有完全重合才归并） | 移到 `toViewer()` **之后** + 显式 `dedupPoint=True`（按需加 `dedupLine`/`dedupSurf`）+ `tol` 按单位制换算（见 §核心 API 2b） |
| 指望 `dedupCoincident` 消掉 `save_script` 的"节点坐标重复定义" | 校验发生在**保存脚本**阶段，归并在 `toViewer()` **之后**才生效，时序上救不了 | 回建模代码复用同一 `Node` 对象（#48）；归并只用于移植 / 迭代既有模型 |
| SI 制下用默认 `tol=0.005` 归并后节点数掉得比预期多 | SI(m) 制下 0.005 = **5 mm**，可能把本不该合并的近距离节点误并 | 按最小特征尺寸重设 `tol`（如 1e-4 = 0.1 mm），先小模型核对归并数量 |

## 验证清单

- [ ] 路线已确认（用户指定或已按澄清表问过），全文只用该路线应有的模型类
- [ ] 混合脚本：`init_ctx(mode=ExecutionMode.MIXED)` 在 import 之后、`clc()` 之前；纯路线脚本未调 `init_ctx`
- [ ] 混合脚本时序完整：`StruModel.toViewer()` → `submitAndMesh()` → `FemModel.fromViewer()` →（荷载/分析）→ `FemModel.toViewer()` → `submitAndSolve()`
- [ ] 每个构件都挂了截面（`sid` ≠ -1），截面类型与构件维度匹配（Line/Surface/Solid）
- [ ] `BeamColumn` 用 `iMark=`；`normal` 与杆轴不平行
- [ ] `Wall` 角点顺序左下→右下→右上→左上；`Plate` 绕序右手螺旋向上
- [ ] `Surf.outer`/`inners`、`Solid.outer`/`inners` 全部是**构件 id**；每个洞一个子 list
- [ ] 圆弧/整圆 `Line` 同时传了 `center` 与 `kp`；圆柱/圆锥面用 `bottom`/`top`（圆锥 `top` 是顶点节点号）
- [ ] 网格设置写在 `StruModel.toViewer()` **之前**，尺寸与构件量级匹配，局部加密 `ids` 为构件号
- [ ] 构件侧线约束用对了 `FixedType.BaseLine`（建筑结构，点编号）/ `BaseLineGeom`（通用几何，线构件号）
- [ ] 有限元阶段的节点号/单元号在 `fromViewer()` 之后重新获取
- [ ] 收口与路线匹配（漏 `toViewer()` 视同未交付）
- [ ] 如用了 `dedupCoincident`：写在 `StruModel.toViewer()` **之后**、需要归并的项显式传了 `True`、
      `tol` 已按项目单位制换算；归并前后的节点/线/面计数已核对并写进交付包
      （5 项未实机验证内容见 `references/stru/known_issues.md` #71）；用户没要求时未主动加
- [ ] 已向用户说明在哪个页面执行、哪个页面会刷新视图