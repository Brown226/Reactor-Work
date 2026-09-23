import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { CodeReviewAnchor, CodeReviewCodeViewerSource } from "@/lib/codeViewer.js";

interface CodeReviewContentProjection {
  focusedRange: CodeCommentRange | null;
  inlineComments: readonly CodeCommentPreview[];
  targetLineOutOfRange: boolean;
  topComment: CodeCommentPreview | null;
}

/**
 * 字符偏移 → 行号（1 起）。
 *
 * 审查问题来自**提取文本**（docx/pdf 没有行号概念），而预览器只能按行定位，所以这里做换算。
 * 越界一律回落 `null` 而不是钳到首/末行：钳位会让"定位到错误的位置"看起来像成功，
 * 而定位错位置比不定位更误导复核者。
 */
export function resolveLineFromOffset(content: string, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) return null;
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") line += 1;
  }
  return line;
}

/**
 * 把锚点归一成「行区间」：优先用显式行号，其次由字符偏移换算。
 * `outOfRange` 表示锚点指向的行超出了实际文本（文件换过、或偏移来自另一个版本）。
 */
export function resolveAnchorLineRange(
  review: CodeReviewAnchor,
  content: string,
): { startLine: number; endLine: number; outOfRange: boolean } | null {
  const lineCount = content.split(/\r\n|\r|\n/).length;
  const explicitStart = review.startLine;
  const explicitEnd = review.endLine ?? review.startLine;
  if (
    Number.isInteger(explicitStart) &&
    Number.isInteger(explicitEnd) &&
    explicitStart !== undefined &&
    explicitEnd !== undefined &&
    explicitStart > 0 &&
    explicitEnd >= explicitStart
  ) {
    return {
      startLine: explicitStart,
      endLine: explicitEnd,
      outOfRange: explicitEnd > lineCount,
    };
  }
  if (Number.isInteger(review.startOffset) && review.startOffset !== undefined) {
    const startLine = resolveLineFromOffset(content, review.startOffset);
    if (startLine === null) return null;
    const endLine =
      Number.isInteger(review.endOffset) && review.endOffset !== undefined
        ? (resolveLineFromOffset(content, review.endOffset) ?? startLine)
        : startLine;
    return {
      startLine,
      endLine: Math.max(startLine, endLine),
      outOfRange: startLine > lineCount,
    };
  }
  return null;
}

export function resolveCodeReviewContentProjection(
  source: CodeReviewCodeViewerSource,
  content: string,
): CodeReviewContentProjection {
  const { review } = source;
  const range = resolveAnchorLineRange(review, content);
  const rangeIsVisible = range !== null && !range.outOfRange;
  const comment: CodeCommentPreview = {
    id: review.requestId,
    sourcePath: source.path,
    sourceTitle: source.title,
    startLine: range?.startLine ?? 1,
    endLine: range?.endLine ?? 1,
    // 命中的原文片段：这是「点击问题 → 原文」里最能自证的一栏，有就必须显示。
    selectedText: review.quote ?? "",
    comment: review.body,
  };

  return {
    focusedRange:
      rangeIsVisible && range ? { startLine: range.startLine, endLine: range.endLine } : null,
    inlineComments: rangeIsVisible ? [comment] : [],
    targetLineOutOfRange: range !== null && range.outOfRange,
    topComment: rangeIsVisible ? null : comment,
  };
}
