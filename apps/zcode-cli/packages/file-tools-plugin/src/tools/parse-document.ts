/**
 * parse_document 工具：Office/PDF → Markdown（@firecrawl/anydoc，napi 原生，
 * 随安装包分发）。扫描件 PDF 由 anydoc 报 needsOcr —— 工具把它翻成给人/模型的
 * 可执行指引（改用 ocr_scan），而不是裸露的 napi 英文堆栈。
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { assertReadableFile, wrapFileContent } from "../guard.js";
import { loadAnydoc } from "../native.js";

export const PARSE_DOCUMENT_DESCRIPTION = [
  "Extract text from a local Office/PDF document as GitHub-Flavored Markdown (docx/doc/xlsx/xls/pptx/ppt/odt/rtf/csv/epub/pdf),",
  "using the bundled offline engine. Tables are preserved. For scanned/image-only PDFs it reports that OCR is needed:",
  "call ocr_scan (or use the pages mode of Read for a quick visual pass).",
].join(" ");

/** 纯文本后缀直读：比 anydoc 快，且这些格式它未必更好（口径与 server 侧 parse.ts 一致）。 */
const PLAIN_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
  ".yml",
  ".yaml",
  ".html",
  ".htm",
  ".xml",
]);

export const parseDocumentInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to the document to parse."),
});

interface ParseDocumentOutput {
  markdown: string;
  parser: "anydoc" | "plain-text";
  charCount: number;
  note?: string;
}

function needsOcrMessage(error: unknown): string | null {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "needsOcr") {
    const pages = (error as { pages?: unknown }).pages;
    const pageText = Array.isArray(pages) ? `（需要 OCR 的页：${pages.join(", ")}）` : "";
    return `该 PDF 是扫描件/无文本层${pageText}，请改用 ocr_scan 抽取文字；也可用 Read 的 pages 模式直接把页面当图片读给模型。`;
  }
  return null;
}

export async function parseDocument(
  input: z.infer<typeof parseDocumentInputSchema>,
): Promise<ParseDocumentOutput> {
  assertReadableFile(input.file_path);
  const extension = extname(input.file_path).toLowerCase();

  if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
    const text = (await readFile(input.file_path)).toString("utf-8");
    return {
      markdown: wrapFileContent(text),
      parser: "plain-text",
      charCount: text.length,
    };
  }

  const anydoc = loadAnydoc();
  let text: string;
  try {
    text = await anydoc.toMarkdownBytes(new Uint8Array(await readFile(input.file_path)));
  } catch (error) {
    const ocrGuide = needsOcrMessage(error);
    if (ocrGuide) {
      throw Object.assign(new Error(ocrGuide), { code: "NEEDS_OCR" });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/unknown|unsupported|format|识别/i.test(message)) {
      throw new Error(
        `暂不支持解析「${extension || "(无后缀)"}」格式的文件（支持 pdf/office/纯文本），请转成 pdf 或 md 后重试。`,
      );
    }
    throw new Error(`解析失败：${message}`);
  }

  if (text.trim().length === 0) {
    throw Object.assign(
      new Error("解析结果为空：可能是扫描件或纯图片内容，请改用 ocr_scan。"),
      { code: "NEEDS_OCR" },
    );
  }

  return {
    markdown: wrapFileContent(text),
    parser: "anydoc",
    charCount: text.length,
  };
}
