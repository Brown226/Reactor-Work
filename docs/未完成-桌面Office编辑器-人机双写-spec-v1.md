# 桌面 Office 编辑器与人机双写

## Feature Summary


| 字段    | 内容                                                                          |
| ----- | --------------------------------------------------------------------------- |
| 变更    | 桌面端对话旁打开本机 Office 文件，人直接编辑；AI 修改同一份文件，Word 改动记成修订，冲突由人选择                    |
| 用户入口  | 工作区文件树、对话文件卡片、文件链接、`@file` 提及                                               |
| 编辑器内核 | GenOffice（Apache-2.0；`ee/` 目录除外），桌面端以本地子进程运行，Main 用 `WebContentsView` 承载    |
| 状态所有者 | 文件内容版本、编辑租约、备份与冲突归 `DocumentEditService`；编辑器缓冲区归编辑器进程；对话归现有 session/runtime |
| 范围外   | Web/多用户服务端容器版、实时多人协同、移动端编辑、跨设备同步、Office 宏与复杂对象全保真                           |


关联决策：[ADR-0005 桌面 Office 编辑器内核与嵌入方式](../adr/0005-desktop-office-editor-embedding.md)。

---

## 背景与目标

KnowWork v0.1.2 验证了「人机双写」的体验：对话和文档并排，人直接改同一份，AI 也改这一份，Word 改动记成修订、冲突由人拍板。Reactor 是桌面优先产品，文件本来就在用户工作区，编辑器可以随安装包分发，不需要服务端每人一个容器。因此复刻体验，但不复刻它的 Web 容器架构。

目标：

- **G1 同一份文件**：人、AI、外部程序看到的是工作区里的同一个文件，不产生「报告（1）」「报告（2）」。
- **G2 AI 改动可审查**：Word 的 AI 改动是修订，署名「用户名（AI）」，可逐条接受/拒绝；Excel/PPT 可撤销。
- **G3 冲突不静默**：AI 改过、人也有未保存改动时，必须由人选择保留哪一份。
- **G4 离线可用**：编辑、保存、转换、AI 工具调用默认不依赖外网；只允许模型调用出网。
- **G5 可回退**：编辑器打不开、崩溃或格式不支持时，退回只读预览，不阻塞对话。

---

## 非目标

- 不做 Web/多用户服务端容器版（每人一个编辑器容器、独立端口、网关按人转发）。
- 不做实时多人协同编辑（CRDT/OT）；同一文件同一时间只允许一个编辑器租约。
- 不保证 Word 复杂对象（脚注、域、SmartArt、嵌入 OLE、宏）完全保真；不支持时降级并提示。
- 不做移动端编辑；手机远控仍只读预览。
- 不接管 GenOffice 内置 AI 面板；产品只保留 Reactor 对话一个 AI 入口。

---

## 核心决策

1. **编辑器内核复用 GenOffice，不自研。**
  - 上游 Apache-2.0，`ee/` 目录为企业许可，构建时排除。
  - 上游已具备：原生 `.docx`/`.xlsx`/`.pptx` 读写、字节保真保存、修订与 diff、`genoffice docs compare` 生成 redline、CLI、MCP stdio/HTTP 服务。
  - 上游没有 web/嵌入式运行模式，外部 MCP 命令默认也不记修订；复用 KnowWork 的 Apache-2.0 补丁（web 模式、嵌入式运行、MCP `track`/`author`、host-owned AI），rebase 到锁定版本。**补丁是嵌入体验的硬依赖，不是可选优化。**
  - GenOffice 与 Genspark 名称/Logo 是 Mainfunc, Inc. 商标；Apache-2.0 不授予商标权，分发必须换品牌并移除其名称/Logo。
2. **桌面嵌入用 Main 管理的** `WebContentsView`**，编辑器跑本地子进程。**
  - 编辑器进程绑定 `127.0.0.1` 随机端口，独立 session partition；不复用主 renderer 的 iframe。
  - 文档属于不受信任内容；编辑器 renderer 禁止 Node、禁止导航/弹窗，外链走受控回调。
  - 复用 browser-use 的 view 创建、bounds 同步、焦点与销毁模式。
