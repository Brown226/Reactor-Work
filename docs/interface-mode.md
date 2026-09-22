# 界面模式（编程 / 办公 / 审查）契约

覆盖 `interfaceMode` 这一产品设置：谁拥有状态、有哪些入口、主面板入口的显示规则与验收场景。
改界面模式相关代码前先读本文；跨目录复用分段控件时也要同步更新第 3 节。
「审查」档位的产品目标（审查类型、Skill、知识库、结果展示）见 [审查板块-方案-v1.md](审查板块-方案-v1.md)。

## 1. 状态所有者

| 项         | 值                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------- |
| 所有者     | `packages/ui/src/store/index.ts` 的 `interfaceMode` 字段                                 |
| 唯一写入口 | `setInterfaceMode(mode)`；内部先 `normalizeInterfaceMode`，再写 `set({ interfaceMode })` |
| 持久化     | localStorage `zcode-interface-mode`（`INTERFACE_MODE_STORAGE_KEY`）                      |
| 取值       | `"coding"` / `"office"` / `"review"`，默认 `"coding"`                                    |
| 旧值迁移   | localStorage 里的 `"general"` / `"concise"` 归一为 `"office"`，其余未知值一律 `"coding"` |

没有第二份状态，也没有服务端事实：任何入口都只读同一个字段、只调同一个 setter。
派生 hook（`hooks/useInterfaceMode.ts`）是只读投影，供展示层判断当前档位：

| hook                 | 语义                            | 用途                                         | 现状     |
| -------------------- | ------------------------------- | -------------------------------------------- | -------- |
| `useIsOfficeMode()`  | `interfaceMode === "office"`    | **仅**办公档独有的行为，不要当成收敛判据     | 已实现   |
| `useIsFocusedMode()` | `office \|\| review`            | **收敛判据**：隐藏终端 / git / 命令详情等     | 已实现   |
| `useIsReviewMode()`  | `interfaceMode === "review"`    | 审查档独有的行为（审查类型卡片等）           | 已实现   |

`office` 与 `review` 都不等于 `coding`，且**两者都要求收纳编程向 UI**；把 `isOfficeMode`
继续当作收敛判据会让审查档漏掉每一处隐藏逻辑，因此新增 `isFocusedMode` 并在第 5 节逐文件列出归属。

**引导子集类型**：`InterfaceMode` 为三值，但首次引导只能记两值，故另有
`OnboardingInterfaceMode = "office" | "coding"` 与收窄函数 `toOnboardingInterfaceMode()`
（`lib/interfaceMode.ts`）。审查档按展示语义最近原则收窄为 `office`，**不扩宽服务端引导 schema**。

## 2. 入口

| 入口           | 位置                                             | 形态         | 说明                                       |
| -------------- | ------------------------------------------------ | ------------ | ------------------------------------------ |
| 主面板（唯一） | `v4/DraftInterfaceModeToggle.tsx`                | 胶囊分段切换 | 见第 4 节；三档                       |
| 首次引导       | `onboarding/OccupationOnboarding.tsx`            | 单选         | **保持两档**（只有编程/办公，见下）；不写就沿用当前值 |
| 快捷键（遗留） | `shared/shortcutCommands.ts` 的 `toggleInterfaceMode` | CmdOrCtrl+Shift+U | 已注册但**无执行侧**，按下不生效，不作为可用入口 |

**首次引导刻意只有两档**：引导是产品定位问题（「你希望怎么用」），不是档位选择器；把
「审查」塞进引导会让一次性问卷承担功能导航的职责。审查档只能从主面板胶囊进入，不选即成
`coding`。因此 `shared/onboardingRecord.ts` 的 `onboardingInterfaceModeSchema` **继续保持
`z.enum(["coding","office"]).nullable()` 不扩**——这是有意不对称，不要「顺手补齐」。

**设置页的「界面模式」行与账户菜单的「界面模式」子菜单已于 2026-09-22 删除**：主面板已有显式入口，
两处设置入口与它重复，只会让用户以为存在两份状态。新增相关设置项时不要再引回第二个交互入口。

所有入口写入同一字段，互相同步；不存在"主面板这份是临时预览"之类的局部覆盖。

## 3. 分段控件的唯一实现

`components/ui/segmented-tabs.tsx` 的 `SegmentedTabs` 是全应用胶囊分段切换的唯一实现
（原 `settings/SettingsSegmentedTabs.tsx`，因主面板也要用同款而上移）。新增同层级的分段切换
一律复用它，不要再用 Tabs 手搓第二套视觉。

尺寸只有两档，选中态是同一套"亮面胶囊"，不因尺寸引入第二种选中语言：

| size         | 用途                                       | 控件高度                  |
| ------------ | ------------------------------------------ | ------------------------- |
| `sm`（默认） | 其它设置详情页的密集分段（MCP / 自动化 / 保存的工作流 / 用量） | 32px（档位 28px） |
| `lg`         | 主面板入口这类需要一眼看见、容易点到的位置 | 44px（档位 36px，含投影） |

