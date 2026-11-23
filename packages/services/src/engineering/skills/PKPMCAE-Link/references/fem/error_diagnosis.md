# 报错诊断 — 参考文档（决策表）


> 📖 **手册锚点**：本文内容为平台日志诊断经验，不依赖手册 API 章节。


## 概述

模型报错时按本文档执行：**读日志 → 对症状 → 查根因 → 修 → 重跑**。
禁止在没读任何日志的情况下凭猜测修模型；禁止只让用户贴日志。

## 第 0 步：日志读取链（不可跳步）

```text
① pserver.log（PkpmCAE 安装目录 resources/ 下；空则取 pserver.YYYY-MM-DD.001.log 最近一份；
   文件大时用 python_executor 只读尾部百行，★ 编码 UTF-8——与 log.out/*.out 的 GBK 相反，见下 §0b）
   ——sep-modelcheck/sep-processor/genfea 各阶段的**真实错误行**在此，是地面真相
   ★ 从后往前找第一个 @failure / **Error: / exit status 0xffffff9c，以它所属的 [ xxx ] 前缀为准
     （⛔ 不要以 run_script 的 msg 为准，msg 可能指向已 @complete 的阶段，见下 §0a）
② read_check_log(项目目录)：ModelCheckResult.json + 最新 genfea-compute*/log.out 尾部；
   ⚠️ 可能返回历史旧日志——按时间戳与 nElem 核对是否本次运行，不符以 ① 为准
③ live_task() 取项目 dir → python_executor（os.listdir/glob/open）定位
   modelCheckFile/、genfea-compute-*/log.out 并读尾部
④ read_script(脚本路径)：按日志中的单元/节点号回读定位
```

> 平台工具清单随版本/环境变化，`read_check_log`/`read_script` 等的存在性与签名以当前环境
> 实时确认为准（优先级：cae-mcp 模式 `function_search` → 内置模式系统工具清单 → 皆无则
> 告知用户需额外连接 cae-mcp；见 `references/platform_tools.md` §0）；
> 清单中没有的文件读写需求一律用 python_executor/shell_executor 完成。

日志位置速查见 `references/platform_tools.md` §5。

## 决策树

```text
脚本报错 or 计算报错？
│
├─ 平台执行失败（run_script 返回 success:false）
│   └─ msg 为 ":sep-processor"/":genfea" 等**阶段名** → 表 A「平台返回阶段名」，
│      必须读 pserver.log 尾部定位真实错误（★ msg 甚至可能指向一个已 @complete 的阶段，
│      只能当"确实失败了"的信号，见 §0a / #106）
│
├─ Python 层报错（脚本执行失败）
│   ├─ 0xc0000409 崩溃        → 表 A
│   ├─ TypeError/关键字错误    → 表 A
│   └─ 静默崩溃无提示          → 先删 print
│
├─ 模型检查失败（modelcheck）
│   ├─ 零长度单元/法向错误     → 表 B
│   ├─ 截面/材料缺失           → 表 B
│   └─ 约束/连接警告           → 表 B
│
└─ 求解失败（log.out）
    ├─ zero pivot/矩阵奇异     → 表 C
    ├─ 不收敛                  → 表 C
    └─ 结果异常（位移全 0 等） → 表 D
```

## 表 A：Python 层错误

