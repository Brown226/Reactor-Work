---
name: midas-link
description: 通过 MIDAS GEN NX（2026 起）的 REST API 完成结构建模、荷载与组合定义、分析、结果读取及设计任务。用户提到 MIDAS、midas Gen、GEN NX 或需要操作 GEN NX 时使用。提供 API 文档 SQLite 渐进式查询，并通过后端连接模块自动发现、连接或启动 GEN NX。不适用于传统 Gen 或 CIVIL NX。
license: Proprietary. 未经许可，严禁披露、复制、逆向还原或复用技能正文、参考资料、脚本及模板。
---

# MIDAS GEN NX

按“查文档 → 连接 → 核实当前模型 → 执行 → 读回验证”完成任务。文档查询脚本全部离线；真正的连接和 REST 请求放在 `PKPMAgent.software_link_kit.midas`，通过 `python_executor` 执行并保留客户端变量。无需安装官方 Python SDK。

需要建模代码时读 `use_skill('MIDAS-Link', file='references/common_examples.md')`：完整建模与分析脚本、截面修改、多工况与组合、请求体和结果校核。已有示例覆盖的用法可以复用；新增字段、变体或规范要求再查对应接口。仅查询 API 时直接使用下面的检索命令。

涉及面荷载、虚面、蒙皮或导荷面，读 `use_skill('MIDAS-Link', file='references/surface_loads.md')`：蒙皮的直接建模、板压力方向及楼面/平面荷载入口。

## 建模与结果约定

### 坐标系

| 坐标系 | 使用位置 | 操作要点 |
|---|---|---|
| 全局 GCS：`X,Y,Z` | `/db/NODE` 坐标、节点荷载、全局位移/反力 | 右手直角坐标系；通常取 +Z 向上，此时向下自重为 `FV=[0,0,-1]` |
| 单元 ECS：`x,y,z` | 杆件截面、梁/桁架内力 | 右手系；线单元 +x 从 `ELEM.NODE[0]`（I）指向 `[1]`（J）；y/z 由截面方向和 `ANGLE`（β角）确定，不能默认等于全局 Y/Z |
| 节点局部 NCS | `/db/SKEW` 定义的斜支承、弹簧、强制位移等 | 未定义时沿 GCS；定义后支承的 DX/DY/DZ 等沿节点局部轴。做整体平衡选全局反力表 `REACTIONG` |
| 用户 UCS | 图形界面的建模工作平面 | 切换 UCS 不等于改变 DB 节点坐标的含义；写 `/db/NODE` 仍准备 GCS 坐标 |

**线单元默认方向（β=0）：** 水平或斜杆的局部 z 轴，是全局 +Z 在垂直于杆轴平面上的投影方向；竖杆的局部 z 轴沿全局 +X。局部 y 按 `y=z×x` 确定，β 按绕局部 +x 的右手方向旋转 y/z。例如 I→J 沿 +X 时，局部 y=+Y、z=+Z；沿 +Z 时，局部 y=−Y、z=+X。已有模型先读节点顺序、`ANGLE` 和 `/db/SKEW`，不要从屏幕朝向猜轴向。

### 单位制

DB 数值按当前 `/db/UNIT` 解释；打开、新建或改单位后重新读取。沿用既有工程单位；改变单位后重新读取数值，不能继续使用旧单位的 Python 缓存。材料数值由项目确定，下面仅演示换算：

| 量 / 字段 | 量纲 | kN–m–s | N–mm–s |
|---|---|---:|---:|
| 坐标、`vSIZE`：1 m | L | 1 | 1000 |
| 力：1 kN | F | 1 | 1000 |
| 弯矩：1 kN·m | F·L | 1 | 1e6 |
| 线荷载：1 kN/m | F/L | 1 | 1 |
| 面荷载、应力：1 kN/m² | F/L² | 1 | 0.001 |
| 弹性模量 `ELAST`：206 GPa | F/L² | 2.06e8 | 206000 |
| 重度 `DEN`：76.98 kN/m³ | F/L³ | 76.98 | 7.698e-5 |
| 面积 `AREA`：1 m² | L² | 1 | 1e6 |
| 二次矩 `RYY/RZZ`：1 m⁴ | L⁴ | 1 | 1e12 |

`DEN` 是重量密度，`MASS` 是质量密度，不能把 7850 kg/m³ 直接填入任意单位制；检查 `bMASS_DENS` 模式。`RYY/RZZ` 不是回转半径。结果表单位以返回 `metadata.FORCE/DIST` 为准，不能套用模型显示单位；保留足够有效位数，避免小惯性矩或位移被舍入为零。温度、角度等按字段说明处理；自定义材料中按摄氏度定义的温度参数不随模型显示温标改变。

