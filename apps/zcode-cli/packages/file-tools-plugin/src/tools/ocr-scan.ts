/**
 * ocr_scan 工具：图片 / 扫描件 PDF → 文本（PP-OCR 本地推理，离线可用）。
 * PDF 走栅格化（pdfjs + @napi-rs/canvas），位图解 jimp。
 */
import { extname } from "node:path";
import { z } from "zod";
import { assertReadableFile, wrapFileContent } from "../guard.js";
import { decodeImageFile, isImagePath, isPdfPath } from "../image-input.js";
import { recognizeImage } from "../ocr-engine.js";
import { rasterizePdfPages } from "../raster.js";

export const OCR_SCAN_DESCRIPTION = [
  "Recognize text from a local image or scanned PDF with the bundled offline OCR engine (PP-OCR, Chinese+English).",
  "Use it when Read on a PDF/page yields no text layer or garbage, when the user attaches a scan/photo/screenshot,",
  "or when parse_document reports the PDF needs OCR. Returns text wrapped in <file_content> plus an average confidence.",
  "If confidence is low, Read the image yourself (Read with the image path) to verify visually.",
].join(" ");

export const ocrScanInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to an image (png/jpg/bmp/tiff/webp) or a PDF file."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max PDF pages to OCR (default 20; the first N pages)."),
});

interface OcrScanOutput {
  status: "success" | "failed";
  text: string;
  confidence: number;
  pages: number;
  note?: string;
}

export async function ocrScan(input: z.infer<typeof ocrScanInputSchema>): Promise<OcrScanOutput> {
  const extension = extname(input.file_path).toLowerCase();
  if (!isImagePath(input.file_path) && !isPdfPath(input.file_path)) {
    return {
      status: "failed",
      text: "",
      confidence: 0,
      pages: 0,
      note: `不支持 OCR 的文件类型「${extension || "(无后缀)"}；支持 png/jpg/jpeg/bmp/tif/tiff/webp/pdf`,
    };
  }
  assertReadableFile(input.file_path);

  const pageTexts: string[] = [];
  const confidences: number[] = [];

  if (isPdfPath(input.file_path)) {
    const { images, totalPages } = await rasterizePdfPages(input.file_path, undefined, {
      dpi: 200,
      maxPages: input.max_pages ?? 20,
    });
    for (const image of images) {
      const result = await recognizeImage(image);
      pageTexts.push(result.text.trim());
      if (result.lines.length > 0) confidences.push(result.confidence);
    }
    return {
      status: "success",
      text: wrapFileContent(pageTexts.filter((text) => text.length > 0).join("\n\n--- 页分隔 ---\n\n")),
      confidence: confidences.length > 0 ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0,
      pages: images.length,
      note: totalPages > images.length ? `共 ${totalPages} 页，仅识别前 ${images.length} 页` : undefined,
    };
  }

  const image = await decodeImageFile(input.file_path);
  const result = await recognizeImage(image);
  return {
    status: "success",
    text: wrapFileContent(result.text.trim()),
    confidence: result.confidence,
    pages: 1,
  };
}
