# 工程软件 MCP 连接层

## Product rules

- Reactor 能连接并驱动本机已安装的工程软件（BIMBase/PKPM、SAP2000、AutoCAD、Rhino、Office）。
- 连接方式为 **API 直连**，不是屏幕镜像：Agent 下发指令，软件在自己的图形内核里执行并渲染，Agent 读取结构化数据（节点坐标、构件 ID、截面参数）。不采集屏幕、不嵌入软件窗口。
- 连接成功后，目标软件暴露的工具函数被注入 Python 执行环境，Agent 可以写脚本批量调用，而不是逐个工具调用。
- 一次连接后，目标软件的全部工具函数与数据结构对当前会话可用；重复连接是幂等的。
- Agent 全程看不到画面，只读取数值；"结果是否正确"由证据门禁判断，不由界面判断。

## Ownership and boundaries

`packages/services/src/engineering/mcp-link/` 拥有运行时连接状态：每个 server name 对应一个 `BaseMCPLink` 实例。连接状态是唯一真相，`mcp-sync` 只负责配置持久化，不持有运行时连接。

**目录与职责**

| 文件 | 职责 |
| --- | --- |
| `base.ts` | `BaseMCPLink` 抽象：`connect` 流程为「启动服务 → (MCP 系) 等端口 → 握手」，子类只实现 `startMcpServer` 与 `connectMcp` |
| `registry.ts` | 按 server name 管理连接实例，提供 connect/disconnect/isConnected/getActiveLink 等入口 |
| `discovery.ts` | 安装位置发现：显式路径 > 环境变量 > 上次成功路径 > 自动发现（注册表四路） |
| `common.ts` | 端口探测（`isPortOpen`）、等待服务就绪（`waitForPort`） |
| `port-lookup.ts` | PID 反查端口：按 PID 取该进程的 TCP 监听端口，排序后逐个连通确认，并支持轮询等待 |
| `briefing.ts` | 连接成功后生成「你能用什么」简报 |
| `links/bimbase.ts` | BIMBase/PKPM 子类，实现安装发现与启动 |
| `links/sap2000.ts` | SAP2000 子类，走 COM |
| `links/autocad.ts` | AutoCAD 子类，走 COM（兼容浩辰/中望） |
| `links/rhino.ts` | Rhino 子类，走 COM |
| `links/office.ts` | Office/WPS 子类，走 COM |

`BaseMCPLink` 持有 `port`/`host`/`connected`；子类持有目标软件特有的启动参数（exe 路径、工程路径、版本）。连接实例不持久化到磁盘，进程重启后重新建立。

**依赖方向**：`engineering/mcp-link` 可以依赖 `shared` 与 `rpc`；不得反向被 `ui` 直接调用（UI 通过 hooks → service）。不得导入 `packages/desktop` 的实现。

**错误与状态**

- `startMcpServer` 返回三态：`number` 为已取到的 MCP 端口（继续等就绪并握手）；`true` 为无需端口（COM 系软件，跳过端口等待直接握手）；`string` 为失败文案。
- 启动失败返回 `string` 错误描述（不抛异常），调用方转告用户。
- 端口等待超时返回明确文案，包含等待时长与端口号。
- 连接失败不自动重试；用户处理后再次调用 `connect`。

```mermaid
sequenceDiagram
    participant Agent
    participant Registry as mcp-link/registry
    participant Link as BaseMCPLink 子类
    participant Disc as discovery
    participant App as 目标软件
    Agent->>Registry: connectToServer(name, workDir)
    Registry->>Link: 取或建实例
    Link->>Disc: resolveExePath()
    Disc-->>Link: exe 路径 或 错误文案
    alt 已有运行实例
        Link->>Link: pidToPort(pid) 反查监听端口
        opt 端口尚未监听
            Link->>Link: 轮询等待端口出现（上限 100s）
        end
    else 未运行
        Link->>App: spawn(exe, 工程)
        Link->>Link: pidToPort(pid) 轮询等待端口
    end
    Link->>Link: waitMcpReady(port, 100s)
    Link->>App: MCP 握手（JSON-RPC）
    App-->>Link: tools/list + schemas
    Link-->>Registry: true
    Registry-->>Agent: true + 连接简报
```

## 安装发现

按优先级依次尝试，命中即停：

1. 显式传入的 `exePath`
2. 环境变量（如 `BIMBASE_EXE_PATH`）
3. 上次成功路径（进程内缓存，不写盘）
4. 自动发现，四路候选并行：
   - 卸载表 `InstallLocation` / `InstallDir`（HKCU + HKLM + WOW6432Node）
   - 产品自有配置键（`HKCU\SOFTWARE\<产品>\...`）
   - 文件关联 `shell\open\command`（`.p3d` 等）
   - 环境变量 `BIMBASE_HOME` / `BIMBASE_ROOT`

