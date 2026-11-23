# 有限元路线：已知问题与使用限制

按当前任务查询相关条目。编号仅在本文件内有效，不与其他路线混用。区分已确认用法与未验证能力；未验证项目不能当作已可用能力承诺。结果验证与重跑仍受 `references/execution_contract.md` 约束。

## 1. 已确认用法与常见问题

| # | 场景 | 用法与限制 |
|---|---|---|
| 1 | 荷载类调用 | 一律关键字传参 |
| 2 | `Cload` 参数顺序 | 歧义已在源头消除；仍推荐关键字传参：`Cload(gnids=[...], dof=[FDof.Fz], value=[-1000.0])` |
| 3 | `Tube`/`IShape` 截面 | 这两个形状类**必须全位置参数**：`Tube(mid, D, d)`、`IShape(mat.id, t, h, bu, tu, bd, td)`。**2026-10-12 实机更正（pypcae 2.1.0）**：`inspect.signature(Tube)` = `(mid: int, D: float, d: float)`——第三参是**内径 d**，手册 §二.2.2 与平台 `list_shapes()` 写作 `t`（壁厚）有误；关键字 `d=` 运行时可用但 `save_script` 校验会拦，仍按全位置写。详见 `references/stru/known_issues.md` #44 |
| 4 | `Circle` 直径参数 | 小写：`Circle(mat.id, d)` |
| 5 | 自重缺失 | 自重必须显式 `Emload(geids=[...], value=9.81, dir=[0,0,-1])` |
| 6 | 温度应力恒为 0 | `Material(..., expansion=1.2e-5)`（钢）/ `1.0e-5`（混凝土） |
| 7 | `Etem` 调用方式 | **必须全位置参数**：`Etem(all_eids, 25.0)`（与 `Tube`/`IShape` 同类例外）；`tem` 接受标量或列表 |
| 8 | 脚本崩溃无提示 | 删除全部 `print` |
| 9 | 零长度单元 | 同一位置只用一个 `Node` 对象，共享引用 |
| 10 | `Analy` 参数错位 | 关键字传参：`Analy("x", steps=[step])`、`Analy("x", setting=AnalySetting(...))` |
| 11 | `Nset/Elset.add()` 传 list | `nset.add(node.id)`，循环逐个添加 |
| 15 | `ChangeChType` 枚举名 | 以 `enums` 中实际枚举名为准，用前可用平台工具核对 |
| 16 | 单位混用 | 全脚本统一项目单位制；规范查得的 mm/kN 值先换算再写入 |
| 17 | `Emload` 自重 | `value` 是加速度，随单位制：SI(m) 用 9.81，mm 制用 9810 |
| 18 | `Wpload` | 传**元组列表** `[(e.id, 2), ...]`，单元号与面号一一对应 |
| 20 | `MatDB.assemble` | 先 `load()`；工具出口为 SI（Pa），`assemble` 出口的 plasPara/曲线为库原值（MPa）——同一材料只按一个出口取数 |
| 21 | `Wload` 时程 | 第二列填**归一化值**（幅值只由 `value` 缩放）；时间列覆盖 `sTime`；用整数除法或 `round(t, 6)` 生成时间列 |
| 22 | 时程时间参数 | 三处自洽：`AnalySetting.sTime/stepLen` + `Step.sTime` + `Step.nSubstep`；~~后两者不在构造签名内，需构造后赋值~~ **手册 2026-09-28 版起已进构造签名**：`Step(name, changes=None, loadCases=None, nSubstep=1, sTime=1.0, keyInherit=0)`，可直接 `Step("S", nSubstep=2000, sTime=20.0)`，构造后赋值仍可用；`keyInherit` 为该步荷载继承模式（0 不继承 / 1 继承） |
| 23 | `Section` 的 `sub` | 传形状类实例或实例列表（单实例与列表均可），禁止 dict |
| 24 | `Job` 的 `uid` | 手册 2026-09-23 版明确：**main=0 → `uid=None`；main>0 → `uid` 为长度 6 的随机码**（任务唯一标识符）；`Job.main` 为 Analy 索引（第 N 个分析对应 N-1）；`JobManager.main/pre/uid` 从所选任务取：`jobs[N-1].main/.pre/.uid` |
| 25 | 谐响应 `AnalySetting` | **显式给频率点**：`st = AnalySetting(anaType=AnaType.HARMONIC, ...)` 后 `st.freqArray = [f1, f2, ...]; st.nFreq = len(...)`；示例见 `examples/fem/harmonic_beam.py` |
| 26 | 谱分析/随机振动 | 补一个 `Step`（如 DL 自重步）；谱分析本身忽略静力荷载，但步定义必须存在 |
| 27 | `Cdisp` 支座沉降 | 该自由度**只给 Cdisp、不给 Fixed**（强迫位移本身即约束）；示例见 `examples/fem/thermal_continuous_beam.py` |
| 28 | 条件查询 `*Query` | 查询类在**独立模块**：`from pypcae.query import *`；比较器实测签名：`eq(k, v, tol=None)` 有 tol，`gt/ge/lt/le` **无** tol，`min/max(k, tol)` tol 必传位置参数 |
| 29 | 梁端约束组合 | 梁端直接 `Dof.All` 固结，或成对释放（释放 Uy 方向的平动时再释放对应面内转动）；示例见 `examples/fem/elastic_foundation_beam.py` |
| 30 | 环向/网格梁 `normal` | 法向不得与杆轴平行：X 向梁 `[0,1,0]`、Y 向梁 `[1,0,0]`（见 `examples/fem/spectrum_frame.py`、`examples/fem/modal_frame.py`） |
| 31 | 实体单元节点绕序 | 低层 4 点**从高层侧看必须逆时针**：`(i,k),(i+1,k),(i+1,k+1),(i,k+1)`，高层 4 点同序对应；面号表随之成立（Face2=5-6-7-8 为高层侧表面） |
| 32 | `run_script` 失败返回 | 读 pserver.log 尾部找该阶段真实错误行定位根因，禁止按 msg 猜修 |
| 33 | `read_check_log` 旧日志 | 以 pserver.log 尾部时间戳确认本次计算状态；结果提取以 `live_task`+`get_results` 为准 |
| 34 | `Ebsload` 表面法向 | **表面法向 = `iCoord=CSYS.LocalCoordinateSystem`**：方向自动沿体单元表面平面向内、不可修改（`dir` 被忽略，给默认 `[1,0,0]` 即可）；环形开挖面支护压力无需拆扇区，整圈建一个 Elset 施加即可（实测 v2026.8.2 通过） |
| 35 | `Ebsload` 的 `esides` | `geids` 可直接传 **Elset 集合号**（`esides=[(elset.id, side)]`），集合内单元全部按该面号受荷（实测 v2026.8.2 通过） |
| 36 | 接触 + 单元生死 | 线性施工阶段分析改用共节点/绑定传力；真接触需先给法向预压（如注浆压力）且走非线性 |
| 37 | `Change` 的 `geids` | `geids` 可直接传 **Elset 集合号**（`geids=[elset.id]`），生死操作按集合施加（实测 v2026.8.2 通过）；建议每施工步建 `KILL_*`/`ADD_*` 集合便于界面选择 |
| 38 | `Contactor(att=…, nids=…)` | 体单元改用 `side=` 直接指定面号（面号见手册附录）；圆柱面按「底面4点从高层侧看逆时针+顶面对应」绕序建单元时：**外圆柱面=Face4、内圆柱面=Face6**（与 Ebsload 开挖面用 Face6 一致）；示例见 `examples/fem/sleeve_interference_contact.py` |
| 39 | 接触分析收敛性（过盈配合） | 稳定收敛组合：**初始几何过盈（套筒内半径=轴半径−过盈量，界面直接做重叠）+ 单步加载 + SuperElement + 默认罚系数**；避免降温驱动引入轴向滑移；实测接触压力 54.8 MPa vs Lamé 57.2 MPa（-4%）、最大 Mises 212 MPa vs 206 MPa（+3%） |
| 40 | 日志编码 | `genfea-compute*/log.out`、`Out*/*.out` = **GBK**；**`resources/pserver.log` = UTF-8**；同目录 `.inp`、`task-log/*.txt` = **UTF-8**。关键词计数异常先怀疑编码再怀疑运行状态，并以耗时与结果目录产物（OutStatic/OutModal+OutSpectrum/OutImDyna）交叉确认 |
| 43 | 材料阻尼类型枚举名 | 以源码为准用 `MatDampType.NoDamping / Rayleigh / DampingRatio`（本库 `references/fem/enums.md` 已按源码收录）；同 #15 一类"手册名 ≠ 源码名"问题，用前可用 `list_*` 工具或源码核对 |
| 106 | ★ `run_script` 的 `msg` 阶段名可能指向**已成功**的阶段（2026-10-14 实测；与另一路线 #80 ） | **`msg` 不可作为定位起点，只能作为"确实失败了"的信号**。正确顺序：读 `pserver.log` **尾部**（★ **UTF-8**），从后往前找第一个 `@failure` / `**Error:` / `exit status 0xffffff9c`，看它属于哪个 `[ xxx ]` 前缀（`sep-processor`/`sep-modelcheck`/`genfea`），**以该前缀为准**。 |
| 107 | ★ 内嵌 Python **没有 numpy**（2026-10-15 实测；与另一路线 #90 ） | **建模脚本内禁止 import numpy / scipy / pandas 等第三方库**（标准库 + `math` 可用）；一切后处理（读结果文件、统计、方向校核、画图）**一律在 Agent 本地 `python_executor` 环境完成**。 |
| 108 | ★ `genfea-compute-*` 每次运行**新建**目录、失败目录**不清理**（2026-10-14 实测；与另一路线 #81 ） | 核对前**必须先锁定本次目录**，两条都要满足：① `mtime` 最新；② 目录内 `log.out` 的 `nNode`/`nElem` 与本次 `pserver.log` 尾部一致。`sorted(glob(PROJ/"genfea-compute-*"), key=os.path.getmtime, reverse=True)[0]`。**重试多轮后尤其容易读错**——症状是"产物内容与脚本明显不符" |
| 109 | ★ `12_Elem.inp` 为**多段复合 + 每单元多行记录**格式（2026-10-15 实机复核；与另一路线 #82 ） | 解析法：定位 `*elem` 段 → **按空行切块** → `块[0].split()` = `单元号 + 类型码 + 截面/材料号`；**`块[2].split()` = `节点数 + 节点号列表`**。实测类型码 `{23:128, 28:3840}`、每单元节点数 `{2:128, 8:3840}`，合计 = 日志 `nElem` ✓。⚠️ 类型码跨版本稳定性未验证，**用"每单元节点数"判型更稳**（8→六面体、2→Link、4→四面体、6→棱柱）。⛔ 只打印汇总。💡 更省事：读 `fe_modelSource.json` 的 `cells` 按节点数分类 |
| 110 | ★ `neq` 差值核账法（定位 `zero pivot` 与**验证相互作用是否真生效**，2026-10-14 实测；与另一路线 #79 ） | `nNode × 每节点自由度数 − neq = 被消除的自由度数`，再逐笔对账（`Fixed` 各组节点数×约束数 + `Embeded` 从单元节点数×3 + `Coupling`/`Binding`/`DofSlave`）。**账目对上仍 `zero pivot`** ⇒ 奇异源是**未被消除的刚体自由度**（实体模型最常见是**绕竖直轴转动**）；**账目对不上** ⇒ 按差额反查哪类相互作用没生效。修复后 `neq` 变化量应与新增约束数**逐个对上**，是"改动确实落地"的即时证据。实测 `5077×3−14740=491`，对账 490 ⇒ 一次推出"绕 Z 转动"并修准（`neq`→14739） |
| 111 | ★ 实体模型的最小约束必须显式消除**全部 6 个刚体自由度**（2026-10-14 实测；与另一路线 #77 ） | 最小约束配方：① 底面**全部**节点 `Uz`；② 底面**形心一点** `Ux+Uy+Uz`；③ ★ 底面 `y=0`（或 `x=0`）边上**一个非形心节点**补 `Uy`（或 `Ux`）。只多加 1 个节点的 1 个自由度，不抑制横向泊松变形。自查：`31_DofFixed.inp` 掩码 **0=约束、1=放开**，各组节点数之和应等于底面节点总数 |
| 112 | ★ `live_task()` 返回的是 **JSON 字符串**（不是 dict）（2026-10-15 实测；与另一路线 #102 ） | `json.loads(live_task())` 后再取 `result.uuid` / `result.dir`。 |
| 113 | ★ **纯模态分析**的任务指派自查法与静力**不同**（2026-10-15 实测；与另一路线 #101 ） | **模态专用判据**：读模态结果文件（特征值输出）里的**待求阶数**，与脚本 `nModal` 比对——**相等** ⇒ 算的是自建分析 ✅；**等于软件默认 3 阶** ⇒ 跑的是默认空分析、结果不可用 ❌。实测 `nModal=10`、结果文件 10 阶 ⇒ 通过。★ **模态结果文件列义已澄清（2026-10-15 已确认，更正此前"未写明"的记录）**：`OutModal/o71_EeigenValueModal.out`（GBK）头注释**原文已写明** `effectMass(6)：有效质量系数(1:6分别表示x,y,z向的各阶值和累加值)`；每行 **9 个字段** = `阶号 + 频率 + 周期 + 6 个系数`，**列序为 `(x各阶, x累加, y各阶, y累加, z各阶, z累加)`**。**算术复核**：已验证示例 10 阶，累加列每阶 = 上阶累加 + 本阶各阶值（y 累加 `0.004→0.050→0.134→…→0.457`、z 累加 `0.110→0.199→0.237→…→0.488`，逐阶吻合；x 两列恒为 0，因模型沿 X 向悬臂）⇒ **该 6 列可以引用**，但须注明来源（头注释 + 累加复核）；⛔ 仍不得据此做规范限值评判（属结果分析，须用户明确要求） |
| 114 | ★ 网格节点表里会出现**孤立节点**（被 0 个单元引用）（2026-10-15 实测；与另一路线 #95 ） | 统计法：读 `12_Elem.inp` 的 `*elem` 段（按 #109 切块），统计每个节点被引用次数，取 **0 引用者**；**一切"按坐标筛节点"的检查都应先剔除孤立节点再判断**。⚠️ 在模态/非线性/动力下是否仍无影响**未验证** |
| 115 | ★ **实体单元只有各向同性本构** ↔ 层合板各向异性参数的本质冲突（2026-10-15 实测补充；与另一路线 #99 ） | 实体单元只有各向同性弹性本构（`E0`/`poisson`/`density`），**给不了** `E1≠E2≠E3`、`G12`。⇒ 二者**本质冲突，必须二选一**：要各向异性 → 走**分层壳**路线；要实体 → 只能取**各向同性等效值**，且必须 ① 注明"由 E1/E2/G12/ν12 折合，属 **[估算]**"，② 说明该值**与取向相关**。★ 用户同时表达"实体模型"与"层合板各向异性参数"时**应在建模前问一次**，⛔ 不要静默取等效值。 |
| 116 | ★ 部分钢筋牌号在材料库中**只有弹塑性条目**（2026-10-14 实测） | **实测按默认调用不报错**、材料正常生成、线性静力正常求解（线弹性分析不激活塑性参数）。做**非线性**分析时才需显式指定 `iModel`，并核对 `plasPara` 单位口径（库原值 **MPa / t·m⁻³**，与 `E0` 的 **Pa** 不同）。对比 `get_material_param("C30")` 返回 3 条目（2 个 `iModel=0` + 1 个 `iModel=2`） |
| 117 | ★ 模型检查日志为 **0 字节空文件**，而平台读取接口返回"无 error / 无 warning"（2026-10-15 实测；与另一路线 #104 ） | 区分三种情形：**文件不存在 / 文件存在但为空 / 有内容且明确无 error**——**空文件 ≠ 检查通过**。交付包描述检查结论时**必须注明依据的是哪一种状态**；把"空文件"说成"检查通过"属**措辞红线** |
| 118 | ★ 手册检索"**未找到**" ≠ "**不支持**"（2026-10-15 实测；与另一路线 #97 ） | 拆成**单关键词**重试；或改用**枚举查询**（`list_shapes`/`list_load_types`/`list_boundary_types`/`list_analysis_types`）、按**节号**检索。⛔ **不得据"未找到"判定软件没有该能力**；确实无文档的 API 应显式标注"暂不建议使用"并给出已实测的替代写法 |
| 119 | `Connector` / `ConnectorSection`（PkpmCAE v2026.8.2.24_4 / pypcae 2.1.0 已验证范围） | 两点之间的弹簧/阻尼使用 `Connector`，接地弹簧使用 `ElasSupport`。已验证范围仅为**平动 + 线弹性 + 常刚度 + Auto 坐标系 + 静力**。模型至少要有一个单元（#120），`consElas` 填实际刚度，两端其余自由度须有约束。连接器将弹簧刚度耦合进总刚，**不消除自由度**，`neq` 核账时消除数记 **0**。梁/杆系中扭转自由度未被支座或相邻构件约束的自由端须补 `Dof.Phx`，避免扭转刚体模态。产物核对 `19_ConnectSect.inp`、`19_ConnectElem.inp` 与 `OutStatic/o63_ConnectForce.out`；格式见 `references/fem/interactions.md`。★ **2026-10-28/29 已扩验（见 #201~#207）**：非线性本构（`elastics`/`plastics`）、转动连接器、`iCoord=Fixed`、动力（隐式/显式）传力**均可用**；**阻尼无作用**、**`iCoord=Follow` 与 `keyFriction/keyFail/keyLock` 不可用**。 |
| 120 | ★ **模型至少要有一个单元**：零单元模型在 `genfea` 报 `readElemLoadInfo出错:*elemLoad:-1`（2026-10-15 实测） | **有限元模型必须至少含 1 个 `Element`**。⚠️ `sep-modelcheck` 的 `**Error:模型未定义截面/材料!` 是**零单元的前兆信号**（没单元 → 没截面/材料被引用），此时不要误以为材料截面写错，应补单元。 |
| 121 | ★ `Section` 用 **`type=`**、`MatDB.assemble` 用 **`iType=`**——两者相反，极易写错（2026-10-15 实测踩坑） | **两者关键字相反，分开记**：`Section(name=..., type=SectionType.Line/Surface/Solid, sub=[形状实例], iKey=1)`；`MatDB.assemble(name=..., iType=MaterialType.Steel, iMark=SteelType.Q345, setting=setting)`。手册权威签名 `Section(name: str, type: int, sub: list[SubSection], iKey: int)`。`TypeError: unexpected keyword argument` 属**执行类**错误，按 `references/fem/error_diagnosis.md` 表 A 对照签名修。 |
| 122 | ★ 手册 `LoadCaseCombine` 签名**漏列 `subType`**（2026-10-15 实机探针判定；与另一路线 #118 ） | **以运行时为准**：探针模型显式传 `subType=0` → 校验通过、`run_script` **执行成功**、模型检查无 error、求解正常结束（`nNode:2/nElem:1/neq:1`）、`61_LoadStep.inp` 步名为自建 `Step_LL`（非 `step-1`）⇒ 运行时**接受** `subType`，手册签名不完整。不确定时省略该参亦可（有默认值）。⚠️ 方法论：手册与实测签名冲突时用**最小探针模型实机判定**，不要凭手册回改实测结论 |
| 123 | ★ **手册 2026-10-16 版扩展 `ConnectorSection` 签名**：新增 `elastics` / `m` / `plastics` 三个**非线性本构**形参（**尚未实机验证**） | 上游手册 `resources/static/pypcae/doc/README.md` 更新至 **2026-10-16 版**（3383 行 / 146821 B）；结构化比对：**标题树 184 个一致、枚举 70 组 / 342 个一致、API 签名 91 个中仅 `ConnectorSection` 1 个变化**（新增 3 形参），另附录示例区 2 处纯空白行删除（无语义影响）。**三参与求解器字段的对应关系（据 `19_ConnectSect.inp` 表头核实，权威）**：`keyStiff=Nonlinear`(1) → **`elastics`** → `numElas`（点数，0=常数弹性）+ `elasCoefs(:,1:2)`（「**荷载-位移**」曲线，第 1 列荷载、第 2 列位移）；`keyStiff=MetalPlastic`(2) → **`plastics`** + **`m`** → `numPlas`（0=忽略塑性）+ `plasCoefs(:,1:2)` + `M`（「**屈服荷载-塑性位移**」曲线）；`m` = 混合硬化参数（**0 随动 / 1 等向 / 0<m<1 混合**，默认 0）。★ **关键更正（手册易误读处）**：手册正文把 `elastics`/`plastics` 都写作"荷载–位移数据表"，但 **`plastics` 第 2 列是「塑性位移」（不可恢复部分）而非总位移**（`elastics` 第 2 列才是总位移），按总位移填会得到**偏硬的骨架曲线** ⇒ **以求解器 inp 表头为准**。★ **2026-10-28 已实机验证通过**（`elastics` 逐点守表、`plastics` 残余=塑性位移，另含卸载写法见 #201/#202）；其余开关/转动/局部系的实测结论见 #203~#206。已写入 `references/fem/interactions.md` §5「刚度本构三选一」与 `references/fem/enums.md`；手册内置副本已同步覆盖 |
| 72 | 手册没有混合流程章节 | 不得据检索“混合”无命中判定软件不支持。需要几何建模后求解时，按 `references/stru/stru_model.md` 的混合流程执行。 |