| 症状 | 根因 | 修复 |
|---|---|---|
| `0xc0000409` | Emload/Esload/Elload 用了纯位置参数 | 全部改关键字传参 |
| `TypeError: unexpected keyword argument` | 关键字名/枚举名写错 | 对照本库 API 签名与 `enums.md` 核对 |
| 崩溃无任何提示 | ~~脚本里有 `print()`~~ ★ **2026-10-22 更正：此条不再成立**——`print()` 运行时可用（输出会进 `pserver.log`/`task-log`），不会崩 | 改按三类排查：① `save_script` 平台校验失败（print 只是其中一种，脚本仍可执行）；② 文件编码读错导致「以为没算」；③ 找错本次 `genfea-compute*` 目录。见 `references/platform_tools.md` §4b~§4d 与 `references/fem/known_issues.md` #124 |
| `Cload` 值错位 | 官方签名与示例参数顺序不一致 | 只用关键字传参（ERRATA #2） |
| Tube/IShape 报错 | 用了关键字传参 | 这两个必须全位置参数 |
| `TypeError: __init__() got an unexpected keyword argument 'iType'`（写在 `Section(...)` 上） | ★ `Section` 的关键字是 **`type=`**，而 `iType=` 是 `MatDB.assemble` 的——**两者相反**（#121）。脚本在 Python 层即终止（`exit status 1`），**走不到 modelcheck** | 改 `Section(name=..., type=SectionType.Line/Surface/Solid, sub=[形状实例], iKey=1)`；`MatDB.assemble(name=..., iType=..., iMark=..., setting=...)` |
| NameError: 枚举不存在 | 枚举类名记错（如 ChangeChType） | 查 `enums.md` 或用 `list_*` 工具 |
| 平台返回阶段名：`run_script` → `success:false, msg:":sep-processor"`（或 `:genfea` 等） | msg 是管线**失败阶段名**而非根因；脚本本身可能无误（实测 v2026.8.2） | 读 pserver.log 尾部找该阶段的真实错误行（如 `checkSolidNodeNumberingRule 出错`），按根因修复后重跑 |
| `checkSolidNodeNumberingRule 出错, 单元号:N`（genfea 阶段） | 实体单元 N 的节点绕序手性错误（雅可比为负） | 8 节点六面体「低层4点+高层4点」绕序：低层 4 点**从高层侧看必须逆时针**（如 `(i,k),(i+1,k),(i+1,k+1),(i,k+1)`），高层同序对应；修正后重跑 |

## 表 B：模型检查错误

| 症状 | 根因 | 修复 |
|---|---|---|
| "线单元局部 y 轴与 x 轴平行"/"单元法向有错: 单元 N" | 单元 N 是零长度段——同坐标重复建 Node（典型：拱脚与柱顶、梁柱交点各建一个） | 同一位置只用同一个 Node 对象 |
| 截面未定义 | Element 的 sid=-1 或引用了不存在的 sec | 核对 `sid=sec.id` |
| 材料未定义 | 截面 mid 指向不存在的材料 | 核对 `mid=mat.id` |
| 约束加到了空集合 | gnids 引用的 Nset 为空 | 回读脚本核对集合成员 |
| 薄壁厚度异常 | mm 未换算 m | ÷1000 |

## 表 C：求解错误

| 症状 | 根因 | 修复 |
|---|---|---|
| 时程分析响应**全 0**（求解正常结束、无 error/warning） | `timeHist` 写成 **2×N**（把时间与系数分成两行）⇒ 软件按无系数处理，静默无响应 | 改成 **N×2**（第一维=采样点数、每行 `[t, 系数]`）；自查「行数=采样点数、每行长度=2」（ERRATA #144） |
| zero pivot / 刚度奇异 | 约束不足：刚体模态 | 按 `supports.md` 约束完备性表补齐；拱脚查 Ux。★ **定位用 `neq` 差值核账法**（见上）：账目对上 ⇒ 是未被消除的刚体自由度；对不上 ⇒ 某类相互作用没生效 |
| ★ zero pivot 且 `neq` 账目**吻合**（梁/杆系） | **扭转刚体模态**：杆段两端 `Phx` 只由扭转刚度 `[[GJ/L,−GJ/L],…]` 相连（**该子矩阵本身奇异**），两端均无接地约束（2026-10-15 实测，#119） | 在自由端补 `Dof.Phx`（**通则**：凡扭转自由度未接地的自由端都要补）。实测 `neq` 48→47 后一次通过 |
| ★ `**Error:readElemLoadInfo出错:*elemLoad:-1`（genfea） | **模型零单元**——只有节点 + 连接器/约束/荷载（2026-10-15 实测，#120） | 补至少 1 个 `Element`。**前兆信号**：modelcheck 先报 `**Error:模型未定义截面!`/`**Error:模型未定义材料!`，**别误判成材料截面写错** |
| zero pivot（局部） | 孤立构件未连主体（装饰梁/悬空杆） | 两端连到主体或删除 |
| 不收敛（非线性） | 步长过大/接触震荡/材料软化 | 减子步步长；查接触参数；非线性求解器换弧长法 |
| 负特征值 | 结构失稳/机构 | 查约束与几何；屈曲问题用 BUCKLING |
| 显式时间步过小 | 单元过小/材料过刚 | 加大局部网格尺寸；核对材料量级 |
| `子步迭代不收敛.......iIter: 501 0.500E-03` + `**Error:solveStaticGeneralFeaEquation出错`（非线性静力） | **卸载 / 回弹一步跳完**：折线本构（`elastics`）用“系数 `0.0`”卸载，或 `nSubstep=1`；⚠️ 不是 `iNLType` 的锅（同一非线性求解器 + 全线性模型卸载照常收敛） | 改 `Step(nSubstep≥5, keyInherit=1)` + `LoadCaseCombine(lc, -1.0)`（见 `analysis.md`「★ 卸载 / 回弹」）；单纯调大 `nSubstep` 救不回 |
| 内存不足 | 模型过大 | 降网格密度；对称性减半 |