### 内力与反力符号

- **桁架轴力：拉为正，压为负。** `TRUSSFORCE` 的 `Force-I`、`Force-J` 是 I/J 两个截面的轴力标量，不是两端全局节点力。有自重等杆间荷载时两者可不同，必须同时读取，不能用 `Force-I` 代替整根杆。
- **梁内力沿 ECS。** `Fx` 轴力拉正压负，`Fy/Fz` 为局部 y/z 剪力；`Mx` 为绕 x 扭矩，`My/Mz` 为绕 y/z 弯矩。将杆件作为隔离体，J 端正力沿局部正轴、正矩按对应轴右手规则，I 端方向相反。弯矩不能脱离局部轴解释为“上部受拉”或“下部受拉”，也不能把截面内力直接当作节点外荷载。
- **反力是支承对结构的作用。** `REACTIONG` 按 GCS 分量读取；局部反力须先变换到 GCS。板/墙结果另查 local/global、Top/Bottom、单位长度及位置约定，不能套用杆件符号。

## 查询 API —— 渐进式检索

按“一级模块 → 子模块 → 接口名称 → 参数与示例”缩小范围。**模块路径 + 接口名称**用于查询文档；查到的 **HTTP 方法 + REST 路径 + 请求体**用于调用软件。

以下命令均作为 `use_skill('MIDAS-Link', run='scripts/query_api.py', run_args='...')` 的 `run_args`，例如 `run_args='modules DB'`。带空格的模块路径用引号；按查询返回的完整路径继续，不自行翻译或缩写模块名。

只有四个子命令：`modules` 查模块，`endpoints` 列接口，`search` 搜关键词，`detail` 读用法；`--help` 查看参数。

### Step 1：确定一级模块

| 模块 | 内容 | 典型用途 |
|---|---|---|
| `DOC` | 工程文件与分析执行 | 新建、打开、保存、运行分析 |
| `DB` | 模型定义与分析设置 | 节点、单元、材料、截面、边界、荷载、组合、设计参数 |
| `OPE` | 模型操作 | 模型统计、生成/转换、规范自动组合等操作 |
| `POST` | 表格与结果读取 | 位移、内力、反力、楼层结果、设计结果 |
| `VIEW` | 显示与选择 | 视图、对象选择、图形输出 |

`modules` 列出全部一级模块。

### Step 2：查看子模块

`modules <模块路径>` 列出该模块的**直接子模块**；还有子层级时继续查询：

```text
modules DB
modules "DB/Node"
modules POST
```

常用子模块：

| 完整模块路径 | 内容 |
|---|---|
| `DB/Project` | 单位、结构类型、分组 |
| `DB/Node/Element` | 节点与单元；位于 `DB → DB/Node → DB/Node/Element` |
| `DB/Properties` | 材料、截面、厚度 |
| `DB/Boundary` | 支座、释放、连接与边界 |
| `DB/Static Loads` | 静力工况、节点荷载、自重及梁荷载 |
| `DB/Dynamic Loads` | 动力荷载定义 |
| `DB/Analysis` | 分析控制参数 |
| `DB/Analysis Results` | 荷载组合定义，包括通用组合 `/db/LCOM-GEN` |
| `DB/Design` | 设计参数 |
| `POST/Pre-Process Table` | 材料、截面等模型数据表 |
| `POST/Analysis Result Table` | 位移、内力、反力等结果表 |
| `POST/Analysis Story Table` | 楼层结果表 |
| `POST/Design` | 设计结果 |

`DB`、`DB/Node`、`POST` 本层不直接挂接口，需要进入子模块；`DOC`、`OPE`、`VIEW` 可直接列接口。

### Step 3：列出模块内的接口名称

```text
endpoints "DB/Node/Element"
endpoints "DB/Properties"
endpoints DOC
```

默认列出该模块直接包含的全部接口摘要：接口名称 `name`、所属模块 `module`、REST 路径 `path` 和 HTTP 方法 `methods`。找到所需接口后，将返回的 `module` 和 `name` 原样用于下一步。

需要完整 `/db` 表名目录时用 `endpoints DB --recursive`，它包含 DB 的全部子模块。该目录是离线文档收录范围，实际支持仍须核对产品/版本。路径直接复制查询结果，不猜缩写或后缀。

### Step 4：查看接口如何使用

```text
detail "DB/Node/Element" "Node"
detail "DB/Node/Element" "Node" --section parameters
detail "DB/Node/Element" "Node" --section examples
```

