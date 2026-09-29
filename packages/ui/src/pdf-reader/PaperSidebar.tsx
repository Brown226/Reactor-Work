import { useMemo, useState } from "react";
import {
  extractCitationsFromText,
  formatPdfQuoteDraft,
  type PaperCitationItem,
  type PaperOutlineItem,
} from "./readerComposerBridge.js";

/**
 * PaperSideBar — 大纲 / 引文页签；点击大纲跳页，点引文可「引用进会话」。
 */

export interface PaperSidebarProps {
  outline: PaperOutlineItem[];
  /** 全文或 References 段文本；有值才显示引文页签。 */
  referencesText?: string;
  fileName: string;
  currentPage: number;
  onJumpToPage: (page: number) => void;
  onQuoteIntoComposer?: (draft: string) => void;
  onClose?: () => void;
}

type Tab = "outline" | "citations";

export function PaperSidebar({
  outline,
  referencesText,
  fileName,
  currentPage,
  onJumpToPage,
  onQuoteIntoComposer,
  onClose,
}: PaperSidebarProps) {
  const [tab, setTab] = useState<Tab>("outline");
  const citations = useMemo<PaperCitationItem[]>(
    () => (referencesText ? extractCitationsFromText(referencesText) : []),
    [referencesText],
  );

  return (
    <aside className="flex h-full min-h-0 w-64 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="text-ui-base font-medium">论文模式</div>
        {onClose ? (
          <button
            type="button"
            className="text-ui-base text-foreground-subtle hover:text-foreground"
            onClick={onClose}
          >
            关闭
          </button>
        ) : null}
      </div>
      <div className="flex gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className={`rounded-md px-2 py-1 text-ui-base ${
            tab === "outline" ? "bg-surface-sunken font-medium" : "text-foreground-subtle"
          }`}
          onClick={() => setTab("outline")}
        >
          大纲 {outline.length > 0 ? `(${outline.length})` : ""}
        </button>
        <button
          type="button"
          className={`rounded-md px-2 py-1 text-ui-base ${
            tab === "citations" ? "bg-surface-sunken font-medium" : "text-foreground-subtle"
          }`}
          onClick={() => setTab("citations")}
          disabled={citations.length === 0}
        >
          引文 {citations.length > 0 ? `(${citations.length})` : ""}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {tab === "outline" ? (
          outline.length === 0 ? (
            <p className="px-1 text-ui-base text-foreground-subtle">
              该 PDF 无书签；可用服务端 pdf_structure 做启发式章节。
            </p>
          ) : (
            <ul className="space-y-0.5">
              {outline.map((item, index) => {
                const active = item.page !== null && item.page === currentPage;
                return (
                  <li key={`${item.title}-${index}`}>
                    <button
                      type="button"
                      className={`w-full rounded-md px-2 py-1 text-left text-ui-base hover:bg-surface-sunken ${
                        active ? "bg-surface-sunken font-medium" : ""
                      }`}
                      style={{ paddingLeft: 8 + (item.level - 1) * 12 }}
                      onClick={() => {
                        if (item.page) onJumpToPage(item.page);
                      }}
                    >
                      <span className="truncate">{item.title}</span>
                      {item.page ? (
                        <span className="ml-1 text-foreground-subtle">{item.page}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <ul className="space-y-2">
            {citations.map((cite) => (
              <li key={cite.id} className="rounded-lg border border-border p-2">
                <div className="text-ui-base">
                  {cite.marker ? (
                    <span className="mr-1 font-mono text-foreground-subtle">{cite.marker}</span>
                  ) : null}
                  {cite.text}
                </div>
                {onQuoteIntoComposer ? (
                  <button
                    type="button"
                    className="mt-1 text-ui-base text-primary hover:underline"
                    onClick={() =>
                      onQuoteIntoComposer(
                        formatPdfQuoteDraft({
                          fileName,
                          page: currentPage,
                          text: cite.text,
                          instruction: "请解释这条参考文献与当前讨论的关系。",
                        }),
                      )
                    }
                  >
                    引用进会话
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