## 表 D：结果异常（算完但不对）

| 症状 | 根因 | 修复 |
|---|---|---|
| 位移全为 0 | 荷载为空/值为 0/工况没进 Step | 沿装配链 LoadCase→Step→Analy 逐环查 |
| 位移量级离谱（m 级） | 单位错（mm 当 m、Pa 当 MPa） | 全脚本核对单位制 |
| 温度应力恒 0 | 材料缺 expansion | 补热膨胀系数 |
| 自重缺失 | 没加 Emload | `Emload(value=9.81, dir=[0,0,-1])` |
| 模态频率异常低 | 有未约束的刚体模态 | 看前几阶振型找自由方向 |
| 谱分析结果偏小 | 质量参与系数不足 | 增加计算模态数（≥90% 参与系数） |
| 反力与外载不平衡 | 约束漏加/荷载漏加 | 用 verification.md §反力平衡核对 |

## ★ 诊断链的三个前置纪律（2026-10-14/15 实测；编号见本技能 `references/fem/known_issues.md` #106~#110）

### 0a. `run_script` 的 `msg` **不可作为定位起点**（#106）

实测两次失败 `msg` 均为 `:sep-processor`，而 `pserver.log` 显示该阶段**两次都 `@complete`**、
并写着 `pserver run once succeeded`；真实错误在其后的 `@pypcae:compute:begin` → `[ genfea ]` 段内。
⇒ **`msg` 只能作为"确实失败了"的信号**。正确顺序：读 `pserver.log` **尾部**（★ **UTF-8**），
从后往前找第一个 `@failure` / `**Error:` / `exit status 0xffffff9c`，
看它属于哪个 `[ xxx ]` 前缀，**以该前缀为准，不要以 `msg` 为准**。

### 0b. 日志编码：**两个主日志相反**，且 `task-log` 是累积文件（#40）

| 文件 | 编码 |
|---|---|
| `<安装目录>/resources/pserver.log` | ★ **UTF-8**（2026-10-14 复测更正，原标 GBK 有误） |
| `genfea-compute*/log.out`、`Out*/*.out` | **GBK** |
| `genfea-compute*/*.inp`、`task-log/*.txt` | **UTF-8** |

读错编码时中文关键词计数会**静默为 0** → 误判"算没算/报没报错"；**先确认中文能正常显示，再匹配关键词**。
稳妥写法（自动回退）：

```python
raw = open(path, "rb").read()
txt = raw.decode("utf-8", errors="ignore")
if "浠诲姟" in txt or "鍑洪敊" in txt:      # UTF-8 字节被当 GBK 解的特征字
    txt = raw.decode("gbk", errors="ignore")
```

⚠️ `task-log/<uuid后6位>.txt` 是**同一项目历次运行的累积**文件：直接全文搜 `Error` 会把**他次运行**的
报错误判为本次 ⇒ 以「`任务执行成功!` / `任务执行失败!`」行号**切段，只看最后一段**，
再与 `genfea-compute-*` 目录 `mtime`、`pserver.log` 时间戳**互证**。

### 0c. `genfea-compute-*` 每次运行**新建**目录、失败目录**不清理**（#108）

