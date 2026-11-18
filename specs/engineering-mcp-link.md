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
| `base.ts` | `BaseMCPLink` 抽象：`connect` 流程固定为「启动服务 → 等端口 → 握手」，子类只实现 `startMcpServer` 与 `connectMcp` |
| `registry.ts` | 按 server name 管理连接实例，提供 connect/disconnect/isConnected/getActiveLink 等入口 |
| `discovery.ts` | 安装位置发现：显式路径 > 环境变量 > 上次成功路径 > 自动发现（注册表四路） |
| `common.ts` | 端口探测、PID 反查端口、等待服务就绪 |
| `briefing.ts` | 连接成功后生成「你能用什么」简报 |
| `links/bimbase.ts` | BIMBase/PKPM 子类，实现安装发现与启动 |
| `links/sap2000.ts` | SAP2000 子类，走 COM |
| `links/autocad.ts` | AutoCAD 子类，走 COM（兼容浩辰/中望） |
| `links/rhino.ts` | Rhino 子类，走 COM |
| `links/office.ts` | Office/WPS 子类，走 COM |

`BaseMCPLink` 持有 `port`/`host`/`connected`；子类持有目标软件特有的启动参数（exe 路径、工程路径、版本）。连接实例不持久化到磁盘，进程重启后重新建立。

**依赖方向**：`engineering/mcp-link` 可以依赖 `shared` 与 `rpc`；不得反向被 `ui` 直接调用（UI 通过 hooks → service）。不得导入 `packages/desktop` 的实现。

**错误与状态**

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
        Link->>App: 复用进程，取 MCP 端口
    else 未运行
        Link->>App: spawn(exe, 工程)
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

## 函数注入

连接成功后，MCP 服务返回的 `tools/list` 与 JSON Schema 需要转换成 Python 可调用的函数与数据结构，注入 Python 执行环境的全局命名空间。

- 工具函数名保持与 MCP 一致，不重命名。
- 输入 Schema 转为带类型注解的 Python 函数签名；输出 Schema 转为可校验的数据结构。
- 注入的是一次性快照，函数清单不会在会话中途变化。
- 函数清单是**有限且可穷尽**的：Agent 可查询「某类别下全部函数」，据此判断某能力是否存在，而不是靠试错。
- 注入后 Agent 通过 `function_search`（普通函数，非工具）检索：`GetType` / `GetName` / `GetDescription` / `GetClass`。

## Acceptance and validation

1. 未安装目标软件时，`connect` 返回可读错误文案，不抛异常，不重试。
2. 目标软件已运行时，`connect` 复用该进程，不重复启动第二个实例。
3. 目标软件未运行时，`connect` 启动它并等待 MCP 就绪；超时返回包含端口号的错误。
4. 重复 `connect` 同一 server name 是幂等的，返回 `true` 且不产生第二个进程。
5. 连接成功后返回简报，包含可用函数类别与数据结构名称。
6. 注入的函数在 Python 执行环境中可直接调用，参数类型与 MCP 定义一致。
7. `function_search` 对某类别返回的函数清单是完整的，不受分页或截断影响。
8. `disconnect` 后 `isConnected` 为 `false`，再次 `connect` 可重建。
9. 目标软件中途关闭后，调用注入的函数返回连接错误而不是静默失败。
10. 四路发现中任一路径命中即可连接；全部失败时错误文案包含「请先启动」与「或指定路径」两条指引。
