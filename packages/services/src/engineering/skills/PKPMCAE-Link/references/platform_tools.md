# platform_tools.md — PCAEAgent 平台工具集成说明


> ⚠️ **清单以当前环境实时确认为准**：平台工具由 `cae-mcp` MCP Server 注入，
> 或作为**内置函数**直接提供（无 cae-mcp 的 Agent 环境，同名同签名）；其清单与签名随
> 软件版本/系统提示词变化。**本文不作权威清单**——动手前必须按 §0 判别环境并确认实时
> 函数清单与签名；本文表格仅为参考快照（2026-09-29 版），与实时清单冲突时一律以实时清单为准。
>
> 本库中的 PyPCAE API 负责"脚本内容正确"；**平台工具**负责"脚本如何落地、报错如何读取"。
> Agent 执行任务时两类能力配合使用。

## 0. 强制流程：先确认平台工具 → 再调用（两种运行环境）

平台工具（`save_script` / `run_script` / `live_task` / `read_check_log` / …）的提供方式随
Agent 运行环境不同，**任何落地操作前先判别环境、确认清单**：

### 环境判别（第一步，必做；按优先级三级判别）

```text
1. 先找 cae 相关 MCP：环境支持 MCP 连接时 connect_to_server("cae-mcp")
   → 连接成功 = 模式 A（MCP 模式），function_search 检索清单与签名
2. 连不上 → 再找内置工具：查系统提示词/可用工具清单中是否有
   save_script / run_script / live_task 等平台函数
   → 有 = 模式 B（内置工具模式），同名同签名直接调用，无需 connect
3. 两者皆无 = 模式 C（平台工具缺失）：
   → 明确告知用户：当前环境既未连接 cae-mcp 也无内置平台工具，
     保存/执行/读日志/取结果等落地操作均无法进行，需要额外连接 cae-mcp
     （或配置平台工具）后再继续；本轮只能以文本形式交付脚本内容
```

```python
ok = connect_to_server("cae-mcp")      # 模式 A 判别；环境无此函数或连接失败 → 转模式 B/C 判别
```

### 模式 A：cae-mcp（MCP 模式）

```python
print(function_search(action="GetName", func_type="cae-mcp"))    # 实时函数清单（完整无遗漏）
print(function_search(action="GetDescription", func_type="cae-mcp",
                      func_names=["save_script", "run_script"]))  # 精确签名（参数/返回值）
```

### 模式 B：内置工具（无 cae-mcp）

- 平台函数已内置于 Agent 环境：以系统提示词/可用工具清单列出的函数与参数为准，直接调用
  （如 `save_script(code=..., title=...)`）；
- "以实时清单为准"原则同样适用：环境列出的清单覆盖本文快照；
- 拿不准签名时优先用环境自带的函数说明/帮助机制查询，查不到再对照本文快照试用。

### 铁律（两种模式通用）

1. **禁止凭本文或记忆直接调用平台函数**——函数是否存在、签名如何，一律以当前环境
   实时确认为准；本文函数名仅用于告诉你"哪类事通常有对应函数"。
2. 环境中**没有**某能力对应函数时，禁止猜函数名反复试探——文件读写类需求
   （读日志/列目录/读任意文本）改用 `python_executor`（`open`/`os.listdir`/`glob`）或
   `shell_executor`（`dir`/`findstr`/`type`）直接实现；其余缺失能力如实告知用户。
3. 平台函数失败时，返回的 `msg` 通常是**管线失败阶段名**（如 `:sep-processor`），
   不是根因——按 §3 诊断链读日志定位真实错误。

## 1. 工具职能速查（参考快照，以实时清单为准）

