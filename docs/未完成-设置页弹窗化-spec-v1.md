# 设置页弹窗化 spec v1

## 背景与目标

当前设置页是「整窗覆盖层」：进入设置后整个窗口被设置页接管（`DesktopWindowFrame` + 68/268px 侧栏 + 右侧内容区），返回工作区才恢复。视觉上是扁平整页，与产品内其它浮层（对话框、命令面板）不是同一语言。

参考 NewMax 偏好弹窗（用户提供的对照图）：居中大圆角浮层，左侧是「搜索设置」+ 分组图标导航，右侧是内容区，右下角「完成」关闭。用户明确要求：把设置界面做成弹窗形式，并保持 Reactor 自己的设计规范（不照抄配色）。

目标：**把设置从「整页接管」改为「浮在 workspace 之上的居中弹窗」**，保留全部现有分区、状态、导航与持久化行为，不改任何设置项语义。

## 关键约束

1. 遵守 `DESIGN.md`：
   - 弹窗外壳 `rounded-2xl`（Dialogs 规则），内容卡片从 `rounded-xl` 起。
   - 遮罩用 `bg-black/60` + `backdrop-blur-xs`（复用 `DialogOverlay` 既有语言）。
   - 深度克制：`shadow-md` 级别，不引入重阴影。
2. **不新增状态所有者**：设置开关仍由 `tabStore.openSettingsTab` 控制（Tab 存在 = 弹窗打开），不引入第二套布尔量。
3. **不破坏无 workspace 场景**：无 workspace 时设置是唯一界面（`Root.tsx` 的 `!workspaceShellPath` 分支），此时仍要能正常显示。
4. 保留 `TID_SETTINGS_PAGE` / `TID_SETTINGS_BACK_BUTTON` / `TID_SETTINGS_SECTION_NAV` 与 `data-settings-*` 钩子，避免破坏既有选择器。
5. `Radix Dialog` 会接管焦点与 Escape；设置页内部已有大量输入控件与二级页面（插件、自动化编辑视图），必须确认二级页的返回逻辑不被 Escape 抢走。

## 结构设计

```
App (RootShell)
└─ 遮罩层 (bg-black/60 + backdrop-blur-xs, z-40)
   └─ 弹窗 (fixed 居中, w-[min(1100px,calc(100vw-4rem))], h-[min(760px,calc(100dvh-4rem))], rounded-2xl, shadow-md)
      ├─ 左侧栏 (240px)：搜索 + 分组导航 + 底部（头像/主题）
      └─ 右侧内容区：区块标题 + 可滚动内容 + 右下「完成」
```

移动/窄屏（`max-lg`）：弹窗改为近全屏（`inset-2`），左侧导航收成 icon rail（沿用现有 `max-lg` 规则）。

## 交互

| 行为 | 说明 |
| --- | --- |
| 打开 | 同现状：`openSettingsTab()`（搜索入口、齿轮、菜单） |
| 关闭 | ① 右下「完成」② 右上关闭按钮 ③ `Escape` ④ 点击遮罩 ⑤ 左侧返回箭头 |
| 关闭语义 | 调 `onBack`（回到 workSpace），保持与现状一致；无 workspace 时关闭按钮隐藏 |
| 搜索 | 左侧新增搜索框，按分区标题/描述过滤导航项；无结果显示空态文案 |
| 分区切换 | 仍走 `setActiveSettingsSection` + `settingsSectionNavigationVersion`，行为不变 |

## 明确不做

1. 不实现 NewMax 的「主题/快捷键/个性化」顶部 tab——Reactor 是左侧分区导航，语义更清晰。
2. 不改任何设置项 UI（背景主题、代码设置、主题色等保持上一轮成果）。
3. 不引入新的设置分区。
4. 不做「弹窗内嵌套弹窗」的特殊处理——Radix 已有层级管理。

## 验收场景

