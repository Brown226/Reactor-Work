/**
 * pdf_research 五件离线 API：结构 / 引文 / 页文本 / 区域文本 / 公式候选。
 *
 * 设计来源 LeAgent `pdf_research_core.py`（Apache-2.0）；引擎为 file-tools
 * 内置 pdfjs-dist。启发式纯函数在 ./pdf-research-heuristics.ts。
 *
 * 边界：与 parse_document 不重复（研究 API vs 正文抽取）；公式候选一律 approx。
 */
import { readFile } from "node:fs/promises";
import { FileToolError, assertReadableFile } from "../guard.js";
import { loadPdfjsOnce } from "../raster.js";
import {
  DOI_RE,
  EQ_LABEL_RE,
  FIGURE_RE,
  URL_RE,
  deriveSectionsFromPages,
  figureLabel,
  looksLikeFormulaLine,
  sortFigures,
  splitLines,
  splitReferenceEntries,
  type FigureEntry,
  type OutlineEntry,
  type SectionEntry,
} from "./pdf-research-heuristics.js";

// ── 打开文档 ────────────────────────────────────────────────────────────────

interface OpenPdf {
  doc: any;
  pageCount: number;
}

/**
 * 加密 PDF：pdfjs 在 getDocument 阶段抛 PasswordException（name 固定，见
 * pdfjs-dist `PasswordException`）。工具无交互渠道问密码，翻成 FileToolError
 * 中文指引；其余打开失败原样上抛，由 server 统一报错。
 */
function isPasswordException(pdfjs: any, error: unknown): boolean {
  if (typeof pdfjs?.PasswordException === "function" && error instanceof pdfjs.PasswordException) {
    return true;
  }
  // 跨 bundle/worker 传输后 instanceof 可能失效，按 name 兜底识别。
  return (error as { name?: unknown })?.name === "PasswordException";
}

async function openPdf(filePath: string): Promise<OpenPdf> {
  assertReadableFile(filePath);
  const pdfjs = await loadPdfjsOnce();
  const bytes = new Uint8Array(await readFile(filePath));
  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
  } catch (error) {
    if (isPasswordException(pdfjs, error)) {
      throw new FileToolError("该 PDF 已加密，无法离线解析，请先解除密码保护");
    }
    throw error;
  }
  return { doc, pageCount: doc.numPages as number };
}

async function closePdf(doc: any): Promise<void> {
  await doc.cleanup();
}

/** 单页纯文本（按阅读顺序拼接）。 */
async function pageText(page: any): Promise<string> {
  const content = await page.getTextContent();
  const parts: string[] = [];
  let lastY: number | null = null;
  for (const item of content.items as Array<{ str?: string; transform?: number[] }>) {
    if (typeof item.str !== "string") continue;
    const y: number = item.transform ? Math.round(item.transform[5]) : (lastY ?? 0);
    if (lastY !== null && y !== lastY) parts.push("\n");
    parts.push(item.str);
    lastY = y;
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function docPageText(doc: any, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  try {
    return await pageText(page);
  } finally {
    page.cleanup();
  }
}

// ── pdf_structure ───────────────────────────────────────────────────────────

/** 大纲最多返回 200 条（与原实现一致），解析 dest 也一并到此为止。 */
const MAX_OUTLINE_ENTRIES = 200;

/**
 * 把书签的 dest 解析成页码。对外页码口径写死为 **1-based**：
 * pdfjs `getPageIndex` 返回 0-based；UI 侧 `PaperModePanel.handleOutline`
 * （packages/ui/src/pdf-reader/PaperModePanel.tsx）同样做 `dest[0] + 1` 再交给
 * pdfjs viewer（pageNumber 从 1 开始），`pdf_page_text` 的 start/end 也是 1-based。
 *
 * dest 形态（实测 pdfjs 6.2）：
 * - 数组且首元素是 Ref `{num, gen}` → getPageIndex(ref) + 1；
 * - 数组且首元素是数字（远端跳转的 0-based 页码）→ +1（与 UI 侧口径一致）；
 * - 字符串 → 具名目标，先 getDestination(name) 再按数组处理。
 * 解析失败一律返回 null（坏书签/无效具名目标在真实文件里很常见，不能让结构抽取失败）。
 */
async function outlineDestPage(doc: any, dest: unknown): Promise<number | null> {
  try {
    const array = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(array) || array.length === 0) return null;
    const target = array[0] as unknown;
    const pageCount = doc.numPages as number;
    if (typeof target === "number") {
      const page = target + 1;
      return Number.isInteger(page) && page >= 1 && page <= pageCount ? page : null;
    }
    if (target && typeof target === "object") {
      const index = await doc.getPageIndex(target);
      return Number.isInteger(index) && index >= 0 && index < pageCount ? index + 1 : null;
    }
    return null;
  } catch {
    // dest 指向不存在的页对象（pdfjs 抛 "The reference does not point to a /Page dictionary."）
    // 或具名目标缺失：保留 null，不抛错。
    return null;
  }
}

async function readOutline(doc: any): Promise<OutlineEntry[]> {
  const raw = (await doc.getOutline()) ?? [];
  const out: OutlineEntry[] = [];
  const walk = async (nodes: any[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (out.length >= MAX_OUTLINE_ENTRIES) return;
      const title = String(node.title ?? "").trim();
      if (title) {
        out.push({ title, page: await outlineDestPage(doc, node.dest), level });
      }
      if (Array.isArray(node.items) && node.items.length > 0) {
        await walk(node.items, level + 1);
      }
    }
  };
  await walk(raw, 1);
  return out;
}

/** 标题行包围盒（原点左上，PDF 点）。 */
async function captionBBox(
  page: any,
  number: string,
): Promise<[number, number, number, number] | null> {
  const viewport = page.getViewport({ scale: 1 });
  const pageHeight = viewport.height as number;
  const textContent = await page.getTextContent();
  const items = textContent.items as Array<{
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
  }>;
  const rows = new Map<
    number,
    Array<{ str: string; x: number; y: number; w: number; h: number }>
  >();
  for (const item of items) {
    if (typeof item.str !== "string" || !item.transform) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const w = item.width ?? 0;
    const h = item.height ?? Math.abs(item.transform[3] ?? 10);
    const key = Math.round(y);
    const row = rows.get(key) ?? [];
    row.push({ str: item.str, x, y, w, h });
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    const line = row.map((r) => r.str).join(" ");
    if (!/\b(figure|fig|table)\b/i.test(line)) continue;
    if (!new RegExp(`\\b${number}\\b`).test(line)) continue;
    const x0 = Math.min(...row.map((r) => r.x));
    const x1 = Math.max(...row.map((r) => r.x + r.w));
    const yBase = Math.min(...row.map((r) => r.y));
    const yTopBaseline = Math.max(...row.map((r) => r.y + r.h));
    const top = pageHeight - yTopBaseline;
    const bottom = pageHeight - yBase;
    return [x0, top, x1, bottom];
  }
  return null;
}

async function deriveFigures(doc: any, pageCount: number): Promise<FigureEntry[]> {
  const figures: FigureEntry[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= pageCount; p += 1) {
    const page = await doc.getPage(p);
    try {
      const text = await pageText(page);
      FIGURE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FIGURE_RE.exec(text)) !== null) {
        const { kind, label } = figureLabel(match[1], match[2]);
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const entry: FigureEntry = { id: `fig-${figures.length}`, label, page: p, kind };
        const bbox = await captionBBox(page, match[2]);
        if (bbox) entry.bbox = bbox;
        figures.push(entry);
        if (figures.length >= 120) break;
      }
    } finally {
      page.cleanup();
    }
  }
  return sortFigures(figures);
}

