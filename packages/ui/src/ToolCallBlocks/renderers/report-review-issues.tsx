/**
 * ReportReviewIssues 结果卡片（文件审查板块 §3.3）。
 *
 * 与「标准引用自检」卡片是同一套外观与行为 —— 差别只在问题条的分类标签：标准自检是固定八类
 * （废止/未注年代号/…），这里是模型给的规则码（`TYPO-001` / `CONSISTENCY` / `CONTRACT-PAYMENT`），
 * 直接显示规则码，不硬套八类标签。
 *
 * 未定位的条目**不装成可点**：偏移是 -1，点了会跳到无关位置；这类问题在报告里也要求写明
 * 「无法定位」。
 */
import { AlertTriangleIcon, CheckCircle2Icon, ListChecksIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ReviewIssueRow } from "@/ToolCallBlocks/renderers/reviewIssueRow.js";
import { readKnowledgeResult, type ReviewIssueView } from "@/ToolCallBlocks/knowledgeCheckResult.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const REVIEW_ISSUES_TOOL_ICON = (
  <ListChecksIcon className="size-4 shrink-0 text-foreground-subtle" />
);

export function ReportReviewIssuesToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const result = useMemo(() => readKnowledgeResult(toolCall.raw), [toolCall.raw]);
  const onOpenCodeViewer = context.onOpenCodeViewer;

  const view = result?.kind === "issues" ? result : null;
  const textPath = view?.textPath ?? null;
  const sourcePath = view?.sourcePath ?? null;

  const openIssue = useCallback(
    (issue: ReviewIssueView) => {
      if (!textPath || !onOpenCodeViewer || !issue.located || issue.startOffset < 0) return;
      // 先开原始文档（docx/xlsx/…）：精确到字符的高亮只能落在提取正文上（Office 预览没有文本层
      // 定位），但用户核对时多数时候更想看原件的版面，所以两个标签一起给：原件在前、正文在后，
      // 高亮的那一页留在最上层。
      if (sourcePath && sourcePath !== textPath) {
        onOpenCodeViewer({
          type: "file",
          title: sourcePath.replaceAll("\\", "/").split("/").pop() ?? sourcePath,
          path: sourcePath,
          workspacePath: context.workspacePath,
        });
      }
      onOpenCodeViewer({
        type: "code-review",
        title: intl.formatMessage({ id: "review.card.title" }),
        path: textPath,
        workspacePath: context.workspacePath,
        review: {
          requestId: `${textPath}:${issue.startOffset}:${issue.code}:${Date.now()}`,
          title: issue.code,
          body: issue.suggestion
            ? `${issue.message}\n\n${intl.formatMessage({ id: "review.card.suggestion" })}：${issue.suggestion}`
            : issue.message,
          severity: issue.severity === "none" ? "info" : issue.severity,
          ...(issue.line > 0 ? { startLine: issue.line, endLine: issue.line } : {}),
          startOffset: issue.startOffset,
          endOffset: issue.endOffset,
          ...(issue.quoted ? { quote: issue.quoted } : {}),
        },
      });
    },
    [context.workspacePath, intl, onOpenCodeViewer, sourcePath, textPath],
  );

  if (!view) return null;

  const summary = view.summary;
  const problems = view.issues.filter((issue) => issue.severity !== "none");
  const primary = summary
    ? intl.formatMessage(
        { id: "review.issues.summary" },
        { total: summary.total, problems: summary.error + summary.warning + summary.info },
      )
    : intl.formatMessage({ id: "review.issues.noIssues" }, { total: view.issues.length });

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={REVIEW_ISSUES_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={problems.length > 0 || Boolean(view.notice)}
      // 一次性默认展开：审查结论就是这个板块的主产物，折叠成一行时用户会以为「没有卡片」。
      // 只展开有内容的卡（空结果展开等于加噪音），展开后用户仍可手动收起。
      autoOpen={problems.length > 0}
      kindLabel={intl.formatMessage({ id: "review.tool.issues" })}
      primaryText={primary}
      statusLabel={
        summary && summary.error > 0 ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertTriangleIcon className="size-3.5" />
            {summary.error}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-500">
            <CheckCircle2Icon className="size-3.5" />
          </span>
        )
      }
      content={
        <div className="flex flex-col gap-2">
          {summary ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground-subtle">
              {(
                [
                  ["review.severity.error", summary.error],
                  ["review.severity.warning", summary.warning],
                  ["review.severity.info", summary.info],
                  ["review.issue.unlocated", summary.unlocated],
                ] as const
              )
                .filter(([, count]) => count > 0)
                .map(([key, count]) => (
                  <span key={key}>
                    {intl.formatMessage({ id: key })} {count}
                  </span>
                ))}
            </div>
          ) : null}
          {/* 工具侧的定位边界必须显式展示：归一化命中的位置是近似值，未定位的条目没有位置 */}
          {view.notice ? (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-ui-sm">
              {view.notice}
            </div>
          ) : null}
          {problems.map((issue) => (
            <ReviewIssueRow
              key={`${issue.startOffset}:${issue.code}:${issue.quoted}`}
              issue={issue}
              label={issue.code}
              unlocated={!issue.located}
              canOpen={Boolean(textPath) && Boolean(onOpenCodeViewer) && issue.located}
              onOpen={() => openIssue(issue)}
            />
          ))}
          {problems.length === 0 ? (
            <div className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "review.issues.clean" })}
            </div>
          ) : null}
          {textPath ? (
            <div className="text-[11px] text-foreground-subtle">
              {intl.formatMessage({ id: "review.card.textPath" })}：{textPath}
              {sourcePath ? `（来源：${sourcePath}）` : ""}
            </div>
          ) : null}
        </div>
      }
    />
  );
}
