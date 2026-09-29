/**
 * About 窗口的 preload。
 *
 * About 窗口是 main 生成的 data: URL 页面，拿不到应用 renderer 的 store；这里只暴露两个动作：
 * 版本号点击上报（计数与判定期在 main）与解锁态推送（用于在版本号下方显示结果提示）。
 * 与 cuaPermissionPanel 同思路：窗口职责单一，不复用主窗口那个庞大的 preload。
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type DevModeUnlockState } from "@zcode/shared";

contextBridge.exposeInMainWorld("reactorAbout", {
  /** 版本号被点了一次：main 按手势契约（7 下 / 1.5s）计数，页面只上报原始点击。 */
  reportVersionTap: () => ipcRenderer.send(PlatformChannels.AboutVersionTap),
  /** 接收 main 推送的开发者模式解锁态，用于显示「已进入/已退出开发者模式」。 */
  onDevModeUnlockChanged: (callback: (state: DevModeUnlockState) => void) => {
    const handler = (_event: unknown, state: DevModeUnlockState) => {
      if (typeof state?.unlocked !== "boolean") return;
      callback({ unlocked: state.unlocked });
    };
    ipcRenderer.on(PlatformChannels.DevModeUnlockChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.DevModeUnlockChanged, handler);
  },
});
