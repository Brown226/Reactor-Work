# 桌面 Office 编辑器内核与嵌入方式

- 状态：Proposed
- 日期：2026-11-21
- 关联规格：`docs/未完成-桌面Office编辑器-人机双写-spec-v1.md`

## Context

Reactor 的 Office 能力目前停在只读预览：`.docx` / `.xlsx` / `.pptx` 能看不能改，AI 只能生成新文件，人和 AI 的改动落在不同副本里。KnowWork v0.1.2 的「人机双写」验证了目标体验：对话与文档并排，人直接改同一份，AI 也改这一份，Word 改动记成修订，冲突由人选择。

Reactor 是桌面优先产品，文件本来就在本机工作区，不需要服务端每人一个编辑器容器。但桌面端仍要解决四个问题：

1. 编辑器内核从哪里来：自研、复用开源办公套件，还是依赖本机安装的 Office。
2. 如何嵌到对话旁边：主 renderer iframe、`WebContentsView`、独立窗口，还是系统级窗口嵌入。
3. 谁能写文件：编辑器、AI、文件树、外部程序都可能改同一份文件，必须有唯一写入者。
4. 如何合规分发：许可证、商标、第三方 notices、安装包体积。

Phase 0 已核实 GenOffice 上游（`genspark-ai/genoffice`）：

- `LICENSE` 为 **Apache-2.0**；`ee/` 目录保留企业许可，不属于 Apache-2.0 授权范围。
- 原生读写 `.docx` / `.xlsx` / `.pptx`，保存时只重写被编辑的块，其余字节保留。
- 支持 Word 修订与 diff、`genoffice docs compare` 生成 redline、CLI 离线编辑。
- 内置 MCP：stdio 服务与本地 HTTP 服务；HTTP 服务提供 `create_session` / `read_document` / `replace_blocks` / `apply_ops` / `save_session`，可驱动可见编辑器会话。
- Electron 多应用架构（Docs、Sheets、Slides、PDF 等），Node ≥ 22.12，Rust 表格 sidecar，electron-builder 支持 macOS/Windows/Linux。
- GenOffice 与 Genspark 名称/Logo 是 Mainfunc, Inc. 商标；README 明确 forks 应使用自己的品牌。

## Decision

采用 **GenOffice 作为桌面 Office 编辑器内核**，桌面端以 **本地子进程 + Main 管理的 `WebContentsView`** 承载，文件写入由新增的 `DocumentEditService` 独占。

