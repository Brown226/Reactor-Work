# 报错诊断（结构 / 混合路线） — 参考文档（决策表）


> 📖 **手册锚点**：本文内容为平台日志与网格管线诊断经验，不依赖手册 API 章节。
> 网格管线各环节与日志标记见 `mesh.md`「网格管线与日志」。

## 概述

脚本报错、网格划分失败或计算异常时按本文执行：**读日志 → 对症状 → 查根因 → 修 → 重跑**。
禁止在没读任何日志的情况下凭猜测修模型；禁止只让用户贴日志。

## 第 0 步：日志读取链（不可跳步）

```text
① pserver.log（PkpmCAE 安装目录 resources/ 下；空则取 pserver.YYYY-MM-DD.001.log 最近一份；
   文件大时用 python_executor 只读尾部百行，★ 编码 UTF-8——与 log.out 的 GBK 相反，见 #40/#56）
   ★ 从后往前找第一个 @failure / **Error: / exit status 0xffffff9c，以它所属的 [ xxx ] 前缀为准
     （不要以 run_script 的 msg 为准，msg 可能指向已 @complete 的阶段，见下「0a」）
   —— 网格（sep-processor/tmesh/femesh）、modelcheck、genfea 各阶段的**真实错误行**在此
② 网格产物目录 <项目>/pcaestru-mesh/：
   StruDataSource.json（几何模型）、StruData.txt / TrStruData.txt（网格输入，Tr 为实体）、
   UserMeshParameter.txt（实际生效的 *meshSize/*meshGen/*meshPattern/*mesh）、fe_modelSource.json（网格结果）
   —— 核对"改了尺寸没生效"类问题先看 UserMeshParameter.txt
③ read_check_log(项目 dir)：ModelCheckResult.json + 最新 genfea-compute*/log.out 尾部
   ⚠️ 可能命中历史旧日志——按时间戳与 nElem 核对是否本次运行，不符以 ① 为准
④ read_script(脚本路径)：按日志中的构件/单元/节点号回读定位代码
```

> 平台工具清单随版本/环境变化，`read_check_log`/`read_script` 等的存在性与签名以当前环境实时确认为准
> （三级判别见 `references/platform_tools.md` §0）；清单中没有的文件读写需求一律用
> `python_executor`/`shell_executor` 完成。
> ★ **编码分工（2026-10-14 实测更正，ERRATA #40/#56）**：`resources/pserver.log` = **UTF-8**；
> `genfea-compute*/log.out`、`Out*/*.out` = **GBK**；同目录 `.inp`、`task-log/*.txt` = **UTF-8**。
> 读错编码时中文关键词计数会**静默为 0** → 误判"算没算/报没报错"；
> **先确认中文能正常显示，再开始匹配关键词**（自动回退写法见 `references/platform_tools.md` §3）。
> ⚠️ `task-log/*.txt` 是**历次运行的累积**文件，必须按"任务执行成功!/失败!"**切段只看最后一段**（见下「0b」）。
> ⚠️ `live_task()` 返回的是 **JSON 字符串**（不是 dict）——须 `json.loads` 后再取 `uuid`/`dir`，
> 直接下标会 `TypeError`（2026-10-15 实测）。

## 决策树

```text
哪一步失败？
│
├─ 脚本执行阶段（Python 层）
│   ├─ 禁止在几何模型中执行有限元脚本（或反向） → 表 A（执行模式）
│   ├─ 0xc0000409 / TypeError / NameError        → 表 A
│   └─ 静默崩溃无提示                            → 先删 print
│
├─ 网格划分阶段（submitAndMesh 中断、脚本提前结束）
│   ├─ save:failed   缺少几何模型文件            → 表 B（先 toViewer）
│   ├─ mesh:failed   网格分析失败                → 表 B（几何/尺寸/划分器）
│   └─ mesh-save:failed 读取 inp / 生成 fem.in   → 表 B（模式与产物）
│
├─ 构件几何错误（可视化后形状不对 / 网格畸形）   → 表 C
│
├─ 模型检查或求解失败（混合路线）
│   ├─ zero pivot / 刚度奇异 / 法向有错          → 表 D
│   └─ 不收敛 / 负特征值 / 内存不足              → 表 D
│
└─ 算完但结果不对                                → 表 E
```