每个候选项必须通过 `isValidRoot()` 校验（存在启动器 + MCP 脚本），不合格的静默跳过。

## 端口反查

MCP 端口不解析厂商配置文件：配置格式随厂商版本变化，且厂商并未承诺稳定；PID 才是稳定事实。因此统一按「PID → 该进程的 TCP 监听端口 → 连通确认」反查（逆向依据：原厂 `common_tools.pid_to_mcp_port(pid)` 与 `wait_local_mcp_ready(port, timeout=100)`）。

- **按 PID 取监听端口**：Windows 首选 `Get-NetTCPConnection -State Listen -OwningProcess <pid>`，无结构化结果时回退 `netstat -ano -p TCP`；Linux 首选 `ss -lptnH`，回退 `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`；其它 POSIX 用 `lsof`。所有命令失败一律降级为空列表，不抛异常。
- **候选排序只影响先试哪个，不丢弃候选**：回环优先 → 非特权端口（≥1024）优先 → 端口号升序；同端口去重并优先保留带地址的记录。
- **连通确认**：按排序逐个 TCP 连接，第一个连通的即为结果；全部不通返回 `undefined`，不猜端口。
- **「找到了进程」与「拿到了端口」必须分开表达**：找到运行实例但端口尚未监听（软件还在启动画面）时，不能退化成再启动一个实例——那会出现两个软件抢同一份工程。正确行为是等待该 PID 的端口出现，超时后返回可读错误文案。
- **注入的端口解析器优先于自动反查**：`setEngineeringPortResolver` 是显式覆盖入口，供无实机调试或厂商特殊形态使用；未注入时才走自动反查。
- **等待不抛异常**：轮询超时返回 `undefined`，由 `BaseMCPLink` 转成用户可读文案。

## 函数注入

连接成功后，MCP 服务返回的工具清单需要转换成目标运行时可调用的函数定义，并连同数据结构一起注入执行环境。

**转换边界**：本模块只做「转换」，不碰传输层，也不决定注入到哪个运行时。这样 Python 执行器与 JS 执行器复用同一份结果。

- 工具名保持原样，不重命名、不加前缀。
- 输入 JSON Schema 转为带类型的函数签名；`$ref` 保留引用名，由数据结构定义承载。
- 输出 Schema 存在时用于推导返回类型；缺失时返回类型为 `any`，不猜。
- 单个工具 Schema 畸形时记入 `skipped` 并继续处理其余，不让一个坏工具让整次注入失败。
- 注入结果是**一次性快照**：会话中途不重取，函数清单不变。
- 转换不抛异常；参数缺失时返回带指引的失败结果，由调用方转告用户。
- 函数清单是**有限且可穷尽**的：Agent 可查询「某类别下全部函数」，据此判断某能力是否存在，而不是靠试错。

**function_search** 是注入环境里的普通函数，不是工具，四个动作：

| action | 输入 | 输出 |
| --- | --- | --- |
| `GetType` | 无 | 全部函数类别及每类函数数量 |
| `GetName` | `funcType` | 该类别全部函数名（完整无遗漏） |
| `GetDescription` | `funcType` + `funcNames` | 参数、类型、必填性、返回类型、涉及的数据结构 |
| `GetClass` | 无 | 可用数据结构清单 |

**防幻觉约定**：函数清单是有限且可穷尽的。`GetDescription` 查不到某函数时，必须明确告知「清单完整、找不到就是不存在」，并引导改用 `GetName` 确认实际函数名，**不得**建议改拼写重试。区分「函数存在但参数错」与「函数不存在」是后续排错的前提。

## 本地 API 目录

COM 系软件（SAP2000 / ETABS / Rhino 等）不提供运行时 `tools/list`，Agent 能调用什么由**随包分发的本地 API 目录**决定。目录文件位置固定为 `<技能目录>/references/api.catalog.json`，由厂商加密 SQLite 库（Abaqus / ETABS / MIDAS / Rhino / SAP2000 / SketchUp / STAADPro / Tekla 共 10 个）编译而来，去重后约 1.66 万条记录。