界面模式本身已不再出现在设置详情页，`sm` 档留给其它分段场景。

## 4. 主面板入口的显示规则

- 只在草稿态空态显示：与 `ConversationDraftEmptyState`（问候语）同属 timeline 的 `emptyState` 节点，
  排在问候语之后、composer dock 之前。
- 会话一旦产生消息（`renderUnits.length > 0`）即随空态一起消失，不与工具输出、终端争注意力。
- 桌面与手机远控共用同一个 `SessionPane`，因此两端显示同一组件，不按平台分叉。
- 图标复用 `onboarding/occupationOptions.ts` 的 `modeOptionIcons`，保证同一模式在全应用只有一套视觉标识。
  三档分别对应 `coding: Code2` / `office: PanelsTopLeft` / `review: ShieldCheck`。
- 文案复用 `settings.interfaceMode.coding` / `.office` / `.review`，不新增同义词。
- 用 `size="lg"`（见第 3 节），与设置页的 `sm` 区分：主面板是入口，不是密集设置项。
- 三个档位必须同宽或等宽分布，不得因新增一档让胶囊在窄窗口里溢出（`SegmentedTabs` 的 trigger 是
  `flex-none`，按内容宽度自适应）。

**命名冲突（已决策）**：`sidePane.review` 原本指 **Git 变更审查**，与审查档语义冲突。已决定
**Git 那侧改名「变更审查」**（新增 `sidePane.changes`，废弃 `sidePane.review` 的 Git 用途），
把 `review` 语义让给本契约的审查档。实施要点（涉及 launcher item id、`hasReviewTab`、
`onOpenReviewTab`、命令 `add-review-tab`、`supportsReview` 五处改名）见
[审查板块-方案-v1.md](审查板块-方案-v1.md) §8.1。

## 5. 收敛判据（强收敛）

审查档与办公档都要求**收纳编程向 UI**，因此展示层判据拆成三条（`hooks/useInterfaceMode.ts`）：

- `useIsFocusedMode()` = `office || review` —— 收敛判据，用于「隐藏终端 / git / 命令详情 / diff」。
- `useIsOfficeMode()` = `office` —— **仅**办公档独有行为（插件推荐排序、主动推荐开关、办公问候语等）。
- `useIsReviewMode()` = `review` —— 审查档独有行为（审查类型卡片等）。

改动纪律：**原 `isOfficeMode` 分支必须逐个归类，不许整批替换**。整批替换会把「办公档独有的推荐
排序」错误地套到审查档上。逐文件归属如下（grep 口径：`isOfficeMode` / `useIsOfficeMode`，
排除 node_modules / dist / out，共命中 **27 个文件**＝26 个消费文件 + 1 个定义文件
`hooks/useInterfaceMode.ts`）。**下表的归属已按此实现**（2026-09-22）：

| 归属                        | 文件                                                                                                             | 说明 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---- |
| 改 `isFocusedMode`（收敛）  | `App.tsx`（`supportsTerminal` / `supportsChanges`）、`quickpick/quickPickCommands.ts`（`supportsChanges`）、`Terminal.tsx`、`WorkspaceTerminalToggleButton.tsx`、`hooks/useAppPanels.ts`（6 处守卫）、`app-shell/AnimatedSidePanePanel.tsx`（菜单 + launcher 过滤 + `hasChangesTab`）、`app-shell/WorkspaceShellLayout.tsx`（抑制 `GitBranchSwitcher`）、`WorkspaceEditorButtonGroup.tsx`、`quickpick/TaskFindDialog.tsx`、`v4/conversationStatusPanelModel.ts`（`isFocusedMode` 入参）、`v4/ConversationStatusPanel.tsx`、`v4/ConversationTurnGroup.tsx`、`v4/ConversationRowView.tsx`、`v4/SessionPane.tsx`（状态面板模型）、`ToolCallBlocks.tsx`、`ToolCallBlocks/fileSummaryTypes.ts`、`ToolCallBlocks/renderers/{execute,execute-group,changes-group,edit}.tsx` | 审查档下这些全部隐藏 |
| 保持 `isOfficeMode`（办公独有） | `WorkspacePluginPreview.tsx`、`mentions/providers/pluginsMentionProvider.ts`、`settings/PluginStoreListView.tsx`、`settings/ProactiveSuggestionsSetting.tsx`、`app-shell/WorkspaceShellLayout.tsx`（插件预览位）、`v4/ConversationDraftEmptyState.tsx`（办公问候语分支）、`v4/SessionPane.tsx`（推荐容器的显示条件 / `proactive` / 间距） | 审查档另有自己的入口，不套办公的推荐池 |
| 按档位三分（已新增分支）    | `v4/ConversationDraftEmptyState.tsx`（`chat.empty.greeting.review`）、`v4/featureSuggestedPrompts.ts`（`mode: "review"` 类型卡片池 + `getRecommendedPromptPool(mode)`）、`v4/featureSuggestedPromptRotation.ts`（`RecommendedPromptMode` 三值）、`v4/ConversationDraftSuggestedPromptsContainer.tsx`（审查档走固定菜单、不注册轮换 pane）、`v4/SessionPane.tsx`（`isReviewMode` 无条件显示审查类型卡片） | 审查档显示审查类型卡片而非推荐语料 |

