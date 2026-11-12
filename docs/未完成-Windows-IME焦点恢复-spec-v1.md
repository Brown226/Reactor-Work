# Windows IME 焦点恢复 — spec v1

## 背景与问题

来源：NewMax 1.1.20 逆向产物 `out/renderer/assets/windowsImeFocusRecovery-*.js`，
函数 `installWindowsImeFocusRecovery`（打包后 L3457–3520，纯 DOM，无框架依赖）。

Windows 上存在一个长期问题：用户正在聊天输入框里用中文输入法打字时，切换到别的
应用窗口再切回来，编辑器已经失去 DOM 焦点，但输入法状态仍停留在"上屏"态，
导致切回来后**输入法打不了字**（按键被 Windows 中文输入法吞掉）。

根因不是 React/Lexical 状态问题，而是：窗口 blur→focus 过程中，编辑器 contentDOM
的 DOM 焦点没有被重新挂回，输入法前端的候选/合成状态与编辑器脱节。

## 产品规则

1. **只在 Windows 生效**（`process.platform` / `navigator.platform` 以 `Win` 开头）。
   macOS / Linux 直接 no-op，返回空清理函数。
2. **只在"窗口失焦前编辑器本来是活跃的"才恢复**：blur 时记录
   `document.activeElement === editor.contentDOM`；不活跃则不干预，避免抢用户
   在新窗口里点到的东西。
3. **恢复用双帧 rAF**，先 `blur()` 再下一帧 `focus()`，把输入法合成上下文重置。
4. **恢复前检查焦点是否已被认领**：若 focus 到达时 `activeElement` 既不是
   body/html 也不是旧编辑器（说明用户已经点到别处），则放弃恢复。
5. 卸载时移除监听并取消挂起的 rAF，不留悬挂帧。

## 状态所有者

- 状态只在插件内部（闭包内的 `appHasFocus` / `editorWasActive` / 两个 frame id），
  不写入任何全局 store，不影响其他模块。
- 唯一副作用是调用 `editor.contentDOM.blur()` / `editor.focus()`。

## 接口

新增 `packages/ui/src/lib/windowsImeFocusRecovery.ts`：

```ts
export interface WindowsImeFocusRecoveryOptions {
  platform: string;             // navigator.platform，注入以便测试
  windowTarget: Window;         // 注入以便测试
  documentTarget: Document;
  getEditor: () => { contentDOM: HTMLElement; focus: () => void } | null;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}
export function installWindowsImeFocusRecovery(
  options: WindowsImeFocusRecoveryOptions,
): () => void;
```

在 `LexicalChatInput` 内新增一个 Lexical 插件（`WindowsImeFocusRecoveryPlugin`），
用 `useLexicalComposerContext()` 拿到 editor，挂载时调用上面的函数，
卸载时执行它返回的清理函数。

## 验收场景

- [ ] Windows 下：编辑器活跃 → 切走 → 切回，编辑器重新获得焦点，且用户中途点到
      别处时不会被抢回。
- [ ] 非 Windows：函数返回空清理函数，不注册任何监听。
- [ ] 卸载编辑器：监听被移除，挂起的 rAF 被取消。
- [ ] 编辑器失焦前本不活跃：切回不做任何事。

## 验证口径

文案/交互类单文件改动 → 对改动文件跑 `pnpm exec oxlint <files>` + 受影响包链
增量 `tsc -b`。