export interface PdfStructureResult {
  page_count: number;
  title: string | null;
  outline: OutlineEntry[];
  sections: SectionEntry[];
  figures: FigureEntry[];
}

export async function pdfStructure(filePath: string): Promise<PdfStructureResult> {
  const { doc, pageCount } = await openPdf(filePath);
  try {
    const meta = await doc.getMetadata();
    const title =
      (meta?.info?.Title && String(meta.info.Title).trim()) ||
      (meta?.metadata?.get?.("dc:title") as string | undefined) ||
      null;
    const outline = await readOutline(doc);
    const sections = await deriveSectionsFromPages(outline, pageCount, (p) =>
      docPageText(doc, p),
    );
    const figures = await deriveFigures(doc, pageCount);
    return {
      page_count: pageCount,
      title: title || null,
      outline,
      sections,
      figures,
    };
  } finally {
    await closePdf(doc);
  }
}

// ── pdf_citations ───────────────────────────────────────────────────────────

export interface PdfCitation {
  id: string;
  marker: string;
  text: string;
  doi: string | null;
  url: string | null;
}

export async function pdfCitations(
  filePath: string,
  maxItems = 200,
): Promise<{ items: PdfCitation[] }> {
  const { doc, pageCount } = await openPdf(filePath);
  try {
    const refParts: string[] = [];
    let started = false;
    for (let p = 1; p <= pageCount; p += 1) {
      const text = await docPageText(doc, p);
      if (!started) {
        const head = splitLines(text).slice(0, 6).join("\n").toLowerCase();
        const headHit = /\b(references|bibliography)\b/.test(head);
        const bodyHit = /^\s*(references|bibliography)\s*$/im.test(text);
        if (headHit || bodyHit) {
          started = true;
          const split = text.split(/\b(references|bibliography)\b/i);
          refParts.push(split.length > 1 ? split.slice(1).join("") : text);
          continue;
        }
      } else {
        refParts.push(text);
      }
    }
    if (!started) return { items: [] };
    const entries = splitReferenceEntries(refParts.join("\n"));
    const items: PdfCitation[] = entries.slice(0, maxItems).map((entry, i) => {
      const markerMatch = /^\s*[[(]?(\d{1,3})[\]).]/.exec(entry);
      const doiMatch = DOI_RE.exec(entry);
      const urlMatch = URL_RE.exec(entry);
      return {
        id: `cit-${i}`,
        marker: markerMatch ? `[${markerMatch[1]}]` : "",
        text: entry.replace(/\s+/g, " ").trim().slice(0, 600),
        doi: doiMatch ? doiMatch[0] : null,
        url: urlMatch ? urlMatch[0] : null,
      };
    });
    return { items };
  } finally {
    await closePdf(doc);
  }
}

