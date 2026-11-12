"use client";

import { useCallback, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfViewer, type PdfViewerProps } from "@/components/ui/pdf-viewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PaperSidebar } from "./PaperSidebar.js";
import { PdfSelectionMenu } from "./PdfSelectionMenu.js";
import {
  appendPdfQuoteToComposerDraft,
  flattenPdfJsOutline,
  formatPdfQuoteDraft,
  scanPaperPagesForFiguresAndFormulas,
  type PaperFigureItem,
  type PaperFormulaItem,
  type PaperOutlineItem,
} from "./readerComposerBridge.js";

/**
 * PaperModePanel：PDF 阅读器 + 论文侧栏（P0b 壳）。
 */
export interface PaperModePanelProps {
  source: PdfViewerProps["source"];
  fileName: string;
  labels: PdfViewerProps["labels"];
  referencesText?: string;
  onQuoteIntoComposer?: (draft: string) => void;
  /** 未传 onQuoteIntoComposer 时，送入该会话/草稿槽的 v4 composer 草稿。 */
  composerScope?: {
    workspacePath: string;
    workspaceIdentity?: string;
    scopeId: string;
    /** 有活跃会话时进该会话输入框；空值表示新建任务草稿槽。 */
    sessionId?: string | null;
  };
  onDocumentLoad?: (info: {
    pageCount: number;
    outline: PaperOutlineItem[];
    pdfDocument: PDFDocumentProxy;
  }) => void;
  className?: string;
}

export function PaperModePanel({
  source,
  fileName,
  labels,
  referencesText,
  onQuoteIntoComposer,
  composerScope,
  onDocumentLoad,
  className,
}: PaperModePanelProps) {
  const { intl } = useZCodeIntl();
  const [outline, setOutline] = useState<PaperOutlineItem[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [jump, setJump] = useState<{ page: number; id: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [autoReferences, setAutoReferences] = useState<string | null>(null);
  const [figures, setFigures] = useState<PaperFigureItem[]>([]);
  const [formulas, setFormulas] = useState<PaperFormulaItem[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const pushDraft = useCallback(
    (draft: string) => {
      if (onQuoteIntoComposer) {
        onQuoteIntoComposer(draft);
        return;
      }
      if (composerScope) {
        appendPdfQuoteToComposerDraft({ ...composerScope, draft });
      }
    },
    [composerScope, onQuoteIntoComposer],
  );

  const handleOutline = useCallback<NonNullable<PdfViewerProps["onDocumentOutline"]>>(
    ({ pageCount, outline: raw, pdfDocument }) => {
      const items = flattenPdfJsOutline(raw ?? [], (dest) => {
        if (Array.isArray(dest) && typeof dest[0] === "number") return dest[0] + 1;
        return null;
      });
      setOutline(items);
      onDocumentLoad?.({ pageCount, outline: items, pdfDocument });
      // 逐页抽文本（失败不阻塞阅读）：
      // - 前 80 页喂给插图/公式页签（论文场景基本全覆盖；超长文档不无限扫描）；
      // - 引文页签保持既有行为，只看尾部 5 页，避免把正文里的编号误当引文。
      void (async () => {
        try {
          const readPageText = async (p: number): Promise<string> => {
            const page = await pdfDocument.getPage(p);
            const content = await page.getTextContent();
            const text = (content.items as Array<{ str?: string }>)
              .map((item) => (typeof item.str === "string" ? item.str : ""))
              .join(" ");
            page.cleanup();
            return text;
          };
          const scanLimit = Math.min(pageCount, 80);
          const tailStart = Math.max(1, pageCount - 4);
          const pageSet = new Set<number>();
          for (let p = 1; p <= scanLimit; p += 1) pageSet.add(p);
          for (let p = tailStart; p <= pageCount; p += 1) pageSet.add(p);
          const pageTexts = new Map<number, string>();
          for (const p of pageSet) pageTexts.set(p, await readPageText(p));
          if (!referencesText) {
            const tail = [...pageTexts.entries()]
              .filter(([p]) => p >= tailStart)
              .sort(([a], [b]) => a - b)
              .map(([, text]) => text)
              .filter((text) => text.trim());
            setAutoReferences(tail.join("\n"));
          }
          const scanned = [...pageTexts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([page, text]) => ({ page, text }));
          const scan = scanPaperPagesForFiguresAndFormulas(scanned);
          setFigures(scan.figures);
          setFormulas(scan.formulas);
        } catch {
          setAutoReferences(null);
        }
      })();
    },
    [onDocumentLoad, referencesText],
  );

  return (
    <div ref={rootRef} className={`relative flex h-full min-h-0 ${className ?? ""}`}>
      <div className="min-w-0 flex-1">
        <PdfViewer
          source={source}
          labels={labels}
          className="h-full"
          onDocumentOutline={handleOutline}
          onPageNumberChange={setPageNumber}
          goToPageRequest={jump ?? undefined}
        />
        <PdfSelectionMenu
          containerRef={rootRef}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text).catch(() => undefined);
          }}
          onQuote={(text) =>
            pushDraft(
              formatPdfQuoteDraft({
                fileName,
                page: pageNumber,
                text,
                instruction: intl.formatMessage({ id: "paperMode.instruction.answer" }),
              }),
            )
          }
          onExplain={(text) =>
            pushDraft(
              formatPdfQuoteDraft({
                fileName,
                page: pageNumber,
                text,
                instruction: intl.formatMessage({ id: "paperMode.instruction.explain" }),
              }),
            )
          }
          onTranslate={(text) =>
            pushDraft(
              formatPdfQuoteDraft({
                fileName,
                page: pageNumber,
                text,
                instruction: intl.formatMessage({ id: "paperMode.instruction.translate" }),
              }),
            )
          }
          onAsk={(text) =>
            pushDraft(
              formatPdfQuoteDraft({
                fileName,
                page: pageNumber,
                text,
                instruction: intl.formatMessage({ id: "paperMode.instruction.ask" }),
              }),
            )
          }
        />
      </div>
      {sidebarOpen ? (
        <PaperSidebar
          outline={outline}
          figures={figures}
          formulas={formulas}
          referencesText={referencesText ?? autoReferences ?? undefined}
          fileName={fileName}
          currentPage={pageNumber}
          onJumpToPage={(page) => setJump({ page, id: Date.now() })}
          onQuoteIntoComposer={pushDraft}
          onClose={() => setSidebarOpen(false)}
        />
      ) : (
        <button
          type="button"
          className="border-l border-border px-2 text-ui-base text-foreground-subtle"
          onClick={() => setSidebarOpen(true)}
        >
          {intl.formatMessage({ id: "paperMode.reopenSidebar" })}
        </button>
      )}
    </div>
  );
}