- **注册时必须解析出目录路径**：`registry.ts` 创建 `ComSoftwareLink` 时调用 `resolveApiCatalogPath(catalogId)`，按标识定位目录文件——技能目录名与标识大小写无关地相等，或为 `<标识>-Link`。只传 `id` 而不传 `path` 时 `loadApiCatalogTools` 直接返回空数组，连接看似成功但 `function_search` 查不到任何函数。
- **目录缺失只降级不失败**：找不到目录文件时连接仍然成功，简报说明「未找到本地 API 目录，function_search 查不到函数清单」，脚本里仍可 `win32com.client.Dispatch` 直接调用。能力缺失不等于连接失败。
- **目录文件是编译产物，原始 SQLite 不入库**：编译脚本从各库的主表（`functions` / `methods` / `endpoints` / `symbols`）取 `name` / `purpose`(或 `summary`) / `syntax` / `parameters` / `module`，单条文本截断到 300 字符；10 个库合计约 4.5 MB JSON。原始 103 MB SQLite 留在构建机/制品库，需要时重新编译。
- **技能 references 以明文入库**：厂商密文（`<!--PKPM-SKILL-ENC:v1-->`）无法离线阅读，已用厂商 `skill_kit.vault` 的 `fernet()` 解密（剥掉标记行、拼接 token 再解密）后以明文替换，共 216 个 Markdown（约 1.74 MB）。

## Python 执行器

工程软件的可编程接口几乎只有 Python（COM 绑定、内嵌解释器、厂商 SDK），所以连接层需要一个会话可复用的 Python 执行通道。

- worker 按 key 复用：同一 key 的后续调用落在同一通道，变量跨调用保留。key 通常取会话或工作区标识。
- 只把 `print()` 的输出返回给用户；stderr 仅用于诊断，不直接呈现。
- 单次执行有超时；超时后**终止该通道并下线**，下次调用重启通道——进程里可能还挂着阻塞调用，不能安全复用。
- 同一通道同时只跑一个任务；并发调用返回明确提示，不排队、不静默串行。
- 执行结果统一走 `PythonRunResult`，失败也返回结构而不抛异常。
- 输出有上限，超出时保留尾部（报错通常在尾部）并标注省略量。
- 解释器缺省按平台取 `python3` / `python`；目标软件的内嵌解释器由调用方显式指定。
- 进程树随主进程回收；进程退出或工作区切换时释放通道。

**函数注入落地**：转换后的函数签名渲染成 Python 调用桩，函数体统一转发到宿主暴露的 `__zcode_mcp_call__`。注入块放在用户脚本之前，同名后定义覆盖先定义。参数名会规范成合法 Python 标识符（非法字符替换、数字开头加前缀、关键字加后缀），不丢弃参数。

## 工程确定性体系

产品能否用于工程交付的前提。三道闸：规格预检（提交前）→ 执行契约（过程中）→ 证据门禁（结果判定）。

### 输入预检

- 12 个必填字段缺失即 `FAIL`，**停止提交计算**。
- 缺失判定只区分「有没有」，不判断「够不够」：`undefined`/`null`/空串算缺失；**空数组、空对象不算缺失**（`units: {}` 是合法的「用软件默认单位制」表达）。把空容器判成缺失会误拦正确规格。
- 预检**不替用户补默认值**。材料、单位、边界条件、验收阈值必须由设计人确认——这是 LLM 最容易犯的错。
- 验收标准全部为 `review` 时给 `WARN`：等于没有可自动判定的条目，交付前需人工核对。

### 输出门禁

- 三种操作符：`between`（闭区间）、`approximately`（目标±容差）、`review`（人工判断）。
- **`review` 永远返回不通过**。有些工程判定 AI 不许自己下结论，这是有意为之。
- 证据缺测值一律判失败：缺测不等于通过。
- 整体判定：任何一条 failed，或有 needsReview 项，整体都不通过。`review` 项不能因为「其它项都过了」被顺带放过。
- 措辞必须区分三件事：计算未完成 / 计算完成但未验证 / 结果已验证。只凭求解器的完成状态不得宣称结果正确。

## 执行门面

`EngineeringExecutor` 把「连接」与「跑 Python」串成一条链路，是 Agent 实际调用的入口。

- 一次调用完成：连接（幂等）→ 生成注入块 → 拼接用户脚本 → 执行 → 返回结果。
- 注入块（参数映射 + 函数桩 + 用户脚本）里注入块在前，用户脚本在后：同名函数后定义覆盖先定义，保证用户代码优先。
- 失败路径全部转成结果结构，不抛未捕获异常——Agent 需要把原因转述给用户，异常会中断整轮对话。
- 结果只带 `print` 的内容与注入的函数名；注入函数名用于向用户说明「你能用什么」。
- 中断按通道 key 执行，终止整棵 worker 进程树。

## 可信交付流程

`verifiedRun` 把「预检 → 执行 → 门禁」三步串成一条不可跳步的链。

为什么不让调用方自己拼：这三步的顺序与「失败即停」语义是整套体系的核心。拆开很容易变成「预检有警告也继续跑」或「算完直接说成功」——那正是这套设计要防的。