## 表 A：脚本执行阶段（Python 层）

| 症状 | 根因 | 修复 |
|---|---|---|
| `**Error: 禁止在几何模型中执行有限元脚本。` | 缺省 `init_ctx` 时执行模式为 `DEFAULT`，首次调用 `StruModel` 接口即锁定 `STRUONLY`，之后又调 `FemModel` 接口 | 混合脚本在全部 import 之后、`clc()` 之前补 `init_ctx(mode=ExecutionMode.MIXED)`；纯结构脚本删掉有限元接口 |
| `**Error: 禁止在有限元模型中执行几何脚本。` | 同上反向（已锁定 `FEMONLY`） | 同上（ERRATA #41） |
| `NameError: name 'init_ctx' is not defined` | 用了 `init_ctx` 但没导入 | 补 `from pypcae.base import init_ctx` |
| `NameError: name 'StruModel' is not defined` | 没导入模型类 | 结构路线 `from pypcae.stru import StruModel`；混合路线再加 `from pypcae.fem import FemModel` |
| `TypeError: unexpected keyword argument 'type'`（BeamColumn） | 手册正文把形参写作 `type`，实际关键字是 `iMark` | `BeamColumn(nids=[...], iMark=ComponentType.COLUMN, ...)`（ERRATA #13） |
| `0xc0000409` | `Etem` 用了关键字传参；或荷载类纯位置传参 | `Etem(elem_ids, 25.0)` 全位置；其余荷载类全关键字 |
| `TypeError`（Tube/IShape） | 用了关键字传参 | 这两个必须全位置：`Tube(mat.id, D, t)` |
| 崩溃无任何提示 | ~~脚本里有 `print()`~~ ★ **2026-10-22 更正：此条不再成立**（`print()` 运行时可用、输出进日志，不会崩） | 改按三类排查：① `save_script` 平台校验失败；② 读错文件编码（`pcaestru-mesh/*.inp`=GBK、`genfea-compute*/*.inp`=UTF-8）；③ 找错本次 `genfea-compute*` 目录。见 `references/stru/known_issues.md` #125/#131 |
| `NameError: name 'NodeQuery' is not defined` | 条件查询类在独立模块 | `from pypcae.query import *` |
| 混合脚本里构件 id 引用报错 | `FemModel.fromViewer()` 内部 `clc()` 后几何对象已作废 | 有限元阶段用 `Element.all()`/`Node.all()` 重新取编号 |

## 表 B：网格划分阶段（`submitAndMesh()`）

