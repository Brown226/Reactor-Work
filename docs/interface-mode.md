# 界面模式（编程 / 办公）契约

覆盖 `interfaceMode` 这一产品设置：谁拥有状态、有哪些入口、主面板入口的显示规则与验收场景。
改界面模式相关代码前先读本文；跨目录复用分段控件时也要同步更新第 3 节。

## 1. 状态所有者

| 项         | 值                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------- |
| 所有者     | `packages/ui/src/store/index.ts` 的 `interfaceMode` 字段                                 |
| 唯一写入口 | `setInterfaceMode(mode)`；内部先 `normalizeInterfaceMode`，再写 `set({ interfaceMode })` |
| 持久化     | localStorage `zcode-interface-mode`（`INTERFACE_MODE_STORAGE_KEY`）                      |
| 取值       | `"coding"` / `"office"`，默认 `"coding"`                                                 |
| 旧值迁移   | localStorage 里的 `"general"` / `"concise"` 归一为 `"office"`，其余一律 `"coding"`       |

没有第二份状态，也没有服务端事实：任何入口都只读同一个字段、只调同一个 setter。
`useIsOfficeMode()`（`hooks/useInterfaceMode.ts`）是只读派生，供展示层判断"当前是不是办公模式"。

## 2. 入口

| 入口     | 位置                                              | 形态         |
| -------- | ------------------------------------------------- | ------------ |
| 设置页   | `settingsPageHelpers.tsx` 的「界面模式」行        | Select       |
| 账户菜单 | `WorkspaceSidebarFooter.tsx` 的「界面模式」子菜单 | Radio 组     |
| 主面板   | `v4/DraftInterfaceModeToggle.tsx`                 | 胶囊分段切换 |
| 快捷键   | `settings.shortcuts.command.toggleInterfaceMode`  | 命令         |

四个入口写入同一字段，互相同步；不存在"主面板这份是临时预览"之类的局部覆盖。

## 3. 分段控件的唯一实现

`components/ui/segmented-tabs.tsx` 的 `SegmentedTabs` 是全应用胶囊分段切换的唯一实现
（原 `settings/SettingsSegmentedTabs.tsx`，因主面板也要用同款而上移）。新增同层级的分段切换
一律复用它，不要再用 Tabs 手搓第二套视觉。

尺寸只有两档，选中态是同一套"亮面胶囊"，不因尺寸引入第二种选中语言：

| size         | 用途                                       | 控件高度                  |
| ------------ | ------------------------------------------ | ------------------------- |
| `sm`（默认） | 设置详情页等密集区域                       | 32px（档位 28px）         |
| `lg`         | 主面板入口这类需要一眼看见、容易点到的位置 | 44px（档位 36px，含投影） |

## 4. 主面板入口的显示规则

- 只在草稿态空态显示：与 `ConversationDraftEmptyState`（问候语）同属 timeline 的 `emptyState` 节点，
  排在问候语之后、composer dock 之前。
- 会话一旦产生消息（`renderUnits.length > 0`）即随空态一起消失，不与工具输出、终端争注意力。
- 桌面与手机远控共用同一个 `SessionPane`，因此两端显示同一组件，不按平台分叉。
- 图标复用 `onboarding/occupationOptions.ts` 的 `modeOptionIcons`，保证同一模式在全应用只有一套视觉标识。
- 文案复用 `settings.interfaceMode.coding` / `.office`，不新增同义词。
- 用 `size="lg"`（见第 3 节），与设置页的 `sm` 区分：主面板是入口，不是密集设置项。

## 5. 主面板问候语的称呼（相关，非模式契约）

同一个 `emptyState` 里的问候语在句首带上登录用户名（`chat.empty.greeting.withName` = `{name}，{greeting}`）：

- 取名字的优先级与侧边栏页脚一致：ZCode 账号 `user.displayName` → `user.username` → 企业登录 `useReactorServer().status.user.name`。
- 两处都未登录时不加称呼，保持原问候语，不出现空称呼或"null"。
- 拉长后的问候语仍走既有的自适应字号逻辑（20–30px），不额外截断。

## 6. 验收场景

1. 主面板点「办公模式」：胶囊高亮切换，且设置页与账户菜单再次打开时同为办公模式（同一份状态）。
2. 刷新或重启后选择保持（localStorage 已写入 `zcode-interface-mode`）。
3. 快捷键切换后，主面板胶囊同步高亮（都走 store，不需要额外同步代码）。
4. 会话进行中主面板不出现该胶囊；切回空草稿首页时重新出现。
5. 从旧版本升级（localStorage 存 `"general"` / `"concise"`）的用户仍然落在办公模式，不被重置为编程模式。
6. 已登录时问候语形如「田科达，今天有什么工作，交给我吧」；未登录时退回「今天有什么工作，交给我吧」。
