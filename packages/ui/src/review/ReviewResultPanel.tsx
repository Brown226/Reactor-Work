/**
 * 审查结果面板（`docs/审查板块-方案-v1.md` §3.2）。
 *
 * 一轮对话只有**一个**面板，挂在轮尾最终正文的下方、操作栏之上：本轮所有审查类工具结果
 * （标准引用自检 / 自述型审查 / 术语白名单）都在这里，按「来源文件 → 规则码」两级分组给计数。
 * 不再按工具调用拆卡、也不再一条问题一个卡片 —— 67 条问题在对话里铺成 67 个块之后，
 * 用户看到的是噪音而不是结论。
 *
 * 行是**密排**的：一行片段（mono，超长截断，悬停看全文）+ 一行说明。点击一条 = 打开原件 +
 * 打开带高亮的提取正文（`code-review` 源）。没定位到的条目**不装成可点**：偏移是 -1，点了会跳到
 * 无关位置，那比不能点更误导复核者。
 */
import { ClipboardListIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { Section, TermChips, issueCodeLabel } from "@/review/ReviewResultRows.js";
import {
  REVIEW_ISSUE_LABEL_KEYS,
  reviewIssueCodeFamily,
  reviewIssueFamilyLabelKey,
  shouldShowSectionTitles,
  type ReviewResultGathering,
  type ReviewResultItem,
} from "@/review/reviewResultGroups.js";


/** 片段数量超过这个量级时分组默认收起：面板要能一眼看完，而不是又变成一堵墙。 */
const GROUP_AUTO_OPEN_MAX_ITEMS = 20;

export interface ReviewResultPanelProps {
  gathering: ReviewResultGathering;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/**
 * 原件预览能不能按片段标出高亮。
 *
 * - `.docx`：`docx-preview` 渲染成真实 DOM，按片段找 Range 即可。
 * - `.pdf`：`react-pdf` 默认渲染文本层（且有 `TextLayer.css` 定位），逐页搜到目标页后跳页再标。
 * - `.xlsx`/`.xls`：canvas 渲染，没有文本层，做不到 —— 退回「原件看版面 + 提取正文看高亮」两标签。
 *
 * 加新类型时**必须**同时在这里与消费方（docx 预览 / PDF 查看器）说清楚，否则用户点了没反应。
 */
function isQuoteHighlightableFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".docx") || lower.endsWith(".pdf");
}