| 症状 / 日志标记 | 根因 | 修复 |
|---|---|---|
| `缺少几何模型文件：StruDataSource.json！`（`save:failed`） | 没调 `StruModel.toViewer()` 就直接 `submitAndMesh()` | 先 `toViewer()` 再 `submitAndMesh()` |
| `重写inp失败，请先检查模型文件！`（sep-processor） | 几何模型数据不合法：构件未挂截面、拓扑引用错、节点重复 | 全部构件挂 `sid`；`Surf.outer` 传线 id、`Solid.outer` 传面 id；连接点共享 Node |
| `整理StruData.txt数据信息有错`（`-6`）、`exit status 0xfffffffa`（femesh 阶段） | ★ 2026-10-22 实测：**几何阶段对「含面/壳构件的集合」施 `Elload`** 会触发（五组对照见 `references/stru/known_issues.md` #129；梁集合布载正常） | 面构件荷载**改到 FEM 阶段**按网格单元号施加（或改用 `Wpload` 等面专用荷载类）；`msg` 可能仍给 `:sep-processor`（#80），定位读 `pserver.log` 尾部 |
| `网格分析失败！`（`mesh:failed`，tmesh 或 femesh 阶段） | 几何有碎面/短线/自交；网格尺寸远小于构件特征尺寸；实体几何不适合当前划分器 | 简化几何、放大 `basicSize`；实体为主改 `meshPattern="tMeshOnly"`；含 `Solid` 时 `meshGen` 自动置 1（Tmesh） |
| `读取inp失败，请先检查模型文件！` / `拷贝文件fe_modelSource.json失败`（`mesh-save:failed`） | 网格结果转有限元模型失败 | 先确认网格阶段成功（`mesh:end`）；读 `pcaestru-mesh/` 产物与 pserver.log 尾部定位 |
| `生成文件pypcae.fem.in失败！`（`mesh-save:failed`） | 非 MIXED 模式（该文件只在混合模式生成） | 补 `init_ctx(mode=ExecutionMode.MIXED)`（ERRATA #41） |
| 脚本跑到 `submitAndMesh()` 就结束、后续代码没执行 | 网格管线某环节**失败**触发 `sys.exit(-1)`（成功路径不会终止进程——旧版"必须拆两个脚本"的结论已作废） | 按上表读日志修网格，**不要拆脚本**（ERRATA #12） |
| 改了网格尺寸但网格没变化（无报错） | `MeshParams` 写在 `StruModel.toViewer()` 之后，用的是 toViewer 时的快照 | 网格设置全部移到 `toViewer()` 之前；核对 `pcaestru-mesh/UserMeshParameter.txt` 的 `*meshSize` 行（ERRATA #19） |
| `FemModel.fromViewer()` ~~报错~~ / 读不到模型 | `pypcae.fem.in` 不存在（未 `submitAndMesh()` 或非 MIXED）。★ **2026-10-22 更正：缺文件时 `fromViewer()` 不抛异常、只记 `**Error: 找不到文件` 日志并静默返回空模型**（#127） | 按混合五步时序执行；用前先查 `<项目>/pypcae/pypcae.fem.in` 是否存在 + 日志有无该错误行 |

## 表 C：构件几何错误

| 症状 | 根因 | 修复 |
|---|---|---|
| 墙网格畸形 / 墙面反向 | `Wall.nids` 角点顺序乱 | 左下 → 右下 → 右上 → 左上；洞口 `caveNids` 同序 |
| 板法向朝下、面荷载方向反 | `Plate.nids` 绕序反了 | 按右手螺旋向上重排 |
| `Surf` 报错或面生成失败 | `outer` 传了节点 id；或圆柱/圆锥面误传 `outer` | `outer` 传**线构件 id**；圆柱/圆锥/球面改用 `bottom`/`top`/`center`（圆锥 `top` 是顶点**节点号**） |
| 开洞无效 | `inners` 传成一维列表 | `inners=[[洞1线id...], [洞2线id...]]`，每个洞一个子 list |
| 圆弧变成直线（无报错） | `Line(type=LineType.Arc/Circle)` 漏传 `center` 或 `kp`，源码静默改回 `Straight` | 两者必须同时传（`kp`：0 竖直向上 / -1 竖直向下 / =center 自动定向）（ERRATA #14） |
| 网格后构件无属性 / 截面缺失 | 构件 `sid=-1` | 每个构件挂截面；线构件 Line、面构件 Surface、体构件 Solid |
| "单元法向有错"（网格后 modelcheck） | `BeamColumn.normal` 与杆轴平行 | X 向梁 `[0,1,0]`、Y 向梁 `[1,0,0]` |
| 零长度单元 / 网格失败 | 同坐标重复建 `Node` | 连接点共享同一个 `Node` 对象 |
| 线约束不生效 | `Fixed.type` 用了 `Default`，或 `gnids` 传错对象 | 建筑结构 `FixedType.BaseLine`（点编号）；通用几何 `FixedType.BaseLineGeom`（线构件号） |
| `TypeError: __init__() got an unexpected keyword argument 'iType'`（写在 `Section(...)` 上） | ★ `Section` 的关键字是 **`type=`**，而 `iType=` 是 `MatDB.assemble` 的——**两者相反**，极易写错（#117）。脚本在 Python 层即终止（`exit status 1`），**根本走不到 modelcheck** | 改 `Section(name=..., type=SectionType.Line/Surface/Solid, sub=[形状实例], iKey=1)`；`MatDB.assemble(name=..., iType=..., iMark=..., setting=setting)`。属**执行类**错误，不消耗物理类额度 |