3. **唯一写入者是** `DocumentEditService`**（Host Workbench Services）。**
  - 编辑器保存、AI 修改、另存为、外部改动检测都经它落盘。
  - 按 `workspaceIdentity + 工作区相对路径` 加编辑租约；租约内只有一个写入者。
  - 保存采用「临时文件 + 原子替换」；写前保留备份。
4. **AI 修改分两条路。**
  - 文档开着：走 GenOffice 的 HTTP MCP 会话工具（`create_session` / `read_document` / `replace_blocks` / `apply_ops` / `save_session`），调用带 `track: true` + `author`，改动实时出现在编辑器里，Word 记修订。上游 MCP bridge 默认直接改文档、不生成修订，`track`/`author` 依赖 KnowWork 补丁 3。
  - 文档没开：走 `genoffice docs read/apply/compare` 或我们的 OOXML 工具离线修改，生成修订后原子写回；下一轮对话与预览看到新版本。
5. **选区→对话用结构化位置。**
  - Word：块索引 + 稳定锚点/文本哈希；Excel：工作表名 + A1 区域；PPT：页索引 + 元素 ID。
  - 发送时带上文件 `@路径`、位置、选中原文；复用现有输入框/队列/草稿链路，不另造聊天。
6. **冲突显式交给用户。**
  - 发下一句前自动保存编辑器未保存改动。
  - 轮末检测「AI 改过 + 人有未保存」→ 提示「载入 AI 改过的版本 / 保留我的」。
  - 编辑器崩溃、关闭或空闲回收前先落备份；重开时提示恢复。

---

## 状态所有权与事件顺序


| 状态 / 事实            | 展示 owner     | 权威 owner              | 持久化             |
| ------------------ | ------------ | --------------------- | --------------- |
| 编辑器内文档缓冲区、未保存改动    | 编辑器 renderer | 编辑器子进程                | 进程内；关闭/崩溃前备份到本地 |
| 文件内容、版本号、内容哈希      | 对话文件卡片 / 文件树 | `DocumentEditService` | 工作区文件 + 本地版本快照  |
| 编辑租约、打开会话          | 侧边面板 tab     | `DocumentEditService` | 进程内 + 本地租约文件    |
| 冲突状态（AI 改过 / 人未保存） | 编辑器上方提示      | `DocumentEditService` | 进程内；事件驱动        |
| AI 修改操作与幂等键        | 工具卡片 / 运行详情  | `DocumentEditService` | 本地操作日志（可清理）     |
| 对话、轮次、消息           | 对话时间线        | 现有 session/runtime    | 现有存储            |
| 选区、编辑器 UI 状态       | 编辑器 renderer | 编辑器 renderer          | 不落业务库           |
| 侧边面板 tab、布局        | 现有 UI store  | 现有 UI store           | 现有持久化           |


事件顺序（打开 → 人改 → AI 改 → 保存）：

```text
用户打开文件
  → DocumentEditService.open()
  → 获取租约、记录基线版本/哈希、写备份
  → 启动/复用编辑器进程，把文件副本放入编辑器工作目录
  → 返回 editorUrl + sessionId + version
  → Main 创建/复用 WebContentsView，加载 editorUrl

人编辑
  → 编辑器缓冲区变脏
  → 定时自动保存 / 手动保存
  → DocumentEditService.save(sessionId, expectedVersion)
  → 版本冲突？→ 返回 conflict，不写盘
  → 无冲突 → 原子写盘、生成版本快照、通知文件树/对话卡片

AI 修改
  → 工具调用带 turnId + callId
  → 文档开着：DocumentEditService.applyAiEdit() 经编辑器 MCP 修改
  → 文档没开：离线 OOXML/GenOffice CLI 修改后原子写盘
  → 记录 author、位置、diff 摘要、版本号
  → 返回 changed / diff / version

轮末
  → DocumentEditService.changes(sessionId)
  → AI 改过且人未保存 → 冲突提示
  → 人选择：载入 AI 版本（discardEdits + reload）或保留我的
  → 人选择后清除冲突，回到可继续状态

关闭 / 崩溃 / 回收
  → 先落未保存备份
  → 释放租约
  → 重开时提示恢复备份
```

