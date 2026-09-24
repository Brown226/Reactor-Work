/**
 * 审查结果卡的 display 构造（KnowledgeCheck / ReportReviewIssues）。
 *
 * 结构化结果到前端只有一条通道：`row.output.display`。工具输出经 resultBudget 后只剩文本，
 * `state.metadata` 里也只有 schemaVersion/serialization，所以**不在这里产出 display 就等于
 * 前端没有卡片**——审查卡片最初「全是文字、看不到卡」就是缺了这一步。
 *
 * 三条约定：
 *  1. 不解析、不重算：只做 `safeParse` + 限长 + 拷贝。判定逻辑在工具里，display 只负责搬运。
 *  2. 逐字段限长（`boundDisplayText`）：display 不走 resultBudget，进实时事件与持久化 metadata
 *     之前必须自己封顶，否则一次 200 条问题的审查会把它撑成大对象。
 *  3. 超上限如实计数（`droppedIssues`）：卡片要写明「仅显示前 N 条」，不能假装完整。
 */
import {
  KNOWLEDGE_CHECK_TOOL_NAME,
  KnowledgeCheckOutputSchema,
  REPORT_REVIEW_ISSUES_TOOL_NAME,
  ReportReviewIssuesOutputSchema,
  REVIEW_DISPLAY_MAX_ISSUES,
  REVIEW_DISPLAY_MAX_MESSAGE_CHARS,
  REVIEW_DISPLAY_MAX_NOTICE_CHARS,
  REVIEW_DISPLAY_MAX_PATH_CHARS,
  REVIEW_DISPLAY_MAX_QUOTED_CHARS,
  REVIEW_DISPLAY_MAX_SUGGESTION_CHARS,
  REVIEW_DISPLAY_MAX_TERMS,
  REVIEW_DISPLAY_MAX_TERM_CHARS,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { boundDisplayText } from "./display-text.js";

const REVIEW_DISPLAY_MAX_NORMALIZED_CHARS = 300;
const REVIEW_DISPLAY_MAX_LIBRARY_NO_CHARS = 200;
const REVIEW_DISPLAY_MAX_LIBRARY_NAME_CHARS = 400;

type ReviewDisplayPayload = Extract<ToolResultDisplayPayload, { kind: "review_issues" }>;
type ReviewDisplayIssue = ReviewDisplayPayload["issues"][number];

function bound(value: string | null | undefined, maxChars: number): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return boundDisplayText(value, maxChars).value;
}

function boundTerms(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return values
    .slice(0, REVIEW_DISPLAY_MAX_TERMS)
    .map((item) => bound(item, REVIEW_DISPLAY_MAX_TERM_CHARS))
    .filter((item): item is string => item !== null);
}

function boundIssues(issues: readonly ReviewDisplayIssue[]): {
  issues: ReviewDisplayIssue[];
  droppedIssues: number;
} {
  const kept = issues.slice(0, REVIEW_DISPLAY_MAX_ISSUES).map((issue) => ({
    ...issue,
    quoted: boundDisplayText(issue.quoted, REVIEW_DISPLAY_MAX_QUOTED_CHARS).value,
    message: boundDisplayText(issue.message, REVIEW_DISPLAY_MAX_MESSAGE_CHARS).value,
    suggestion: bound(issue.suggestion, REVIEW_DISPLAY_MAX_SUGGESTION_CHARS),
    ...(issue.normalized !== undefined
      ? { normalized: boundDisplayText(issue.normalized, REVIEW_DISPLAY_MAX_NORMALIZED_CHARS).value }
      : {}),
    ...(issue.libraryNo !== undefined
      ? { libraryNo: bound(issue.libraryNo, REVIEW_DISPLAY_MAX_LIBRARY_NO_CHARS) }
      : {}),
    ...(issue.libraryName !== undefined
      ? { libraryName: bound(issue.libraryName, REVIEW_DISPLAY_MAX_LIBRARY_NAME_CHARS) }
      : {}),
  }));
  return { issues: kept, droppedIssues: Math.max(0, issues.length - kept.length) };
}

function createKnowledgeCheckDisplay(output: unknown): ReviewDisplayPayload | undefined {
  const parsed = KnowledgeCheckOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const bounded = boundIssues(
    data.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      quoted: issue.quoted,
      message: issue.message,
      line: issue.line,
      startOffset: issue.startOffset,
      endOffset: issue.endOffset,
      suggestion: issue.suggestion,
      normalized: issue.normalized,
      libraryNo: issue.libraryNo,
      libraryName: issue.libraryName,
      ...(issue.libraryStatus !== null ? { libraryStatus: issue.libraryStatus } : {}),
    })),
  );
  return {
    kind: "review_issues",
    action: data.action,
    stale: data.stale,
    textPath: bound(data.textPath, REVIEW_DISPLAY_MAX_PATH_CHARS),
    sourcePath: null,
    notice: bound(data.notice, REVIEW_DISPLAY_MAX_NOTICE_CHARS),
    summary: data.summary ? { ...data.summary } : null,
    issues: bounded.issues,
    droppedIssues: bounded.droppedIssues,
    whitelisted: boundTerms(data.whitelisted),
    remaining: boundTerms(data.remaining),
  };
}

function createReportIssuesDisplay(output: unknown): ReviewDisplayPayload | undefined {
  const parsed = ReportReviewIssuesOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  const bounded = boundIssues(
    data.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      quoted: issue.quoted,
      message: issue.message,
      line: issue.line,
      startOffset: issue.startOffset,
      endOffset: issue.endOffset,
      suggestion: issue.suggestion,
      occurrences: issue.occurrences,
      matchedOccurrence: issue.matchedOccurrence,
      matchKind: issue.matchKind,
      located: issue.located,
    })),
  );
  return {
    kind: "review_issues",
    action: "issues",
    stale: false,
    textPath: bound(data.textPath, REVIEW_DISPLAY_MAX_PATH_CHARS),
    sourcePath: bound(data.sourcePath, REVIEW_DISPLAY_MAX_PATH_CHARS),
    notice: bound(data.notice, REVIEW_DISPLAY_MAX_NOTICE_CHARS),
    summary: { ...data.summary },
    issues: bounded.issues,
    droppedIssues: bounded.droppedIssues,
    whitelisted: [],
    remaining: [],
  };
}

export function createReviewResultDisplay(
  toolName: string,
  output: unknown,
): ReviewDisplayPayload | undefined {
  if (toolName === KNOWLEDGE_CHECK_TOOL_NAME) return createKnowledgeCheckDisplay(output);
  if (toolName === REPORT_REVIEW_ISSUES_TOOL_NAME) return createReportIssuesDisplay(output);
  return undefined;
}