## 表 D：模型检查与求解错误（混合路线）

| 症状 | 根因 | 修复 |
|---|---|---|
| `zero pivot` / 刚度奇异 | 约束不足（刚体模态）；或约束写在 `fromViewer()` 之前被清空 | 拱脚查 `Dof.Ux`；简支端补 `Dof.Phx`；约束在有限元阶段重新施加。★ **定位用 `neq` 差值核账法**（见下）：账目对上 ⇒ 奇异源是**未被消除的刚体自由度**，账目对不上 ⇒ 某类相互作用没生效 |
| ★ `zero pivot` 且 `neq` 账目**吻合**（梁/杆系） | **扭转刚体模态**：某杆段两端的 `Phx` 只由杆件扭转刚度 `[[GJ/L,−GJ/L],…]` 相连——**该子矩阵本身奇异**，若两端都无接地约束即产生刚体扭转（2026-10-15 实测，#115） | 在该杆段的自由端补 `Dof.Phx`（**通则**：凡扭转自由度未被支座或相邻构件接地的自由端都要补）。实测 `neq` 48→47（正好少 1）后一次通过 |
| ★ `**Error:readElemLoadInfo出错:*elemLoad:-1`（genfea 阶段） | **模型零单元**——只有节点 + 连接器/约束/荷载，没有任何 `Element`/构件（2026-10-15 实测，#116） | 补至少 1 个单元。**前兆信号**：`sep-modelcheck` 会先报 `**Error:模型未定义截面!` / `**Error:模型未定义材料!`（没单元 → 没截面/材料被引用），**别误判成材料截面写错** |
| `zero pivot`（局部） | 孤立构件未连主体（装饰构件/悬空杆） | 两端连到主体或删除 |
| "线单元局部 y 轴与 x 轴平行" | 零长度段或 `normal` 平行杆轴 | 共享 Node；改 `normal` |
| `checkSolidNodeNumberingRule 出错, 单元号:N` | 实体单元节点绕序手性错误 | 网格参数改 `meshPattern`/加密重试；手工网格时低层 4 点从高层侧看逆时针 |
| 不收敛（非线性） | 步长过大 / 接触震荡 / 材料软化 | 减步长；查接触参数；换弧长法 |
| 负特征值 | 结构失稳 / 机构 | 查约束与几何；屈曲问题用 `BUCKLING` |
| 显式时间步过小 | 单元过小（网格太密）/ 材料过刚 | 放大局部网格尺寸；核对材料量级 |
| 内存不足 | 网格过密、模型过大 | 降网格密度；对称性减半建模 |
| `子步迭代不收敛.......iIter: 501 0.500E-03` + `**Error:solveStaticGeneralFeaEquation出错`（非线性静力） | **卸载 / 回弹一步跳完**：折线本构（`elastics`）用“系数 `0.0`”卸载，或 `nSubstep=1`；⚠️ 不是 `iNLType` 的锅（同一非线性求解器 + 全线性模型卸载照常收敛） | 改 `Step(nSubstep≥5, keyInherit=1)` + `LoadCaseCombine(lc, -1.0)`（见 `analysis.md`「★ 卸载 / 回弹」）；单纯调大 `nSubstep` 救不回 |
| 位移全为 0 | 荷载为空 / 工况没进 Step / 荷载写在 `fromViewer()` 之前 | 沿装配链 `LoadCase→Step→Analy` 逐环查 |

## 表 E：结果异常（算完但不对）

