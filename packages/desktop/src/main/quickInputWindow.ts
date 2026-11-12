/**
 * 快捷输入浮窗（d）。
 *
 * 参考 NewMax 的快捷输入浮窗：一个常驻的轻量输入窗口，全局热键唤起，随手问一句。
 * 内容提交后转交主窗口 composer（文本走 `InjectComposerText`、图片走
 * `InjectComposerAttachment`），复用主窗口 composer 的完整提交链路，浮窗本身不做请求。
 *
 * 窗口范式取自 `cuaPermissionDragPanel.ts`，但**必须可聚焦**（输入框要能键入），
 * 所以去掉 `type:"panel"` 与 `focusable:false`，改用 `show()` + `focus()`。
 */
import { app, BrowserWindow, globalShortcut, screen, ipcMain } from "electron";
import { join } from "node:path";
import {
  PlatformChannels,
  type Locale,
  type QuickInputStatePayload,
  type QuickInputSubmitPayload,
} from "@zcode/shared";

/** 浮窗尺寸（px）。 */
const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 168;
/** 距屏幕上缘的比例位置（居中偏上）。 */
const TOP_RATIO = 0.22;
/** 唤起浮窗的全局热键（避开已占用的 CommandOrControl+Shift+B）。 */
const TOGGLE_ACCELERATOR = "CommandOrControl+Shift+Space";

export interface QuickInputWindowDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** 获取当前界面语言。 */
  getLocale: () => Locale;
  rendererDir: string;
  rendererDevUrl?: string | undefined;
  /** 浮窗提交文本 → 转交主窗口 composer。 */
  injectTextToComposer: (text: string) => void;
  /** 浮窗提交图片 → 转交主窗口 composer。 */
  injectImageToComposer: (imagePath: string) => void;
  /** 唤起/前置主窗口（提交后可选聚焦）。 */
  showCurrentWindow: () => Promise<void> | void;
}

export interface QuickInputWindow {
  toggle: () => void;
  dispose: () => void;
}

function preloadPath(): string {
  // 与其它窗口一致：生产包用打包后的 .cjs，开发态用同名产物。
  return join(import.meta.dirname, "../preload/quickInput.cjs");
}

function resolveBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - PANEL_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height * TOP_RATIO),
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
  };
}

export function createQuickInputWindow(deps: QuickInputWindowDeps): QuickInputWindow {
  let win: BrowserWindow | null = null;
  let disposed = false;

  function ensureWindow(): BrowserWindow | null {
    if (win && !win.isDestroyed()) {
      return win;
    }
    const bounds = resolveBounds();
    try {
      win = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        hasShadow: true,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: preloadPath(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
    } catch (error) {
      deps.logger.warn("[quick-input] failed to create window", error);
      win = null;
      return null;
    }

    const created = win;
    created.on("blur", () => {
      // 失焦即收起，符合「随手问一句」的浮窗语义。
      if (!created.isDestroyed()) created.hide();
    });
    created.on("closed", () => {
      if (win === created) win = null;
    });

    if (!app.isPackaged && deps.rendererDevUrl) {
      void created.loadURL(`${deps.rendererDevUrl}/quick-input.html`);
    } else {
      void created.loadFile(`${deps.rendererDir}/quick-input.html`);
    }
    return win;
  }

  function show(): void {
    const target = ensureWindow();
    if (!target || target.isDestroyed()) {
      return;
    }
    const bounds = resolveBounds();
    target.setBounds(bounds);
    target.show();
    target.focus();
    target.setAlwaysOnTop(true, "screen-saver");
    target.webContents.send(PlatformChannels.QuickInputState, {
      locale: deps.getLocale(),
    } satisfies QuickInputStatePayload);
  }

  function hide(): void {
    if (win && !win.isDestroyed()) {
      win.hide();
    }
  }

  ipcMain.on(PlatformChannels.QuickInputSubmit, (_event, raw: unknown) => {
    const payload = raw as QuickInputSubmitPayload | undefined;
    if (!payload || typeof payload !== "object") {
      return;
    }
    if (payload.hide) {
      hide();
      return;
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    const imagePath = typeof payload.imagePath === "string" ? payload.imagePath : undefined;
    if (text.trim().length === 0 && !imagePath) {
      hide();
      return;
    }
    if (text.trim().length > 0) {
      deps.injectTextToComposer(text);
    }
    if (imagePath) {
      deps.injectImageToComposer(imagePath);
    }
    hide();
    // 提交后把主窗口带到前台，让用户看到内容已落到输入框。
    void Promise.resolve(deps.showCurrentWindow()).catch((error) => {
      deps.logger.warn("[quick-input] failed to show main window", error);
    });
  });

  const registered = globalShortcut.register(TOGGLE_ACCELERATOR, () => {
    if (disposed) return;
    const visible = win && !win.isDestroyed() && win.isVisible();
    if (visible) {
      hide();
    } else {
      show();
    }
  });
  if (!registered) {
    deps.logger.warn(`[quick-input] global shortcut ${TOGGLE_ACCELERATOR} not registered`);
  } else {
    deps.logger.info(`[quick-input] registered toggle shortcut ${TOGGLE_ACCELERATOR}`);
  }

  return {
    toggle: () => {
      if (disposed) return;
      const visible = win && !win.isDestroyed() && win.isVisible();
      if (visible) hide();
      else show();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        globalShortcut.unregister(TOGGLE_ACCELERATOR);
      } catch (error) {
        deps.logger.warn("[quick-input] failed to unregister shortcut", error);
      }
      ipcMain.removeAllListeners(PlatformChannels.QuickInputSubmit);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      win = null;
    },
  };
}
