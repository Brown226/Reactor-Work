/**
 * KnowledgeCheck 工具结果卡片（文件审查板块 §3.3）。
 *
 * 存在的理由：标准引用自检的结论是一串**带原文位置的判定**，塞进普通文本会变成一大段
 * 无法核对的清单。这里把它渲染成可点击的问题条 —— 点一条就打开被审文本并滚到该位置高亮，
 * 复核者不用手工搜索原文。
 *
 * 打开的是工具落盘的**正文快照**（`textPath`），不是原 docx：Office/PDF 没有文本层定位能力，
 * 而审查问题都带相对提取文本的字符偏移，两者必须用同一份文本才对得上（见方案 §3.3）。
 */
import { AlertTriangleIcon, CheckCircle2Icon, FileSearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { ReviewIssueRow } from "@/ToolCallBlocks/renderers/reviewIssueRow.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import {
  actionableIssues,
  compareIssues,
  readKnowledgeResult,
  type ReviewIssueView,
} from "@/ToolCallBlocks/knowledgeCheckResult.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const KNOWLEDGE_CHECK_TOOL_ICON = (
  <FileSearchIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** 结果里问题类别 → i18n 标签的 key（显式映射：codes 是接口契约，不能靠拼接字符串）。 */
const ISSUE_LABEL_KEYS: Record<string, string> = {
  abolished: "review.issue.abolished",
  no_year: "review.issue.noYear",
  no_version: "review.issue.noVersion",
  not_in_library: "review.issue.notInLibrary",
  family_not_collected: "review.issue.familyNotCollected",
  missing: "review.issue.missing",
  upcoming: "review.issue.upcoming",
  ok: "review.issue.ok",
};

export function KnowledgeCheckToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const result = useMemo(() => readKnowledgeResult(toolCall.raw), [toolCall.raw]);
  const onOpenCodeViewer = context.onOpenCodeViewer;

  const textPath = result?.kind === "standards" ? result.textPath : null;

  const openIssue = useCallback(
    (issue: ReviewIssueView) => {
      if (!textPath || !onOpenCodeViewer) return;
      onOpenCodeViewer({
        type: "code-review",
        title: intl.formatMessage({ id: "review.card.title" }),
        path: textPath,
        workspacePath: context.workspacePath,
        review: {
          // requestId 每次递增语义：同一个文件重复点击也要重新定位/滚动（见 code-viewer 的 focusRequestId）
          requestId: `${textPath}:${issue.startOffset}:${issue.code}:${Date.now()}`,
          title: intl.formatMessage(
            { id: ISSUE_LABEL_KEYS[issue.code] ?? "review.issue.unknown" },
            { code: issue.code },
          ),
          body: issue.suggestion
            ? `${issue.message}\n\n${intl.formatMessage({ id: "review.card.suggestion" })}：${issue.suggestion}`
            : issue.message,
          severity: issue.severity === "none" ? "info" : issue.severity,
          ...(issue.line > 0 ? { startLine: issue.line, endLine: issue.line } : {}),
          ...(issue.startOffset >= 0 ? { startOffset: issue.startOffset } : {}),
          ...(issue.endOffset >= 0 ? { endOffset: issue.endOffset } : {}),
          ...(issue.quoted ? { quote: issue.quoted } : {}),
        },
      });
    },
    [context.workspacePath, intl, onOpenCodeViewer, textPath],
  );

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
        canToggle={result.whitelisted.length > 0 || result.remaining.length > 0}
        autoOpen={result.whitelisted.length > 0 || result.remaining.length > 0}
        kindLabel={intl.formatMessage({ id: "review.tool.terminology" })}
        primaryText={primary}
        content={
          <div className="flex flex-col gap-1.5 text-ui-sm">
            {result.whitelisted.length > 0 ? (
              <div>
                <div className="text-foreground-subtle">
                  {intl.formatMessage({ id: "review.terminology.whitelisted" })}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {result.whitelisted.map((term) => (
                    <span key={term} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                      {term}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {result.remaining.length > 0 ? (
              <div>
                <div className="text-foreground-subtle">
                  {intl.formatMessage({ id: "review.terminology.remaining" })}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {result.remaining.map((term) => (
                    <span key={term} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                      {term}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        }
      />
    );
  }

  const issues = actionableIssues(result.issues).slice().sort(compareIssues);
  const summary = result.summary;
  const primary = result.stale
    ? intl.formatMessage({ id: "review.standards.stale" })
    : summary
      ? intl.formatMessage(
          { id: "review.standards.summary" },
          {
            total: summary.total,
            ok: summary.ok,
            problems: summary.total - summary.ok,
          },
        )
      : intl.formatMessage({ id: "review.standards.noIssues" }, { total: result.issues.length });

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={KNOWLEDGE_CHECK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={issues.length > 0 || Boolean(result.notice) || result.stale}
      // 同 ReportReviewIssues：结论是主产物，默认展开一行摘要用户会当成「没卡片」。
      autoOpen={issues.length > 0 || result.stale}
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
      content={
        <div className="flex flex-col gap-2">
          {/* 缓存缺失时必须显式说出来：不说就等于把「库没同步」伪装成「查过了没问题」 */}
          {result.stale && result.notice ? (
            <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-ui-sm">
              {result.notice}
            </div>
          ) : null}
          {!result.stale && summary ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground-subtle">
              {(
                [
                  ["review.issue.abolished", summary.abolished],
                  ["review.issue.noYear", summary.noYear],
                  ["review.issue.noVersion", summary.noVersion],
                  ["review.issue.notInLibrary", summary.notInLibrary],
                  ["review.issue.familyNotCollected", summary.familyNotCollected],
                  ["review.issue.missing", summary.missing],
                  ["review.issue.upcoming", summary.upcoming],
                  ["review.issue.ok", summary.ok],
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
          {issues.map((issue) => (
            <ReviewIssueRow
              key={`${issue.startOffset}:${issue.code}:${issue.quoted}`}
              issue={issue}
              label={intl.formatMessage({
                id: ISSUE_LABEL_KEYS[issue.code] ?? "review.issue.unknown",
              })}
              canOpen={Boolean(textPath) && Boolean(onOpenCodeViewer)}
              onOpen={() => openIssue(issue)}
            />
          ))}
          {issues.length === 0 && !result.stale ? (
            <div className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "review.standards.clean" })}
            </div>
          ) : null}
          {textPath ? (
            <div className="text-[11px] text-foreground-subtle">
              {intl.formatMessage({ id: "review.card.textPath" })}：{textPath}
            </div>
          ) : null}
        </div>
      }
    />
  );
}
