/**
 * 「采纳这条修改建议」的标记（全局 store，按会话 scope 隔离）。
 *
 * 为什么要有它：一轮审查可能给出几十条问题，用户是在**读**的过程中逐条拍板「这条改、那条不改」，
 * 拍完才想「把我标记的一次性改掉」。标记就是这个决定过程的载体 —— 它是**用户的决定**，
 * 不是审查结果的派生数据，所以既不能塞进工具结果里，也不能只在某个组件的 useState 里活着
 * （面板、定位卡、后续发出的消息三处都要读同一份）。
 *
 * 生命周期：随审查会话存在，用户随时可清空；不落盘（界面侧没有静默写文件的能力，
 * 见 packages/shared/src/platform.ts 的 IPlatformService）。刷新会丢标记 —— 这是当前已知边界。
 */
import { create } from "zustand";
import type { ReviewQuoteMarkTarget } from "@/lib/quoteSearch.js";

export type ReviewMark = ReviewQuoteMarkTarget & {
  /** 用户拍板的时间：指令与提示块按这个顺序给，不让模型自己重排 */
  markedAt: number;
};

interface ReviewMarksState {
  marks: Record<string, ReviewMark>;
  /** 传 target + 时间戳：调用方不该关心 markedAt 这类存储细节 */
  toggle: (target: ReviewQuoteMarkTarget, markedAt?: number) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export const useReviewMarksStore = create<ReviewMarksState>((set) => ({
  marks: {},
  toggle: (target, markedAt = Date.now()) =>
    set((state) => {
      const next = { ...state.marks };
      if (next[target.key]) {
        delete next[target.key];
      } else {
        next[target.key] = { ...target, markedAt };
      }
      return { marks: next };
    }),
  remove: (key) =>
    set((state) => {
      if (!state.marks[key]) return state;
      const next = { ...state.marks };
      delete next[key];
      return { marks: next };
    }),
  clear: () => set({ marks: {} }),
}));

/** 按标记时间排序的列表：指令与提示块都按用户拍板的顺序给，别让模型自己重排。 */
export function selectSortedReviewMarks(state: { marks: Record<string, ReviewMark> }): ReviewMark[] {
  return Object.values(state.marks).sort((left, right) => left.markedAt - right.markedAt);
}

export function selectReviewMarkByKey(
  state: { marks: Record<string, ReviewMark> },
  key: string,
): ReviewMark | null {
  return state.marks[key] ?? null;
}
