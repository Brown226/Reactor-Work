# engineering-mcp-link 模块契约

工程软件 MCP 连接层：把本机已安装的工程软件（BIMBase/PKPM、SAP2000、ETABS、AutoCAD、Rhino、Office、Tekla Structures、MIDAS Civil、SketchUp、STAAD.Pro、Abaqus）连成一个可由 Agent 驱动的执行环境。spec 见 `specs/engineering-mcp-link.md`。

设计来源是 PKPM Agent 的连接层逆向还原（`software_link_kit` + `mcp_link`）。

类型与测试表达不了的不变量：

- **不是屏幕镜像**：Agent 下发指令，软件在自己的图形内核里执行并渲染；连接层不采集屏幕、不嵌入软件窗口、不读界面像素。Agent 读取的是结构化数据（节点坐标、构件 ID、截面参数）。
- `connect` 流程固定三段且顺序不可颠倒：启动服务 → 等端口 → 握手。任何一段失败都返回 `string` 错误文案，不抛异常、不自动重试。
- **端口按 PID 反查，不解析厂商配置文件**：配置格式随厂商版本变化且无稳定承诺，PID 才稳定。反查为「PID → 该进程的 TCP 监听端口 → 逐个连通确认」，逆向依据是原厂 `common_tools.pid_to_mcp_port(pid)`。
- **「找到进程」与「拿到端口」必须分开表达**：找到运行实例但端口尚未监听时，只能等该 PID 的端口出现，不能再启动一个实例——否则两个软件会抢同一份工程文件。`startMcpServer` 的返回值无法表达这个区别，因此由子类内部区分（`{ running, port }`），对外仍是三态。
- **注入的端口解析器优先于自动反查**：`setEngineeringPortResolver` 是显式覆盖入口，未注入时才走自动反查。
- **端口等待不抛异常**：轮询超时返回 `undefined`，由 `BaseMCPLink` 转成用户可读文案。
- 同一 server name 只允许一个活动实例，重复 `connect` 幂等。实例不落盘，进程重启后重建。
- 连接状态是唯一真相，由本模块持有。`mcp-sync` 只负责配置持久化，不持有运行时连接。
- 安装发现按优先级命中即停：显式路径 > 环境变量 > 上次成功路径 > 注册表四路（卸载表 / 产品配置键 / 文件关联 / 安装根环境变量）。每个候选必须通过 `isValidRoot` 校验，不合格静默跳过。
- 读注册表失败一律静默降级为空候选，不让发现环节整体失败。
- 注入的工具函数是**一次性快照**，会话中途不变化；清单有限且可穷尽，Agent 据此判断某能力是否存在，而不是靠试错。
- **COM 系软件的目录路径必须在注册时解析出来**：`ComSoftwareLink` 的能力清单来自本地 API 目录，`catalog.path` 为 `undefined` 时 `loadApiCatalogTools` 直接返回空数组，连接看似成功但 `function_search` 查不到任何函数。目录文件位置固定为 `<技能目录>/references/api.catalog.json`，由 `resolveApiCatalogPath` 按软件标识定位（目录名与标识大小写无关地相等，或为 `<标识>-Link`）。
- **API 目录缺失只降级不失败**：找不到目录时连接仍然成功，`briefing` 说明「function_search 查不到函数清单」，脚本里仍可 `win32com.client.Dispatch`。能力缺失不等于连接失败。
- **技能 references 以明文入库**：厂商加密格式（`<!--PKPM-SKILL-ENC:v1-->`）无法离线阅读，已用厂商 `skill_kit.vault` 解密后以明文替换，仓库内不得再提交该标记的密文。API 知识库只保留编译后的 `api.catalog.json`，原始 SQLite 原件不入库。
- **一个连接类覆盖所有桌面软件，桥接方式必须如实表达**：`ComSoftwareLink` 只做「安装/进程发现 + 本地 API 目录注入」，与是否 COM 无关。每个软件的调用方式（COM / .NET 程序集 / 本地 HTTP API / Ruby 插件 / 自带 Python）记在 `DesktopServerSpec.bridge` 上，简报、平台限制文案与诊断建议都按它生成；不得把非 COM 软件说成 COM，也不得在提示里让用户用 `win32com.client.Dispatch` 去调 .NET 或 Ruby 接口。
- **没有 ProgID 就不编造**：Tekla / MIDAS / SketchUp / STAAD.Pro / Abaqus 的连接库随各自专业安装包分发，无法在本仓库反查到 ProgID，因此登记为「exe 名 + 环境变量 + 连接时传 `exePath`」，并在 `note` 写明使用前提。诊断为它们检查「安装位置」而非「COM 注册」。
- **登记项必须能解析到 API 目录，AutoCAD 例外**：除 AutoCAD（走脚本/`sendCommand`，不依赖注入目录）外，任何登记项的 `catalogId` 解析不到 `api.catalog.json` 都视为登记错误，由回归测试拦截。
- 注入的函数已存在于执行环境，脚本中不得 `import`；只有 `print()` 的输出返回给用户。
- 目标软件中途关闭后，调用注入的函数必须返回连接错误，不静默失败。

## 函数注入的不变量

- 转换层只做「MCP 工具清单 → 函数签名」，不碰传输层、不决定注入到哪个运行时。Python 与 JS 执行器复用同一份结果。
- 工具名原样保留。`$ref` 保留引用名，由数据结构定义承载，不展开、不内联。
- 单个工具畸形（缺 name、Schema 非对象）记入 `skipped`，其余继续；转换整体不抛异常。
- 注入结果是一次性快照，会话中途不重取。
- `function_search` 是注入环境里的普通函数，不是工具。四个动作：`GetType` / `GetName` / `GetDescription` / `GetClass`。
- **清单完整性是防幻觉的基础**：`GetDescription` 查不到某函数时必须给出「不存在」的确定结论，并引导用 `GetName` 确认实际名称，不得建议改拼写重试。要区分「存在但参数错」与「不存在」。

## 目标软件的关键约束（来自逆向，写进实现注释避免重踩）

BIMBase/PKPM：

1. 模型定位骨架是**平面**的：节点 → 网格 → 构件；柱依附节点，梁墙依附网格，斜杆依附两端节点。
2. 新建梁/墙/网格时若与其他构件相交，软件会自动在交点加节点并**打断成多段**；返回的构件信息是打断前捕获的，ID 不保证仍代表原构件。布置完成后必须重新检索。
3. 三维空间结构必须用带 `_WithAutoStdFlrDetection` 后缀的入口，普通二维入口会把端部标高拉平到同一标准层。
