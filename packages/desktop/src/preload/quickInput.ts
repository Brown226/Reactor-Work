/**
 * 快捷输入浮窗的 preload。
 *
 * 只暴露浮窗真正需要的三件事，不复用主窗口那个庞大的 preload —— 浮窗是常驻的轻量输入窗口，
 * 攻击面越小越好。文本/图片提交后由 main 转交主窗口 composer（见 shared/channels 的
 * QuickInputSubmit → InjectComposerText / InjectComposerAttachment）。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  PlatformChannels,
  type QuickInputStatePayload,
  type QuickInputSubmitPayload,
} from "@zcode/shared";

contextBridge.exposeInMainWorld("quickInput", {
  /** 提交浮窗内容（文本/图片），转交主窗口 composer。 */
  submit: (payload: QuickInputSubmitPayload) =>
    ipcRenderer.send(PlatformChannels.QuickInputSubmit, payload),
  /** 收起浮窗。 */
  hide: () => ipcRenderer.send(PlatformChannels.QuickInputSubmit, { text: "", hide: true }),
  /** 接收 main 推送的语言，用于本地化文案。 */
  onState: (callback: (state: QuickInputStatePayload) => void) => {
    const listener = (_event: unknown, payload: QuickInputStatePayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.QuickInputState, listener);
    return () => ipcRenderer.removeListener(PlatformChannels.QuickInputState, listener);
  },
});
