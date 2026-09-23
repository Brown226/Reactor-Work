/**
 * 审查问题条（共用行组件）。
 *
 * 两个来源共用同一行：`KnowledgeCheck`（标准引用自检，确定性判定）与 `ReportReviewIssues`
 * （模型自述型审查的定位结果）。共用是刻意的——它们的外观、点击行为、严重度口径必须一致，
 * 否则同一排审查按钮点下去会得到两套观感，用户还得重新学一遍。
 *
 * 点击行为：打开被审正文快照并滚到该位置高亮。没有快照（或问题没定位到）时保持只读，
 * **不装成可点** —— 点了跳到无关位置比不能点更误导复核者。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ReviewIssueView } from "@/ToolCallBlocks/knowledgeCheckResult.js";

export const REVIEW_ISSUE_SEVERITY_STYLES: Record<ReviewIssueView["severity"], string> = {
  error: "border-destructive/40 bg-destructive/5",
  warning: "border-amber-500/40 bg-amber-500/5",
  info: "border-border bg-surface",
  none: "border-border bg-surface",
};

export const REVIEW_ISSUE_SEVERITY_DOTS: Record<ReviewIssueView["severity"], string> = {
  error: "bg-destructive",
  warning: "bg-amber-500",
  info: "bg-foreground-subtle",
  none: "bg-foreground-subtlest",
};

export interface ReviewIssueRowProps {
  issue: ReviewIssueView;
  /** 已解析的类别标签（调用方决定用 i18n 类别名还是规则码） */
  label: string;
  /** 可点条件：有正文快照、有打开回调、且本条确实定位到了 */
  canOpen: boolean;
  onOpen: () => void;
  /** 片段未在正文中出现：显式标注，不给行号也不给偏移 */
  unlocated?: boolean;
}

export function ReviewIssueRow({ issue, label, canOpen, onOpen, unlocated }: ReviewIssueRowProps) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={canOpen ? onOpen : undefined}
      className={cn(
        "flex w-full flex-col gap-1 rounded border p-2 text-left transition-colors",
        REVIEW_ISSUE_SEVERITY_STYLES[issue.severity],
        canOpen ? "cursor-pointer hover:border-foreground/40" : "",
      )}
    >
      <span className="flex items-center gap-2 text-[11px]">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", REVIEW_ISSUE_SEVERITY_DOTS[issue.severity])}
        />
        <span className="font-medium">{label}</span>
        {unlocated ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-foreground-subtle">
            {intl.formatMessage({ id: "review.issue.unlocated" })}
          </span>
        ) : issue.line > 0 ? (
          <span className="text-foreground-subtle">
            {intl.formatMessage({ id: "review.card.line" }, { line: issue.line })}
          </span>
        ) : null}
        {!unlocated && issue.occurrences > 1 ? (
          <span className="text-foreground-subtle">
            {intl.formatMessage(
              { id: "review.card.occurrence" },
              { index: issue.matchedOccurrence, total: issue.occurrences },
            )}
          </span>
        ) : null}
      </span>
      <span className="font-mono text-ui-sm break-all">{issue.quoted}</span>
      <span className="text-ui-sm text-foreground-subtle">{issue.message}</span>
      {issue.suggestion ? (
        <span className="text-ui-sm">
          {intl.formatMessage({ id: "review.card.suggestion" })}：{issue.suggestion}
        </span>
      ) : null}
    </button>
  );
}
