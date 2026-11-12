/**
 * Windows 输入法焦点恢复。
 *
 * 参考实现：NewMax 1.1.20 解包产物 `out/renderer/assets/windowsImeFocusRecovery-*.js`
 * 中的 `installWindowsImeFocusRecovery`（纯 DOM，无框架依赖）。此处按 Reactor 的
 * TS 风格重写，并把平台、window/document、编辑器访问都做成注入参数以便测试。
 *
 * 解决的问题：Windows 中文输入法在「编辑器正活跃时切走窗口 → 再切回」后，
 * 编辑器的 DOM 焦点没有重新挂回，输入法合成上下文与编辑器脱节，导致切回来打不了字。
 *
 * 修复策略：
 * - 只在 Windows 生效；
 * - 只在失焦前编辑器本来是活跃的才恢复，避免抢用户在别处点中的焦点；
 * - 用双帧 rAF：先 blur 重置合成态，下一帧再 focus 把焦点挂回；
 * - 恢复前确认焦点没有被别处认领，否则放弃。
 */

export interface WindowsImeFocusEditor {
  contentDOM: HTMLElement;
  focus: () => void;
}

export interface WindowsImeFocusRecoveryOptions {
  /** 平台标识（通常传 `navigator.platform`），以 `Win` 开头才启用。 */
  platform: string;
  windowTarget: Window;
  documentTarget: Document;
  /** 读取当前编辑器；编辑器被替换或卸载时返回 null。 */
  getEditor: () => WindowsImeFocusEditor | null;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * 安装 Windows 输入法焦点恢复监听，返回清理函数。
 *
 * 非 Windows 平台返回空清理函数，不注册任何监听。
 */
export function installWindowsImeFocusRecovery(
  options: WindowsImeFocusRecoveryOptions,
): () => void {
  const {
    platform,
    windowTarget,
    documentTarget,
    getEditor,
    requestFrame = (callback) => windowTarget.requestAnimationFrame(callback),
    cancelFrame = (handle) => windowTarget.cancelAnimationFrame(handle),
  } = options;

  if (!platform.toUpperCase().startsWith("WIN")) {
    return () => {};
  }

  let appHasFocus = true;
  let editorWasActive = false;
  let settleFrame: number | null = null;
  let refocusFrame: number | null = null;

  const cancelPendingRecovery = () => {
    if (settleFrame !== null) {
      cancelFrame(settleFrame);
    }
    if (refocusFrame !== null) {
      cancelFrame(refocusFrame);
    }
    settleFrame = null;
    refocusFrame = null;
  };

  const handleWindowBlur = () => {
    appHasFocus = false;
    cancelPendingRecovery();
    const editor = getEditor();
    editorWasActive = Boolean(editor) && documentTarget.activeElement === editor?.contentDOM;
  };

  const handleWindowFocus = () => {
    appHasFocus = true;
    // 失焦前编辑器本就不活跃：不干预，避免抢用户在别处点中的焦点。
    if (!editorWasActive) {
      return;
    }

    const editor = getEditor();
    if (!editor || documentTarget.activeElement !== editor.contentDOM) {
      editorWasActive = false;
      return;
    }

    cancelPendingRecovery();
    // 第一帧：等窗口完全获得焦点后先 blur，重置输入法的合成上下文。
    settleFrame = requestFrame(() => {
      settleFrame = null;
      const currentEditor = getEditor();
      if (
        !appHasFocus ||
        !editorWasActive ||
        !currentEditor ||
        documentTarget.activeElement !== currentEditor.contentDOM
      ) {
        editorWasActive = false;
        return;
      }

      currentEditor.contentDOM.blur();
      // 第二帧：焦点回到 body 后重新挂回编辑器。
      refocusFrame = requestFrame(() => {
        refocusFrame = null;
        const latestEditor = getEditor();
        const activeElement = documentTarget.activeElement;
        // 只有当焦点仍未被别处认领时才恢复。
        const focusStillUnclaimed =
          activeElement === null ||
          activeElement === documentTarget.body ||
          activeElement === documentTarget.documentElement ||
          activeElement === latestEditor?.contentDOM;
        if (appHasFocus && editorWasActive && latestEditor && focusStillUnclaimed) {
          latestEditor.focus();
        }
        editorWasActive = false;
      });
    });
  };

  windowTarget.addEventListener("blur", handleWindowBlur);
  windowTarget.addEventListener("focus", handleWindowFocus);

  return () => {
    cancelPendingRecovery();
    editorWasActive = false;
    windowTarget.removeEventListener("blur", handleWindowBlur);
    windowTarget.removeEventListener("focus", handleWindowFocus);
  };
}