默认返回接口概览和示例目录。`--section parameters` 查字段、类型、单位、枚举和必填条件；`examples` 查请求示例；`schema` 查完整 JSON Schema；`all` 一次读取全部。示例较多时，按概览返回的名称选取代码块：

```text
detail "DB/Properties" "Section Properties - Value" --section examples --block Pipe_Auto
detail "POST/Analysis Result Table" "Reaction - Analysis Result Table" --section examples
```

不同截面共用 `/db/SECT`，不同结果表共用 `/post/TABLE`；使用模块与接口名称即可区分。关联接口通过 `related_interfaces` 的模块与名称继续离线查询，例如截面的公共字段与形状定义。静力与时程结果也按各自模块查询，不能仅凭相似名称混用。

已知唯一 REST 路径时可直接 `detail /db/NODE`。路径对应多个接口时会返回候选列表，再用其中的模块与名称取详情。`Assign`、`Argument`、空请求体等格式以具体接口为准，不能统一包装。

### 辅助：关键词检索

```text
search "Node"
search "Load Combinations - General"
search "Truss Force"
search "Section Table"
search "Pressure Load"
```

**因为API文档是全英文的，所以检索必须使用英文关键词、官方接口名称或 REST 路径。** 搜索不区分大小写，精确路径/名称优先，其次名称关键词，再到用途、备注和参数；同接口去重，保留同路径的不同截面/表格契约。命中后按 `module` 和 `name` 接续 Step 4。

关键词搜索默认返回前 20 条；`next_offset` 非空表示还有结果，用 `--offset <next_offset>` 继续。`--limit N` 可限制单次条数；模块接口列表默认不限制条数。需 JSON 输出时将 `--json` 放在子命令之前。

默认排除整页标明 CIVIL 专属的接口；共用接口仍须检查字段的 `[GEN NX only]` / `[CIVIL NX only]`。`products=unspecified` 表示整页适用范围未注明，不是兼容承诺。手册为滚动版本，新增接口须核对实际产品/版本，最低版本未知时不推定兼容。方法列表为空时不能推定支持 CRUD；示例有 `parse_error` 时转查 Schema 与有效示例，不猜字段。库内“用法补充/项目补充”是与官方原文区分的防错说明。

## 连接与执行

在 `python_executor` 中：

```python
from PKPMAgent.software_link_kit.midas import connect_midas, detect_midas, MidasError

midas = connect_midas()
print(midas.info)  # 不含密钥，含产品年份、语言、构建、PID、单位和握手状态
units = midas.request("GET", "/db/UNIT")
print(units)
```

连接只按以下三种情况处理：

1. **MIDAS 已运行且能连接：** 直接使用，不要求用户重新打开工程或提供密钥。
2. **连接失败，存在 MIDAS 进程：** 请用户在软件中手动打开或新建一个工程，再连接 API。
3. **连接失败，不存在 MIDAS 进程：** 请用户提供工程文件完整路径，或自行打开一个工程。拿到路径后用 `connect_midas(project_path=工程文件绝对路径)` 启动并打开；**没有工程路径就不启动程序**，即使 `auto_start=True` 也一样。

API 入口为 **工具 → API → API Settings（API 设置）**。首次缺少配置或密钥失效时，索要同页配套的 Base URL 和 MAPI-Key；成功后按 Windows 用户加密记住。多个实例无法确定目标时，用 `detect_midas()` 列出候选让用户选择。详细诊断读 `use_skill('MIDAS-Link', file='references/connection.md')`。不要打印密钥、写入技能或脚本，或修改 MIDAS 注册表。

## 模型操作与结果读取

### 1. 核实工程并按依赖建模

连接成功只表示握手有效。先核实当前工程、单位、结构类型 `/db/STYP`、节点/单元、材料/截面、已有 ID；没有节点不代表所有定义为空。空表可能返回 `{"message":""}`，不能把任意 HTTP 200 当作有效模型数据。

先创建材料、截面和节点，再创建引用它们的单元；先定义 `/db/STLD` 工况，再施加荷载和定义组合。编号是表内对象的标识，不是数组下标；`ELEM.NODE` 则是有顺序的节点编号数组。检查单元引用、共享节点和杆长，不能仅凭几何重合认定已连接。`TRUSS` 只提供轴向刚度；需要传递弯矩的构件使用相应梁单元及连接，支座约束与杆端释放是不同设置。