| 201 | ★★ **连接器刚度非线性 `elastics` / `plastics`+`m`（2026-10-28 实测：均可用）** | `elastics=[[0,0],[500,5e-4],[1000,1.5e-3]]`（`consElas=1e6` 作区分）⇒ `ux(n3)` = `1.50062e-3`/`5.00309e-4`/`≈0`，**逐点守表、路径无关**；`plastics=[[800,0],[1000,2e-3]]`+`m=0` ⇒ 加载 `3.00062e-3`（`F/K`+`up`）、卸载残余 `2.000e-3` 且 `o63` 内力 0（**第 2 列是塑性位移**）。**非线性分析须配 `NLType.MaterNonlinear`**；⚠️ `NLType` **没有 `Linear` 成员**（只有 `ALinear=1`），线性静力直接不传 `iNLType` |
| 202 | ★★ **卸载 / 回弹：按本构分档**（2026-10-29 实测 22 探针） | **线弹性**（`ConnStiffType.Linear`）任意写法都收敛并精确回零（系数 `0.0`+继承 0+`nSubstep=1` ⇒ `0.000000e+00`）；**折线非线性弹性（`elastics`）必须** `Step(keyInherit=1)` + `LoadCaseCombine(lc, -1.0)` + `nSubstep≥2`（系数 `0.0` ⇒ `iIter: 501` 不收敛；`nSubstep=1` 也不收敛）；**金属弹塑性（`plastics`）**两种写法逐位相同。反例：继承 1+系数 `0.0` **不卸载**；继承 0+系数 `-1.0` 是**反向加载**。落盘自查 `61_LoadStep.inp`：每步首行第 5 字段 = `keyInherit`、次行 `coefLoad` 应为 `-1`。`iNLType` **不是**不收敛原因（非线性求解器 + 全线性模型照常收敛） |
| 203 | ★★ **连接器阻尼：能落盘但动力中无作用**（2026-10-28 复核，**更正旧"两段式失败"口径**） | `consDamp`（`Constant`）与 `dampCoefs`（`Nonlinear`，**二维表** `[[F,v],…]`）均能构造并写入 `19_ConnectSect.inp`，但隐式动力 A/B 两子系统**逐帧差 `0.000e+00`** ⇒ **静默无效**；**扁平一维表**在构造期即 `ValueError: 维度不足`。⇒ ⛔ 不得用连接器阻尼减震，**改分析级阻尼**（`iDampType=AnaDampType.RatioToMass, dampRatio=…`） |
| 204 | ★ **转动连接器 `ConnSectType.Rotation` 可用**（2026-10-28 实测） | `consElas` 单位 **N·m/rad**；`Phx` 与串联解析逐位吻合（`1.2856e-3`/`1.1286e-2`）。★ **`iDofs` 必须写该类型自己的第一自由度**：转动 `[Dof.Phx]`、平动 `[Dof.Ux]`，写错**静默零**（无报错） |
| 205 | ★ **`iCoord` 与 `vy`/`vx`**（2026-10-28/29 实测 + 手册 2026-10-29 版） | `Auto` 与 **`Fixed`+`vy`** 可用；`Fixed` 下**只落 `vy`**（`cNum=1`），**`vx` 被丢弃**；**`Follow` 不可用**（genfea `**Error:setConnectionElem有错`）。手册新增 `ConnCoordType.Global`（固定总体系，称此时 vx/vy 不生效），但**本机 2.2.1 运行时无该成员**（`hasattr=False`，写成员抛 `AttributeError`；传裸值 `iCoord=3` 可跑通） |
| 206 | ⛔ **`keyFriction` / `keyFail` / `keyLock`：脚本层不可用**（2026-10-28/29 实测） | 三者**无对应限值形参**（`frictCoef`/`dispFail`/`dispLock` 只能构造后赋值）。**只置 `On` 不给限值 ⇒ `sep-processor` 崩 `exit status 0xc0000005`**（`msg` 却误报 `:sep-modelcheck`）；给了限值**也不是阈值**（`dispLock` `5e-4` 与 `2e-3` 结果逐位相同；`dispFail` 大于实际位移仍立即断开）。**交付脚本一律不用**；需"拉断/限位"用界面定义或多分析步手工等效 |
| 207 | ★ **动力下的连接器**（2026-10-28 实测） | 隐式 Direct：`OutImDyna/o63_ConnectForce.out` 有非零内力；**显式 HalfStep**：结果落 **`OutExDyna/`**（`o11`/`o63` 均在，按 `OutImDyna/` 找会读到上一次隐式运行的旧文件）。显式步长按最高频率取 |
| 208 | ★★ **`Wpload` 静水压力：面号 / 方向 / 线性规律**（2026-10-28 实测 + 手册 2026-10-29 版） | **面号 = 手册附录节点组合表**（8 节点六面体 F1=`4-3-2-1`…F6=`4-1-5-8`）；**体表面 → 压力指向体内部**；**面（壳）表面按正面/反面**：**Face1（`1-2-3-4`）→ 法向反向**、**Face2（反序）→ 法向正向**；数值 **`p(z)=value·(h0−z)/(h0−h)`**（实测 ΣR `500/750/1500` 逐位吻合）⇒ 要均匀水压取 `h0` 远大于结构高度，⛔ `h0=h` 会 `0/0` |
| 209 | ★ **`VSABoundary` 实体表面可运行**（2026-10-28 实测） | 落盘 **`33_VSABoundary.inp`**（`*VSABoundary`：`alphaT/alphaN/R/src/iElems/iSurfs`），`40_GlobalAnaly.inp` 增设 **`*VSABoundaryCtrl 0`**（0 集中 / 1 一致，脚本侧无形参）；模型可**无任何 `Fixed`** 也求解 ⇒ 静态下 VSA 等价很硬支承、**dashpot 不贡献**（别用静力位移评价边界效果）。显式动力下同样可运行 |
| 210 | ★ **`Binding` 容差一律用默认**（2026-10-29 口径） | `iTol` 保持默认（自动），**不要自定义 `tol`**；⚠️ **未绑定不报错**——从节点变孤立点、荷载被静默忽略（`o11` 全 0、`run_script` 仍 `success:true`）⇒ 建完核对"从节点有荷载时位移是否为 0" |
| 211 | ★ **两处平台告警/行为更正**（2026-10-28/29 实测） | ① `save_script` 的「BeamEuler 未检测到 `Dof.Phx`/`Dof.All` 约束」在**已写 `Fixed(dof=[Dof.All])`** 时仍报，而模态/静力正常结束 ⇒ **假阳性**，照常交付并列入 warning；② **孤立节点**在模态/线性/非线性/隐式动力四类分析下**均无影响**（结果与基准逐位相同，仅污染节点统计） |
| 212 | ★ **手册与导入**（2026-10-29 15:29 版，3393 行 / 151192 B） | 导入表新增 **`from pypcae.query import *`**（查询类在独立模块；`save_script` 校验放行）；`Wpload` 壳面方向按正面/反面细化；`Connector` 的 `vy`/`vx` 明确为局部 Y/X 轴方向向量。查询类在独立模块这一条与 #28 一致 |


