/**
 * pdf_research 启发式（纯函数）：章节/图表/引文拆分/公式行判定。
 * 口径对齐 LeAgent pdf_research_core.py；不碰 IO，便于单测。
 */

export const SECTION_KEYWORDS = new Set([
  "abstract",
  "introduction",
  "background",
  "related work",
  "preliminaries",
  "methodology",
  "methods",
  "approach",
  "model",
  "experiments",
  "experimental setup",
  "evaluation",
  "results",
  "analysis",
  "discussion",
  "ablation",
  "limitations",
  "conclusion",
  "conclusions",
  "future work",
  "acknowledgments",
  "acknowledgements",
  "references",
  "bibliography",
  "appendix",
]);

export const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+){0,2})\.?\s+([A-Z][^\n]{2,80})$/;
export const FIGURE_RE = /\b(Fig(?:ure)?|Table)\s*\.?\s*([0-9]+|[IVX]+)\b/gi;
export const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
export const URL_RE = /https?:\/\/[^\s)]+/i;
export const EQ_LABEL_RE = /\(\s*(\d{1,3}[a-z]?)\s*\)\s*$/;

const MATH_SYMBOLS =
  "=≈≤≥≠∑∫∏√∞±×÷·∂∇∈∉⊂⊆⊃∪∩∀∃∝⇒⇔→←↦∼≜ℓ" +
  "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ";
export const MATH_HINT_RE = new RegExp(
  `[${MATH_SYMBOLS}]|\\\\(?:frac|sum|int|prod|sqrt|partial|nabla)|\\^\\{?\\w|_\\{?\\w`,
);
export const MATH_NOISE_RE = /https?:\/\/|www\.|doi[:.]|©|\bfig(?:ure)?\b|\btable\b/i;

export interface OutlineEntry {
  title: string;
  page: number | null;
  level: number;
}

export interface FigureEntry {
  id: string;
  label: string;
  page: number;
  kind: "figure" | "table";
  bbox?: [number, number, number, number];
}

export function headingLevel(numbering: string | null): number {
  return numbering ? Math.min(3, numbering.split(".").length) : 1;
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 引文条目拆分：编号行 → 空行块 → 单行，取第一个够用的策略。 */
export function splitReferenceEntries(blob: string): string[] {
  const trimmed = blob.trim();
  if (!trimmed) return [];
  const numbered = `\n${trimmed}`
    .split(/\n\s*(?=\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}\.\s)/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (numbered.length >= 3) return numbered;
  const blocks = trimmed
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 20);
  if (blocks.length >= 3) return blocks;
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 20);
}

/** 公式候选：单行启发式；命中数学符号且不像噪声/长句。 */
export function looksLikeFormulaLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 180) return false;
  if (MATH_NOISE_RE.test(trimmed)) return false;
  const hits = trimmed.match(MATH_HINT_RE);
  if (!hits) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return !(words.length > 14 && hits.length < 2);
}

export interface SectionEntry {
  id: string;
  title: string;
  page: number;
  level: number;
}

/**
 * 章节：优先书签（level≤2），否则扫前 40 页标题行。
 * `getText` 由 core 注入，保持本文件零 IO。
 */
export async function deriveSectionsFromPages(
  outline: OutlineEntry[],
  pageCount: number,
  getPageText: (page: number) => Promise<string>,
): Promise<SectionEntry[]> {
  const sections: SectionEntry[] = [];
  if (outline.length > 0) {
    for (let i = 0; i < outline.length; i += 1) {
      const node = outline[i];
      if (node.level <= 2 && node.page) {
        sections.push({ id: `sec-${i}`, title: node.title, page: node.page, level: node.level });
      }
    }
    if (sections.length > 0) return sections.slice(0, 80);
  }

  const seen = new Set<string>();
  let idx = 0;
  const scanPages = Math.min(pageCount, 40);
  for (let p = 1; p <= scanPages; p += 1) {
    for (const line of splitLines(await getPageText(p))) {
      if (line.length > 90) continue;
      let numbering: string | null = null;
      let title: string | null = null;
      const match = NUMBERED_HEADING_RE.exec(line);
      if (match) {
        numbering = match[1];
        title = match[2].trim();
      } else {
        const lower = line.toLowerCase().replace(/:$/, "");
        if (SECTION_KEYWORDS.has(lower)) {
          title =
            line === line.toUpperCase() && line.length <= 40
              ? titleCase(line)
              : line.replace(/:$/, "");
        }
      }
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sections.push({
        id: `sec-${idx}`,
        title: numbering ? `${numbering} ${title}`.trim() : title,
        page: p,
        level: headingLevel(numbering),
      });
      idx += 1;
      if (sections.length >= 80) return sections;
    }
  }
  return sections;
}

export function sortFigures(figures: FigureEntry[]): FigureEntry[] {
  return figures
    .slice()
    .sort(
      (a, b) =>
        Number(a.kind !== "figure") - Number(b.kind !== "figure") || a.page - b.page,
    );
}

export function figureLabel(kindRaw: string, number: string): {
  kind: "figure" | "table";
  label: string;
} {
  const kind: "figure" | "table" = kindRaw.toLowerCase().startsWith("table")
    ? "table"
    : "figure";
  return { kind, label: `${kind === "table" ? "Table" : "Figure"} ${number}` };
}
