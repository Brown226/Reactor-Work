/**
 * 面板的行与分组（从 `ReviewResultPanel` 里拆出来：面板本体已经很长，再塞下去会顶到 max-lines，
 * 而这几块是纯展示、只依赖传入的数据与回调，独立成文件更清楚）。
 *
 * 视觉层级（对齐 DESIGN.md：密排操作面板优先于卡片装饰，层次靠背景/描边/圆角而非重阴影）：
 *   文件节（text-ui-base font-medium + 图标）
 *     └ 规则码族（可折叠行：chevron + 名称 + 计数 + 只在有 error/warning 时出现的彩色计数）
 *          └ 问题行（左侧 2px 严重度色条锚定 + 片段/元数据 + 说明 + 绿色建议 + 悬停显形的采纳）
 * 计数与行号一律 `tabular-nums`（数字变化时不抖）；字号只用 `text-ui-*`，不写像素值。
 */
import { CheckIcon, ChevronRightIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REVIEW_ISSUE_LABEL_KEYS,
  reviewIssueCodeFamily,
  reviewIssueCodeSuffix,
  reviewIssueFamilyLabelKey,
  type ReviewResultCodeGroup,
  type ReviewResultItem,
  type ReviewResultSection,
} from "@/review/reviewResultGroups.js";

/** 严重度色条：左侧 2px，是问题行唯一的位置锚点（不再用彩色圆点，免得与族计数抢注意力）。 */
const SEVERITY_BAR: Record<ReviewResultItem["severity"], string> = {
  error: "border-destructive",
  warning: "border-warning",
  info: "border-border",
  none: "border-border",
};

/** 严重度计数的点与数字用同一语义色（DESIGN.md：只给真实语义状态上色）。 */
const SEVERITY_DOT: Record<"error" | "warning", string> = {
  error: "bg-destructive",
  warning: "bg-warning",
};
const SEVERITY_NUMBER: Record<"error" | "warning", string> = {
  error: "text-destructive",
  warning: "text-warning",
};

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/** 采纳标记的 key：与面板、定位卡共用同一口径（`textPath:startOffset:code`）。 */
export function issueMarkKey(item: ReviewResultItem): string {
  return `${item.textPath}:${item.startOffset}:${item.code}`;
}

/**
 * 规则码的展示形式：整码或族名有译名就用译名（`PUNCT-001` → `标点-001`），否则原样。
 * 序号不翻译 —— 它是这条问题在族内的身份，改了就没有可引用的编号了。
 */
export function issueCodeLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  code: string,
): string {
  const exact = REVIEW_ISSUE_LABEL_KEYS[code];
  if (exact) return intl.formatMessage({ id: exact });
  const key = reviewIssueFamilyLabelKey(reviewIssueCodeFamily(code));
  return key ? `${intl.formatMessage({ id: key })}${reviewIssueCodeSuffix(code)}` : code;
}

/** 一族的严重度计数：只在有 error / warning 时出现（info 由总数隐含，不必再报一遍）。 */
function GroupSeverityCounts({ totals }: { totals: ReviewResultCodeGroup["totals"] }) {
  const entries = (["error", "warning"] as const).filter((severity) => totals[severity] > 0);
  if (entries.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {entries.map((severity) => (
        <span
          key={severity}
          className="flex items-center gap-1 text-ui-xs tabular-nums text-foreground-subtle"
        >
          <span className={cn("size-1.5 rounded-full", SEVERITY_DOT[severity])} />
          <span className={SEVERITY_NUMBER[severity]}>{totals[severity]}</span>
        </span>
      ))}
    </span>
  );
}

export function TermChips({ label, terms }: { label: string; terms: readonly string[] }) {
  if (terms.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="text-ui-xs text-foreground-subtle">{label}</span>
      {terms.map((term) => (
        <span key={term} className="rounded-md bg-muted px-1.5 py-0.5 text-ui-xs text-foreground">
          {term}
        </span>
      ))}
    </div>
  );
}

export function Section({
  section,
  showTitle,
  separated,
  defaultOpen,
  canOpen,
  onOpenItem,
  markedKeys,
  onToggleMark,
}: {
  section: ReviewResultSection;
  showTitle: boolean;
  /** 非首个节加一条分隔线：层次靠描边，而不是堆间距 */
  separated: boolean;
  defaultOpen: boolean;
  canOpen: boolean;
  onOpenItem: (item: ReviewResultItem) => void;
  /** 已采纳条目的 key 集合（与定位卡同一口径） */
  markedKeys: ReadonlySet<string>;
  onToggleMark?: (item: ReviewResultItem) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className={cn("flex flex-col gap-0.5", separated && "border-t border-border/60 pt-2")}>
      {showTitle ? (
        <div className="flex items-center gap-2 px-2 text-ui-base font-medium">
          <FileTextIcon className="size-3.5 shrink-0 text-foreground-subtle" />
          <span className="truncate">
            {section.sourcePath
              ? basename(section.sourcePath)
              : intl.formatMessage({ id: "review.panel.sourceless" })}
          </span>
          <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
            {intl.formatMessage({ id: "review.panel.count" }, { count: section.totals.total })}
          </span>
          {section.totals.unlocated > 0 ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
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
          markedKeys={markedKeys}
          {...(onToggleMark ? { onToggleMark } : {})}
        />
      ))}
    </div>
  );
}

