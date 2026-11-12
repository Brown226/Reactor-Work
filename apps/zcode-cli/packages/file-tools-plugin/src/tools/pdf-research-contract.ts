/**
 * pdf_research 工具契约：zod 入参与模型可见 description。
 * 算法在 ./pdf-research-core.ts；本文件只描述接口，便于 server 注册与单测共用。
 */
import { z } from "zod";

export const pdfStructureInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to a local PDF file."),
});

export const PDF_STRUCTURE_DESCRIPTION = [
  "Extract offline PDF research structure: page_count, title, outline/sections, and figure/table references.",
  "All page numbers (outline[].page, sections[].page, figures[].page) are 1-based; outline[].page is null when a bookmark target cannot be resolved (broken or named destinations).",
  "Use this before quoting or summarizing a paper; for plain body text use parse_document.",
].join(" ");

export const pdfCitationsInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to a local PDF file."),
  max_items: z.number().int().min(1).max(500).optional().describe("Cap on citation entries (default 200)."),
});

export const PDF_CITATIONS_DESCRIPTION = [
  "Extract the References/Bibliography list from a local PDF (offline, heuristic but structured).",
  "Returns entries with optional [n] markers, DOI and URL when present.",
].join(" ");

export const pdfPageTextInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to a local PDF file."),
  start_page: z.number().int().min(1).optional().describe("1-based inclusive start page."),
  end_page: z.number().int().min(1).optional().describe("1-based inclusive end page."),
});

export const PDF_PAGE_TEXT_DESCRIPTION = [
  "Extract plain text for a 1-based inclusive page range of a local PDF (whole document if omitted).",
  "If the range yields no text (scanned page / no text layer) the result carries a note telling you to use ocr_scan instead of retrying.",
  "For full-document markdown prefer parse_document; this tool is for page-scoped research reads.",
].join(" ");

export const pdfRegionTextInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to a local PDF file."),
  page: z.number().int().min(1).describe("1-based page number."),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe("Region [x0,y0,x1,y1] in PDF points with origin at the page top-left."),
});

export const PDF_REGION_TEXT_DESCRIPTION = [
  "Extract text inside a rectangular region on one PDF page (origin top-left, PDF points).",
  "Use for figure captions or a selection the user highlighted in a reader.",
].join(" ");

export const pdfFormulaCandidatesInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to a local PDF file."),
  max_items: z.number().int().min(1).max(200).optional().describe("Cap on candidates (default 60)."),
});

export const PDF_FORMULA_CANDIDATES_DESCRIPTION = [
  "Heuristically list equation-like lines from a local PDF (offline).",
  "Every item is approx=true and latex is raw captured text — not a LaTeX parse. Use as candidates for analysis.",
].join(" ");
