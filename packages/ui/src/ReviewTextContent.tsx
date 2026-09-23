/**
 * 审查文本预览：行号 + **字符级高亮** + 滚到命中位置 + 显示问题说明。
 *
 * 只用于带字符区间的审查定位（`code-review` 源且锚点给了 offsets）。
 * 纯文本、无语法高亮、无 diff —— 这正是提取正文需要的全部（见 reviewTextModel.ts 头注：
 * 为什么不用 `@pierre/diffs` 做字符级）。
 */
import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/components/lib/utils.js";

import { buildReviewTextModel } from "@/reviewTextModel.js";

interface ReviewTextContentProps {
  text: string;
  startOffset?: number | null;
  endOffset?: number | null;
  /** 命中的原文片段：与文本里的高亮互为印证（偏移错位时一眼能看出） */
  quote?: string | null;
  /** 问题说明（代替代码预览器的评论卡） */
  comment?: string | null;
  severity?: "error" | "warning" | "info" | null;
  /** 每次点击问题条都换一个值：同一个文件重复点击也要重新滚动到位 */
  focusRequestId?: string;
  className?: string;
}

const MARK_CLASS: Record<"error" | "warning" | "info", string> = {
  error: "bg-destructive/25 outline outline-1 outline-destructive/50",
  warning: "bg-amber-400/30 outline outline-1 outline-amber-500/50",
  info: "bg-sky-400/25 outline outline-1 outline-sky-500/40",
};

export function ReviewTextContent({
  text,
  startOffset,
  endOffset,
  quote,
  comment,
  severity,
  focusRequestId,
  className,
}: ReviewTextContentProps) {
  const model = useMemo(
    () => buildReviewTextModel(text, startOffset, endOffset),
    [text, startOffset, endOffset],
  );
  const hitRef = useRef<HTMLDivElement | null>(null);

  // 定位：命中行渲染出来之后再滚。`focusRequestId` 变化即重新定位（同一文件连续点不同问题）。
  useEffect(() => {
    if (!focusRequestId) return;
    const node = hitRef.current;
    if (!node) return;
    // 用 rAF 等一帧：虚拟化/长列表场景下刚挂载就滚动会落空
    const frame = window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusRequestId, model.hitLine]);

  const markClass = MARK_CLASS[severity ?? "warning"];

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {comment ? (
        <div className="shrink-0 border-b border-border bg-surface px-3 py-2 text-ui-sm">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-medium">{quote ?? ""}</span>
            {model.rangeValid ? null : (
              // 偏移无效时明说：否则读者会以为"没高亮=没问题"
              <span className="text-[11px] text-foreground-subtle">未能定位到正文（偏移越界）</span>
            )}
          </div>
          <div className="whitespace-pre-wrap text-foreground-subtle">{comment}</div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
        <div className="min-w-full font-mono text-ui-sm leading-relaxed">
          {model.lines.map((line) => (
            <div
              key={line.number}
              ref={line.hasHit ? hitRef : undefined}
              data-review-line={line.number}
              className={cn("flex", line.hasHit && "bg-foreground/[0.04]")}
            >
              <span className="sticky left-0 w-[52px] shrink-0 select-none border-r border-border bg-background px-2 text-right text-foreground-subtlest">
                {line.number}
              </span>
              <span className="whitespace-pre-wrap break-words px-2">
                {line.segments.map((segment, index) =>
                  segment.hit ? (
                    <mark
                      key={index}
                      data-review-hit="true"
                      className={cn("rounded-sm px-0.5 text-foreground", markClass)}
                    >
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
              </span>
            </div>
          ))}
          {model.truncated ? (
            <div className="px-3 py-2 text-foreground-subtle">
              文本过长，仅显示前 {model.lines.length} 行（完整内容见正文快照文件）
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