export function ReviewResultPanel({
  gathering,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenCodeViewer,
}: ReviewResultPanelProps) {
  const { intl } = useZCodeIntl();
  const groupsDefaultOpen = gathering.totals.total <= GROUP_AUTO_OPEN_MAX_ITEMS;
  const showSectionTitles = shouldShowSectionTitles(gathering.sections);

  const openItem = useCallback(
    (item: ReviewResultItem) => {
      if (!onOpenCodeViewer || !item.located || !item.textPath) return;
      const scope = {
        ...(workspacePath ? { workspacePath } : {}),
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
      };
      // 定位卡内容在这里组装：原件预览没有评论面板，修改意见必须跟着定位一起过去。
      // 标题是**类别**（标点 / 已废止引用），码另给一格（标点-001）—— 两处同源会给用户
      // 看到重复的一段字（`标点-001 标点-001`）。
      const family = reviewIssueCodeFamily(item.code);
      const familyKey =
        REVIEW_ISSUE_LABEL_KEYS[family] ??
        REVIEW_ISSUE_LABEL_KEYS[item.code] ??
        reviewIssueFamilyLabelKey(family);
      const title = familyKey ? intl.formatMessage({ id: familyKey }) : family;
      const codeLabel = issueCodeLabel(intl, item.code);
      const note = {
        title,
        ...(codeLabel !== title ? { code: codeLabel } : {}),
        message: item.message,
        suggestion: item.suggestion,
        severity: item.severity === "none" ? "info" : item.severity,
        line: item.line,
      } as const;
      const highlight = {
        quote: item.quoted,
        occurrence: item.matchedOccurrence,
        focusRequestId: `${item.textPath}:${item.startOffset}:${item.code}:${Date.now()}`,
        note,
      };
      const hasOriginal = Boolean(item.sourcePath && item.sourcePath !== item.textPath);
      // 能在原件里标出这句话（docx 预览有 DOM 文本层）就**只开原件** —— 用户要核对的版面与上下文
      // 都由原件说了算，再开一个提取正文标签只是多一个要关的东西。
      if (hasOriginal && isQuoteHighlightableFile(item.sourcePath!)) {
        onOpenCodeViewer({
          type: "file",
          title: basename(item.sourcePath!),
          path: item.sourcePath!,
          ...scope,
          quoteHighlight: highlight,
        });
        return;
      }
      // 原件标不出来（xlsx 是 canvas、扫描件 PDF 没有文本层）或无原件：给原件 + 提取正文两个标签，
      // 高亮落在正文上且留在最上层。
      if (hasOriginal) {
        onOpenCodeViewer({
          type: "file",
          title: basename(item.sourcePath!),
          path: item.sourcePath!,
          ...scope,
        });
      }
      onOpenCodeViewer({
        type: "code-review",
        title: intl.formatMessage({ id: "review.card.title" }),
        path: item.textPath,
        ...scope,
        review: {
          requestId: highlight.focusRequestId,
          title: intl.formatMessage(
            { id: REVIEW_ISSUE_LABEL_KEYS[item.code] ?? "review.issue.unknown" },
            { code: item.code },
          ),
          body: item.suggestion
            ? `${item.message}\n\n${intl.formatMessage({ id: "review.card.suggestion" })}：${item.suggestion}`
            : item.message,
          severity: item.severity === "none" ? "info" : item.severity,
          // 提取正文按正文渲染（含高亮），不是源码：这条由面板声明，不靠扩展名猜。
          textFormat: "markdown",
          note,
          ...(item.line > 0 ? { startLine: item.line, endLine: item.line } : {}),
          ...(item.startOffset >= 0 ? { startOffset: item.startOffset } : {}),
          ...(item.endOffset >= 0 ? { endOffset: item.endOffset } : {}),
          ...(item.quoted ? { quote: item.quoted } : {}),
          // 渲染后的 markdown/Office 预览靠片段 + 序号重新定位（见 lib/quoteHighlightDom.ts）
          ...(item.matchedOccurrence > 1 ? { occurrence: item.matchedOccurrence } : {}),
        },
      });
    },
    [
      intl,
      onOpenCodeViewer,
      workspaceIdentity,
      workspacePath,
      workspaceRemoteSessionId,
    ],
  );

  if (!gathering.hasContent) return null;

  const severityChips = (
    [
      ["review.severity.error", gathering.totals.error],
      ["review.severity.warning", gathering.totals.warning],
      ["review.severity.info", gathering.totals.info],
    ] as const
  ).filter(([, count]) => count > 0);

  return (
    <section
      data-review-result-panel="true"
      className="flex w-full flex-col gap-2 rounded-xl border border-card-border bg-card p-3 text-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-ui-base font-medium leading-5">
          <ClipboardListIcon className="size-4 shrink-0 text-foreground-subtle" />
          {intl.formatMessage({ id: "review.panel.title" })}
        </span>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "review.panel.totals" }, { total: gathering.totals.total })}
        </span>
        {severityChips.map(([key, count]) => (
          <span key={key} className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: key })} {count}
          </span>
        ))}
        {gathering.passed > 0 ? (
          <span className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "review.panel.passed" }, { count: gathering.passed })}
          </span>
        ) : null}
      </header>

      {gathering.notices.map((notice) => (
        <div
          key={notice}
          className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-ui-sm"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
          <span>{notice}</span>
        </div>
      ))}
      {gathering.totals.unlocated > 0 ? (
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "review.panel.unlocated" },
            { count: gathering.totals.unlocated },
          )}
        </div>
      ) : null}
      {gathering.totals.total === 0 && gathering.terminology.length === 0 ? (
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "review.issues.clean" })}
        </div>
      ) : null}

      {gathering.sections.map((section) => (
        <Section
          key={section.key}
          section={section}
          showTitle={showSectionTitles}
          defaultOpen={groupsDefaultOpen}
          onOpenItem={openItem}
          canOpen={Boolean(onOpenCodeViewer)}
        />
      ))}

      {gathering.terminology.map((card) => (
        <div key={card.key} className="flex flex-col gap-1.5 border-t border-border/50 pt-2">
          <div className="text-ui-sm font-medium">{intl.formatMessage({ id: "review.tool.terminology" })}</div>
          {card.stale ? (
            <div className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "review.terminology.stale" })}
            </div>
          ) : null}
          <TermChips
            label={intl.formatMessage({ id: "review.terminology.whitelisted" })}
            terms={card.whitelisted}
          />
          <TermChips
            label={intl.formatMessage({ id: "review.terminology.remaining" })}
            terms={card.remaining}
          />
        </div>
      ))}
    </section>
  );
}