| 症状 | 根因 | 修复 |
|---|---|---|
| 时程分析响应**全 0**（求解正常结束、无 error/warning） | `timeHist` 写成 **2×N**（把时间与系数分成两行）⇒ 软件按无系数处理，静默无响应 | 改成 **N×2**（第一维=采样点数、每行 `[t, 系数]`）；自查「行数=采样点数、每行长度=2」（ERRATA #150） |
| 位移量级离谱（m 级） | 单位错（mm 当 m、Pa 当 MPa）；网格尺寸与几何单位不一致 | 全脚本核对单位制 |
| 结果偏刚、位移偏小 | 网格过粗 | 按 `verification.md` 做网格收敛性检查（2~3 套尺寸） |
| 温度应力恒 0 | 材料缺 `expansion` | 补热膨胀系数 |
| 自重缺失 | 没加 `Emload`（`density` 不产生重力） | `Emload(geids=..., value=9.81, dir=[0,0,-1])` |
| 模态频率异常低 / 质量偏小 | 有未约束刚体模态；未做荷载转质量 | 看前几阶振型找自由方向；几何阶段加 `LoadToMassSetting` |
| 反力与外载不平衡 | 约束或荷载漏加 | 按 `verification.md` §反力平衡核对（o62） |
| 界面看不到模型/结果 | 在几何页面找有限元结果（视图只刷新与本页相关的部分） | 切到有限元模型页面查看（ERRATA #42） |

## ★ 诊断链的三个前置纪律（2026-10-14/15 实测，先做这三步再对表）

### 0a. `run_script` 的 `msg` **不可作为定位起点**，只能作为"确实失败了"的信号

实测两次失败 `msg` 均为 `{"result":{"success":false},"code":1,"msg":":sep-processor"}`，
但 `pserver.log` 显示 `sep-processor` **两次都成功完成**：

```text
[ sep-processor ] >>输出PkpmCAE的inp文件结束
@complete:sep-processor
========== pserver run once succeeded ==========
@pypcae:sep-process:end
@pypcae:compute:begin          ← ★ 真实失败点在此之后（genfea 段内）
```

⇒ **`msg` 甚至可能指向一个已经 `@complete` 的阶段**。若照 `msg` 去查 `sep-processor` 相关产物，
会**完全找错方向**。

**正确的定位顺序**：读 `pserver.log` **尾部**（★ **UTF-8** 解码），从后往前找第一个
`@failure` / `**Error:` / `exit status 0xffffff9c`，看它属于哪个 `[ xxx ]` 前缀
（`sep-processor` / `sep-modelcheck` / `genfea`），**以该前缀为准，不要以 `msg` 为准**。

### 0b. `task-log` 是**累积日志**，必须切段后再看

`<项目>/task-log/<uuid后6位>.txt` 是**同一项目历次运行的累积**文件（UTF-8）。
直接全文搜 `Error` 会把**他次运行**（如探针脚本）的报错误判为本次。

**方法**：以「`任务执行成功!` / `任务执行失败!`」行号**切段**，**只检查最后一段**；
再与 `genfea-compute-*` 目录 `mtime`、`pserver.log` 时间戳**互证**。

### 0c. `genfea-compute-*` 每次运行**新建**目录、失败目录**不清理**

实测 3 次运行在同一项目下留下 3 个目录，**失败那两次的 `.inp` 产物也完整保留**：

| 目录 | mtime | 对应运行 | 结果 |
|---|---|---|---|
| `genfea-compute-nazpty` | 16:08:54 | 第 1 次 | 失败（不允许梁单元嵌入） |
| `genfea-compute-dngcwh` | 16:12:43 | 第 2 次 | 失败（zero pivot） |
| `genfea-compute-l11gy0` | 16:16:04 | 第 3 次 | **成功** |

若按目录名排序或随手取第一个，会把**失败版本**的产物当本次结果去核对
（例如读到第 2 次的 `31_DofFixed.inp` 只有 2 组约束，误判"抗转动约束没写进去"）。

**核对产物前必须先锁定本次目录，两条都要满足**：① `mtime` 最新；
② 目录内 `log.out` 的 `nNode`/`nElem` 与本次 `pserver.log` 尾部一致。

```python
dirs = sorted(glob.glob(os.path.join(PROJ, "genfea-compute-*")),
              key=os.path.getmtime, reverse=True)
CP = dirs[0]        # 再读 CP/log.out 核对 nNode/nElem 是否与本次日志相符
```

> 重试多轮后尤其容易读错目录——症状是"**产物内容与脚本明显不符**"，实为读到了上一轮失败版本。
> ⚠️ 另有一套**同名但不同目录**的"模板 inp"陷阱见 §表 F。

