/**
 * 审查定位卡：贴在原件里那句被标出来的话旁边，显示「是什么问题 + 改成什么」。
 *
 * 为什么要有它：改成原件预览高亮之后，修改意见一度丢了 —— 以前「提取正文」是走代码预览器的
 * 评论框显示 message/suggestion，而 docx/PDF 原件预览没有评论位。用户点一条问题要看的恰恰是
 * 「改成什么」，所以意见必须跟着定位一起给，而不是只留一个色块。
 *
 * 位置算法：卡片挂在**预览区不滚动的外层**（不跟着内容滚、也不吃缩放 transform），每次滚动/缩放/重排
 * 都用命中的 Range 重新量一次矩形。右侧放得下就贴右边（像代码审查的评论气泡），放不下就落到下方。
 */
import { CheckIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { QuoteHighlightNote } from "@/lib/quoteSearch.js";

const SEVERITY_DOTS: Record<string, string> = {
  error: "bg-destructive",
  warning: "bg-amber-500",
  info: "bg-foreground-subtle",
};

const CARD_WIDTH = 320;
const CARD_GAP = 12;
/** 卡片至少要露出这么高才算「贴住了」；贴不下就往下压，免得被容器底裁掉。 */
const CARD_MIN_VISIBLE = 96;

export interface ReviewQuoteCalloutProps {
  /** 命中的范围（由定位函数交回）；null 表示未命中，不渲染 */
  range: Range | null;
  note: QuoteHighlightNote | undefined;
  /** 定位坐标系：预览区不滚动的那层容器 */
  hostRef: React.RefObject<HTMLElement | null>;
  onDismiss?: () => void;
  /**
   * 采纳这条建议（右上角对号）。不传就不显示对号 —— 只有审查面板打开的定位卡才有"采纳"语义，
   * 代码评论之类的定位没有。
   */
  onToggleMarked?: (marked: boolean) => void;
  marked?: boolean;
}

export function ReviewQuoteCallout({
  range,
  note,
  hostRef,
  onDismiss,
  onToggleMarked,
  marked = false,
}: ReviewQuoteCalloutProps) {
  const { intl } = useZCodeIntl();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host || !range) {
      setPlacement(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPlacement(null);
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const height = cardRef.current?.offsetHeight ?? 0;
    const spaceRight = hostRect.right - rect.right;
    const placeRight = spaceRight >= CARD_WIDTH + CARD_GAP;
    const rawTop = placeRight ? rect.top - hostRect.top : rect.bottom - hostRect.top + CARD_GAP;
    const rawLeft = placeRight
      ? rect.right - hostRect.left + CARD_GAP
      : Math.max(CARD_GAP, rect.left - hostRect.left);
    setPlacement({
      top: Math.max(
        0,
        Math.min(rawTop, Math.max(0, hostRect.height - Math.max(height, CARD_MIN_VISIBLE))),
      ),
      left: Math.max(0, Math.min(rawLeft, Math.max(0, hostRect.width - CARD_WIDTH - CARD_GAP))),
    });
  }, [hostRef, range]);

  useLayoutEffect(() => {
    measure();
    const host = hostRef.current;
    if (!host) return undefined;
    // 滚动发生在预览区自己的滚动容器上（可能是 host 的后代），所以用捕获阶段监听。
    host.addEventListener("scroll", measure, { passive: true, capture: true });
    window.addEventListener("resize", measure);
    const frame = window.requestAnimationFrame(measure);
    return () => {
      window.cancelAnimationFrame(frame);
      host.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [hostRef, measure]);

  useEffect(() => {
    if (!range) return undefined;
    // 命中的元素本身可能还在重排（缩放/字体加载），再补量几帧。
    const timers = [140, 420, 900].map((delay) => setTimeout(measure, delay));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [measure, range]);

  if (!range || !note || !placement) return null;

  const severity = note.severity ?? "warning";

  return (
    <div
      ref={cardRef}
      data-review-quote-callout="true"
      className="pointer-events-auto absolute z-30 flex flex-col gap-1.5 rounded-xl border border-card-border bg-card p-3 shadow-lg"
      style={{ top: placement.top, left: placement.left, width: CARD_WIDTH }}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOTS[severity])} />
        <span className="text-ui-sm font-medium">{note.title}</span>
        {note.code ? (
          <span className="rounded bg-muted px-1 text-[11px] text-foreground-subtle">{note.code}</span>
        ) : null}
        {note.line && note.line > 0 ? (
          <span className="text-[11px] text-foreground-subtle">
            {intl.formatMessage({ id: "review.card.line" }, { line: note.line })}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {onToggleMarked ? (
            // 采纳按钮：对号。采纳后实心绿底 —— 用户扫一眼面板/原件就能看出"这条我认了"。
            <button
              type="button"
              data-review-mark-toggle={marked ? "marked" : "unmarked"}
              aria-pressed={marked}
              title={intl.formatMessage({
                id: marked ? "review.mark.unmark" : "review.mark.mark",
              })}
              aria-label={intl.formatMessage({
                id: marked ? "review.mark.unmark" : "review.mark.mark",
              })}
              onClick={() => onToggleMarked(!marked)}
              className={cn(
                "rounded p-0.5",
                marked
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "text-foreground-subtle hover:bg-muted hover:text-foreground",
              )}
            >
              <CheckIcon className="size-3.5" />
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "common.close" })}
              onClick={onDismiss}
              className="rounded p-0.5 text-foreground-subtle hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      <div className="max-h-24 overflow-auto rounded bg-muted/60 px-2 py-1 font-mono text-[11px] break-all">
        {range.toString()}
      </div>
      <div className="text-ui-sm">{note.message}</div>
      {note.suggestion ? (
        // 建议用绿色 + 加粗：一条问题里「是什么问题」与「改成什么」是两种信息，
        // 用户扫一眼要能直接落到改法上（与卡片里「通过」用的 emerald 是同一语义）。
        <div className="mt-0.5 rounded-md bg-emerald-500/10 px-2 py-1 text-ui-sm">
          <span className="text-emerald-700 dark:text-emerald-400">
            {intl.formatMessage({ id: "review.card.suggestion" })}：
          </span>
          <span className="font-medium text-emerald-700 dark:text-emerald-300">
            {note.suggestion}
          </span>
        </div>
      ) : null}
    </div>
  );
}