1. 从任意入口打开设置 → 出现居中弹窗，背后 workspace 可见且被遮罩压暗。
2. 左侧搜索输入「外观」→ 只剩匹配分区，点击可进入。
3. 切换各分区 → 内容正常，滚动正常。
4. 点「完成」/关闭按钮/Escape/遮罩 → 回到 workspace，再次打开落在上次分区。
5. 无 workspace 首次启动打开设置 → 弹窗正常（无「返回」按钮）。
6. 插件/自动化等二级视图内按 Escape → 先返回上一级，不直接关闭弹窗（若无法实现，则明确记录为遗留）。

## 实际落地（2026-10-20）

与上面设计稿的差异，以及原因：

| 设计稿 | 实际实现 | 原因 |
| --- | --- | --- |
| `fixed` 定位 + `w-[min(1100px,...)]` | 沿用 `absolute inset-0` 容器 + `w-[min(1080px,calc(100vw-2rem))]` | 设置页由 `WorkspaceSettingsLayer` 的 `absolute inset-0 z-10` 承载，用 `absolute` 与宿主同层更稳，不引入新的定位上下文 |
| Escape 关闭 | 未接线 | 设置页内没有现成的 Escape 处理（全仓 `SettingsPage` 无 keydown 监听）；Radix 未用于此弹窗。记为遗留 |

**无 workspace 分支的外壳补齐**：有 workspace 时窗口外壳（圆角、底色、mac 红绿灯留白）由底层 `WorkspaceShellLayout` 的 `DesktopWindowFrame` 提供；无 workspace 时设置是唯一界面，底层无外壳，因此在 `onBack` 缺失时把内容包进一层 `DesktopWindowFrame`，否则首次启动窗口失去底色与圆角。

## 验证证据（CDP 实测，非静态推断）

| 验收项 | 实测结果 |
| --- | --- |
| 弹窗呈现 | `data-settings-presentation="dialog"`、`role="dialog"`、`aria-modal="true"` 均在 |
| 居中与尺寸 | 弹窗 1080×760 @ (228, 28)，视口 1536×816 → 水平居中 |
| 遮罩 | `backdrop-filter: blur(4px)`、`bg-black/60` 生效 |
| 圆角/阴影 | `border-radius: 16px`；`--tw-shadow` = `0 4px 6px -1px rgb(0 0 0 / 0.1)...`（`shadow-md` 生效） |
| 底层 inert | 打开时 `data-root-workspace-surface="inert"`，关闭后回到 `"interactive"` |
| 搜索过滤 | 输入「外观」后导航项 11 → 1（仅「外观」），并出现空态判定 |
| 「完成」按钮 | 点击后 `dialog: true → false`，workspace 恢复 `interactive` |
| 点击遮罩 | 同样正确关闭并恢复 workspace |
| 窗口框不重复 | 有 workspace 时全页 `data-desktop-window-frame` 计数 = 1，设置内容内 = 0 |

## 运行时修复的真实布局缺陷（2026-10-20）

第一次截图检查时发现「完成」按钮只露一个角、右侧下拉与壁纸列表被切在弹窗外。CDP 量测定位根因：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| `dialog.scrollWidth` / `clientWidth` | 1143 / 1078（**溢出 65px**） | 1078 / 1078 |
| 右侧内容区 `right` | 1216（弹窗右界仅 1152） | 1151.2（正确落在界内） |

**根因**：`<section data-settings-content-frame>` 是 flex 子项，默认 `min-width: auto`，内部超宽内容（下拉框、横向壁纸列表）会把它撑破，而不是让它收缩。**修法**：加 `min-w-0`，让它按 flex 规则收缩。

这是典型的 flex 子项 `min-width` 陷阱，静态阅读代码看不出来，必须靠运行时量测才能发现——也说明本功能的视觉验收不能只靠 tsc + lint。

## 遗留

1. **Escape 关闭未实现**。当前只能通过「完成」、返回箭头、点击遮罩关闭。若要补齐，需在弹窗外壳加 keydown 监听，并处理二级视图（插件/自动化编辑页）优先返回上一级的层级关系。
2. **无 workspace 分支未做运行时验证**。该分支要清空当前 workspace 才能进入，本次只保证类型与结构正确（`DesktopWindowFrame` 包裹 + 条件分支），未实际启动到该状态截图。
