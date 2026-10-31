/**
 * 我的空间：文件预览。
 *
 * 为什么不直接用 iframe：浏览器对 docx/xlsx/pptx 没有原生渲染能力，iframe 只会触发下载
 * 或乱码。产品里已有成熟的 Office 渲染器（桌面端预览面板在用），这里直接复用同一套组件，
 * 把空间文件按 base64 喂进去即可——不重复造轮子，也保证预览效果与桌面端一致。
 *
 * 分级策略：
 * - 图片 → <img>
 * - PDF → <iframe>（浏览器原生 PDF 阅读器）
 * - docx/doc/xlsx → PreviewPaneOfficeContent
 * - pptx → PptxPreviewContent
 * - 图纸(.dwg/.dxf) 及其它 → 明确提示 + 下载入口（DWG 需要服务端 sidecar 解析，
 *   属于 agent 工具能力，不在前端渲染范围内）
 */
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { PptxPreviewContent } from "@/previewPanePptxContent.js";
import { PreviewPaneOfficeContent } from "@/previewPaneOfficeContent.js";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { spaceClient } from "./spaceClient.js";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const PDF_EXT = /\.pdf$/i;
const PPTX_EXT = /\.pptx$/i;
const DWG_EXT = /\.(dwg|dxf)$/i;

/** 与桌面端预览面板一致的 PPT 文案集合（中文，与面板其余文案同语言）。 */
const PPTX_LABELS = {
  loading: "正在加载演示文稿…",
  loadError: "演示文稿加载失败",
  noSlides: "没有可显示的幻灯片",
  previousPage: "上一页",
  nextPage: "下一页",
  pageInput: "页码",
  zoomIn: "放大",
  zoomOut: "缩小",
  thumbnails: "缩略图",
  thumbnail: (pageNumber: number) => `第 ${pageNumber} 页`,
  exportPdf: "导出 PDF",
  exportingPdf: "正在导出…",
  exportPdfSuccess: (path: string) => `已导出：${path}`,
  exportPdfFailed: "导出失败",
  selectElement: "选择元素",
  exitElementSelection: "退出选择",
  aiEdit: "AI 编辑",
  commentPlaceholder: "描述你的修改要求",
  cancelAiEdit: "取消",
  addToConversation: "加入对话",
  referencedPageMissing: (pageNumber: number) => `第 ${pageNumber} 页不存在`,
  referencedSourceChanged: (pageNumber: number) => `第 ${pageNumber} 页来源已变更`,
};

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function MySpacePreview({
  relPath,
  resolvedTheme,
}: {
  relPath: string;
  resolvedTheme: "light" | "dark";
}) {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const previewUrl = spaceClient.previewUrl(relPath);
  const officeKind = getOfficeFilePreviewKind(relPath);
  const needsBytes = Boolean(officeKind) || PPTX_EXT.test(relPath) || DWG_EXT.test(relPath);

  useEffect(() => {
    if (!needsBytes) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBuffer(null);
    void fetch(previewUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`加载失败（${response.status}）`);
        const data = await response.arrayBuffer();
        if (!cancelled) setBuffer(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsBytes, previewUrl]);

  if (IMAGE_EXT.test(relPath)) {
    return <img src={previewUrl} alt={relPath} className="h-full w-full object-contain" />;
  }

  if (PDF_EXT.test(relPath)) {
    return <iframe title={relPath} src={previewUrl} className="h-full w-full" />;
  }

  if (officeKind && (buffer || loading || error)) {
    return (
      <PreviewPaneOfficeContent
        error={error}
        kind={officeKind}
        loading={loading}
        preview={
          buffer
            ? { path: relPath, dataBase64: base64FromBuffer(buffer), totalBytes: buffer.byteLength }
            : null
        }
        resolvedTheme={resolvedTheme}
        sourcePath={relPath}
      />
    );
  }

  if (PPTX_EXT.test(relPath) && buffer) {
    return (
      <PptxPreviewContent data={buffer} fileName={relPath} labels={PPTX_LABELS} />
    );
  }

  if (DWG_EXT.test(relPath)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-ui-sm text-foreground-subtle">
          图纸需要服务端解析后才能预览。可以先下载用 CAD 打开，或直接在对话里让 agent 解析这张图纸。
        </p>
        <Button size="sm" variant="outline" asChild={false} onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}>
          <Download className="mr-2 size-4" /> 下载图纸
        </Button>
      </div>
    );
  }

  if (loading) return <p className="p-4 text-ui-sm text-foreground-subtle">加载中…</p>;
  if (error) return <p className="p-4 text-ui-sm text-foreground-subtle">{error}</p>;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-ui-sm text-foreground-subtle">该类型暂不支持在线预览。</p>
      <Button size="sm" variant="outline" onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}>
        <Download className="mr-2 size-4" /> 下载文件
      </Button>
    </div>
  );
}