---

## 接口契约

### DocumentEditService

```ts
interface DocumentEditService {
  open(input: {
    workspaceIdentity: string;
    workspacePath: string;
    filePath: string; // 工作区相对路径，posix
  }): Promise<{ sessionId: string; leaseId: string; editorUrl: string; version: string }>;

  close(sessionId: string): Promise<void>;

  save(input: {
    sessionId: string;
    expectedVersion: string;
    bytes?: Uint8Array; // 不传时由编辑器进程导出当前缓冲区
  }): Promise<{ version: string; conflict?: 'external' | 'stale' }>;

  applyAiEdit(input: {
    sessionId: string;
    operations: DocumentOperation[];
    idempotencyKey: string; // turnId + callId
    author: string; // 展示名；Word 写成「名字（AI）」
  }): Promise<{ changed: boolean; diff: DocumentDiff; version: string }>;

  selection(sessionId: string): Promise<SelectionRef | null>;

  changes(sessionId: string): Promise<{ changed: boolean; unsaved: boolean; diskVersion: string }>;

  discardEdits(sessionId: string): Promise<void>;

  recover(sessionId: string): Promise<{ backupPath: string; savedAt: string } | null>;
}
```

约束：

- `filePath` 必须是工作区相对 posix 路径；拒绝绝对路径、`..`、符号链接逃逸、附件只读目录。
- `expectedVersion` 不匹配时返回 `conflict: 'stale'`，不写盘；磁盘哈希变了返回 `conflict: 'external'`。
- `applyAiEdit` 幂等：同 `idempotencyKey` + 同操作返回上次结果；同键不同操作拒绝。
- 所有写盘原子：同目录临时文件 + `rename`；保留最近 N 个版本快照（N 可配置，默认 20）。
- 备份目录与版本快照不进入工作区可见文件树，放在应用数据目录。

### 编辑器 bridge 消息

```ts
type EditorMessage =
  | { type: 'editor:ready' }
  | { type: 'editor:saved'; version: string }
  | { type: 'editor:disconnected'; reason?: string }
  | {
      type: 'editor:selection';
      text: string;
      word?: { blockStart: number; blockEnd: number; anchor?: string };
      sheet?: { name: string; range: string };
      slide?: { index: number; elements: string[] };
    }
  | { type: 'editor:ai-busy'; ranges?: BusyRange[]; cells?: BusyCell; slide?: BusySlide }
  | { type: 'editor:agent-edited' };

type HostMessage =
  | { type: 'host:ai-busy'; ranges?: BusyRange[]; cells?: BusyCell; slide?: BusySlide }
  | { type: 'host:reload' }
  | { type: 'host:discard-edits' }
  | { type: 'host:save'; requestId: string };
```

约束：

- 只接受来自当前 `WebContentsView` 且 origin 匹配的消息；形状不符丢弃。
- 位置以稳定 ID/锚点优先，索引只作提示；索引失效时回退文本匹配。
- `editor:agent-edited` 在 AI 改动真正落进文档后发送；UI 收到后立即收掉「AI 正在改」标记。

### AI 工具

```ts
interface DocumentOperation {
  kind: 'replace' | 'insert' | 'delete' | 'format';
  target: SelectionRef;
  content?: string;
  format?: Record<string, unknown>;
  tracked?: boolean; // Word 默认 true
}
```

- `docx_tracked_edit`：按段落/选区插入、删除、替换；生成 `w:ins` / `w:del` / `w:delText`，作者 `displayName（AI）`，日期 ISO。
- `xlsx_edit_range`：按工作表/区域读写、公式重算；一次 AI 批量算一步撤销。
- `pptx_edit_elements`：按页/元素改文本、位置、样式；一次批量算一步撤销。
- 工具输出统一带 `changed`、`diff`、`author`、`version`；供 UI 展示与审计。
- AI 文档写入属于现有工具权限体系：遵守当前 permission mode、审批与命令/路径限制；不新增绕过通道。

