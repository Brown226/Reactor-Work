/**
 * 论文模式侧栏：大纲 / 插图 / 公式 / 引文（P0b，docs/未完成-PDF阅读器-论文模式-spec-v1.md）。
 * 大纲来自 pdf.js getOutline；图注/公式/引文用与 file-tools 同口径的启发式
 * （浏览器侧轻量版，完整 API 仍在 file-tools `pdf_*` 工具）。
 */

import {
  appendBlockToComposerDraftText,
  normalizeComposerTextInsertSessionId,
} from "@/lib/composerTextInsert.js";

export interface PaperOutlineItem {
  title: string;
  page: number | null;
  level: number;
}

export interface PaperCitationItem {
  id: string;
  marker: string;
  text: string;
}

export interface PaperFigureItem {
  id: string;
  label: string;
  kind: "figure" | "table";
  page: number;
}

export interface PaperFormulaItem {
  id: string;
  page: number;
  text: string;
}

/** 与 file-tools `pdf-research-heuristics.ts` 的 FIGURE_RE 保持同口径。 */
const PAPER_FIGURE_RE = /\b(Fig(?:ure)?|Table)\s*\.?\s*([0-9]+|[IVX]+)\b/gi;

/** 与 file-tools 同口径的数学特征字符集与噪声过滤（浏览器侧轻量版）。 */
const PAPER_MATH_SYMBOLS =
  "=≈≤≥≠∑∫∏√∞±×÷·∂∇∈∉⊂⊆⊃∪∩∀∃∝⇒⇔→←↦∼≜ℓ" + "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ";
const PAPER_MATH_HINT_RE = new RegExp(
  `[${PAPER_MATH_SYMBOLS}]|\\\\(?:frac|sum|int|prod|sqrt|partial|nabla)|\\^\\{?\\w|_\\{?\\w`,
);
const PAPER_MATH_NOISE_RE = /https?:\/\/|www\.|doi[:.]|©|\bfig(?:ure)?\b|\btable\b/i;

/** 单页文本里收集图注候选；`seen` 由调用方跨页传递用于按 label 去重（同服务端口径）。 */
export function collectPaperFiguresFromPage(
  page: number,
  text: string,
  seen: Set<string>,
  acc: PaperFigureItem[],
  maxItems = 120,
): void {
  if (acc.length >= maxItems) return;
  PAPER_FIGURE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAPER_FIGURE_RE.exec(text)) !== null) {
    const kindRaw = match[1] ?? "";
    const kind: "figure" | "table" = kindRaw.toLowerCase().startsWith("table") ? "table" : "figure";
    const label = `${kind === "table" ? "Table" : "Figure"} ${match[2]}`;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    acc.push({ id: `fig-${acc.length}`, label, kind, page });
    if (acc.length >= maxItems) return;
  }
}

/** 公式候选：单行启发式；命中数学符号且不像噪声/长句（同服务端 looksLikeFormulaLine）。 */
export function looksLikePaperFormulaLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 180) return false;
  if (PAPER_MATH_NOISE_RE.test(trimmed)) return false;
  const hits = trimmed.match(PAPER_MATH_HINT_RE);
  if (!hits) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return !(words.length > 14 && hits.length < 2);
}

/** 单页文本里收集公式候选（每页最多 8 条，避免整页矩阵刷屏）。 */
export function collectPaperFormulasFromPage(
  page: number,
  text: string,
  acc: PaperFormulaItem[],
  maxItems = 200,
): void {
  if (acc.length >= maxItems) return;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!looksLikePaperFormulaLine(rawLine)) continue;
    acc.push({
      id: `eq-${acc.length}`,
      page,
      text: rawLine.trim().replace(/\s+/g, " ").slice(0, 80),
    });
    if (acc.length >= maxItems) return;
  }
}