export function CodeGroup({
  group,
  defaultOpen,
  canOpen,
  onOpenItem,
  markedKeys,
  onToggleMark,
}: {
  group: ReviewResultCodeGroup;
  defaultOpen: boolean;
  canOpen: boolean;
  onOpenItem: (item: ReviewResultItem) => void;
  markedKeys: ReadonlySet<string>;
  onToggleMark?: (item: ReviewResultItem) => void;
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
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm transition-colors hover:bg-surface"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
              open ? "rotate-90" : "rotate-0",
            )}
          />
          <span className="shrink-0 font-medium">{label}</span>
          <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
            {intl.formatMessage({ id: "review.panel.count" }, { count: totals.total })}
          </span>
          <span className="ml-auto">
            <GroupSeverityCounts totals={totals} />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* pl-6 让问题行对齐到族名文字而不是 chevron：缩进表达从属关系 */}
        <div className="flex flex-col gap-0.5 py-0.5 pl-6">
          {group.items.map((item) => (
            <IssueRow
              key={item.key}
              item={item}
              showCode={showCodePerItem}
              canOpen={canOpen}
              onOpen={() => onOpenItem(item)}
              marked={markedKeys.has(issueMarkKey(item))}
              {...(onToggleMark ? { onToggleMark: () => onToggleMark(item) } : {})}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function IssueRow({
  item,
  showCode,
  canOpen,
  onOpen,
  marked,
  onToggleMark,
}: {
  item: ReviewResultItem;
  /** 同族里有多个具体规则码时逐行标出来，用户才能引用准确的码 */
  showCode: boolean;
  canOpen: boolean;
  onOpen: () => void;
  marked?: boolean;
  onToggleMark?: () => void;
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

  const suggestionLabel = intl.formatMessage({ id: "review.card.suggestion" });

  return (
    // 采纳按钮不能嵌在「打开」按钮里（button 不能嵌套 button）：外层负责色条与悬停底色，
    // 两个动作各自是独立按钮。
    <div
      className={cn(
        "group/issue flex items-start gap-1 rounded-md border-l-2 pr-1 transition-colors",
        SEVERITY_BAR[item.severity],
        marked ? "bg-success/5" : clickable ? "hover:bg-surface" : "",
      )}
    >
      <button
        type="button"
        disabled={!clickable}
        onClick={clickable ? onOpen : undefined}
        title={[
          item.quoted,
          item.message,
          item.suggestion ? `${suggestionLabel}：${item.suggestion}` : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n")}
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left",
          clickable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          {showCode ? (
            <span className="shrink-0 rounded-md bg-muted px-1 py-0.5 text-ui-xs text-foreground-subtle">
              {issueCodeLabel(intl, item.code)}
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-ui-sm text-foreground">{item.quoted}</span>
          {meta.length > 0 ? (
            <span className="shrink-0 text-ui-xs tabular-nums text-foreground-subtlest">
              {meta.join(" · ")}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{item.message}</span>
        {item.suggestion ? (
          // 建议用 success 色：与定位卡里的绿色建议同源，一眼分得出「问题」与「改法」
          <span className="min-w-0 truncate text-ui-sm text-success">
            {suggestionLabel}：{item.suggestion}
          </span>
        ) : null}
      </button>
      {onToggleMark ? (
        // 采纳态：实心绿 = 已采纳；未采纳时只在悬停时显形，免得 27 行都在喊「点我」。
        <button
          type="button"
          data-review-mark-toggle={marked ? "marked" : "unmarked"}
          aria-pressed={marked}
          title={intl.formatMessage({ id: marked ? "review.mark.unmark" : "review.mark.mark" })}
          aria-label={intl.formatMessage({ id: marked ? "review.mark.unmark" : "review.mark.mark" })}
          onClick={onToggleMark}
          className={cn(
            "mt-1.5 mr-1 shrink-0 self-start rounded-md p-0.5 transition-opacity",
            marked
              ? "bg-success text-success-foreground hover:opacity-90"
              : "text-foreground-subtlest opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/issue:opacity-100",
          )}
        >
          <CheckIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
