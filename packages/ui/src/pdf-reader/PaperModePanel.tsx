"use client";

import { useCallback, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfViewer, type PdfViewerProps } from "@/components/ui/pdf-viewer.js";
import { PaperSidebar } from "./PaperSidebar.js";
import { PdfSelectionMenu } from "./PdfSelectionMenu.js";
import {
  appendPdfQuoteToComposerDraft,
  flattenPdfJsOutline,
  formatPdfQuoteDraft,
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
  /** 未传 onQuoteIntoComposer 时，追加到该 scope 的 v4 composer 草稿。 */
  composerScope?: {
    workspacePath: string;
    workspaceIdentity?: string;
    scopeId: string;
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
  const [outline, setOutline] = useState<PaperOutlineItem[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [jump, setJump] = useState<{ page: number; id: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [autoReferences, setAutoReferences] = useState<string | null>(null);
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
      // 自动抽 References（尾部若干页），供引文页签；失败不阻塞阅读。
      if (!referencesText) {
        void (async () => {
          try {
            const start = Math.max(1, pageCount - 4);
            const parts: string[] = [];
            for (let p = start; p <= pageCount; p += 1) {
              const page = await pdfDocument.getPage(p);
              const content = await page.getTextContent();
              const line = (content.items as Array<{ str?: string }>)
                .map((item) => (typeof item.str === "string" ? item.str : ""))
                .join(" ");
              if (line.trim()) parts.push(line);
              page.cleanup();
            }
            setAutoReferences(parts.join("\n"));
          } catch {
            setAutoReferences(null);
          }
        })();
      }
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
                instruction: "请结合以上原文作答。",
              }),
            )
          }
          onExplain={(text) =>
            pushDraft(
              formatPdfQuoteDraft({
                fileName,
                page: pageNumber,
                text,
                instruction: "请解释这段原文。",
              }),
            )
          }
          onTranslate={(text) =>
            pushDraft(
              formatPdfQuoteDraft({
                fileName,
                page: pageNumber,
                text,
                instruction: "请翻译成中文。",
              }),
            )
          }
        />
      </div>
      {sidebarOpen ? (
        <PaperSidebar
          outline={outline}
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
          侧栏
        </button>
      )}
    </div>
  );
}