```text
┌──────────────────────────── Reactor Desktop ────────────────────────────┐
│ Renderer（对话 / 文件树 / 侧边面板）                                      │
│        │  IPC（打开、保存、选区、冲突）                                  │
│        ▼                                                                │
│ Main                                                                    │
│  ├─ DocumentEditService（唯一写入者：租约、版本、备份、冲突、幂等）       │
│  ├─ WebContentsView（独立 partition，加载编辑器 Web UI）                  │
│  └─ 编辑器子进程（GenOffice，127.0.0.1 随机端口）                         │
│        ├─ Docs / Sheets / Slides 编辑器                                  │
│        └─ HTTP MCP（AI 修改打开着的文档）                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

具体决策：

1. **内核**：GenOffice，构建排除 `ee/`；分发换品牌并移除 GenOffice/Genspark 名称与 Logo；保留 Apache-2.0 LICENSE/NOTICE 与第三方 notices。
2. **嵌入**：Main 创建 `WebContentsView`，加载编辑器本地 HTTP 服务；独立 session partition、无 Node、禁止导航/弹窗、外链受控。不复用主 renderer iframe。
3. **进程**：编辑器作为本地子进程运行，绑定 `127.0.0.1` 随机端口；Main 负责启动、健康检查、崩溃重启与退出清理。
4. **写入**：`DocumentEditService` 是唯一写盘者；编辑器保存、AI 修改、另存为、外部改动检测都经它做租约与版本校验。
5. **AI 路径**：文档开着走 GenOffice HTTP MCP；文档没开走 `genoffice` CLI/OOXML 离线修改；两条路都生成 Word 修订（Excel/PPT 用撤销 + diff 日志）。
6. **补丁策略**：上游没有 web/embedded 模式，外部 MCP 命令默认也不记修订；必须复用 KnowWork 的 Apache-2.0 补丁（web 模式、嵌入式运行、MCP `track`/`author`、host-owned AI），rebase 到锁定版本并单独维护补丁清单。补丁是嵌入体验的硬依赖，不是可选优化。
7. **范围**：本期只支持本地 workspace；远程 workspace、Web/多用户容器版另立项。

## Phase 0 静态 spike（2026-11-21）

已核对上游 `genspark-ai/genoffice` 当前 main（浅克隆约 154 MB）：

| 项 | 结论 |
| --- | --- |
| 许可证 | Apache-2.0；`ee/` 当前只有 LICENSE/README，无代码，但构建必须排除 |
| 商标 | README 明确 forks 应使用自己的品牌 |
| 原生格式 | `.docx` / `.xlsx` / `.pptx`，保存只重写被编辑块，其余字节保留 |
| 修订 | Docs 有完整 revision / accept / reject；AI ops 支持 `track: { author }` |
| MCP | `apps/shell/src/main/mcp/mcp-server.ts`：loopback HTTP，`/mcp` + `/sse`，默认端口 3093；可见编辑工具 `create_session` 等 |
| 外部 MCP 修订 | 上游 `apps/docs/src/renderer/mcp-bridge.ts` 调 `executeTool` 不传 `track`，外部命令默认不记修订；KnowWork patch 3 增加 `track: true` / `author` |
| web/嵌入 | 上游无 `GENOFFICE_WEB` / `--web-only`；需 KnowWork patch 1/2/4 |
| 安全 | 主窗口 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；control socket 只支持 open/selection |
| 构建 | Node ≥ 22.12、Rust xlsx sidecar、electron-builder；本机 Node 24.14，Rust 未安装 |

## Alternatives

### OnlyOffice Docs / Collabora Online

成熟、修订与协同能力强，但都是服务端文档服务：需要本地起 Document Server/协作服务，资源占用与部署复杂度高；OnlyOffice 社区版 AGPL、Collabora MPL 系，闭源分发需法务确认或商业授权；嵌入 Electron 侧边面板仍需额外窗口/协议适配。拒绝作为首选，保留为 GenOffice 嵌入失败时的候选。

### SuperDoc + Univer 组合

SuperDoc 覆盖 Word 编辑与修订，Univer 覆盖表格/幻灯片，许可证相对宽松、Web 原生。但三个编辑器三套 UI/状态模型，Word 修订、PPT 元素操作、字节保真保存需要分别验证；产品体验容易割裂。暂不作为首选，保留为 GenOffice 不可用时的备选。

### 本机 Microsoft Office / WPS 自动化

依赖用户已安装 Office，Windows 可用 COM、macOS 需 AppleScript/插件，跨平台不一致；嵌入对话旁边困难；企业环境版本差异大。拒绝。

### 从零自研编辑器

OOXML 解析、排版、公式、修订、渲染、保存保真度是无底洞，投入远超产品收益。拒绝。

### 独立窗口，不嵌入

实现成本最低，但用户仍要在对话和文档之间切换，无法做到「选中一段→AI 修改」的并排体验。拒绝作为目标形态，仅作为嵌入失败时的降级。

## Consequences

正面影响：

- 复用 Apache-2.0 的成熟办公套件，原生格式、修订、字节保真保存、CLI、MCP 都已具备。
- 桌面端不需要服务端容器，离线可用，符合产品定位。
- `DocumentEditService` 契约与编辑器内核解耦，未来换内核不影响对话/权限/文件服务。
- Word 修订由编辑器引擎生成，避免我们自研 OOXML 修订的兼容性风险。

代价与风险：

- 安装包体积增加（编辑器可能数百 MB）；需要按平台拆分或可选组件下载。
- GenOffice 是七个 Electron 应用 + Rust sidecar，构建链重；CI 需要缓存与分平台构建。
- web/embedded 与 MCP 修订依赖 KnowWork 补丁，必须跟随上游 rebase，存在维护成本；补丁缺失时嵌入或 AI 修订能力直接不可用。
- `ee/` 目录必须排除；商标必须替换；第三方 notices 必须随包分发。
- 构建需要 Rust（xlsx sidecar）与平台原生工具链；Windows 构建还需 MSVC/交叉编译环境，Windows 本机当前未安装 Rust。
- 文档内容不可信，编辑器 renderer 必须严格隔离，不能把文档脚本放进主 renderer。
- 复杂 Word 对象（脚注、域、SmartArt、OLE、宏）可能降级，需要明确提示与备份。

## Rollback

- 嵌入 spike 失败：先退回「独立编辑器窗口 + 只读预览」，`DocumentEditService` 与 AI 工具契约保留，后续换嵌入方式。
- GenOffice 构建/许可不可用：切换到 SuperDoc + Univer 或 OnlyOffice，`DocumentEditService` 契约不变。
- 任一阶段出现数据丢失风险：关闭编辑器入口，保留只读预览与 AI 离线修改；已写文件从版本快照/备份恢复。

## Evidence

- GenOffice `LICENSE`：Apache License 2.0。
- GenOffice `README.md`：原生格式、修订、CLI、MCP、`ee/` 例外、商标说明。
- GenOffice `apps/shell/src/main/mcp/mcp-server.ts`、`apps/docs/src/renderer/mcp-bridge.ts`：MCP 服务与外部编辑桥；后者默认不传 `track`。
- GenOffice `apps/docs/src/renderer/ai/ops.ts`、`apps/docs/src/renderer/editor/revisions.ts`：AI 修订与 `track`/author 机制。
- KnowWork `deploy/docker/office/`：web 模式与嵌入式运行补丁、MCP 门卫、容器运行方式（Apache-2.0，可参考）。
- 本仓库 `docs/ui/office-file-preview.md`：只读预览的边界与安全约束。
- 本仓库 `docs/product/product-capability-map-office-computer-use.md`：Office 解析/转换/保存/冲突应留在 Host Workbench Services，renderer 不直接接触 Node/LibreOffice/本地路径。
