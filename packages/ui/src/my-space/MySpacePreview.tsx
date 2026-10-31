/**
 * 我的空间：文件预览。
 *
 * 这里**不重新实现预览器**，而是复用桌面端预览面板（PreviewPane）已经在用的同一批渲染组件：
 * - 图片 / SVG → ImagePreviewContent（棋盘底、@2x 折算）
 * - PDF → PdfPreviewContent（react-pdf 翻页/缩放，不是 iframe）
 * - docx / doc / xlsx / xls → PreviewPaneOfficeContent
 * - pptx → PptxPreviewContent
 * - md → MarkdownPreviewContent
 * - 代码 / 纯文本 → CodeContent（shiki 高亮）
 * - 音视频 → PreviewPaneMediaContent
 *
 * 只有 DWG/DXF 是空间页新增的（桌面端预览面板并不渲染图纸），走服务端 sidecar。
 *
 * 数据来源差异：桌面端经 fileService 读工作区，Web 端只能走 `/api/space/preview`
 * 的 HTTP 流。因此这里按类型选择「直接给 URL」还是「先取字节/文本再交给渲染器」。
 */
import { useEffect, useMemo, useState } from "react";
import { Download, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { CodeContent } from "@/previewPaneCodeContent.js";
import { ImagePreviewContent } from "@/previewPaneImageContent.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { PdfPreviewContent } from "@/previewPanePdfContent.js";
import { PreviewPaneOfficeContent } from "@/previewPaneOfficeContent.js";
import { PptxPreviewContent } from "@/previewPanePptxContent.js";
import { PreviewPaneMediaContent } from "@/previewPaneMediaContent.js";
import { MySpaceDwgPreview } from "./MySpaceDwgPreview.js";
import { spaceClient } from "./spaceClient.js";
import {
  resolveSpacePreviewKind,
  SPACE_BINARY_PREVIEW_MAX_BYTES,
  SPACE_TEXT_PREVIEW_MAX_BYTES,
} from "./spaceFileType.js";

const OFFLINE_TIP = "下载后可查看完整内容";

export function MySpacePreview({
  relPath,
  size,
  resolvedTheme,
}: {
  relPath: string;
  size: number;
  resolvedTheme: "light" | "dark";
}) {
  const { intl } = useZCodeIntl();
  const pdfLabels = usePdfViewerLabels();
  const pptxLabels = usePptxViewerLabels();
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const kind = resolveSpacePreviewKind(relPath);
  const previewUrl = spaceClient.previewUrl(relPath);

  // 文本类按需取字符串；Office/PPTX 取 ArrayBuffer。两者互斥，共用一个 loading/error 状态。
  const needsText = kind === "markdown" || kind === "code";
  const needsBytes = kind === "office" || kind === "pptx";
  const tooLarge =
    (needsText && size > SPACE_TEXT_PREVIEW_MAX_BYTES) ||
    (needsBytes && size > SPACE_BINARY_PREVIEW_MAX_BYTES);

  const [text, setText] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setBytes(null);
    setError(null);
    if (!needsText && !needsBytes) return;
    if (tooLarge) return;

    const controller = new AbortController();
    setLoading(true);
    void fetch(previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return needsText ? response.text() : response.arrayBuffer();
      })
      .then((payload) => {
        if (needsText) setText(payload as string);
        else setBytes(payload as ArrayBuffer);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [needsBytes, needsText, previewUrl, tooLarge]);

  const fallback = useMemo(
    () => (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <FileQuestion className="size-6 text-foreground-subtlest" aria-hidden="true" />
        <p className="max-w-sm text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.preview.unsupported" })}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}
        >
          <Download className="mr-1.5 size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "mySpace.action.download" })}
        </Button>
      </div>
    ),
    [intl, relPath],
  );

  if (tooLarge) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.preview.tooLarge" })}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}
        >
          <Download className="mr-1.5 size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "mySpace.action.download" })}
        </Button>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <ImagePreviewContent
        fitToContainer
        title={relPath}
        imageSource={previewUrl}
        sourcePath={relPath}
      />
    );
  }

  if (kind === "pdf") {
    return <PdfPreviewContent source={previewUrl} labels={pdfLabels} fileName={relPath} />;
  }

  if (kind === "dwg") {
    return <MySpaceDwgPreview relPath={relPath} />;
  }

  if (kind === "audio" || kind === "video") {
    return (
      <PreviewPaneMediaContent
        source={{
          type: "media",
          title: relPath,
          path: relPath,
          kind,
          mediaType: "",
        }}
        loading={false}
        error={null}
        url={previewUrl}
        labels={{
          loading: intl.formatMessage({ id: "mySpace.preview.loading" }),
          unavailable: intl.formatMessage({ id: "mySpace.preview.error" }),
          unsupported: intl.formatMessage({ id: "mySpace.preview.unsupported" }),
        }}
      />
    );
  }

  if (needsText || needsBytes) {
    if (loading || (!error && !text && !bytes)) {
      return (
        <p className="p-4 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.preview.loading" })}
        </p>
      );
    }
    if (error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mySpace.preview.error" })}（{error}）
          </p>
          <p className="text-ui-xs text-foreground-subtlest">{OFFLINE_TIP}</p>
        </div>
      );
    }

    if (kind === "markdown" && text !== null) {
      return (
        <div className="h-full overflow-auto p-3">
          <MarkdownPreviewContent
            content={text}
            sourceKey={relPath}
            sourceTitle={relPath}
            sourcePath={relPath}
            codePreviewSettings={codePreviewSettings}
          />
        </div>
      );
    }

    if (kind === "code" && text !== null) {
      return (
        <CodeContent
          code={text}
          language={inferCodeLanguage(relPath, text)}
          codePreviewSettings={codePreviewSettings}
          codeTheme={
            resolvedTheme === "dark"
              ? codePreviewSettings.darkTheme
              : codePreviewSettings.lightTheme
          }
          wrapLongLines
          className="h-full"
        />
      );
    }

    if (kind === "office" && bytes) {
      return (
        <PreviewPaneOfficeContent
          error={null}
          kind={resolveOfficeKind(relPath)}
          loading={false}
          preview={{ path: relPath, dataBase64: toBase64(bytes), totalBytes: bytes.byteLength }}
          resolvedTheme={resolvedTheme}
          sourcePath={relPath}
        />
      );
    }

    if (kind === "pptx" && bytes) {
      return <PptxPreviewContent data={bytes} fileName={relPath} labels={pptxLabels} />;
    }
  }

  return fallback;
}

/** Office 子类型由同一份扩展名表决定，避免预览器和详情面板各判一次。 */
function resolveOfficeKind(path: string): "docx" | "doc" | "excel" {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".doc")) return "doc";
  if (normalized.endsWith(".xlsx") || normalized.endsWith(".xlsm") || normalized.endsWith(".xls")) {
    return "excel";
  }
  return "docx";
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
