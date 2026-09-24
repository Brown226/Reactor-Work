/**
 * 在**渲染后的 DOM** 上按原文片段画高亮（markdown / Office 预览共用）。
 *
 * 为什么这么做，而不是往文本里插 `<mark>`：
 * - markdown 预览的 rehype 链带 sanitize，`mark` 不在白名单里，插进去会被 unwrap（文字留下、
 *   高亮消失），注入方案在真实渲染管线里无效；
 * - 直接改 React 渲染出来的文本节点（split + wrap）会和 React 的协调打架 —— 文本变化时它写回的
 *   是它自己记录的那个节点，被切开的节点会让正文出现重复文本。
 *
 * 所以用 CSS Custom Highlight API：只画在 `Range` 上，不碰 DOM 结构、不产生新节点，
 * 与对话内查找（`conversationFindHighlightDom.ts`）同一套做法。找不到就不画，
 * **绝不**退化成「大概是这里」。
 */
import { normalizeWithIndexMap } from "@/lib/quoteSearch.js";

const REVIEW_QUOTE_HIGHLIGHT_NAME = "zcode-review-quote";
const REVIEW_QUOTE_STYLE_ID = "zcode-review-quote-highlight-style";
const REVIEW_QUOTE_STYLE = `
::highlight(${REVIEW_QUOTE_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
`;

interface CssHighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type CssHighlightLike = { priority?: number };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

interface NodeEntry {
  node: Text;
  /** 该节点第一个字符在全局归一化串里的下标 */
  base: number;
  text: string;
  /** 归一化字符 → 节点内偏移 */
  indices: number[];
}

function getCssHighlightSupport(): {
  highlights: CssHighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }
  const highlights = (CSS as unknown as { highlights?: CssHighlightRegistryLike }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!highlights || !Highlight) return null;
  return { highlights, Highlight };
}

function ensureReviewQuoteStyle(): void {
  if (typeof document === "undefined") return;
  const style = document.getElementById(REVIEW_QUOTE_STYLE_ID) ?? document.createElement("style");
  style.id = REVIEW_QUOTE_STYLE_ID;
  if (style.textContent !== REVIEW_QUOTE_STYLE) {
    style.textContent = REVIEW_QUOTE_STYLE;
  }
  if (!style.isConnected) {
    document.head.append(style);
  }
}

function shouldSkipTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) return true;
  return Boolean(
    parent.closest(
      'button,input,textarea,select,[contenteditable="true"],[data-review-quote-ignore="true"]',
    ),
  );
}

function collectNodeEntries(root: HTMLElement): NodeEntry[] {
  const entries: NodeEntry[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let base = 0;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    if (!shouldSkipTextNode(node)) {
      const { text, indices } = normalizeWithIndexMap(node.data);
      if (text.length > 0) {
        entries.push({ node, base, text, indices });
        base += text.length;
      }
    }
    current = walker.nextNode();
  }
  return entries;
}

function resolvePosition(
  entries: readonly NodeEntry[],
  index: number,
): { node: Text; offset: number } | null {
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position]!;
    if (index >= entry.base) {
      const offset = entry.indices[index - entry.base];
      return offset === undefined ? null : { node: entry.node, offset };
    }
  }
  return null;
}

/**
 * 在 `root` 渲染出的文本里找 `quote` 的第 `occurrence` 处并返回一个 `Range`。
 *
 * 片段跨内联元素（`**粗体**`、`<code>`）时由「归一化文本流 + 回指映射」自然覆盖：
 * 归一化串把整棵子树的文字连成一条，Range 的两端各自落回自己的文本节点。
 */
export function findQuoteRangeInElement(
  root: HTMLElement,
  quote: string,
  occurrence?: number | null,
): Range | null {
  const needle = normalizeWithIndexMap(quote).text;
  if (needle.length === 0) return null;
  const entries = collectNodeEntries(root);
  if (entries.length === 0) return null;
  const haystack = entries.map((entry) => entry.text).join("");

  const starts: number[] = [];
  let from = 0;
  while (starts.length < 200) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    starts.push(found);
    from = found + 1;
  }
  if (starts.length === 0) return null;

  const wanted =
    occurrence && occurrence > 0 && occurrence <= starts.length ? occurrence - 1 : 0;
  const startIndex = starts[wanted]!;
  const start = resolvePosition(entries, startIndex);
  const end = resolvePosition(entries, startIndex + needle.length - 1);
  if (!start || !end) return null;

  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
  } catch {
    return null;
  }
  return range;
}

export function clearReviewQuoteHighlight(): void {
  getCssHighlightSupport()?.highlights.delete(REVIEW_QUOTE_HIGHLIGHT_NAME);
}

export function scrollRangeIntoView(range: Range): void {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "auto" });
}

/**
 * 找 + 画 + 滚。返回是否命中 —— 未命中时调用方要显式告知用户（而不是静默什么都不发生）。
 */
export function applyReviewQuoteHighlight(
  root: HTMLElement,
  quote: string,
  occurrence?: number | null,
): boolean {
  ensureReviewQuoteStyle();
  const support = getCssHighlightSupport();
  const range = findQuoteRangeInElement(root, quote, occurrence);
  if (!support) return false;
  const highlight = new support.Highlight(...(range ? [range] : [])) as CssHighlightLike;
  highlight.priority = 3;
  support.highlights.set(REVIEW_QUOTE_HIGHLIGHT_NAME, highlight);
  if (range) scrollRangeIntoView(range);
  return range !== null;
}