## 2. 未验证 — 用前对照软件版本自查

| 位置 | 事项 | 需核对内容 |
|------|------|-----------|
| ~~`TaperGroup`~~ ✅ **已结案（见 #201 系列与 `references/fem/model_modification.md`）** | 梁变截面组 | 关键字 = **`jSec`**、首参 = **`name`**；**组内单元号必须连续**（非连续 ⇒ genfea `**Error:读取变截面组出错:*taperGroupCoefs:1`） |
| ~~`Wpload` 面号~~ ✅ **已结案（见 #208）** | 静水压力 | 面号 = 手册附录节点组合表；体表面→指向体内；壳表面按 Face1 反向 / Face2 正向 |
| `VSABoundary` | 人工边界 | 签名/默认值/实体表面运行态**已实测（#209）**；**仍待确认**：`alphaT/alphaN` 取值的适用工况（波动问题工程判断）、显式动力稳定时间步与反射效果 |
| `keyFriction`/`keyFail`/`keyLock` 的**触发语义** | 连接器开关 | 限值的参考系与 `iFricTag/iFailTag/iLockTag` 语义**手册未给**；当前口径是"脚本层不用"，见 #206 |
| 卸载 / 回弹的边界条件 | `keyInherit` + 系数 `-1` | 大位移/屈曲工况、**动力与时程**、`Cdisp`/`Ctem` 类荷载是否同样受 `keyInherit` 影响、与接触/几何非线性组合 —— **均未验证**（#202） |
| 条件查询 `*Query` | 试验功能 | 官方标注"试验功能"，生产脚本优先用 `Nset`/`Elset` 显式分组，查询仅作兜底且用前先验证 |

