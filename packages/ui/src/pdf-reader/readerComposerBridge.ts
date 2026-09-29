/**
 * 论文模式侧栏：大纲 / 引文（P0b，docs/未完成-PDF阅读器-论文模式-spec-v1.md）。
 * 大纲来自 pdf.js getOutline；引文用与 file-tools 同口径的 References 拆分启发式
 * （浏览器侧轻量版，完整 API 仍在 file-tools `pdf_*` 工具）。
 */

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
 * 把引用块追加进 v4 composer 草稿（事实源 composerDraftStore）。
 * 宿主可传 onQuoteIntoComposer 覆盖；不传时用本函数落到当前 scope。
 */
export function appendPdfQuoteToComposerDraft(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  scopeId: string;
  draft: string;
}): void {
  // 延迟 import 保持 pdf-reader 纯函数可测；同时避免测试拉起整个 composer 依赖。
  void import("@/v4/composer/composerDraftStore.js").then((mod) => {
    const existing = mod.readV4ComposerDraft(
      params.workspacePath,
      params.workspaceIdentity,
      params.scopeId,
    );
    const text = existing?.text?.trim()
      ? `${existing.text.trimEnd()}\n\n${params.draft.trim()}\n`
      : `${params.draft.trim()}\n`;
    mod.persistV4ComposerDraft(params.workspacePath, params.workspaceIdentity, params.scopeId, {
      ...existing,
      text,
    });
  });
}