---

## 边界决策


| 边界           | 决策                                                                          | 原因                                               |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------ |
| 编辑器内核        | GenOffice，构建排除 `ee/`，换品牌                                                    | Apache-2.0 可商用；上游已有原生格式、修订、CLI、MCP；`ee/` 与企业商标除外 |
| 编辑器 web 模式   | 复用 KnowWork web/embedded 补丁并 rebase；不自己改 shell                              | 上游没有 web/嵌入模式；补丁已在 KnowWork 验证可嵌入                |
| MCP 修订       | 调用带 `track: true` + `author`；依赖 KnowWork 补丁 3                               | 上游 MCP bridge 默认直接改文档，不生成修订                      |
| 嵌入方式         | Main 管理 `WebContentsView` + 本地子进程 + 独立 partition                            | 文档不可信，必须与主 renderer 隔离；复用已有 view 管理              |
| 文件写入         | 只有 `DocumentEditService` 写盘                                                 | 避免编辑器、AI、文件树多写入路径；租约/版本/冲突只有一个 owner             |
| AI 修改打开文档    | 走编辑器 HTTP MCP 会话工具                                                          | 改动实时可见，Word 修订由编辑器引擎生成                           |
| AI 修改未开文档    | 走 GenOffice CLI/OOXML 离线修改                                                  | 不要求编辑器常开；下一轮预览/对话看到新版本                           |
| Word 修订作者    | `displayName（AI）`；日期用当前时区 ISO                                               | 人和 AI 的改动可区分，可逐条接受/拒绝                            |
| Excel/PPT    | 不生成修订；一次 AI 批量一步撤销，保留 diff 日志                                               | 两类格式没有统一的修订模型；撤销 + 日志是可用折中                       |
| 冲突           | 只做打开、保存、轮末三个检查点；不自动合并                                                       | 实时协同成本高；显式选择更安全                                  |
| 只读预览         | 编辑器打不开、格式不支持、远程/移动端时回退只读预览                                                  | 保持现有能力，不阻塞对话                                     |
| 远程 workspace | 本期只支持本地 workspace；SSH/WSL/Docker/Web 回退只读预览                                 | 远程文件 IO 与子进程边界不同，另立项                             |
| 编辑器内置 AI     | 隐藏/禁用；所有 AI 走 Reactor 对话                                                    | 避免两个 AI 入口、两套上下文与权限                              |
| 包体积          | 按平台拆分；Phase 0 实测后决定随包还是可选组件下载                                               | 编辑器可能数百 MB，不能无脑塞进安装包                             |
| 品牌           | 分发内移除 GenOffice/Genspark 名称与 Logo；保留 Apache-2.0 LICENSE/NOTICE 与第三方 notices | 商标条款要求 forks 使用自己的品牌                             |


---

## Domain Scope


| Domain                      | 是否包含 | 说明                                |
| --------------------------- | ---- | --------------------------------- |
| Desktop main / host         | 是    | 编辑器子进程、`WebContentsView`、IPC、崩溃恢复 |
| UI shell / side pane / i18n | 是    | 编辑器 tab、并排布局、冲突提示、中英文文案           |
| File / workspace service    | 是    | 工作区相对路径、租约、版本、原子写、备份              |
| Permission / approval       | 是    | AI 文档写入遵守现有权限模式；人工编辑不额外审批         |
| Document toolchain          | 是    | GenOffice CLI/MCP、OOXML 工具、格式转换   |
| Packaging / third-party     | 是    | 按平台打包、许可证 notices、体积预算            |
| Session / realtime protocol | 部分   | 选区→对话复用现有输入链路；不新增会话实时状态           |
| Web / remote runtime        | 否    | 本期只读预览；服务端容器版另立项                  |
| Mobile                      | 否    | 手机远控保持只读                          |


---

## Candidate Combinations