实测 3 次运行留下 3 个目录，**失败那两次的 `.inp`/`log.out` 也完整保留**。
按目录名排序或随手取第一个，会把**失败版本**产物当本次结果核对。
**锁定条件（两条都要满足）**：① `mtime` 最新；② 目录内 `log.out` 的 `nNode`/`nElem` 与本次 `pserver.log` 尾部一致。

```python
dirs = sorted(glob.glob(os.path.join(PROJ, "genfea-compute-*")), key=os.path.getmtime, reverse=True)
CP = dirs[0]        # ← 本次目录
```

## ★ `neq` 差值核账法（定位 `zero pivot` 与验证相互作用是否真生效，2026-10-14 实测，#110）

```text
被消除的自由度数 = nNode × 每节点自由度数 − neq
```

逐笔对账：`Fixed` 各组 (节点数 × 约束自由度数) + `Embeded` (从单元节点数 × 3) +
`Coupling`/`Binding`/`DofSlave` 消除数。

- **账目对上但仍有 `zero pivot`** ⇒ 奇异源是**未被消除的刚体自由度**
  （实体模型最常见的是**绕竖直轴转动**：形心/轴线上点 `x=y=0`，绕 Z 转动位移恒为 0，
  约束形心的 `Ux,Uy` **拦不住**——须在底面 `y=0` 边补 **1 个非形心节点**约束 `Uy`，见 `supports.md`）；
- **账目对不上** ⇒ 按差额反查哪一类相互作用**没生效**
  （★ `Embeded` 不生效时**不报错**、`18_Embedding.inp` 照样写出，**只能这样验**：
  钢筋节点数 × 3 应恰好等于 `neq` 的减少量）。

**实战**：`nNode=5077`、`neq=14740` ⇒ 消除 `15231−14740=491`；对账 `82`(底面 Fixed) + `0`(抗转动点未加)
+ `408`(136 钢筋节点×3) = **490** ⇒ 断定嵌入生效、奇异源是刚体自由度 ⇒ **一次修准**
（补 1 个 `Uy` 后 `neq=14739`，正好少 1）。修复后 `neq` 变化量应与新增约束数**逐个对上**，
是"改动确实落地"的即时证据。

## 表 E：产物核对类陷阱（不是脚本报错，但会让你误判）

| 症状 | 根因 | 修复 |
|---|---|---|
| 单元类型统计出上千个"假类型" | 对 `12_Elem.inp` 整表按**固定列索引**解析（把节点号当成了类型码）。★ 实机复核：该文件 `*elem` 段内**每个单元占 8 行、块间以空行分隔** | **按空行切块**：`块[0].split()`=`单元号+类型码+截面号`，**`块[2].split()`=`节点数+节点号列表`**；用"每单元节点数"判型（8→六面体、2→Link、4→四面体、6→棱柱）。⛔ 只打印汇总（#109） |
| 中文关键词计数恒为 0、误判"没报错" | 日志编码读反（`pserver.log`=UTF-8、`log.out`/`*.out`=GBK） | 见 §0b（#40） |
| 模型检查"无 error / 无 warning"但文件是 **0 字节** | 把"空文件"当成"通过了检查"的强证据 | 区分**文件不存在 / 文件为空 / 已检查无问题**三种情形；空文件**不等于**检查通过（#117） |
| 网格/求解成功但 `run_script` 返回 `success:false` | 脚本尾部 `import numpy`（内嵌 Python **无 numpy**）→ 完成之后抛 `ModuleNotFoundError` | 删除全部第三方库 import（#107）；⚠️ **此时产物已落盘**，不要误判为计算失败 |
| 按坐标筛节点得到"某区域内有母材节点"的假阳性 | **孤立节点**：未被任何单元引用的节点（多建的定位辅助点、`Coupling` 悬空参考点等；实测某模型 74 个） | 先统计并剔除孤立节点再判断（#114）：读 `12_Elem.inp` 统计每个节点被引用次数，取 0 引用者 |
| "绑定/约束/工况**看起来全没写进去**" | 读到的是**上一次运行遗留的旧目录**产物（`genfea-compute-*` 每次运行新建、失败目录不清理） | 按 §0c **锁定本次目录**（`mtime` 最新 + `log.out` 的 `nNode/nElem` 与本次日志一致）后再核对（#108） |

