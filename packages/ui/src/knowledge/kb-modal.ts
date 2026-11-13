/**
 * `showConfirm` 模块级桥。
 *
 * ## 为什么需要它
 *
 * EvoFlow 的知识库 UI 用模块级 `showConfirm(text) => Promise<boolean>`
 * （它的 `components/modal.js`）。而我们的确认对话框是 React hook
 * `useConfirmDialog()`（底层 `useConfirmDialogStore`），只能在组件里调。
 *
 * UI 代码有 12 处 `await showConfirm(...)`，改它们是纯机械劳动且会diff 很吵；
 * 这里提供一个同形状的模块级函数，内部直接驱动 store —— 复用同一套
 * ConfirmDialog 组件与 E2E testId，不新建第二套弹窗。
 *
 * 注意：本文件是 UI 代码的适配层，不是新的弹窗实现。
 */
import { useConfirmDialogStore } from "../store/confirmDialogStore.js";

/**
 * 弹一个确认框，返回用户是否确认。
 *
 * @param message 说明文字。EvoFlow 的 showConfirm 只收一段文本，
 *         我们把它放到 description，标题用固定「确认」——知识库的确认
 *         场景（停用/删除/移动）都是同一个语义，不值得为每个调用点起标题。
 */
export function showConfirm(message: string): Promise<boolean> {
  return useConfirmDialogStore.getState().requestConfirmation({
    title: "确认",
    description: String(message ?? ""),
    confirmLabel: "确认",
    cancelLabel: "取消",
    intent: "knowledge-confirm",
  });
}

/** 与 EvoFlow `showModal` 同形状的提示框（只有确认，没有取消）。 */
export function showModal(message: string): Promise<boolean> {
  return useConfirmDialogStore.getState().requestConfirmation({
    title: "提示",
    description: String(message ?? ""),
    confirmLabel: "知道了",
    requiredAcknowledgement: true,
    intent: "knowledge-modal",
  });
}