| 职能 | 典型函数名 | 何时用 |
|------|------|--------|
| 取当前项目 | `live_task` | 一切落地操作的起点：取项目 dir 与 uuid；取不到就请用户在 PkpmCAE 中新建/打开项目，不要绕开。★ **返回的是 JSON 字符串（不是 dict）**——必须 `json.loads(live_task())` 后再取 `result.uuid` / `result.dir`，直接下标会 `TypeError`（2026-10-15 实测，#112） |
| 生成脚本 | `generate_script` | 简单可参数化结构（spec JSON；不支持 plasPara，非线性走 save_script） |
| 保存脚本 | `save_script` | 复杂结构（循环/条件/曲面）；`folder=原目录` 用于同模型迭代；保存时自动校验语法/print/中文标识符/收口（若因用户明确要求而缺收口，校验报错属预期——照常交付并说明，见 `references/workflow.md` 黄金法则 6） |
| 回读脚本 | `read_script` | 修改旧模型、按日志定位代码前 |
| 浏览已生成文件 | `browse_generated_files` | 保存前查重（防覆盖）；发现旧文件不得拒绝生成 |
| 执行脚本 | `run_script` | 传 live_task 的 uuid/dir + 脚本绝对路径。★ **`msg` 的阶段名不可作为定位起点**——实测 `msg` 可能指向一个**已经 `@complete` 的阶段**（如两次失败均报 `:sep-processor`，而真实错误在其后的 `[ genfea ]` 段内）；只能当作"确实失败了"的信号，定位一律读 `pserver.log` 尾部（#106）。★ 2026-10-28 再复现 4 例：`TaperGroup` 非连续、`iCoord=Follow`、`keyLock/keyFail` 崩溃（`msg` 报 `:sep-modelcheck`，真实为 **sep-processor `0xc0000005`**）、`elastics` 两级加载不收敛 |
| 读检查/计算日志 | `read_check_log` | 传项目 dir，汇总 ModelCheckResult.json 与最新 compute 日志尾部；⚠️ 可能命中**历史旧日志**——按时间戳与 nElem 核对是否本次运行，不符则以 pserver.log 尾部为准 |
| 提取结果 | `get_results` | 计算完成后提取结果（先 live_task 取 uuid 与 compute 目录）；调用失败直接告诉用户，不要尝试其他调用 |
| 材料库查询 | `get_material_tree` / `get_material_param` | 标准牌号材性的**首选来源**（E0/density 已换算 SI） |
| 材料预设 | `list_materials` | 不确定材料参数时 |
| 截面形状/单元类型 | `list_shapes` | 不确定截面写法时 |
| 荷载类型 | `list_load_types` | 不确定荷载类签名时 |
| 支座/约束/相互作用 | `list_boundary_types` | 不确定约束写法时 |
| 分析类型 | `list_analysis_types` | 不确定 AnalySetting 参数时 |
| 文件下载路径 | `get_file_download_path` | 把生成文件交付用户时 |
| 建模资源查询 | `get_modeling_resources` | 查询当前可用建模资源 |

> 以上为 2026-09-29 实测清单的职能归类；新增/更名/下线以当前环境实时清单为准
> （模式 A 用 `function_search`，模式 B 查系统工具清单）。

## 2. 工具选择优先级（强制）

```text
1. 用到标准牌号材料      → 先 get_material_tree / get_material_param 查库，禁止凭记忆手填
2. 能用 spec 参数化描述  → generate_script（注意：spec 不支持 plasPara，非线性走 save_script）
3. 必须循环/条件/复杂几何 → save_script
4. 修改已有模型          → 先 read_script，再 save_script(folder=原目录)
5. 模型报错              → 按 agent_playbook.md 诊断链
6. 不确定 API/枚举       → list_* / get_material_* 查询，禁止凭记忆编造
```

禁止无脑 `save_script`，也禁止把简单结构硬写成几百行代码。

## 3. 报错诊断链（与工具的配合）

