/**
 * KnowledgeCheck 工具行（文件审查板块 §3.2）。
 *
 * 与 `ReportReviewIssues` 同构：**这里只留一行摘要**。两类结果（标准引用自检 / 术语白名单）
 * 都汇进轮尾正文下方的统一面板（`review/ReviewResultPanel.tsx`）——自检的八个判定类别在那里是
 * 带计数的分组，术语是两组词条；结论不该在过程里再摊一遍。
 */
import { AlertTriangleIcon, CheckCircle2Icon, FileSearchIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { readKnowledgeResult } from "@/ToolCallBlocks/knowledgeCheckResult.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const KNOWLEDGE_CHECK_TOOL_ICON = (
  <FileSearchIcon className="size-4 shrink-0 text-foreground-subtle" />
);

export function KnowledgeCheckToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const result = useMemo(() => readKnowledgeResult(toolCall.raw), [toolCall.raw]);

  // 只处理 KnowledgeCheck 自己的两种结果：`issues` 是 ReportReviewIssues 的，走它自己的渲染器。
  if (!result || result.kind === "issues") return null;

  if (result.kind === "terminology") {
    const primary = result.stale
      ? intl.formatMessage({ id: "review.terminology.stale" })
      : intl.formatMessage(
          { id: "review.terminology.summary" },
          { hit: result.whitelisted.length, remaining: result.remaining.length },
        );
    return (
      <ToolLayout
        toolId={toolCall.toolId}
        icon={KNOWLEDGE_CHECK_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={intl.formatMessage({ id: "review.tool.terminology" })}
        primaryText={primary}
      />
    );
  }

  const summary = result.summary;
  const primary = result.stale
    ? intl.formatMessage({ id: "review.standards.stale" })
    : summary
      ? intl.formatMessage(
          { id: "review.standards.summary" },
          { total: summary.total, ok: summary.ok, problems: summary.total - summary.ok },
        )
      : intl.formatMessage({ id: "review.standards.noIssues" }, { total: result.issues.length });

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={KNOWLEDGE_CHECK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={intl.formatMessage({ id: "review.tool.standards" })}
      primaryText={primary}
      statusLabel={
        !result.stale && summary && summary.total > summary.ok ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <AlertTriangleIcon className="size-3.5" />
            {summary.total - summary.ok}
          </span>
        ) : !result.stale ? (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-500">
            <CheckCircle2Icon className="size-3.5" />
          </span>
        ) : undefined
      }
    />
  );
}