| ID    | 文件 / 环境                | 操作           | 预期结果                             | 状态       |
| ----- | ---------------------- | ------------ | -------------------------------- | -------- |
| DE-01 | 本地 `.docx`             | 从文件树打开       | 编辑器 tab 打开；对话与编辑器并排；文件未被复制到工作区外  | accepted |
| DE-02 | 本地 `.xlsx` / `.pptx`   | 从文件树打开       | 对应编辑器打开；可切换 sheet / 页            | accepted |
| DE-03 | 已打开的 `.docx`           | 人编辑并保存       | 工作区文件更新；版本递增；对话文件卡片看到新版本         | accepted |
| DE-04 | 已打开的 `.docx`           | 选中一段 → AI 修改 | 选中内容、位置、`@文件`进入输入框；AI 改动实时出现在编辑器 | accepted |
| DE-05 | 已打开的 `.docx`           | AI 修改        | 改动是修订，作者「用户名（AI）」；可接受/拒绝         | accepted |
| DE-06 | 已打开的 `.xlsx` / `.pptx` | AI 修改        | 区域/元素正确修改；一次批量一步撤销               | accepted |
| DE-07 | 人有未保存改动 + AI 改了同一文件    | 轮末           | 提示「载入 AI 改过的版本 / 保留我的」；不静默覆盖     | accepted |
| DE-08 | 文件被外部程序修改              | 编辑器开着        | 提示重载/冲突；本地未保存不丢                  | accepted |
| DE-09 | 编辑器崩溃 / 被结束            | 重新打开         | 提示恢复备份；恢复后内容与崩溃前一致               | accepted |
| DE-10 | 文档未打开                  | AI 修改        | 离线 OOXML/CLI 修改；生成修订；预览可见        | accepted |
| DE-11 | 工作区外路径 / `..` / 符号链接逃逸 | 打开           | 拒绝，不读不写                          | accepted |
| DE-12 | 远程 workspace / 手机远控    | 打开 Office 文件 | 回退只读预览                           | accepted |
| DE-13 | 同一文件重复打开               | 再次打开         | 聚焦已有编辑器 tab，不创建第二个租约             | accepted |
| DE-14 | 多人同时打开同一文件（同机不同窗口）     | 打开           | 第二个打开者只读或提示已被占用；不产生双写            | accepted |
| DE-15 | 实时多人协同编辑               | —            | 不提供                              | pruned   |
| DE-16 | Web/服务端每人容器            | —            | 不提供                              | pruned   |
| DE-17 | 宏、OLE、SmartArt、域等复杂对象  | 打开/保存        | 不支持时降级并提示；不静默丢内容                 | accepted |


---

## Accepted Cases


| Case ID | Setup                        | Action      | Assertions                                   | Evidence | 自动化状态   |
| ------- | ---------------------------- | ----------- | -------------------------------------------- | -------- | ------- |
| DE-01   | 本地工作区含 `报告.docx`             | 文件树打开       | 编辑器 tab 出现；对话仍在左侧；路径严格相对化；无工作区外副本            | 待实现      | planned |
| DE-03   | 编辑器已打开 `报告.docx`             | 输入文字并保存     | 文件字节更新；版本号递增；文件树/对话卡片刷新；备份存在                 | 待实现      | planned |
| DE-04   | 编辑器已打开，选中一段                  | 点「AI 修改」并发送 | 输入框出现 `@报告.docx` + 位置 + 引用原文；发送后该段显示「AI 正在改」 | 待实现      | planned |
| DE-05   | AI 完成修改                      | 打开修订窗格      | 修订作者为「用户名（AI）」；接受/拒绝逐条生效；拒绝后原文恢复             | 待实现      | planned |
| DE-06   | 已打开 `.xlsx`                  | AI 改一片区域    | 单元格值与公式正确；一次批量一步撤销；diff 日志可查                 | 待实现      | planned |
| DE-07   | 人改未保存，AI 也改了                 | 轮末          | 出现冲突提示；选「保留我的」不丢本地；选「载入 AI 版本」重载后显示 AI 修订    | 待实现      | planned |
| DE-08   | 编辑器开着，外部程序改文件                | 等待/保存       | 提示外部改动；不静默覆盖；可选重载或另存                         | 待实现      | planned |
| DE-09   | 编辑器崩溃                        | 重开文件        | 恢复备份提示；恢复后内容一致；租约释放                          | 待实现      | planned |
| DE-10   | 文档未打开                        | AI 改文件      | 离线修改成功；Word 生成修订；预览/下一轮看到新版本                 | 待实现      | planned |
| DE-11   | 路径为 `../secret.docx` 或符号链接逃逸 | 打开          | 拒绝并提示；不读不写                                   | 待实现      | planned |
| DE-13   | 同一文件已打开                      | 从文件树再次打开    | 聚焦已有 tab；租约数仍为 1                             | 待实现      | planned |
| DE-14   | 同机第二个窗口打开同一文件                | 打开          | 第二个窗口只读或提示占用；不产生第二个写租约                       | 待实现      | planned |


