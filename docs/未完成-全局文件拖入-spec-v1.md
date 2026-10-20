# 全局文件拖入 — spec v1

## 背景与现状核验（重要）

来源：Namiwork 的"从资源管理器全局拖入文件"。**核验后 Reactor 的实现程度比预期高**：

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 窗口级拖拽反馈 | **已有** | `prompt-editor/usePromptEditorDragState.ts` 监听 document `dragover`，`enableExternalFileDrop: true` |
| 对话区 drop 接收 | **已有** | `v4/SessionPane.tsx:4614-4616` 绑定 `dropTargetController` 的 onDragOver/onDragLeave/onDrop |
| 草稿头部 drop | **已有** | `WorkspaceShellLayout.tsx:1701` 把 `draftHeaderDropTargetController` 传给 `WorkspaceHeader` |
| OS 拖入文件解析为本地路径 | **已有** | `getPathForFile → getPathForFile`（`desktop/src/preload/index.ts:307`，`webUtils.getPathForFile`）；`useComposerAttachments.ts:686` 消费 |
| **workspace shell 空白区兜底** | **缺口** | shell 根容器未绑定 drop |

**真实缺口**：用户把外部文件拖到 workspace 的**非投递区**（侧栏空白、面板间隙、工具栏）时，
既不会加入附件，也可能触发 Electron 的默认行为（把文件当导航目标打开），造成窗口跳走/白屏。

## 产品规则

1. 在 workspace shell 根容器加 drop **兜底**，**不改变**任何已有投递面的行为：
   - 若事件已被内层投递面处理（`event.defaultPrevented === true`，SessionPane / header 已 preventDefault），
     根兜底直接返回，不重复处理；
   - 否则，对**外部文件拖入**（`dataTransfer.types` 含 `Files`）执行 `preventDefault`，
     阻止 Electron 默认导航，避免拖到空白区把窗口带走。
2. 兜底**不自行添加上传**：shell 层没有 composer 的附件通道，硬塞会造出第二条上传路径
   （违反"单一写入路径"）。因此兜底只做"安全拦截"，不做"隐式加附件"。
3. workspace 文件树拖拽（内部 payload）不受影响，仍走既有 `workspaceFilePayload` 分支。

## 状态所有者

- 无新增状态：兜底只读事件、只调用 `preventDefault`，不写 store、不建通道。

## 验收场景

- [ ] 从资源管理器拖文件到**对话区** → 行为与改动前完全一致（加入附件）。
- [ ] 从资源管理器拖文件到**侧栏/面板间隙** → 窗口不发生导航/白屏（被兜底拦截）。
- [ ] 拖 workspace 文件树节点 → 仍插入 mention，不受兜底影响。
- [ ] 拖拽过程中松手在空白区 → 无副作用、无报错。

## 遗留（如实记录）

- "拖到窗口任意位置都自动加入当前会话附件"未实现：需要一条从 shell 到
  ConversationComposer 附件状态机的通道，属架构改动；本期只做安全兜底。
- 图片/文件在 Desktop 用 `getPathForFile` 拿路径；Web 端仍走 bytes（无路径），不受本项影响。

## 验证口径

交互改动 → 全量 `pnpm typecheck` + `pnpm lint`。拖拽的 OS 级行为需真实运行验证，
本项以编译 + lint + 既有链路未被破坏为准，如实注明。