/** 逐页扫描：输入是「页码 → 该页文本」，输出四页签用的插图/公式候选。 */
export function scanPaperPagesForFiguresAndFormulas(pages: Array<{ page: number; text: string }>): {
  figures: PaperFigureItem[];
  formulas: PaperFormulaItem[];
} {
  const figures: PaperFigureItem[] = [];
  const formulas: PaperFormulaItem[] = [];
  const seenFigures = new Set<string>();
  for (const { page, text } of pages) {
    collectPaperFiguresFromPage(page, text, seenFigures, figures);
    collectPaperFormulasFromPage(page, text, formulas);
  }
  return { figures, formulas };
}

/** 从 pdf.js outline 树展平（dest 页码在浏览器侧用 getPageIndex 解析成本）。 */
export function flattenPdfJsOutline(
  items: Array<{ title?: string; dest?: unknown; items?: unknown }> | null | undefined,
  destToPage: (dest: unknown) => number | null,
  level = 1,
  acc: PaperOutlineItem[] = [],
): PaperOutlineItem[] {
  for (const item of items ?? []) {
    const title = String(item.title ?? "").trim();
    if (title) {
      acc.push({ title, page: destToPage(item.dest), level });
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      flattenPdfJsOutline(item.items as never, destToPage, level + 1, acc);
    }
  }
  return acc;
}

/** References 段拆条（与 pdf-research-heuristics.splitReferenceEntries 同策略）。 */
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

export function extractCitationsFromText(text: string, maxItems = 200): PaperCitationItem[] {
  const match = /\b(references|bibliography)\b/i.exec(text);
  if (!match || match.index === undefined) return [];
  const blob = text.slice(match.index + match[0].length);
  return splitReferenceEntries(blob)
    .slice(0, maxItems)
    .map((entry, i) => {
      const markerMatch = /^\s*[[(]?(\d{1,3})[\]).]/.exec(entry);
      return {
        id: `cit-${i}`,
        marker: markerMatch ? `[${markerMatch[1]}]` : "",
        text: entry.replace(/\s+/g, " ").trim().slice(0, 600),
      };
    });
}

/** 引用进会话的草稿块（与 spec §5 格式一致）。 */
export function formatPdfQuoteDraft(params: {
  fileName: string;
  page: number;
  text: string;
  instruction?: string;
}): string {
  const instruction = params.instruction?.trim()
    ? `\n${params.instruction.trim()}\n`
    : "\n请结合以上原文作答。\n";
  return `[PDF 引用] ${params.fileName} page=${params.page}\n---\n${params.text.trim()}\n---${instruction}`;
}

/**
 * 把引用块送进 v4 composer 草稿。
 * - 有活跃会话（`sessionId`）：走既有的「实时插入当前输入框」通道
 *   `requestComposerTextInsert`，请求带目标会话标识 + `append` 模式，
 *   文本追加到该会话已有草稿之后，不覆盖用户已输入内容。
 * - 无会话（新建任务态）：保持原行为，追加进根草稿槽 `scopeId`（通常 `__draft__`）。
 *
 * 修复依据：此前不分会话一律写 `__draft__`，已有会话里点「引用进会话」时文本进了
 * 新建任务草稿槽，当前会话输入框看不到任何东西（docs/未完成-PDF阅读器-论文模式
 * -spec-v1.md §6.4 要求的是「会话草稿」）。
 */
export function appendPdfQuoteToComposerDraft(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
  sessionId?: string | null;
  draft: string;
}): void {
  const targetSessionId = normalizeComposerTextInsertSessionId(params.sessionId);
  if (targetSessionId) {
    // 延迟 import 保持 pdf-reader 纯函数可测；同时避免测试拉起整个 composer/store 依赖。
    void import("@/store/zcodeSessionStore.js").then(({ useZCodeSessionStore }) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          params.workspacePath,
          params.draft,
          params.workspaceIdentity,
          undefined,
          "append",
          targetSessionId,
        );
    });
    return;
  }
  void import("@/v4/composer/composerDraftStore.js").then((mod) => {
    const existing = mod.readV4ComposerDraft(
      params.workspacePath,
      params.workspaceIdentity,
      params.scopeId,
    );
    const text = appendBlockToComposerDraftText(existing?.text, params.draft);
    mod.persistV4ComposerDraft(params.workspacePath, params.workspaceIdentity, params.scopeId, {
      ...existing,
      text,
    });
  });
}