---

## Implementation Contract

- 编辑器 renderer 必须运行在独立 `WebContentsView`/session partition：`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；禁止 `window.open`、导航到非编辑器 origin、下载与文件选择器。
- 文档内链先走白名单（`http:`/`https:`/校验过的 `#anchor`）；其余协议拒绝。外链走受控回调，不直接交给 `shell.openExternal`。
- Renderer 不得直接读写文件、不得引用 Node/LibreOffice/本地绝对路径；所有文件操作经 `DocumentEditService` 与 `IPlatformService`。
- `DocumentEditService` 是唯一写入者；编辑器保存、AI 修改、另存为、外部改动检测共用同一租约与版本校验。
- 所有写盘原子；写前备份；版本快照数量与保留期可配置；备份/快照目录不进入工作区文件树。
- 路径必须严格工作区相对化；拒绝绝对路径、`..`、符号链接逃逸、附件只读目录。
- AI 修改必须带 `turnId + callId` 幂等键；同键不同操作拒绝；重复调用返回上次结果。
- Word 修订使用 `w:ins`/`w:del`/`w:delText`，作者 `displayName（AI）`，日期 ISO；人工编辑作者为 `displayName`。
- Excel/PPT 不做修订；一次 AI 批量一步撤销，保留 diff 日志。
- 同一文件同一时间只有一个写租约；第二个打开者只读或提示占用。
- 编辑器内置 AI 入口隐藏/禁用；所有 AI 交互走 Reactor 对话，避免双 AI 上下文与双权限。
- 文件树、对话文件卡片、预览在保存后刷新；不要求用户手动重开。
- 编辑器崩溃/关闭/空闲回收前先落备份；恢复失败时保留备份并提示路径。
- UI 文案中英文；主题遵守 `DESIGN.md`；日志使用 `packages/ui/src/logger.ts` 或对应服务 logger，不使用 `console`。
- 分发物保留 Apache-2.0 LICENSE/NOTICE 与第三方 notices；移除 GenOffice/Genspark 名称与 Logo；排除 `ee/`。

---

## Verification

- Desktop E2E：`packages/desktop/test/e2e/ui-shell/panels/document-editor-open-save.test.ts`、`.../document-editor-dual-write.test.ts`；新交互先在 `manual-review/pending` 跑，人工评审后转正。
- 手动运行时：`pnpm dev:desktop:test` 走 DE-01/03/04/05/07/09/11。
- 打包：`pnpm bundle:desktop`；检查 `Resources/THIRD-PARTY-NOTICES.md`、LICENSE/NOTICE、安装包体积。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；涉及 React 组件/hooks 时复核 `react/exhaustive-deps` 与 `react/rules-of-hooks`。
- 安全：编辑器 renderer 的 Node/导航/弹窗/外链/文件选择器负向用例必须覆盖；文档内恶意链接不得进入主 renderer。
- 跨平台：Windows 先跑通，macOS 跟进，Linux 记录依赖（xvfb/字体）与已知限制。

---

## 分期


