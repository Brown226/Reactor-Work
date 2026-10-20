# 桌面悬浮球 — 已移除（spec-v1）

## 结论

桌面悬浮球（常驻透明球窗 + 动作面板 + `Ctrl/Cmd+Shift+B` 热键）已**整体移除**，
`quickInputWindow` 快捷输入浮窗（`Ctrl/Cmd+Shift+Space`）不受影响，保留。

## 为什么移除

- **价值判定**：大王两轮实测「点击无反应」，判定「没有什么用」。
- **根因未彻底定位**（如实记录，不编造）：
  - 早期 `data:` URL + `location.href` 改私有 scheme + `will-navigate` 方案的失败原因已确认——
    Chromium 直接拦截「不透明来源 → 未注册 scheme」的导航，`will-navigate` 不触发。
  - 改为「真实 HTML 页面 + 专用 preload + IPC」后，链路各段单独验证均正常
    （dev server 两个页面 HTTP 200、`out/preload/floatingBall.cjs` 669KB 已产出、
    热键注册日志出现、无页面加载失败日志），但用户点击仍无反应，
    main 侧未收到 `[floating-ball] action=` 日志。
  - 遗留疑点：`focusable:false` + `transparent:true` 的常驻置顶窗在 Windows 上的
    鼠标事件投递不稳定，需在本机配合 DevTools 逐窗口调试才能定位，成本高于功能收益。
- 合并删除两份前置 spec：`未完成-桌面悬浮球-spec-v1.md`、`未完成-悬浮球快捷动作-spec-v1.md`。

## 移除范围

| 类型 | 内容 |
| --- | --- |
| 删除文件 | `packages/desktop/src/main/desktopFloatingBall.ts`、`src/preload/floatingBall.ts`、`src/renderer/floatingBall.ts`、`src/renderer/floatingBallPanel.ts`、`src/renderer/floating-ball.html`、`src/renderer/floating-ball-panel.html` |
| 回退接入 | `packages/desktop/src/main/index.ts`（import / 模块变量 / 窗口过滤 / 创建 / dispose）、`vite.config.ts`（两个多页面入口）、`tsup.config.ts`（preload 入口） |
| 回退契约 | `packages/shared/src/channels.ts`（`FloatingBallAction` 通道名与 payload 映射）、`platform.ts`（`FloatingBallAction` 类型、`ComposerAttachmentInjectionPayload.source` 去掉 `floating-ball-screenshot`）、`index.ts`（导出） |

## 保留不动

- 快捷输入浮窗（`quickInputWindow.ts` + `Ctrl/Cmd+Shift+Space`）：独立模块，与悬浮球无耦合。
- `InjectComposerAttachment` 通道：quick-input 与外部图片交接仍在用。
- `getApplicationWindowsExcludingCuaIndicator()`：CUA 指示器排除逻辑仍在用，仅去掉悬浮球分支。
