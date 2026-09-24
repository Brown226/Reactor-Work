/**
 * 审查结果面板（`docs/审查板块-方案-v1.md` §3.2）。
 *
 * 一轮对话只有**一个**面板，挂在轮尾最终正文的下方、操作栏之上：本轮所有审查类工具结果
 * （标准引用自检 / 自述型审查 / 术语白名单）都在这里，按「来源文件 → 规则码族」两级分组给计数。
 * 不再按工具调用拆卡、也不再一条问题一个卡片 —— 67 条问题在对话里铺成 67 个块之后，
 * 用户看到的是噪音而不是结论。
 *
 * 视觉语言（对齐 DESIGN.md：密排操作面板优于卡片装饰，层次靠描边/背景/缩进而非重阴影）：
 *   工具栏头部（标题 + 语义色计数 + 右侧采纳/一键修改，底部一条分隔线）
 *     └ 文件节（图标 + 名称 + 计数）→ 规则码族（可折叠）→ 问题行（严重度色条 + 绿色建议）
 * 字号一律 `text-ui-*`，计数与行号 `tabular-nums`。点击一条问题 = 打开原件并在原件里高亮；
 * 没定位到的条目**不装成可点**：偏移是 -1，点了会跳到无关位置，那比不能点更误导复核者。
 */