| 阶段  | 交付                                         | 退出门禁                       |
| --- | ------------------------------------------ | -------------------------- |
| P0  | 本 spec + ADR + GenOffice 构建/嵌入/修订/体积验证     | 许可证通过（已完成）；嵌入与修订 spike 通过  |
| P1  | `DocumentEditService` + 租约/版本/备份/冲突 + 模块注册 | 服务契约与 E2E 骨架通过             |
| P2  | 编辑器宿主 + 侧边面板 tab + 打开/保存/崩溃恢复              | DE-01/02/03/09/11/13/14 通过 |
| P3  | AI 编辑桥 + Word 修订 + Excel/PPT 工具 + 选区→对话    | DE-04/05/06/10 通过          |
| P4  | 双写冲突 + 轮末重载 + 自动保存 + 审计                    | DE-07/08 通过                |
| P5  | 打包、跨平台、E2E 转正、文档                           | 安装包与 notices 通过；正式 E2E 绿   |


---

## 风险与回退


| 风险                | 影响                        | 回退 / 缓解                                            |
| ----------------- | ------------------------- | -------------------------------------------------- |
| GenOffice 嵌入模式不可用 | 无法并排编辑                    | 复用 KnowWork 的 web/embedded 补丁（Apache-2.0）；或先独立窗口运行 |
| 包体积过大             | 安装包膨胀                     | 按平台拆分；可选组件下载；体积预算门禁                                |
| 修订保真度不足           | 复杂文档丢格式                   | 先支持正文/表格/批注；复杂对象降级并提示；保留原文件备份                      |
| 冲突语义复杂            | 用户数据丢失                    | 只做三个检查点；永不静默覆盖；写前备份                                |
| 跨平台差异             | Windows/macOS/Linux 行为不一致 | Windows 先交付；平台专属用例；Linux 记录依赖                      |
| 第三方升级             | 补丁漂移、回归                   | 锁定版本 + 补丁清单；升级独立验证；不自动跟随上游                         |
| 商标/许可             | 分发合规风险                    | 换品牌；排除 `ee/`；保留 LICENSE/NOTICE；法务复核                |


---

## 待决问题

1. 编辑器随包分发还是首次使用时下载？依赖 Phase 0 实测体积与目标客户离线要求。
2. 首批平台是否只做 Windows？建议 Windows 先行，macOS 紧随，Linux 按客户需求。
3. GenOffice 的 web/embedded 补丁集最小范围：只保留 web 模式 + host-owned AI，还是也保留 MCP 外部 Agent 补丁（上游已有 MCP 时可去掉）。
4. 版本快照保留策略与磁盘配额：默认 20 个/文件是否需要按文件大小动态调整。
5. 远程 workspace 的后续方案：SSH/WSL/Docker 下是否允许编辑器在远端运行，需另立 spec。

---

## Phase 0 结论（2026-11-21）

- GenOffice 上游许可证：**Apache-2.0**；`ee/` 目录为企业许可，构建排除。
- 商标：GenOffice/Genspark 名称与 Logo 为 Mainfunc, Inc. 商标；分发须换品牌。
- 上游能力：原生 `.docx`/`.xlsx`/`.pptx`、字节保真保存、修订/diff、`docs compare` redline、CLI、MCP stdio/HTTP（可见编辑器会话工具）。
- 上游缺口：没有 web/嵌入式运行模式；`apps/docs/src/renderer/mcp-bridge.ts` 调用 `executeTool` 时不传 `track`，外部 MCP 命令默认不生成修订。
- 补丁依赖：KnowWork 补丁 3 已提供 `track: true` / `author`（可在 Track Changes 关闭时强制记修订）；补丁 1/2/4 提供 web 模式、嵌入式运行、host-owned AI。补丁均为 Apache-2.0，需 rebase 到锁定版本。
- 本机环境：Node 24.14 可用；Rust 未安装。GenOffice 构建需要 Rust + 平台原生工具链，构建 spike 应在专用环境或 CI 执行。
- 首次 Docker 构建（KnowWork Dockerfile）失败：卡在 Docker Hub 拉取 `node:24.18.0-bookworm` 镜像层，exit code 1，未生成镜像；待镜像源/CI 重试。
- 结论：**许可证门禁通过；嵌入与修订 spike 的技术路径已明确，但尚未执行构建验证**。下一步验证补丁 rebase、WebContentsView 嵌入、包体积与复杂文档保真度。

&nbsp;