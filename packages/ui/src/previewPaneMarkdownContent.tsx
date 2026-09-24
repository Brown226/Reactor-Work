import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownSelectionTooltip } from "@/v4/MarkdownSelectionTooltip.js";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { scheduleReviewQuoteHighlight } from "@/lib/quoteHighlightDom.js";
import type { QuoteHighlightTarget } from "@/lib/quoteSearch.js";
import type { Theme } from "@/useTheme.js";

export type { QuoteHighlightTarget } from "@/lib/quoteSearch.js";

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
  quoteHighlight?: QuoteHighlightTarget;
}

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
    if (!quote) {
      setQuoteMissing(false);
      return undefined;
    }
    return scheduleReviewQuoteHighlight({
      getRoot: () => rootRef.current,
      quote,
      occurrence,
      onSettled: (found) => setQuoteMissing(!found),
    });
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