```text
用户报告报错 / run_script 返回失败
  │
  ├─ ① python_executor 读 pserver.log 尾部（PkpmCAE 安装目录 resources/ 下；
  │     空则取 pserver.YYYY-MM-DD.001.log 最近一份；文件大只读尾部百行）
  │     —— 地面真相：sep-modelcheck / sep-processor / genfea 各阶段的**真实错误行**在此
  │
  ├─ ② read_check_log(项目目录)        # live_task 返回的 dir
  │     ModelCheckResult.json + 最新 genfea-compute*/log.out 尾部
  │     ⚠️ 核对时间戳/nElem，旧日志不代表本次运行
  │
  ├─ ③ python_executor 列目录定位（os.listdir/glob）：
  │     项目 dir 下 modelCheckFile/、genfea-compute-*/log.out，读尾部精读
  │
  └─ ④ read_script(脚本路径)           # 对照日志中的单元/节点号定位并修复
```

硬性要求：**禁止只让用户贴日志；禁止在没读任何日志的情况下凭猜测修模型。**

> ⚠️ **日志编码**：`genfea-compute*/log.out` 为 **GBK**——用 python_executor 读尾部时须
> `open(..., encoding="gbk", errors="ignore")`；按 UTF-8 读会中文关键词乱码、计数为 0，
> 造成"算没算"误判（见 ERRATA #40）。

## 4. 保存与多版本

- 调 `generate_script`/`save_script` 前先 `browse_generated_files()` 查重；
- 不同方案/版本：title 加区分后缀（`Bridge_undamped`/`_v2`），不覆盖旧版；
- 同模型微调：`save_script(folder=原目录)` 允许覆盖；
- **发现旧文件不得跳过生成**——不得以"已有同名文件"为由拒绝产出。

## 4b. ★ 锁定本次计算目录（`genfea-compute-*`）——核对产物前必做（2026-10-14 实测，#108）

**每次运行新建一个随机后缀目录，失败目录不会被清理**（实测 3 次运行留下 3 个目录，
失败那两次的 `.inp`/`log.out` 均完整保留）。按目录名排序或随手取第一个，
会把**失败版本**的产物当本次结果核对。

**锁定条件（两条都要满足）**：① `mtime` 最新；② 目录内 `log.out` 的 `nNode`/`nElem`
与本次 `pserver.log` 尾部一致。

```python
import glob, os
dirs = sorted(glob.glob(os.path.join(PROJ, "genfea-compute-*")),
              key=os.path.getmtime, reverse=True)
CP = dirs[0]                       # ← 本次目录；再读 CP/log.out 核对 nNode/nElem
```

> 重试多轮后尤其容易读错目录——症状是"**产物内容与脚本明显不符**"，实为读到了上一轮失败版本。

## 4c. ★ 三种"看起来没问题"的日志状态必须区分（2026-10-15 实测，#117）

| 状态 | 事实 | 能否当作"检查通过"的证据 |
|---|---|---|
| 日志文件**不存在** | 该环节根本没执行（或未产出该文件） | ❌ 不能 |
| 日志文件**存在但为 0 字节** | 实测：模型检查日志为 **0 字节空文件**，而平台读取接口返回"无 error / 无 warning" | ⚠️ **不能当作"通过了检查"的强证据**——须在交付包如实写明"文件为空"，与"已检查无问题"分开表述 |
| 日志**有内容且明确无 error/warning** | 真通过 | ✅ 可以 |

⇒ 交付包描述检查结论时**必须注明依据的是哪一种状态**；把"空文件"说成"检查通过"属**措辞红线**
（见 `references/execution_contract.md` §4）。

## 4d. ★ 手册/API 检索："未找到" ≠ "不支持"（2026-10-15 实测，#118）

多关键词组合检索容易直接报"未找到"。实测某些**枚举成员**（手册里只有枚举名 + 一句注释）
按其中文别名逐个检索，**只回显枚举那一行**，无小节、无参数语义、无示例——这**只说明该词组没命中**。

