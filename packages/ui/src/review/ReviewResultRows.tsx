/**
 * 面板的行与分组（从 `ReviewResultPanel` 里拆出来：面板本体已经很长，再塞下去会顶到 max-lines，
 * 而这几块是纯展示、只依赖传入的数据与回调，独立成文件更清楚）。
 */
import { CheckIcon, ChevronRightIcon } from "lucide-react";
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

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/**
 * 规则码的展示形式：整码或族名有译名就用译名（`PUNCT-001` → `标点-001`），否则原样。
 * 序号不翻译 —— 它是这条问题在族内的身份，改了就没有可引用的编号了。
 */
/** 采纳标记的 key：与面板、定位卡共用同一口径（`textPath:startOffset:code`）。 */
export function issueMarkKey(item: ReviewResultItem): string {
  return `${item.textPath}:${item.startOffset}:${item.code}`;
}

export function issueCodeLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  code: string,
): string {
  const exact = REVIEW_ISSUE_LABEL_KEYS[code];
  if (exact) return intl.formatMessage({ id: exact });
  const key = reviewIssueFamilyLabelKey(reviewIssueCodeFamily(code));
  return key ? `${intl.formatMessage({ id: key })}${reviewIssueCodeSuffix(code)}` : code;
}

export const SEVERITY_DOTS: Record<ReviewResultItem["severity"], string> = {
  error: "bg-destructive",
  warning: "bg-amber-500",
  info: "bg-foreground-subtle",
  none: "bg-foreground-subtlest",
};

export function TermChips({ label, terms }: { label: string; terms: readonly string[] }) {
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

export function Section({
  section,
  showTitle,
  defaultOpen,
  canOpen,
  onOpenItem,
  markedKeys,
  onToggleMark,
}: {
  section: ReviewResultSection;
  showTitle: boolean;
  defaultOpen: boolean;
  canOpen: boolean;
  onOpenItem: (item: ReviewResultItem) => void;
  /** 已采纳条目的 key 集合（与定位卡同一口径） */
  markedKeys: ReadonlySet<string>;
  onToggleMark?: (item: ReviewResultItem) => void;
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

  return (
    // 不能把「采纳」按钮嵌在「打开」按钮里（button 不能嵌套 button）：外层只做布局与 hover，
    // 两个动作各自是独立的按钮。
    <div
      className={cn("group/issue flex w-full items-start gap-1 rounded", marked ? "bg-emerald-500/8" : "")}
    >
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
            "mt-0.5 shrink-0 self-start rounded p-0.5 transition-opacity",
            marked
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "text-foreground-subtle opacity-0 hover:bg-muted hover:text-foreground group-hover/issue:opacity-100 focus-visible:opacity-100",
          )}
        >
          <CheckIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
