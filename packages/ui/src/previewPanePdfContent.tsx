import { Suspense, lazy } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import type { QuoteHighlightTarget } from "@/lib/quoteSearch.js";

// react-pdf（含 pdf.js 与 worker）体积较大，懒加载让它只在首次打开 PDF 预览时进入 bundle，
// 不拖慢没有用到 PDF 的会话的启动。
const PdfViewer = lazy(() =>
  import("@/components/ui/pdf-viewer.js").then((module) => ({
    default: module.PdfViewer,
  })),
);

const PaperModePanel = lazy(() =>
  import("@/pdf-reader/PaperModePanel.js").then((module) => ({
    default: module.PaperModePanel,
  })),
);

interface PdfPreviewContentProps {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
  /** 审查定位：在原件 PDF 里标出这句原文（逐页搜 + 跳页 + 文本层高亮） */
  quoteHighlight?: QuoteHighlightTarget;
  /** 论文模式：阅读器 + 大纲/引文侧栏（与审查定位二选一，不叠加）。 */
  paperMode?: boolean;
  fileName?: string;
  referencesText?: string;
  /** 引用进会话：宿主写入输入框草稿。 */
  onQuoteIntoComposer?: (draft: string) => void;
  /** 未传 onQuoteIntoComposer 时，追加到该 scope 的 v4 composer 草稿。 */
  composerScope?: {
    workspacePath: string;
    workspaceIdentity?: string;
    scopeId: string;
  };
}

export function PdfPreviewContent({
  source,
  labels,
  quoteHighlight,
  paperMode,
  fileName,
  referencesText,
  onQuoteIntoComposer,
  composerScope,
}: PdfPreviewContentProps) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      {paperMode ? (
        <PaperModePanel
          source={source}
          fileName={fileName ?? "document.pdf"}
          labels={labels}
          {...(referencesText ? { referencesText } : {})}
          {...(onQuoteIntoComposer ? { onQuoteIntoComposer } : {})}
          {...(composerScope ? { composerScope } : {})}
          className="h-full"
        />
      ) : (
        <PdfViewer
          source={source}
          labels={labels}
          className="h-full"
          {...(quoteHighlight ? { quoteHighlight } : {})}
        />
      )}
    </Suspense>
  );
}
