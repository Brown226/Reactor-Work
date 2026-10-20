import { create } from "zustand";
import { nanoid } from "nanoid";
import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";

/**
 * 系统侧内容注入 composer 的运行态通道（截图、外部图片交接、快捷输入浮窗共用）。
 *
 * 为什么是运行态而非草稿持久化：附件含 objectUrl/File，不可序列化；且
 * `composerDraftStore` 已明确裁决「附件不入草稿」。所以这里只做内存态一次性移交。
 *
 * 认领策略：唯一拥有焦点的 composer（`SessionPane.focused` → `useComposerAttachments.focused`）
 * 认领并消费；非焦点 composer 不认领，避免竖切多 pane 时抢注入。这与既有
 * `whiteboard:add-to-chat` 事件的「焦点 pane 处理」语义一致。
 */
export type SystemComposerInjectionSource = "external-image" | "quick-input";

export interface SystemComposerInjection {
  id: string;
  /** 来源标识，用于日志与去重。 */
  source: SystemComposerInjectionSource;
  /** 已构造好的附件（objectUrl/File 直接可用）。 */
  attachment: ChatComposerAttachment;
}

interface SystemComposerInjectionState {
  pending: SystemComposerInjection[];
}

export const useSystemComposerInjectionStore = create<SystemComposerInjectionState>()(() => ({
  pending: [],
}));

/** 入队一条待注入内容，返回其 id。 */
export function pushSystemComposerInjection(
  injection: Omit<SystemComposerInjection, "id">,
): string {
  const id = nanoid();
  useSystemComposerInjectionStore.setState((state) => ({
    pending: [...state.pending, { ...injection, id }],
  }));
  return id;
}

/** 认领后出队；重复调用幂等。 */
export function consumeSystemComposerInjection(id: string): void {
  useSystemComposerInjectionStore.setState((state) => ({
    pending: state.pending.filter((entry) => entry.id !== id),
  }));
}

export function readPendingSystemComposerInjections(): SystemComposerInjection[] {
  return useSystemComposerInjectionStore.getState().pending;
}