## 修复后动作

1. `save_script(folder=原目录)` 覆盖迭代；
2. 重跑提交；
3. **最多 3 次**迭代仍失败 → 停止，如实报告：现象 / 已读日志 / 已试方案 / 待用户确认项；
4. 若发现本表未收录的坑 → 记录到 `references/fem/known_issues.md`。

## ★ 2026-10-22 新增症状（两条，来自实机）

| 症状 | 根因 | 处置 |
|---|---|---|
| 某方向的荷载「凭空消失」：位移 0、`o62` 无对应反力、**无任何 error/warning**，模型照常收敛 | **连接器的传力方向＝它自身的轴向**，`iDofs` 写了无效值：`iDofs=[Dof.Uy]`(2) **静默无效**（该方向压根没建弹簧）；`iDofs=[Ux,Uy]` 时第二条目同样无效；`iDofs=[Dof.Uz]`(3) **同样不建弹簧**（多数静默；自由度悬空时表现为 `zero pivot` ⇒ `solveLinearEquaOne出错`，`msg` 仍可能假指 `:sep-processor`） | 查 `19_ConnectElem.inp` 的 `iDofs` 行 + 该连接器的**轴向**；改为 `iDofs=[Dof.Ux]`（＝沿轴向），要多个方向就**沿各方向分别建连接器**。⚠️ `neq` **不能**用来判断弹簧是否建立。详见 `references/fem/known_issues.md` #141 / #135 |
| `sep-modelcheck` 崩溃 `exit status 0xc0000409`（`@failure`，`run_script` 的 `msg` 只给空或 `:sep-processor`），**且不产生 `genfea-compute-*` 目录** | 荷载数据形状非法——实测两类：① `Ctem(gnids=[n 个节点], value=[v1…vn])`（**`Ctem` 只接受标量**）；② `ConnectorSection(dampCoefs/elastics/plastics=[扁平列表])`（见 #139/#133） | 按上述改：`Ctem` 用**标量**（逐点不同温度须逐点各写一条）；连接器本构表在脚本层暂不可用（改界面定义）。提示：**modelcheck 阶段失败不会有 compute 目录**，可据此区分「模型数据被拒」与「求解失败」 |

## ★ 2026-10-22 新增症状（环境「半更新」，两条，最高优先级）

| 症状 | 根因 | 处置 |
|---|---|---|
| 脚本**一开始就失败**：`run_script` 返回 `success:false`、`msg` 为空、耗时仅 3~4 s；`pserver.log` 显示 `File "instance.py", line 3 … from pypcae.comp import *` → `TypeError: 'type' object is not subscriptable` | 安装包的 Python 层用了 **PEP 585 注解**（`list[list[int]]` 等，需 py3.9+），而平台内嵌 Python 是 **3.7.9** → `pypcae.comp` 导入即失败 | 非脚本问题：**报给厂商修注解**（`typing.List[...]` 或 `from __future__ import annotations`）。临时自救见 `references/fem/known_issues.md`（技能一 #137 / 技能二 #143）。⛔ 不要改自己的脚本去绕，交付脚本内不得写补丁 |
| **所有**模型（连 3 节点静力）都在 `sep-modelcheck` 崩溃 `exit status 0xc0000409`，且**不产生 `genfea-compute-*` 目录**；`msg` 为空 | Python/C++ **版本错配**：新 Python 往模型 JSON 的 `setting` 段写了 14 个新键（`calcCrtl`/`fCalcCtrl`/`spectralOut`/`lFreq`/`uFreq`/`bias`/`iSpectralType`/`selectModeType`/`selectMode`/`selectModeFreq`/`iTypeD`/`selectModeDamp`/`modeFreq`/`coefDamping`），而 `sep-modelcheck.exe` 是旧构建 | 比对 `pypcae/comp/setting.py` 与 `io/sep-processor/sep-modelcheck.exe` **文件时间是否同批**；须厂商同步更新 modelcheck。⚠️ 此时**任何功能验证都无意义**（随机振动/连接器等一律不可测） |
