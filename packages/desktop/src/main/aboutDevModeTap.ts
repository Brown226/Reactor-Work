import { BrowserWindow, ipcMain } from "electron";
import { DEV_TAP_TARGET, DEV_TAP_WINDOW_MS, PlatformChannels } from "@zcode/shared";

/**
 * About 窗口「版本号连点 7 下」→ 开发者模式开关的桌面侧中转。
 *
 * 状态所有者仍是 renderer 的模块 store（packages/ui/src/lib/devMode.ts，localStorage 持久化）；
 * About 窗口是另一个 renderer 进程，拿不到那份 store，main 只做两件事：
 *   1. 按手势契约对每个 About 窗口独立计数（各入口各数各的，语义见 spec §1.1）；
 *   2. 第 7 下把「取反后的新值」广播给应用窗口，并把同一份值回给被点的 About 窗口显示提示。
 * 真正的写入永远由 renderer 的 store 完成；main 只保存 `latestKnown` 镜像用于取反，
 * 镜像由 renderer 在启动与每次本地变更时上报刷新（DevModeUnlockReported），main 不回播，
 * 因此不存在回环。镜像陈旧时最坏结果是 About 连点得到反方向的提示，不影响真实状态。
 */
type AboutTapState = { taps: number; lastAt: number };

export interface AboutDevModeTapBridge {
  /** About 窗口创建后挂上：接管该窗口的连点计数与提示推送。 */
  attach(window: BrowserWindow): void;
  /** 窗口关闭时摘掉，清掉计数与提示目标。 */
  detach(window: BrowserWindow): void;
}

export function createAboutDevModeTapBridge(): AboutDevModeTapBridge {
  const aboutWindows = new Set<BrowserWindow>();
  const tapStates = new WeakMap<BrowserWindow, AboutTapState>();
  let latestKnown = false;
  let ipcRegistered = false;

  const ensureIpcRegistered = () => {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.on(PlatformChannels.AboutVersionTap, (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed() || !aboutWindows.has(window)) return;
      handleTap(window);
    });
    // 只刷镜像，不回播；广播只由 About 连点的第 7 下发起。
    ipcMain.on(PlatformChannels.DevModeUnlockReported, (_event, state: unknown) => {
      const unlocked = (state as { unlocked?: unknown } | null)?.unlocked;
      if (typeof unlocked !== "boolean") return;
      latestKnown = unlocked;
    });
  };

  const handleTap = (window: BrowserWindow) => {
    const now = Date.now();
    const state = tapStates.get(window) ?? { taps: 0, lastAt: 0 };
    if (now - state.lastAt > DEV_TAP_WINDOW_MS) state.taps = 0;
    state.lastAt = now;
    state.taps += 1;
    if (state.taps < DEV_TAP_TARGET) return;

    state.taps = 0;
    const next = !latestKnown;
    latestKnown = next;
    const payload = { unlocked: next };
    // 应用窗口应用新值；其他辅助窗口（更新窗、CUA 指示器等）没有该频道监听，发送是无害 no-op。
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (candidate.isDestroyed() || aboutWindows.has(candidate)) continue;
      candidate.webContents.send(PlatformChannels.DevModeUnlockChanged, payload);
    }
    // 回给被点的 About 窗口显示结果提示。
    window.webContents.send(PlatformChannels.DevModeUnlockChanged, payload);
  };

  return {
    attach(window: BrowserWindow) {
      if (window.isDestroyed()) return;
      ensureIpcRegistered();
      aboutWindows.add(window);
      window.once("closed", () => {
        aboutWindows.delete(window);
      });
    },
    detach(window: BrowserWindow) {
      aboutWindows.delete(window);
    },
  };
}

/** About 窗口由 showAboutDialog 独占创建，bridge 也随之单例。 */
let aboutDevModeTapBridge: AboutDevModeTapBridge | null = null;

export function getAboutDevModeTapBridge(): AboutDevModeTapBridge {
  if (!aboutDevModeTapBridge) {
    aboutDevModeTapBridge = createAboutDevModeTapBridge();
  }
  return aboutDevModeTapBridge;
}

/** 仅供测试重置单例。 */
export function resetAboutDevModeTapBridgeForTest(): void {
  aboutDevModeTapBridge = null;
}
