/**
 * `ReportReviewIssues` 工具行（文件审查板块 §3.2）。
 *
 * 这里**只留一行摘要**，不再是卡片：审查结论整体挂在轮尾正文下方的统一面板
 * （`review/ReviewResultPanel.tsx`），问题条在那里分组显示并可点击定位。工具行属于「工作过程」，
 * 它要回答的是「这一步做了什么」，而不是把结论再铺一遍 —— 同一份结果在两处渲染，用户会先怀疑
 * 到底哪一份才是最新的。
 */
import { AlertTriangleIcon, CheckCircle2Icon, ListChecksIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { readKnowledgeResult } from "@/ToolCallBlocks/knowledgeCheckResult.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const REVIEW_ISSUES_TOOL_ICON = (
  <ListChecksIcon className="size-4 shrink-0 text-foreground-subtle" />
);

export function ReportReviewIssuesToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const result = useMemo(() => readKnowledgeResult(toolCall.raw), [toolCall.raw]);

  const view = result?.kind === "issues" ? result : null;
  if (!view) return null;

  const summary = view.summary;
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
      canToggle={false}
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
    />
  );
}