| 现象 | 正确处置 |
|---|---|
| 多词组合"未找到" | **拆成单关键词重试**；或改用**枚举查询**（`list_shapes`/`list_load_types`/`list_boundary_types`/`list_analysis_types`）、按**节号**检索 |
| 某 API 只有枚举名、无任何文档与示例 | ⇒ 该 API **当前不可施工**：显式标注"暂不建议使用"，并给出**已实测的替代写法**；⛔ 不得据"未找到"判定"软件没有该能力" |
| 检索某词 0 命中 | ⚠️ **不得据此判定软件没有该能力**——手册存在"**能力仍在、但整节说明被移除**"的先例（#72：2026-10-14 版整节移除某流程说明，而该能力的相关 API 与枚举仍在手册他处）。处置：拆单词重试 + 改枚举查询（`list_*`）+ 按节号查；仍无线索时**如实报告"文档未覆盖"**，⛔ 不要下"软件不支持"的结论 |

## 5. 关键路径速查

| 内容 | 位置 | 编码（★ 2026-10-14 实测更正，两个主日志**相反**） |
|------|------|------|
| 运行日志 | `<PkpmCAE安装目录>/resources/pserver.log`（或带日期后缀；用 python_executor 读尾部） | ★ **UTF-8**（原标 GBK 有误，#40） |
| 模型检查日志 | `generated/<模型名>/FemodelCheckLog.txt`、`ModelCheckResult.json` | UTF-8（⚠️ 可能是 **0 字节空文件**，见 §4c） |
| 求解日志 | 项目目录下 `genfea-compute*/log.out`（★ 每次运行新建随机后缀目录、失败目录不清理，须按 §4b 锁定本次） | **GBK** |
| 求解输入 | `genfea-compute*/*.inp`（`12_Elem.inp`、`31_DofFixed.inp`、`51_NodeLoad.inp`、`61_LoadStep.inp`…） | UTF-8 |
| 任务日志 | `<项目>/task-log/<uuid后6位>.txt`（★ **历次运行的累积文件**，须按"任务执行成功!/失败!"**切段只看最后一段**） | UTF-8 |
| 结果文件 | 项目目录下 `genfea-compute*/Out<类型>/o11_NodeDisp.out`（位移）、`o41_ElemStress.out`（单元应力）、`o42_ElemMisesStress.out`（Mises）、`o62_ReactionForce.out`（反力）等，完整清单见 `references/fem/verification.md` | **GBK** |

## ★ 环境「半更新」自检（2026-10-22 起，跑任何脚本前先做）

2026-10-22 的安装包更新曾造成**全部脚本不可用**（两技能 ERRATA 均登记为阻塞级：技能一 **#137** / 技能二 **#143**）。
两个判据、30 秒可查：

| 现象 | 判据 | 含义 |
|---|---|---|
| 脚本**第 3 行**就失败（`from pypcae.comp import *`），`pserver.log` 里是 `TypeError: 'type' object is not subscriptable` | `pypcae/comp/setting.py` 里存在 `list[list[int]]` 这类 **PEP 585 注解** | Python 层需 py3.9+，而平台内嵌 **3.7.9** ⇒ 须厂商改注解（`typing.List[...]` 或 `from __future__ import annotations`） |
| 脚本能跑到提交，但**所有模型**（含 3 节点静力）都在 `sep-modelcheck` 报 `exit status 0xc0000409` | 比对 `pypcae/comp/setting.py` 与 `io/sep-processor/sep-modelcheck.exe` 的**文件时间是否同批** | Python 写的模型 JSON 含新键（`calcCrtl`/`spectralOut`/`selectMode`/`coefDamping` 等 14 个），旧 modelcheck 读不了 |

> ⚠️ 两个判据**同时成立**时，**任何**功能验证都无法进行（含随机振动）：脚本进不去、模型过不了检查。
> 此时唯一合法动作是**如实告知用户「环境需厂商修复」**，⛔ 不得把失败归因到自己的脚本，也不得据"手册已补参数"下功能结论。
> 临时自救（仅限继续复现用，勿写进交付脚本）：脚本最前用 `types.ModuleType` 预加载"去掉下标注解"的 setting.py；
> 并在提交前 `delattr(st, <14 个新键>)`。两段均已在 2026-10-22 实机验证可用，命令片段见技能二 ERRATA #143。