## ★ `neq` 差值核账法（定位 `zero pivot` 与验证嵌入是否生效，2026-10-14 实测有效）

求解器日志给出三个数：`nNode`、`nElem`、`neq`。利用

```text
被消除的自由度数 = nNode × 每节点自由度数 − neq
```

可以把「约束 / 嵌入 / 耦合各消了多少自由度」**逐笔对上账**，从而判断奇异源在哪。

**实战示例**（第 2 次失败时）：`nNode = 5077`，实体与 Link 节点均为 3 个平动自由度
⇒ 总自由度 `5077 × 3 = 15231`；`neq = 14740` ⇒ 被消除 `15231 − 14740 = 491`。逐项核账：

| 来源 | 计算 | 消除数 |
|---|---|---|
| 底面 `Fixed` | 79 节点 × `Uz`(1) + 形心 1 节点 × `Ux,Uy,Uz`(3) | 82 |
| 底面抗转动点 | 当时**尚未加** | 0 |
| `Embeded` | 136 个钢筋节点 × 3 | 408 |
| **合计** | | **490** |

与 491 相差 1（另 1 个来自约束组的组织方式），**账目基本吻合** ⇒ 可断定：
① **嵌入是生效的**（408 个自由度确被消除），奇异源不在嵌入；
② 剩下的奇异只能是**未被消除的刚体自由度** ⇒ 直接推出「绕 Z 转动」⇒ **一次修准**
（见 `supports.md`「实体模型的最小约束」）。修复后 `neq = 14739`（比 14740 少 1，正是新增的那个 `Uy`）。

**两种判读**：
- **账目对上但仍有 `zero pivot`** ⇒ 奇异源是**未被消除的刚体自由度**
  （实体模型最常见的是**绕竖直轴转动**），而不是嵌入/约束写错；
- **账目对不上** ⇒ 按差额反查是哪一类相互作用**没生效**
  （★ `Embeded` 不生效时**不报错**、`18_Embedding.inp` 照样写出，**只能这样验**：
  钢筋节点数 × 3 应恰好等于 `neq` 的减少量）。

**附带价值**：修复后 `neq` 的变化量应与新增/减少的约束数**逐个对上**，
可作为"**改动确实落地**"的即时证据（比只看 `success:true` 硬得多）。

## 表 F：产物核对类陷阱（不是脚本报错，但会让你误判）

| 症状 | 根因 | 修复 |
|---|---|---|
| "绑定/耦合/约束/工况**全没写进去**" | 读的是 **`pcaestru-mesh/`** 下的 `18_Binding.inp`/`31_DofFixed.inp`/`61_LoadStep.inp`/`50_LoadCaseName.inp`——它们是**网格阶段的空模板**（`*binding 0`、`*dofFixed 0`、只列 DL） | **真正的输入在 `genfea-compute-*/` 下的同名文件**；★ 两套目录极易误判，核对一律读 `genfea-compute-*/` |
| 单元类型统计出上千个"假类型" | 对 `12_Elem.inp` 整表按**固定列索引**解析（把节点号当成了类型码） | 该文件是**多段复合格式**，按**每行列数/节点数**分组统计，详见 `verification.md` |
| 中文关键词计数恒为 0、误判"没报错" | 日志编码读反（`pserver.log` = UTF-8、`log.out`/`*.out` = GBK） | 见 §第 0 步与 `references/platform_tools.md`「两个主日志编码相反」 |
| 模型检查日志"无 error / 无 warning"但文件是 **0 字节** | 把"空文件"当成了"通过了检查"的强证据 | 区分三种情形：**文件不存在 / 文件为空 / 已检查无问题**；空文件不等于检查通过 |
| 网格成功但 `run_script` 返回 `success:false` | 脚本尾部 `import numpy`（内嵌 Python **无 numpy**）→ 网格完成之后抛 `ModuleNotFoundError` | 删除全部第三方库 import（`script_standard.md` 铁律 20）；**注意此时网格产物已落盘**，不要误判为网格失败 |

## 修复后动作