## 3. 运行限制
- **`submitAndSolve()` 单任务语义**：每次调用仅计算 JobManager 指定的当前分析任务（inp 只导出该任务，成立）；同脚本多次调用**各跑一条完整管线**（2026-10-22 复核更正）但**返回码只反映最后一次** → 同模型多任务推荐 `CUR_TASK` 分次提交，见 `references/fem/analysis.md` 模板 8

- PyPCAE 脚本在 PkpmCAE 内嵌 Python（3.7.9）执行；★ **运行时可 `print()`**（输出进 `pserver.log`/`task-log/*.txt`），
  被拦的是 `save_script` 的**平台校验**（交付脚本仍不写 `print`，后处理放 Agent 本地做）；
- 计算结果查看以**当前分析任务**为准，多任务需在 JobManager 中切换；
- **多任务计算语义**：一次 `submitAndSolve()` 只计算 JobManager 指向的**当前任务**（成立）；★ **2026-10-22 复核更正**：同脚本内多次 `submitAndSolve()` **各自跑一条完整管线**（旧"第 2 次及以后不执行"已推翻），但**返回码只反映最后一次** ⇒ 多任务同脚本提交必须**逐目录**核对产物（`genfea-compute-<job.uid>`）；`fromViewer()` 读回模型再切换任务的路线在 Agent 环境不可用（依赖 `pypcae.fem.in`，本路线脚本不产生该文件，缺文件直接 TypeError）。多分析正确姿势：**定义一次（多 Analy+多 Job）、按任务提交**——Agent 侧在脚本顶部留单一开关常量（如 `CUR_TASK=0/1/2`）选择当前任务，同一脚本运行多次即算完全部；见 `examples/fem/gravity_dam_multi_task.py`；
- 部分单元结果（o21/o22/o23/o24/o41/o42 等）仅能通过 `*.out` 文件查看，不在后处理界面展示；
- 节点结果为关联单元均值：跨单元类型、板壳交叉位置的节点应力物理含义可能失真（见用户手册 1.6.3.2 节）；
- `submitAndSolve()` 会自动保存模型，无需手动调 `saveModel()`。
- **随机振动仍不可脚本化（2026-10-22 复核）**：① 5 个声明为 2 维表的参数构造期抛 `ValueError`；② 带 `psdCurve` 的分析在 `sep-modelcheck` 崩溃；③ 早前版本还观察到曲线不落盘。⇒ 随机振动任务请**改在界面中定义**；
- 两点间弹簧/阻尼使用 `Connector`；接地弹簧使用 `ElasSupport`。可用范围与约束见本文件的连接器条目。
