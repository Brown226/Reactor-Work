# 隐藏工作区菜单中的「远程连接」入口 — spec v1

## 需求

在大王指定的位置（新任务页工作区选择器下拉菜单）隐藏「远程连接」菜单项。

截图指向：`ChatEmptyState` 工作区下拉菜单中「打开文件夹」与「不在项目中工作」之间的「远程连接」项。

## 范围界定（关键）

- **只隐藏 UI 入口**。远程连接能力、`SSHDialog`、已有远程工作区 tab 的重连/恢复链路一律不动。
- 不修改 `useRemoteConnectionEntryVisibility()`：该 hook 同时被 `useRemoteWorkspaceHistory` 用于控制远程会话恢复（`allowRemoteWorkspaceRestore`），直接置 false 会连带停用已有远程工作区的重连，超出"隐藏入口"的需求边界。
- `WorkspaceSidebar` 的侧边栏远程入口当前已是注释状态，不改动。
- `TID_COMPOSER_REMOTE_CONNECTION` 等 testid 保留在代码中（仅由开关控制渲染），避免影响既有 E2E 选择器。

## 落点

`packages/ui/src/ChatEmptyState.tsx`

- 新增局部常量 `showRemoteConnectionMenuEntry = false`，并注明原因。
- 菜单项渲染条件由 `canUseRemoteWorkspace` 改为 `canUseRemoteWorkspace && showRemoteConnectionMenuEntry`。
- `canUseRemoteWorkspace` 本身保持原语义，继续供 `SSHDialog` 使用。

## 状态所有者

无新增状态。开关为组件内字面常量，不广播、不持久化。

## 验收场景

1. 打开新任务页 → 点「选择项目」→ 下拉菜单中不再出现「远程连接」，其余项（搜索、文件夹列表、打开文件夹、不在项目中工作）保持不变。
2. 已存在的远程工作区 tab 仍可正常显示、重连。
3. 其他页面（设置、命令面板）行为无变化。

## 已执行验证

- `pnpm exec oxlint packages/ui/src/ChatEmptyState.tsx`：0 error
- `pnpm exec tsc -b packages/ui/tsconfig.json`：通过
- `pnpm lint`：0 error（既有 warning 与本次无关）
- `pnpm architecture:check --changed`：violations 0