1. `save_script(folder=原目录)` 覆盖迭代；
2. 重跑提交（网格失败修复后需重跑整条时序：`toViewer()` → `submitAndMesh()` → …）；
3. **最多 3 次**迭代仍失败 → 停止，如实报告：现象 / 已读日志 / 已试方案 / 待用户确认项；
4. 若发现本表未收录的坑 → 记录到 `references/stru/known_issues.md`（已确认的第 1 区，未验证的第 2 区）。

## ★ 2026-10-22 新增症状（两条，来自实机）

| 症状 | 根因 | 处置 |
|---|---|---|
| 某方向的荷载「凭空消失」：位移 0、`o62` 无对应反力、**无任何 error/warning**，模型照常收敛 | **连接器的传力方向＝它自身的轴向**，`iDofs` 写了无效值：`iDofs=[Dof.Uy]`(2) **静默无效**（该方向压根没建弹簧）；`iDofs=[Ux,Uy]` 时第二条目同样无效；`iDofs=[Dof.Uz]`(3) **同样不建弹簧**（多数静默；自由度悬空时表现为 `zero pivot` ⇒ `solveLinearEquaOne出错`，`msg` 仍可能假指 `:sep-processor`） | 查 `19_ConnectElem.inp` 的 `iDofs` 行 + 该连接器的**轴向**；改为 `iDofs=[Dof.Ux]`（＝沿轴向），要多个方向就**沿各方向分别建连接器**。⚠️ `neq` **不能**用来判断弹簧是否建立。详见 `references/stru/known_issues.md` #141 / #135 |
| `sep-modelcheck` 崩溃 `exit status 0xc0000409`（`@failure`，`run_script` 的 `msg` 只给空或 `:sep-processor`），**且不产生 `genfea-compute-*` 目录** | 荷载数据形状非法——实测两类：① `Ctem(gnids=[n 个节点], value=[v1…vn])`（**`Ctem` 只接受标量**）；② `ConnectorSection(dampCoefs/elastics/plastics=[扁平列表])`（见 #139/#133） | 按上述改：`Ctem` 用**标量**（逐点不同温度须逐点各写一条）；连接器本构表在脚本层暂不可用（改界面定义）。提示：**modelcheck 阶段失败不会有 compute 目录**，可据此区分「模型数据被拒」与「求解失败」 |

## ★ 2026-10-22 新增症状（环境「半更新」，两条，最高优先级）

| 症状 | 根因 | 处置 |
|---|---|---|
| 脚本**一开始就失败**：`run_script` 返回 `success:false`、`msg` 为空、耗时仅 3~4 s；`pserver.log` 显示 `File "instance.py", line 3 … from pypcae.comp import *` → `TypeError: 'type' object is not subscriptable` | 安装包的 Python 层用了 **PEP 585 注解**（`list[list[int]]` 等，需 py3.9+），而平台内嵌 Python 是 **3.7.9** → `pypcae.comp` 导入即失败 | 非脚本问题：**报给厂商修注解**（`typing.List[...]` 或 `from __future__ import annotations`）。临时自救见 `references/stru/known_issues.md`（技能一 #137 / 技能二 #143）。⛔ 不要改自己的脚本去绕，交付脚本内不得写补丁 |
| **所有**模型（连 3 节点静力）都在 `sep-modelcheck` 崩溃 `exit status 0xc0000409`，且**不产生 `genfea-compute-*` 目录**；`msg` 为空 | Python/C++ **版本错配**：新 Python 往模型 JSON 的 `setting` 段写了 14 个新键（`calcCrtl`/`fCalcCtrl`/`spectralOut`/`lFreq`/`uFreq`/`bias`/`iSpectralType`/`selectModeType`/`selectMode`/`selectModeFreq`/`iTypeD`/`selectModeDamp`/`modeFreq`/`coefDamping`），而 `sep-modelcheck.exe` 是旧构建 | 比对 `pypcae/comp/setting.py` 与 `io/sep-processor/sep-modelcheck.exe` **文件时间是否同批**；须厂商同步更新 modelcheck。⚠️ 此时**任何功能验证都无意义**（随机振动/连接器等一律不可测） |