// ── pdf_page_text ───────────────────────────────────────────────────────────

/**
 * 无文本层提示：措辞与 parse-document.ts 的 needsOcr 指引保持同一套说法，
 * 避免同一个事实在两条路径上有两种口径。
 */
const NO_TEXT_LAYER_NOTE =
  "该 PDF 是扫描件/无文本层，请改用 ocr_scan 抽取文字；也可用 Read 的 pages 模式直接把页面当图片读给模型。";

export interface PdfPageTextResult {
  text: string;
  start: number;
  end: number;
  page_count: number;
  /** 仅当请求页范围抽不到任何文本时给出：提示改用 ocr_scan，而不是静默返回空串。 */
  note?: string;
}

export async function pdfPageText(
  filePath: string,
  startPage?: number | null,
  endPage?: number | null,
): Promise<PdfPageTextResult> {
  const { doc, pageCount } = await openPdf(filePath);
  try {
    const start = Math.max(1, startPage ?? 1);
    const end = Math.min(pageCount, endPage ?? pageCount);
    const parts: string[] = [];
    for (let p = start; p <= end; p += 1) {
      const body = (await docPageText(doc, p)).trim();
      if (body) parts.push(body);
    }
    const text = parts.join("\n\n");
    return {
      text,
      start,
      end,
      page_count: pageCount,
      ...(text ? {} : { note: NO_TEXT_LAYER_NOTE }),
    };
  } finally {
    await closePdf(doc);
  }
}

// ── pdf_region_text ─────────────────────────────────────────────────────────

export interface PdfRegionTextResult {
  text: string;
  page: number;
  page_count: number;
  /** 仅当该页整体没有文本层时给出（框内为空但页内有文字属于正常选区，不加提示）。 */
  note?: string;
}

/** bbox 原点左上；过滤文本 item 中心点是否落在框内。 */
export async function pdfRegionText(
  filePath: string,
  page: number,
  bbox: [number, number, number, number],
): Promise<PdfRegionTextResult> {
  const { doc, pageCount } = await openPdf(filePath);
  try {
    if (page < 1 || page > pageCount) return { text: "", page, page_count: pageCount };
    const pdfPage = await doc.getPage(page);
    try {
      const viewport = pdfPage.getViewport({ scale: 1 });
      const pageHeight = viewport.height as number;
      const [x0, y0, x1, y1] = bbox;
      const content = await pdfPage.getTextContent();
      const items = content.items as Array<{
        str?: string;
        transform?: number[];
        width?: number;
      }>;
      const pageHasText = items.some(
        (item) => typeof item.str === "string" && item.str.trim() !== "",
      );
      const parts: string[] = [];
      let lastY: number | null = null;
      for (const item of items) {
        if (typeof item.str !== "string" || !item.transform) continue;
        const cx = item.transform[4] + (item.width ?? 0) / 2;
        const topY = pageHeight - item.transform[5];
        if (cx < x0 || cx > x1 || topY < y0 || topY > y1) continue;
        const yKey = Math.round(topY);
        if (lastY !== null && yKey !== lastY) parts.push(" ");
        parts.push(item.str);
        lastY = yKey;
      }
      const text = parts.join("").replace(/\s+/g, " ").trim();
      return {
        text,
        page,
        page_count: pageCount,
        ...(text === "" && !pageHasText ? { note: NO_TEXT_LAYER_NOTE } : {}),
      };
    } finally {
      pdfPage.cleanup();
    }
  } finally {
    await closePdf(doc);
  }
}

// ── pdf_formula_candidates ──────────────────────────────────────────────────

export interface PdfFormulaCandidate {
  id: string;
  latex: string;
  page: number;
  label: string;
  description: string;
  approx: true;
}

export async function pdfFormulaCandidates(
  filePath: string,
  maxItems = 60,
): Promise<{ items: PdfFormulaCandidate[]; note: string }> {
  const { doc, pageCount } = await openPdf(filePath);
  try {
    const out: PdfFormulaCandidate[] = [];
    const seen = new Set<string>();
    for (let p = 1; p <= pageCount && out.length < maxItems; p += 1) {
      for (const raw of splitLines(await docPageText(doc, p))) {
        const line = raw.trim();
        if (!looksLikeFormulaLine(line)) continue;
        const key = line.replace(/\s+/g, "");
        if (seen.has(key)) continue;
        seen.add(key);
        const labelMatch = EQ_LABEL_RE.exec(line);
        const label = labelMatch ? `(${labelMatch[1]})` : "";
        const latex = label ? line.replace(EQ_LABEL_RE, "").trim() : line;
        out.push({
          id: `eq-${out.length}`,
          latex,
          page: p,
          label,
          description: "",
          approx: true,
        });
        if (out.length >= maxItems) break;
      }
    }
    return {
      items: out,
      note: "启发式候选，非 LaTeX 识别；字段 latex 为原始行文本（approx=true）。",
    };
  } finally {
    await closePdf(doc);
  }
}
