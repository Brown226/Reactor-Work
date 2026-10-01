import { useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  extractCitationsFromText,
  formatPdfQuoteDraft,
  type PaperCitationItem,
  type PaperFigureItem,
  type PaperFormulaItem,
  type PaperOutlineItem,
} from "./readerComposerBridge.js";

/**
 * PaperSideBar — 大纲 / 插图 / 公式 / 引文页签；点击条目跳页，点引文可「引用进会话」。
 */

export interface PaperSidebarProps {
  outline: PaperOutlineItem[];
  /** 图注候选（浏览器侧启发式，与 file-tools pdf_structure 同口径）。 */
  figures: PaperFigureItem[];
  /** 公式候选。 */
  formulas: PaperFormulaItem[];
  /** 全文或 References 段文本；有值才显示引文页签。 */
  referencesText?: string;
  fileName: string;
  currentPage: number;
  onJumpToPage: (page: number) => void;
  onQuoteIntoComposer?: (draft: string) => void;
  onClose?: () => void;
}

type Tab = "outline" | "figures" | "formulas" | "citations";

export function PaperSidebar({
  outline,
  figures,
  formulas,
  referencesText,
  fileName,
  currentPage,
  onJumpToPage,
  onQuoteIntoComposer,
  onClose,
}: PaperSidebarProps) {
  const { intl } = useZCodeIntl();
  const [tab, setTab] = useState<Tab>("outline");
  const citations = useMemo<PaperCitationItem[]>(
    () => (referencesText ? extractCitationsFromText(referencesText) : []),
    [referencesText],
  );

  return (
    <aside className="flex h-full min-h-0 w-64 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="text-ui-base font-medium">
          {intl.formatMessage({ id: "paperMode.title" })}
        </div>
        {onClose ? (
          <button
            type="button"
            className="text-ui-base text-foreground-subtle hover:text-foreground"
            onClick={onClose}
          >
            {intl.formatMessage({ id: "paperMode.close" })}
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          className={`rounded-md px-2 py-1 text-ui-base ${
            tab === "outline" ? "bg-surface-sunken font-medium" : "text-foreground-subtle"
          }`}
          onClick={() => setTab("outline")}
        >
          {intl.formatMessage({ id: "paperMode.tab.outline" })}{" "}
          {outline.length > 0 ? `(${outline.length})` : ""}
        </button>
        <button
          type="button"
          className={`rounded-md px-2 py-1 text-ui-base ${
            tab === "figures" ? "bg-surface-sunken font-medium" : "text-foreground-subtle"
          }`}
          onClick={() => setTab("figures")}
        >
          {intl.formatMessage({ id: "paperMode.tab.figures" })}{" "}
          {figures.length > 0 ? `(${figures.length})` : ""}
        </button>
        <button
          type="button"
          className={`rounded-md px-2 py-1 text-ui-base ${
            tab === "formulas" ? "bg-surface-sunken font-medium" : "text-foreground-subtle"
          }`}
          onClick={() => setTab("formulas")}
        >
          {intl.formatMessage({ id: "paperMode.tab.formulas" })}{" "}
          {formulas.length > 0 ? `(${formulas.length})` : ""}
        </button>
        <button
          type="button"
          className={`rounded-md px-2 py-1 text-ui-base ${
            tab === "citations" ? "bg-surface-sunken font-medium" : "text-foreground-subtle"
          }`}
          onClick={() => setTab("citations")}
          disabled={citations.length === 0}
        >
          {intl.formatMessage({ id: "paperMode.tab.citations" })}{" "}
          {citations.length > 0 ? `(${citations.length})` : ""}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {tab === "outline" ? (
          outline.length === 0 ? (
            <p className="px-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "paperMode.outlineEmpty" })}
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
        ) : tab === "figures" ? (
          figures.length === 0 ? (
            <p className="px-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "paperMode.figuresEmpty" })}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {figures.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`w-full rounded-md px-2 py-1 text-left text-ui-base hover:bg-surface-sunken ${
                      item.page === currentPage ? "bg-surface-sunken font-medium" : ""
                    }`}
                    onClick={() => onJumpToPage(item.page)}
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="ml-1 text-foreground-subtle">{item.page}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : tab === "formulas" ? (
          formulas.length === 0 ? (
            <p className="px-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "paperMode.formulasEmpty" })}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {formulas.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`w-full rounded-md px-2 py-1 text-left text-ui-base hover:bg-surface-sunken ${
                      item.page === currentPage ? "bg-surface-sunken font-medium" : ""
                    }`}
                    onClick={() => onJumpToPage(item.page)}
                  >
                    <span className="block truncate font-mono">{item.text}</span>
                    <span className="text-foreground-subtle">{item.page}</span>
                  </button>
                </li>
              ))}
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
                          instruction: intl.formatMessage({
                            id: "paperMode.instruction.citationRelation",
                          }),
                        }),
                      )
                    }
                  >
                    {intl.formatMessage({ id: "paperMode.quoteIntoComposer" })}
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