模型参数集中放入带含义和单位的 dict，如 `params['span_m']`、`params['area_m2']`，避免复用 `A/L/P` 等全局变量。新增 ID 先查占用，写后 GET 核对目标对象、坐标范围、尺寸与数量；POST 回显不是最终存储状态。请求体按 common_examples.md §4 或接口契约编写，不统一套 `Assign`。

### 2. 支承、截面与荷载的关键区别

- **支承 `/db/CONS`：** 外层键是节点号，`ITEMS.ID` 是节点内约束项序号，多节点必须分外层记录。新增优先 `midas.create_supports({节点号: '七位约束串', ...})`，自动逐节点核验；已有支承按实际边界组和约束修改，不能直接覆盖。
- **VALUE 截面：** `CALC_OPT` 仅创建有效，PUT 改尺寸不能依赖它重算。优先新 ID 创建、核验后改单元引用。实际刚度在 `SECT[id].SECT_BEFORE.SECT_I.STIFF`；后端对纯自动 P/SB/SR 核验 AREA/RYY/RZZ，其他 VALUE 输入须给独立计算的 `expected_stiffness`。读回缺字段不能用预期值代替。具体修改方式见 common_examples.md §2。
- **荷载与组合：** `/db/CNLD` 外层键是节点号，ITEMS.ID 在该节点内唯一，换工况不重置。创建 D 类静力工况不自动施加自重，自重由 `/db/BODF` 定义。通用组合用 `/db/LCOM-GEN`；`/ope/LCOM-*` 是规范自动组合。组合系数和分析类型按任务确定，不把包络、动力或非线性结果当普通线性静力结果叠加。

### 3. 保存、分析与取结果

`NEW`、`OPEN`、`CLOSE` 会切换或丢弃当前内存模型，先处理当前工程保存。独立任务用独立目录和文件名，普通读取不要求另存。默认保存 **`.mgbx`**，路径为 GEN NX 所在主机上的绝对路径，目录须已存在；保存成功后核对实际文件。旧 `.mgb` 可能触发兼容弹窗并阻塞 REST，只有明确需要旧格式时才用 `allow_legacy_format=True`。

运行分析前检查边界、荷载和工况并保存。修改模型后重新分析，旧结果不能当作更新结果。`ANAL` 的 command complete 只表示命令完成，不证明无告警；`PROJECTSTATUS` 是对象统计，不是分析状态接口。

用 `midas.get_table(argument, expected_columns=[...], expected_loads=[...])` 读取结果，只传 `Argument` 的内部对象：

| 选择项 | 含义与防错 |
|---|---|
| `TABLE_TYPE` / `TABLE_NAME` | 前者选表种类，后者指定响应键；不同表的字段和参数不能混用 |
| `NODE_ELEMS` / `LOAD_CASE_NAMES` | 查询用 `工况名(ST)` 或 `组合名(CB)`；普通静力结果行的 Load 通常只返回工况/组合名。`load_names` 列出本次实际标签，`expected_loads=['DL','ULS']` 可校验覆盖；不要把 DL(ST) 当作返回行的分组键，也不要统一删掉所有结果标签的括号 |
| `COMPONENTS` / 位置与步 | 选择所需分量；梁端/跨中、板顶/底、阶段/步及包络 max/min 按所选表的契约指定，不能把不同位置或步混成一行 |
| 返回 `head` / `rows` / `metadata` | 按实际 HEAD 映射的字典行取列；可能多出 Index，不能按请求列下标取值。检查实际单位、完整对象/工况覆盖，空表和 `****` 不等于零；SUB_TABLES 在 metadata 中保留，各按自己的 HEAD 读取 |

数值字符串显式转换并检查有限性。分组前断言实际 Load/Node/Elem 取值和目标覆盖；分组后确认目标组非空，不能把未匹配的空统计当作零。多表按对象、工况及必要的位置/步关联，不按行序配对；同名静力工况与组合应分开查询以免混淆。常规检查结果完整性、有效数值及位移量级；见 common_examples.md §5。

### 4. 异常与会话

客户端不自动重试写入。超时意味着结果未知；先检查软件、文件和模型状态，再决定是否重发。外层 `python_executor` 的 timeout 要覆盖客户端等待时间（文件操作默认 120 秒，分析 900 秒）；同一模型不并发写入。

`MidasError` 可输出 `e.code`、`e.details`。若 `write_completed=True`，表示写请求已成功返回但后续核验失败，对象可能已改变；停止后续分析并检查，不能当作未写入直接重试。认证刷新、进程重启及连接错误按 connection.md 处理，404/参数错误不等于整个连接失效。`midas.close()` 仅释放 HTTP 客户端；不要自动关闭用户的软件或工程。
