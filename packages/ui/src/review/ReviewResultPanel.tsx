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
import { ChevronRightIcon, ClipboardListIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  REVIEW_ISSUE_LABEL_KEYS,
  reviewIssueCodeFamily,
  reviewIssueCodeSuffix,
  reviewIssueFamilyLabelKey,
  shouldShowSectionTitles,
  type ReviewResultCodeGroup,
  type ReviewResultGathering,
  type ReviewResultItem,
  type ReviewResultSection,
} from "@/review/reviewResultGroups.js";

const SEVERITY_DOTS: Record<ReviewResultItem["severity"], string> = {
  error: "bg-destructive",
  warning: "bg-amber-500",
  info: "bg-foreground-subtle",
  none: "bg-foreground-subtlest",
};

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
 * 行上的规则码：族名有中文标签就把族名换掉，序号原样保留（`PUNCT-001` → `标点-001`）。
 * 序号不翻译——它是这条问题在族内的身份，改了就没有可引用的编号了。
 */
function issueCodeLabel(intl: ReturnType<typeof useZCodeIntl>["intl"], code: string): string {
  const key = reviewIssueFamilyLabelKey(reviewIssueCodeFamily(code));
  return key ? `${intl.formatMessage({ id: key })}${reviewIssueCodeSuffix(code)}` : code;
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
      // 两个标签一起给：原件看版面，提取正文看命中位置（高亮那一页留在最上层）。
      if (item.sourcePath && item.sourcePath !== item.textPath) {
        onOpenCodeViewer({
          type: "file",
          title: basename(item.sourcePath),
          path: item.sourcePath,
          ...scope,
        });
      }
      onOpenCodeViewer({
        type: "code-review",
        title: intl.formatMessage({ id: "review.card.title" }),
        path: item.textPath,
        ...scope,
        review: {
          requestId: `${item.textPath}:${item.startOffset}:${item.code}:${Date.now()}`,
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

function TermChips({ label, terms }: { label: string; terms: readonly string[] }) {
  if (terms.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-foreground-subtle">{label}</span>
      {terms.map((term) => (
        <span key={term} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
          {term}
        </span>
      ))}
    </div>
  );
}

function Section({
  section,
  showTitle,
  defaultOpen,
  canOpen,
  onOpenItem,
}: {
  section: ReviewResultSection;
  showTitle: boolean;
  defaultOpen: boolean;
  canOpen: boolean;
  onOpenItem: (item: ReviewResultItem) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-0.5">
      {showTitle ? (
        <div className="flex items-center gap-2 border-t border-border/50 pt-2 text-ui-sm font-medium">
          <span className="truncate">
            {section.sourcePath
              ? basename(section.sourcePath)
              : intl.formatMessage({ id: "review.panel.sourceless" })}
          </span>
          <span className="shrink-0 text-foreground-subtle">
            {intl.formatMessage({ id: "review.panel.count" }, { count: section.totals.total })}
          </span>
          {section.totals.unlocated > 0 ? (
            <span className="shrink-0 text-foreground-subtle">
              {intl.formatMessage({ id: "review.issue.unlocated" })} {section.totals.unlocated}
            </span>
          ) : null}
        </div>
      ) : null}
      {section.codeGroups.map((group) => (
        <CodeGroup
          key={group.key}
          group={group}
          defaultOpen={defaultOpen}
          canOpen={canOpen}
          onOpenItem={onOpenItem}
        />
      ))}
    </div>
  );
}

function CodeGroup({
  group,
  defaultOpen,
  canOpen,
  onOpenItem,
}: {
  group: ReviewResultCodeGroup;
  defaultOpen: boolean;
  canOpen: boolean;
  onOpenItem: (item: ReviewResultItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(defaultOpen);
  // 标准自检的判定码有固定译名；族名（`PUNCT` / `标点`）另有一张标签表。都没有就原样显示族名。
  const labelKey = REVIEW_ISSUE_LABEL_KEYS[group.family] ?? reviewIssueFamilyLabelKey(group.family);
  const label = labelKey ? intl.formatMessage({ id: labelKey }) : group.family;
  const totals = group.totals;
  const showCodePerItem = group.items.some((item) => item.code !== group.family);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-review-result-group={group.family}
          className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-ui-sm hover:bg-muted/50"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-foreground-subtle transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          />
          <span className="shrink-0 font-medium">{label}</span>
          <span className="shrink-0 text-foreground-subtle">
            {intl.formatMessage({ id: "review.panel.count" }, { count: totals.total })}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {(["error", "warning", "info"] as const)
              .filter((severity) => totals[severity] > 0)
              .map((severity) => (
                <span key={severity} className="flex items-center gap-1 text-[11px] text-foreground-subtle">
                  <span className={cn("size-1.5 rounded-full", SEVERITY_DOTS[severity])} />
                  {totals[severity]}
                </span>
              ))}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-1 pl-5 pt-1">
          {group.items.map((item) => (
            <IssueRow
              key={item.key}
              item={item}
              showCode={showCodePerItem}
              canOpen={canOpen}
              onOpen={() => onOpenItem(item)}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function IssueRow({
  item,
  showCode,
  canOpen,
  onOpen,
}: {
  item: ReviewResultItem;
  /** 同族里有多个具体规则码时逐行标出来，用户才能引用准确的码 */
  showCode: boolean;
  canOpen: boolean;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  const clickable = canOpen && item.located && Boolean(item.textPath);
  const meta = [
    !item.located
      ? intl.formatMessage({ id: "review.issue.unlocated" })
      : item.line > 0
        ? intl.formatMessage({ id: "review.card.line" }, { line: item.line })
        : null,
    clickable && item.occurrences > 1
      ? intl.formatMessage(
          { id: "review.card.occurrence" },
          { index: item.matchedOccurrence, total: item.occurrences },
        )
      : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? onOpen : undefined}
      title={[item.quoted, item.message, item.suggestion ? `${intl.formatMessage({ id: "review.card.suggestion" })}：${item.suggestion}` : null]
        .filter((entry): entry is string => Boolean(entry))
        .join("\n")}
      className={cn(
        "flex w-full items-start gap-2 rounded px-1 py-1 text-left",
        clickable ? "cursor-pointer hover:bg-muted/50" : "cursor-default",
      )}
    >
      <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", SEVERITY_DOTS[item.severity])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-mono text-ui-sm">{item.quoted}</span>
          {meta.length > 0 ? (
            <span className="shrink-0 text-[11px] text-foreground-subtle">{meta.join(" · ")}</span>
          ) : null}
          {showCode ? (
            <span className="shrink-0 rounded bg-muted px-1 text-[11px] text-foreground-subtle">
              {issueCodeLabel(intl, item.code)}
            </span>
          ) : null}
        </span>
        <span className="truncate text-ui-sm text-foreground-subtle">
          {item.message}
          {item.suggestion ? `　${intl.formatMessage({ id: "review.card.suggestion" })}：${item.suggestion}` : ""}
        </span>
      </span>
    </button>
  );
}
