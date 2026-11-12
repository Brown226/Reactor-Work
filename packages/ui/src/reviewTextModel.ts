/**
 * 审查文本的**字符级高亮**模型（纯函数，可单测）。
 *
 * 为什么自渲染而不用现成的代码预览器：审查问题定位到的是**字符区间**（错别字往往在行中间），
 * 而 `@pierre/diffs` 的 `FileOptions` 只提供行级能力（`selectedLines` 行选中、`markedLines` 行标记、
 * `unsafeCSS` 注样式），没有字符级装饰钩子 —— 其 `createDiffSpanDecoration` 走的是内部 diff 渲染路径，
 * `LineDecoration` 是 `DiffHunksRenderer` 的 protected 方法，都不是外部可用选项。
 *
 * 而审查文本是**我们自己落盘的纯文本**（提取出来的正文），它不需要语法高亮、不需要 diff、
 * 不需要折叠：需要的只是「行号 + 把命中的那几个字标出来 + 滚到那儿」。所以直接渲染更简单、更可控，
 * 也不受第三方库版本变化影响。
 */

export interface ReviewTextSegment {
  text: string;
  /** 是否落在命中的字符区间内（渲染成 <mark>） */
  hit: boolean;
}

export interface ReviewTextLine {
  /** 行号，从 1 起（与 CodeReviewAnchor.startLine / 用户看到的行号一致） */
  number: number;
  segments: ReviewTextSegment[];
  /** 该行是否包含命中区间（用于滚动定位与强调） */
  hasHit: boolean;
}

export interface ReviewTextModel {
  lines: ReviewTextLine[];
  /** 命中区间的起始行号；无有效区间时为 null */
  hitLine: number | null;
  /** 区间是否有效（越界/倒置/缺失都为 false） */
  rangeValid: boolean;
  /** 是否因超长被截断（截断时必须让用户知道，不能假装全文都在） */
  truncated: boolean;
}

/** 单文件最多渲染的行数：提取文本可能很大，全量渲染会把预览器拖死。 */
export const REVIEW_TEXT_MAX_LINES = 20_000;

/**
 * 把正文切成带高亮信息的行。
 *
 * 三条口径：
 * ① 按 `\r\n | \r | \n` 切（提取文本里三种换行都可能出现）；
 * ② 字符偏移一律按**原始文本**计算（与 `KnowledgeCheck` 回报的 startOffset/endOffset 同坐标系），
 *    因此切行时同时记录每行的起始偏移，而不是先归一化换行再算 —— 那会整体错位；
 * ③ 区间无效时不做任何高亮（`rangeValid=false`），也**不**退化成"高亮第一个字"之类的猜测。
 */
export function buildReviewTextModel(
  text: string,
  startOffset?: number | null,
  endOffset?: number | null,
  maxLines: number = REVIEW_TEXT_MAX_LINES,
): ReviewTextModel {
  const hasRange =
    typeof startOffset === "number" &&
    typeof endOffset === "number" &&
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    startOffset < text.length;
  const rangeStart = hasRange ? Math.max(0, startOffset) : 0;
  const rangeEnd = hasRange ? Math.min(text.length, endOffset) : 0;

  const lines: ReviewTextLine[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  let hitLine: number | null = null;
  let truncated = false;

  const pushLine = (lineEnd: number): void => {
    if (lineNumber > maxLines) {
      truncated = true;
      return;
    }
    const segments: ReviewTextSegment[] = [];
    let hasHit = false;
    if (hasRange && rangeStart < lineEnd && rangeEnd > lineStart) {
      const from = Math.max(rangeStart, lineStart) - lineStart;
      const to = Math.min(rangeEnd, lineEnd) - lineStart;
      const line = text.slice(lineStart, lineEnd);
      if (from > 0) segments.push({ text: line.slice(0, from), hit: false });
      segments.push({ text: line.slice(from, to), hit: true });
      if (to < line.length) segments.push({ text: line.slice(to), hit: false });
      hasHit = true;
      if (hitLine === null) hitLine = lineNumber;
    } else {
      segments.push({ text: text.slice(lineStart, lineEnd), hit: false });
    }
    lines.push({ number: lineNumber, segments, hasHit });
    lineNumber += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      pushLine(index);
      lineStart = index + 1;
    } else if (char === "\r") {
      // `\r\n` 视为一次换行；`\r` 单独出现也视为换行
      pushLine(index);
      if (text[index + 1] === "\n") index += 1;
      lineStart = index + 1;
    }
    if (truncated) break;
  }
  if (!truncated) pushLine(text.length);

  return { lines, hitLine, rangeValid: hasRange, truncated };
}
