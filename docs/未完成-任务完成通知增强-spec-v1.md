# 任务完成通知增强 — spec v1

## 背景

来源：Namiwork 3.25.0 `src/notify/notification-presenter.js`。Reactor 已有
`desktopNotifications.ts`（系统通知 + 去重 + 点击唤起），但**缺**两个原生强调动作：

- Windows：任务栏图标闪烁（`BrowserWindow.flashFrame`）
- macOS：Dock 图标弹跳（`app.dock.bounce`）

内网常驻 + 多任务场景下，用户切到别处时系统通知可能被忽略，任务栏闪烁/Dock 弹跳是
低成本的"回来看看"提示。

## 产品规则

1. **只在展示系统通知时一并触发**：沿用 `dispatchTaskNotification` 现有的
   "任一 app 窗口已聚焦则不通知" 判定，不新增触发条件。
2. **Windows**：对发通知的窗口调用 `flashFrame(true)`，窗口获得焦点时调用
   `flashFrame(false)` 停止闪烁。
3. **macOS**：调用 `app.dock.bounce("informational")`（持续型，获得焦点后由
   `cancelBounce` 停止）。
4. **其它平台 / 窗口已销毁 / API 不存在**：静默跳过，不影响通知本身。
5. 不改变现有通知的标题/正文/去重/点击行为。

## 状态所有者

- 每个窗口的"待停止闪烁/弹跳"由 `WeakMap<BrowserWindow, bounceId>` 记录，
  窗口聚焦或销毁时清理；不引入全局可变状态，不影响多窗口语义。
- 唯一副作用是对该窗口调用 `flashFrame` / `dock.bounce` / `dock.cancelBounce`。

## 验收场景

- [ ] Windows 后台完成任务 → 系统通知弹出 + 任务栏图标闪烁；点击通知或切回窗口后停止闪烁。
- [ ] macOS 后台完成任务 → 系统通知弹出 + Dock 弹跳；窗口获焦后停止。
- [ ] 前台（有窗口聚焦）完成任务 → 既不通知也不闪烁/弹跳（沿用现有判定）。
- [ ] 窗口已销毁 → 跳过，不抛异常。

## 验证口径

行为改动 → 全量 `pnpm typecheck` + `pnpm lint`；三种平台的原生视觉行为本机无法全量
验证，如实注明。