**`v4/ConversationDraftEmptyState.tsx` 与 `v4/SessionPane.tsx` 同时出现在两行是刻意的**：这两个文件里
既有收敛/办公独有分支，也有三分分支，实现时按分支逐个归类，未整文件替换。

> `treemapping` 与本契约无关：它始终从侧边栏隐藏，不由档位决定（见 `hooks/useAppPanels.ts:755`）。

## 6. 主面板问候语的称呼（相关，非模式契约）

同一个 `emptyState` 里的问候语在句首带上登录用户名（`chat.empty.greeting.withName` = `{name}，{greeting}`）：

- 取名字的优先级与侧边栏页脚一致：ZCode 账号 `user.displayName` → `user.username` → 企业登录 `useReactorServer().status.user.name`。
- 两处都未登录时不加称呼，保持原问候语，不出现空称呼或"null"。
- 拉长后的问候语仍走既有的自适应字号逻辑（20–30px），不额外截断。

## 7. 验收场景

1. 主面板点「办公模式」：胶囊高亮切换；首次引导若已记录偏好，进入应用时落在同一模式（同一份状态）。
2. 刷新或重启后选择保持（localStorage 已写入 `zcode-interface-mode`）。
3. 设置页「常规」分区与左下角账户菜单里都**不再出现**界面模式选项，只有主面板胶囊能改它。
4. 快捷键 `CmdOrCtrl+Shift+U` 当前无执行侧（见第 2 节遗留说明），不作为验收项。
5. 会话进行中主面板不出现该胶囊；切回空草稿首页时重新出现。
6. 从旧版本升级（localStorage 存 `"general"` / `"concise"`）的用户仍然落在办公模式，不被重置为编程模式。
7. 已登录时问候语形如「田科达，今天有什么工作，交给我吧」；未登录时退回「今天有什么工作，交给我吧」。
8. 胶囊出现三档；点「审查」后高亮第三档，刷新后仍停在审查档。
9. 审查档下草稿空态显示**审查类型卡片**，不显示编程/办公的推荐语料；切回办公档恢复推荐语料。
10. 审查档下 git 面板、终端、命令详情、代码 diff 均不出现；切回编程档全部恢复（对应第 5 节逐文件归属）。
11. 首次引导仍只出现「编程 / 办公」两项；在引导里选完后，若再切到审查档，重启后落在审查档
    （引导不记录 review，但主面板写入的 `review` 不被引导覆盖）。
12. 办公档的现有行为零回归：插件推荐排序、主动推荐开关、办公问候语均不受 `isFocusedMode` 引入影响。
13. 审查档问候语为「把文件交给我来审」（`chat.empty.greeting.review`），句首同样带登录用户名。
14. 审查类型卡片固定显示全部 5 类（基础校对 / 全文一致性 / 以文审文 / 合同风险 / 标准引用自检），
    **不受办公档「主动推荐」开关影响，也没有「换一批」**（它是菜单，不是推荐池）。
15. 点任一审查类型卡片 → 提示词填入输入框（不自动发送）；用户可再补一句或直接发送。
16. 用户停在审查档时打开首次引导：引导内不出现第三档；引导保存后不把审查档改写为办公室档。

## 8. 实现状态（2026-09-22）

**已落地**（经 `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 三项通过）：

- 三档 `interfaceMode` + 归一化 + 跨窗口广播白名单扩到 `review`。
- 三个派生 hook（`useIsOfficeMode` / `useIsFocusedMode` / `useIsReviewMode`）。
- 主面板胶囊三档 + `FileSearch2` 图标 + 中英文案。
- 第 5 节收敛归属表**全量实现**。
- 审查类型卡片（5 类）+ 预填 + 审查档问候语。
- Git 侧改名「变更审查」（5 处标识符 + `sidePane.changes`）。

**未落地**（属方案文档的后续里程碑，不在本契约范围）：

- 审查 Skill 集、知识板块（术语/标准/规范库）、标准引用自检的确定性工具。
- Office/PDF 的原生高亮（当前问题卡定位机制仅支持代码/文本预览源）。
- **审查类型卡片目前只做「预填提示词」**：点击后把提示词写进输入框，审查本身仍由 Agent 通用能力完成，
  尚未挂载 §4.1 的审查 Skill，也未接入标准库（M2/M3）。
