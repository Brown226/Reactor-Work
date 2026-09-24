import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownSelectionTooltip } from "@/v4/MarkdownSelectionTooltip.js";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { applyReviewQuoteHighlight, clearReviewQuoteHighlight } from "@/lib/quoteHighlightDom.js";
import type { Theme } from "@/useTheme.js";

/** 审查定位：把命中的原文片段在渲染后的正文里标出来并滚过去。 */
export interface MarkdownQuoteHighlightTarget {
  quote: string;
  /** 片段是第几次出现（1 起），与工具算出的偏移同源 */
  occurrence?: number | null;
  /** 每次点击都换一个值：同一个文件重复点同一条也要重新定位/滚动 */
  focusRequestId?: string;
}

interface MarkdownPreviewContentProps {
  content: string;
  sourceKey?: string;
  sourceTitle?: string;
  sourcePath?: string;
  selectionTarget?: MarkdownSelectionTarget;
  workspacePath?: string;
  /** 应用主题（store 耦合剥离）：透传给 markdown 渲染，缺省按 "system" 兜底。 */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：透传给 markdown 渲染，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  onOpenBrowserUrl?: (url: string) => void;
  quoteHighlight?: MarkdownQuoteHighlightTarget;
}

/** 渲染是异步的（Streamdown 内部还会做代码高亮），一次找不到就在这几个时间点重试。 */
const QUOTE_RETRY_DELAYS_MS = [0, 120, 320, 700];

export function MarkdownPreviewContent({
  content,
  sourceKey,
  sourceTitle,
  sourcePath,
  selectionTarget,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenBrowserUrl,
  quoteHighlight,
}: MarkdownPreviewContentProps) {
  const { intl } = useZCodeIntl();
  const rootRef = useRef<HTMLDivElement>(null);
  const [quoteMissing, setQuoteMissing] = useState(false);
  const selectionScope = useMemo(
    () => ({}),
    [content, sourceKey, sourcePath, selectionTarget?.workspaceKey, selectionTarget?.sessionId],
  );
  const quote = quoteHighlight?.quote ?? null;
  const occurrence = quoteHighlight?.occurrence ?? null;
  const focusRequestId = quoteHighlight?.focusRequestId ?? null;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !quote) {
      setQuoteMissing(false);
      clearReviewQuoteHighlight();
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const run = () => {
      if (cancelled) return;
      const found = applyReviewQuoteHighlight(root, quote, occurrence);
      if (found) {
        setQuoteMissing(false);
        return;
      }
      attempt += 1;
      const delay = QUOTE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        setQuoteMissing(true);
        return;
      }
      timer = setTimeout(run, delay);
    };
    run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      clearReviewQuoteHighlight();
    };
  }, [content, occurrence, quote, focusRequestId]);

  return (
    <div
      ref={rootRef}
      data-markdown-preview="true"
      className="w-full h-full bg-background overflow-auto"
    >
      {quoteMissing ? (
        // 找不到就不画：偏移在渲染后的正文里没有对应位置，标错地方比不标更误导复核者。
        <div className="border-b border-amber-500/40 bg-amber-500/5 px-3 py-2 text-ui-sm">
          {intl.formatMessage({ id: "review.quote.notFound" })}
        </div>
      ) : null}
      {selectionTarget && sourceKey ? (
        <MarkdownSelectionTooltip
          scopeKey={selectionScope}
          rootRef={rootRef}
          sourceKey={sourceKey}
          sourceTitle={sourceTitle ?? sourceKey}
          sourcePath={sourcePath}
          target={selectionTarget}
        />
      ) : null}
      <div className="min-h-full bg-background p-4">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {content}
        </MessageResponse>
      </div>
    </div>
  );
}
