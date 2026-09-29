/**
 * ocr_scan 工具：图片 / 扫描件 PDF → 文本。
 *
 * 推理与栅格化在 office-engines Python（office_skill_lib.ocr，PP-OCR ONNX 最小管线）。
 * 本文件只做入参校验与结果包装，对外契约与历史版本一致。
 * 见 docs/OCR栈轻量化方案.md。
 */
import { extname } from "node:path";
import { z } from "zod";
import { assertReadableFile, wrapFileContent } from "../guard.js";
import { EngineUnavailableError, runOcrCli } from "../ocr-python.js";

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

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"]);
const PDF_EXT = ".pdf";

function isImage(path: string): boolean {
  return IMAGE_EXT.has(extname(path).toLowerCase());
}

function isPdf(path: string): boolean {
  return extname(path).toLowerCase() === PDF_EXT;
}

export async function ocrScan(input: z.infer<typeof ocrScanInputSchema>): Promise<OcrScanOutput> {
  const extension = extname(input.file_path).toLowerCase();
  if (!isImage(input.file_path) && !isPdf(input.file_path)) {
    return {
      status: "failed",
      text: "",
      confidence: 0,
      pages: 0,
      note: `不支持 OCR 的文件类型「${extension || "(无后缀)"}；支持 png/jpg/jpeg/bmp/tif/tiff/webp/pdf`,
    };
  }
  assertReadableFile(input.file_path);

  try {
    if (isPdf(input.file_path)) {
      const result = await runOcrCli([
        "pdf",
        input.file_path,
        "--max-pages",
        String(input.max_pages ?? 20),
      ]);
      if (result.status !== "success") {
        return {
          status: "failed",
          text: "",
          confidence: 0,
          pages: 0,
          note: result.message ?? result.error ?? "OCR 失败",
        };
      }
      return {
        status: "success",
        text: wrapFileContent(String(result.text ?? "")),
        confidence: Number(result.confidence ?? 0),
        pages: Number(result.pages ?? 0),
        note: result.note ? String(result.note) : undefined,
      };
    }

    const result = await runOcrCli(["image", input.file_path]);
    if (result.status !== "success") {
      return {
        status: "failed",
        text: "",
        confidence: 0,
        pages: 0,
        note: result.message ?? result.error ?? "OCR 失败",
      };
    }
    return {
      status: "success",
      text: wrapFileContent(String(result.text ?? "").trim()),
      confidence: Number(result.confidence ?? 0),
      pages: 1,
    };
  } catch (error) {
    if (error instanceof EngineUnavailableError) {
      return {
        status: "failed",
        text: "",
        confidence: 0,
        pages: 0,
        note: error.message,
      };
    }
    throw error;
  }
}
