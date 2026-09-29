/**
 * pdf_research 对外入口：算法在 core，契约在 contract。
 * server 与测试统一从本文件 import，避免多条路径。
 */
export {
  pdfCitations,
  pdfFormulaCandidates,
  pdfPageText,
  pdfRegionText,
  pdfStructure,
} from "./pdf-research-core.js";
export type {
  PdfCitation,
  PdfFormulaCandidate,
  PdfRegionTextResult,
  PdfStructureResult,
} from "./pdf-research-core.js";
export {
  PDF_CITATIONS_DESCRIPTION,
  PDF_FORMULA_CANDIDATES_DESCRIPTION,
  PDF_PAGE_TEXT_DESCRIPTION,
  PDF_REGION_TEXT_DESCRIPTION,
  PDF_STRUCTURE_DESCRIPTION,
  pdfCitationsInputSchema,
  pdfFormulaCandidatesInputSchema,
  pdfPageTextInputSchema,
  pdfRegionTextInputSchema,
  pdfStructureInputSchema,
} from "./pdf-research-contract.js";
