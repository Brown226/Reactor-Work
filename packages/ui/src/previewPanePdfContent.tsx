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

interface PdfPreviewContentProps {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
  /** 审查定位：在原件 PDF 里标出这句原文（逐页搜 + 跳页 + 文本层高亮） */
  quoteHighlight?: QuoteHighlightTarget;
}

export function PdfPreviewContent({ source, labels, quoteHighlight }: PdfPreviewContentProps) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PdfViewer
        source={source}
        labels={labels}
        className="h-full"
        {...(quoteHighlight ? { quoteHighlight } : {})}
      />
    </Suspense>
  );
}