import {
  CheckCheckIcon,
  ClipboardListIcon,
  FileTextIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { QuoteHighlightNote, ReviewQuoteMarkTarget } from "@/lib/quoteSearch.js";
import { Section, TermChips, issueCodeLabel } from "@/review/ReviewResultRows.js";
import { useSendReviewFixRequest } from "@/review/useSendReviewFixRequest.js";
import { useReviewMarksStore } from "@/store/reviewMarksStore.js";
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
  /** 当前会话 id：一键修改要把指令发进这一轮会话 */
  sessionId?: string;
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

/** 采纳载荷：定位卡的对号与面板行上的对号必须产出同一份数据，所以只在这里造一次。 */
function buildMarkForItem(item: ReviewResultItem, note: QuoteHighlightNote): ReviewQuoteMarkTarget {
  return {
    key: `${item.textPath}:${item.startOffset}:${item.code}`,
    code: note.code ?? item.code,
    title: note.title,
    severity: note.severity ?? "warning",
    quoted: item.quoted,
    matchedOccurrence: item.matchedOccurrence,
    message: item.message,
    suggestion: item.suggestion,
    line: item.line,
    sourcePath: item.sourcePath,
    textPath: item.textPath,
  };
}

/** 类别名的解析（标准判定码走既有译名，族名走标签表，都没有就原样）：面板与定位卡共用。 */
function resolveIssueTitle(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  item: ReviewResultItem,
): string {
  const family = reviewIssueCodeFamily(item.code);
  const familyKey =
    REVIEW_ISSUE_LABEL_KEYS[family] ??
    REVIEW_ISSUE_LABEL_KEYS[item.code] ??
    reviewIssueFamilyLabelKey(family);
  return familyKey ? intl.formatMessage({ id: familyKey }) : family;
}

export function ReviewResultPanel({
  gathering,
  sessionId,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenCodeViewer,
}: ReviewResultPanelProps) {
  const { intl } = useZCodeIntl();
  const fix = useSendReviewFixRequest(sessionId ?? null);
  const [sendFailed, setSendFailed] = useState(false);
  // 行上的采纳态与定位卡的对号共用同一份 store：一处勾上，另一处立刻是勾上的。
  const marks = useReviewMarksStore((state) => state.marks);
  const toggleMark = useReviewMarksStore((state) => state.toggle);
  const markedKeys = useMemo(() => new Set(Object.keys(marks)), [marks]);

  // 行上的对号与定位卡的对号共用同一份载荷；已采纳再点一次 = 取消采纳。
  const toggleRowMark = useCallback(
    (item: ReviewResultItem) => {
      const title = resolveIssueTitle(intl, item);
      const codeLabel = issueCodeLabel(intl, item.code);
      toggleMark(
        buildMarkForItem(item, {
          title,
          ...(codeLabel !== title ? { code: codeLabel } : {}),
          message: item.message,
          suggestion: item.suggestion,
          severity: item.severity === "none" ? "info" : item.severity,
          line: item.line,
        }),
        Date.now(),
      );
    },
    [intl, toggleMark],
  );
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
      const title = resolveIssueTitle(intl, item);
      const codeLabel = issueCodeLabel(intl, item.code);
      const note = {
        title,
        ...(codeLabel !== title ? { code: codeLabel } : {}),
        message: item.message,
        suggestion: item.suggestion,
        severity: item.severity === "none" ? "info" : item.severity,
        line: item.line,
      } as const;
      const mark = buildMarkForItem(item, note);
      const highlight = {
        quote: item.quoted,
        occurrence: item.matchedOccurrence,
        focusRequestId: `${item.textPath}:${item.startOffset}:${item.code}:${Date.now()}`,
        note,
        mark,
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
          mark,
          ...(item.line > 0 ? { startLine: item.line, endLine: item.line } : {}),
          ...(item.startOffset >= 0 ? { startOffset: item.startOffset } : {}),
          ...(item.endOffset >= 0 ? { endOffset: item.endOffset } : {}),
          ...(item.quoted ? { quote: item.quoted } : {}),
          // 渲染后的 markdown/Office 预览靠片段 + 序号重新定位（见 lib/quoteHighlightDom.ts）
          ...(item.matchedOccurrence > 1 ? { occurrence: item.matchedOccurrence } : {}),
        },
      });
    },
    [intl, onOpenCodeViewer, workspaceIdentity, workspacePath, workspaceRemoteSessionId],
  );

  if (!gathering.hasContent) return null;

  // 严重度计数带语义色（DESIGN.md：只给真实语义状态上色）；数字用 tabular-nums，计数变化不抖。
  const severityChips = (
    [
      ["review.severity.error", gathering.totals.error, "bg-destructive", "text-destructive"],
      ["review.severity.warning", gathering.totals.warning, "bg-warning", "text-warning"],
      [
        "review.severity.info",
        gathering.totals.info,
        "bg-foreground-subtle",
        "text-foreground-subtle",
      ],
    ] as const
  ).filter(([, count]) => count > 0);

  return (
    <section
      data-review-result-panel="true"
      className="flex w-full flex-col gap-2.5 rounded-xl border border-card-border bg-card p-4 text-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 pb-2.5">
        <span className="flex items-center gap-2 text-ui-base font-medium leading-5">
          <ClipboardListIcon className="size-4 shrink-0 text-foreground-subtle" />
          {intl.formatMessage({ id: "review.panel.title" })}
        </span>
        <span className="text-ui-sm tabular-nums text-foreground-subtle">
          {intl.formatMessage({ id: "review.panel.totals" }, { total: gathering.totals.total })}
        </span>
        {severityChips.map(([id, count, dotClass, textClass]) => (
          <span key={id} className="flex items-center gap-1 text-ui-xs tabular-nums">
            <span className={cn("size-1.5 rounded-full", dotClass)} />
            <span className={textClass}>{count}</span>
            <span className="text-foreground-subtle">{intl.formatMessage({ id })}</span>
          </span>
        ))}
        {gathering.passed > 0 ? (
          <span className="text-ui-xs tabular-nums text-success">
            {intl.formatMessage({ id: "review.panel.passed" }, { count: gathering.passed })}
          </span>
        ) : null}
        {fix.count > 0 ? (
          // 采纳了才出现：没标记时这个按钮点下去无事可做，占位只是噪音。
          <span className="ml-auto flex items-center gap-2">
            <span className="text-ui-xs tabular-nums text-success">
              {intl.formatMessage({ id: "review.mark.count" }, { count: fix.count })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="review-apply-marks"
              disabled={fix.sending}
              onClick={() => {
                void fix.send().then((result) => setSendFailed(!result.ok));
              }}
            >
              <CheckCheckIcon className="size-3.5" />
              {intl.formatMessage({ id: "review.mark.apply" })}
            </Button>
          </span>
        ) : null}
      </header>

      {sendFailed ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-ui-sm text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{intl.formatMessage({ id: "review.mark.applyFailed" })}</span>
        </div>
      ) : null}
      {/* 提示分两级：`stale`（结论不可用）用警告块；其余是「读结论前该知道的边界」，
          降级成一行弱提示 —— 结论已经够多，不该再让说明去抢注意力。 */}
      {gathering.notices.map((notice) =>
        gathering.stale ? (
          <div
            key={notice}
            className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-ui-sm text-foreground"
          >
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>{notice}</span>
          </div>
        ) : (
          <div
            key={notice}
            className="flex items-start gap-2 px-1 text-ui-xs text-foreground-subtlest"
          >
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        ),
      )}
      {gathering.totals.unlocated > 0 ? (
        <div className="px-1 text-ui-xs text-foreground-subtlest">
          {intl.formatMessage(
            { id: "review.panel.unlocated" },
            { count: gathering.totals.unlocated },
          )}
        </div>
      ) : null}
      {gathering.totals.total === 0 && gathering.terminology.length === 0 ? (
        <div className="px-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "review.issues.clean" })}
        </div>
      ) : null}

      {gathering.sections.map((section, index) => (
        <Section
          key={section.key}
          section={section}
          showTitle={showSectionTitles}
          separated={index > 0}
          defaultOpen={groupsDefaultOpen}
          onOpenItem={openItem}
          canOpen={Boolean(onOpenCodeViewer)}
          markedKeys={markedKeys}
          onToggleMark={toggleRowMark}
        />
      ))}

      {/* 术语白名单与节同一套语言：图标 + 名称 + 计数 + 词条 chip（不折叠，它本身就是结论的一部分） */}
      {gathering.terminology.map((card, index) => (
        <div
          key={card.key}
          className={cn(
            "flex flex-col gap-1.5",
            (index > 0 || gathering.sections.length > 0) && "border-t border-border/60 pt-2",
          )}
        >
          <div className="flex items-center gap-2 px-2 text-ui-base font-medium">
            <FileTextIcon className="size-3.5 shrink-0 text-foreground-subtle" />
            {intl.formatMessage({ id: "review.tool.terminology" })}
            <span className="text-ui-xs tabular-nums text-foreground-subtlest">
              {intl.formatMessage(
                { id: "review.panel.count" },
                { count: card.whitelisted.length + card.remaining.length },
              )}
            </span>
          </div>
          {card.stale ? (
            <div className="px-2 text-ui-xs text-warning">
              {intl.formatMessage({ id: "review.terminology.stale" })}
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5 px-2 pb-1">
            <TermChips
              label={intl.formatMessage({ id: "review.terminology.whitelisted" })}
              terms={card.whitelisted}
            />
            <TermChips
              label={intl.formatMessage({ id: "review.terminology.remaining" })}
              terms={card.remaining}
            />
          </div>
        </div>
      ))}
    </section>
  );
}
