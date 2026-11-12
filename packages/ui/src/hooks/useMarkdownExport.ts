import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { buildExportHtml } from "@/lib/markdownExportHtml.js";
import { buildRichClipboardContent, writeRichClipboard } from "@/lib/richClipboardHtml.js";
import { markdownToDocx } from "@/lib/markdownToDocx.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type MarkdownExportFormat = "png" | "docx" | "pdf";

export interface UseMarkdownExportOptions {
  /** 预览根元素（已渲染 DOM）；PNG/PDF 以它的快照为导出源 */
  getPreviewRoot: () => HTMLElement | null;
  /** markdown 源码；docx 以它重新解析 */
  content: string;
  /** 文件名（不含扩展名），用作默认保存名 */
  fileName: string;
}

/** 超过该高度的 PNG 导出提前提示（spec 3.1） */
const OVER_HEIGHT_LIMIT = 12000;

/** Markdown 导出的唯一状态 owner：互斥标记与错误恢复都在 hook 内，UI 只读。 */
export function useMarkdownExport(options: UseMarkdownExportOptions) {
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const [exporting, setExporting] = useState<MarkdownExportFormat | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const exportAs = useCallback(
    async (format: MarkdownExportFormat) => {
      const { getPreviewRoot, content, fileName } = latest.current;
      const saveFile = platform?.saveFile;
      if (!saveFile) return;
      if (exporting) return;
      setExporting(format);
      try {
        let data: ArrayBuffer;
        if (format === "docx") {
          data = await markdownToDocx(content);
        } else {
          const exportRender = platform?.exportMarkdownPage;
          if (!exportRender) return;
          const root = getPreviewRoot();
          if (!root) return;
          const built = buildExportHtml({ root, title: fileName });
          if (format === "png" && built.height > OVER_HEIGHT_LIMIT) {
            toast(
              intl.formatMessage(
                { id: "markdownExport.tooLong" },
                { height: String(Math.round(built.height)) },
              ),
            );
          }
          const result = await exportRender({
            format,
            html: built.html,
            width: built.width,
            contentHeight: built.height,
          });
          if (!result.success || !result.data) {
            throw new Error(result.error ?? "render_failed");
          }
          data = result.data;
        }
        const extension = format === "png" ? "png" : format === "docx" ? "docx" : "pdf";
        const saveResult = await saveFile({
          data,
          suggestedName: `${fileName || "markdown"}.${extension}`,
        });
        if (saveResult.canceled) return;
        if (!saveResult.success || !saveResult.path) {
          throw new Error(saveResult.error ?? "save_failed");
        }
        toast(intl.formatMessage({ id: "markdownExport.success" }, { path: saveResult.path }));
      } catch (error) {
        logger.error("[useMarkdownExport] Markdown 导出失败", error);
        toast(intl.formatMessage({ id: "markdownExport.failed" }));
      } finally {
        setExporting(null);
      }
    },
    [exporting, intl, platform],
  );

  /**
   * 复制为富文本：把预览 DOM 内联样式后写入剪贴板，供粘贴到 Word / 公众号编辑器等
   * 只认内联 style 的目标。纯前端，不落盘、不新增 IPC。
   */
  const copyAsRichText = useCallback(async () => {
    const { getPreviewRoot } = latest.current;
    const root = getPreviewRoot();
    if (!root) {
      return;
    }
    const content = buildRichClipboardContent(root);
    const ok = await writeRichClipboard(content);
    if (ok) {
      toast(intl.formatMessage({ id: "markdownExport.copyRichTextSuccess" }));
    } else {
      // 富文本剪贴板不可用时退回纯文本，至少让用户拿到内容。
      try {
        await navigator.clipboard.writeText(content.text);
        toast(intl.formatMessage({ id: "markdownExport.copyRichTextFallback" }));
      } catch (error) {
        logger.error("[useMarkdownExport] 复制富文本失败", error);
        toast(intl.formatMessage({ id: "markdownExport.copyRichTextFailed" }));
      }
    }
  }, [intl]);

  return { exporting, exportAs, copyAsRichText };
}