- 预检 `FAIL` / `UNSUPPORTED`：不调用计算函数，直接返回。**不是「先跑再看」。**
- 计算失败：返回带原因的结果，不进入门禁。
- 无验收标准：计算结果未经确认，不可交付。
- 门禁不通过：不可交付，措辞区分「未完成」与「完成但未验证」。
- 全部通过：可交付，但预检阶段的 `WARN` 一并带上，不让它消失在成功消息里。

## Acceptance and validation

1. 未安装目标软件时，`connect` 返回可读错误文案，不抛异常，不重试。
2. 目标软件已运行时，`connect` 复用该进程，不重复启动第二个实例。
3. 目标软件未运行时，`connect` 启动它并等待 MCP 就绪；超时返回包含端口号的错误。
4. 目标软件已运行但 MCP 端口尚未监听（仍在启动画面）时，`connect` 等待该 PID 的端口出现，不启动第二个实例；等待超时返回可读文案，提示确认已进入工程主界面。
5. 端口反查按 PID 取该进程的 TCP 监听端口，并按「回环优先 → 非特权端口优先 → 端口号升序」排序后逐个连通确认；全部不通时返回 `undefined`，不猜端口。
6. 端口反查的解析函数对空输出、非法 JSON、非目标 PID 与非 LISTENING 行返回空结果，命令执行失败降级为空列表，均不抛异常。
7. 已注入 `setEngineeringPortResolver` 时优先使用注入值，不触发自动反查。
8. 重复 `connect` 同一 server name 是幂等的，返回 `true` 且不产生第二个进程。
9. 连接成功后返回简报，包含可用函数类别与数据结构名称。
10. 注入的函数在 Python 执行环境中可直接调用，参数类型与 MCP 定义一致。
11. `function_search` 对某类别返回的函数清单是完整的，不受分页或截断影响。
12. `disconnect` 后 `isConnected` 为 `false`，再次 `connect` 可重建。
13. 目标软件中途关闭后，调用注入的函数返回连接错误而不是静默失败。
14. 四路发现中任一路径命中即可连接；全部失败时错误文案包含「请先启动」与「或指定路径」两条指引。
15. 工具清单转换后，函数签名包含参数名、类型、必填性与返回类型；`$ref` 解析到数据结构定义。
16. 畸形工具（缺 name、Schema 非对象）被记入 `skipped`，其余工具仍完成转换。
17. `GetName` 对存在的类别返回完整清单，不截断、不分页。
18. `GetDescription` 查询不存在的函数名时，返回「不存在」结论并给出 `GetName` 指引，不返回模糊的成功。
19. 未连接时调用 `function_search` 返回失败结果而不是抛异常。
20. Python 执行器返回 `print` 的内容，stderr 不混入 stdout。
21. 执行超时后通道被终止，下次调用重启通道而不是复用僵死进程。
22. 同一通道并发调用返回明确提示，不排队也不静默串行。
23. 输出超限时保留尾部并标注省略字符数。
24. 注入桩的参数名全部是合法 Python 标识符，关键字与数字开头均被规范化。
25. 空规格预检为 `FAIL`，且逐项列出缺失字段。
26. 含空容器（`units: {}`、`materials: []`）的规格不因容器为空被判缺失。
27. 证据缺测值判失败，不因缺测而通过。
28. `review` 操作符永远不自动通过；与其它全通过的条目混合时整体仍不通过。
29. `between` 闭区间边界值判通过；超出边界判失败。
30. `approximately` 恰好等于容差边界判通过。
31. 注入桩在 Python 中可直接调用（无需 import），调用参数正确转发到宿主的 `__zcode_mcp_call__`。
32. 执行门面在连接失败时返回错误结果，不抛异常，且不启动 Python 通道。
33. 用户脚本可以覆盖同名注入函数（后定义生效）。
34. 预检失败时计算函数**不被调用**（失败即停，不是先跑再看）。
35. 计算成功但无验收标准时不可交付。
36. 门禁不通过时不可交付，且 `review` 项使整体不通过。
37. 全部通过时预检的 `WARN` 仍出现在结论里。
38. COM 系软件连接成功后，`function_search` 能查到本地 API 目录里的函数（SAP2000/ETABS/Rhino 均非空），不会因 `catalog.path` 缺失而恒为空。
39. `resolveApiCatalogPath` 对标识大小写不敏感，接受 `<标识>-Link` 与同名目录两种布局；目录存在但缺 `api.catalog.json`、标识未知、技能根不存在时返回 `undefined`，不抛异常。
40. 本地 API 目录缺失时连接仍成功，简报明确说明「查不到函数清单」，脚本仍可 `Dispatch`。
41. 技能 references 目录内不再存在 `<!--PKPM-SKILL-ENC` 密文；构建产物（`dist/engineering/skills`）随包含明文 references 与 `api.catalog.json`。
