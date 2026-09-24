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
/** 闪过的那一下用单独的名字：注册表按名字换，不用重算 Range */
const REVIEW_QUOTE_FLASH_NAME = "zcode-review-quote-flash";
/** 命中所在**整段**的淡色底：只标几个字时，光看那几个字很难在整页里找到它 */
const REVIEW_QUOTE_BLOCK_NAME = "zcode-review-quote-block";
const REVIEW_QUOTE_STYLE_ID = "zcode-review-quote-highlight-style";

// 配色刻意比「对话内查找」的浅黄更重：查找是扫一眼，审查定位是「请核对这一句」，
// 浅色底 + 白纸（docx/pdf 纸张永远是白的）在屏幕上几乎看不出来。
const REVIEW_QUOTE_STYLE = `
::highlight(${REVIEW_QUOTE_HIGHLIGHT_NAME}) {
  background-color: #fbbf24;
  color: #1f2937;
  text-decoration: underline 2px #b45309;
}
::highlight(${REVIEW_QUOTE_FLASH_NAME}) {
  background-color: #fb7185;
  color: #1f2937;
  text-decoration: underline 2px #9f1239;
}
::highlight(${REVIEW_QUOTE_BLOCK_NAME}) {
  background-color: rgba(251, 191, 36, 0.28);
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
  const support = getCssHighlightSupport();
  support?.highlights.delete(REVIEW_QUOTE_HIGHLIGHT_NAME);
  support?.highlights.delete(REVIEW_QUOTE_FLASH_NAME);
  support?.highlights.delete(REVIEW_QUOTE_BLOCK_NAME);
  stopReviewQuoteScrollSettle();
}

/** 命中所在整段的范围（只标几个字时，用户在一个页面里仍然很难找到那几个字）。 */
const BLOCK_SELECTOR = "p,li,blockquote,dd,dt,td,th,h1,h2,h3,h4,h5,h6";
/** 整段超过这个字符数就不给淡色底：一整页表格铺满颜色反而看不见重点。 */
const BLOCK_HIGHLIGHT_MAX_CHARS = 400;

function findBlockRange(root: HTMLElement, range: Range): Range | null {
  const start = range.startContainer;
  const element = start instanceof Element ? start : start.parentElement;
  // 表格里的段落优先按段落标 ：整格铺色会盖住相邻内容，看不清命中在哪个单元格的哪一句。
  const block = element?.closest<HTMLElement>("p") ?? element?.closest<HTMLElement>(BLOCK_SELECTOR);
  if (!block || !root.contains(block)) return null;
  if ((block.textContent ?? "").length > BLOCK_HIGHLIGHT_MAX_CHARS) return null;
  const blockRange = document.createRange();
  try {
    blockRange.selectNodeContents(block);
  } catch {
    return null;
  }
  return blockRange;
}

/** 命中所在元素最近的纵向滚动容器（预览区的滚动发生在它身上，不是窗口）。 */
function findScrollHost(element: Element | null): HTMLElement | null {
  let current: Element | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll)/u.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
      return current as HTMLElement;
    }
    current = current.parentElement;
  }
  return null;
}

function isRangeVisible(range: Range, host: HTMLElement | null): boolean {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  // 上下各留一点余量：贴边就算「看不到」，免得高亮正好压在工具栏/窗口边缘上。
  const margin = 48;
  if (!host) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > margin && rect.top < viewportHeight - margin;
  }
  const hostRect = host.getBoundingClientRect();
  return rect.top >= hostRect.top + margin && rect.bottom <= hostRect.bottom - margin;
}

/** 定位相关定时器的统一取消入口（补滚 + 闪烁），切换文件/卸载时必须调用 */
let cancelScrollSettle: (() => void) | null = null;

function stopReviewQuoteScrollSettle(): void {
  cancelScrollSettle?.();
  cancelScrollSettle = null;
}

/**
 * 滚动到位，并在布局稳定前补几次。
 *
 * 为什么不能只滚一次：docx 预览是「先渲染原尺寸、再按可用宽度 scale」，PDF 的文本层也是在页面
 * 渲染完成后才定位 —— 在缩放/重排之前滚，量到的是**旧高度**，滚完内容一收缩，命中就跑到视口上方
 * 之外，用户得自己往上翻。这里在几个时间点复查：**只在命中不在视口内时**才补滚，
 * 用户已经自己滚走的情况下不抢滚动位置。
 */
function scrollRangeIntoViewSettled(range: Range): void {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const host = findScrollHost(element);
  const scrollNow = () => {
    if (isRangeVisible(range, host)) return;
    const rect = range.getBoundingClientRect();
    if (host) {
      // 直接算目标偏移而不是 scrollIntoView：后者会连带滚动外层容器（对话流也跟着跳），
      // 而且这里的滚动只能发生在预览区自己身上。
      host.scrollTop += rect.top - host.getBoundingClientRect().top - host.clientHeight / 2 + rect.height / 2;
      return;
    }
    element?.scrollIntoView({ block: "center", behavior: "auto" });
  };
  stopReviewQuoteScrollSettle();
  scrollNow();
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const delay of [120, 320, 700, 1200]) {
    timers.push(setTimeout(scrollNow, delay));
  }
  cancelScrollSettle = () => {
    for (const timer of timers) clearTimeout(timer);
  };
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
  const blockRange = range ? findBlockRange(root, range) : null;
  const highlight = new support.Highlight(...(range ? [range] : [])) as CssHighlightLike;
  highlight.priority = 3;
  support.highlights.set(REVIEW_QUOTE_HIGHLIGHT_NAME, highlight);
  support.highlights.set(
    REVIEW_QUOTE_BLOCK_NAME,
    new support.Highlight(...(blockRange ? [blockRange] : [])) as CssHighlightLike,
  );
  if (range) {
    scrollRangeIntoViewSettled(range);
    flashReviewQuoteHighlight(range, support);
  }
  return range !== null;
}

/**
 * 闪三下：审查定位是「请核对这一句」，一瞬间的颜色变化能把眼睛带过去；闪完停在稳定配色上。
 * 换的是注册表里的名字，Range 不重算。
 */
function flashReviewQuoteHighlight(
  range: Range,
  support: { highlights: CssHighlightRegistryLike; Highlight: HighlightConstructor },
): void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const show = (name: string) => {
    support.highlights.delete(REVIEW_QUOTE_HIGHLIGHT_NAME);
    support.highlights.delete(REVIEW_QUOTE_FLASH_NAME);
    const highlight = new support.Highlight(range) as CssHighlightLike;
    highlight.priority = 3;
    support.highlights.set(name, highlight);
  };
  [120, 360, 600].forEach((delay, index) => {
    timers.push(setTimeout(() => show(index % 2 === 0 ? REVIEW_QUOTE_FLASH_NAME : REVIEW_QUOTE_HIGHLIGHT_NAME), delay));
  });
  timers.push(setTimeout(() => show(REVIEW_QUOTE_HIGHLIGHT_NAME), 860));
  const cancel = () => {
    for (const timer of timers) clearTimeout(timer);
  };
  const previousCancel = cancelScrollSettle;
  cancelScrollSettle = () => {
    previousCancel?.();
    cancel();
  };
}

/** 渲染是异步的（markdown 子树、docx 分页），一次找不到就在这几个时间点重试。 */
const QUOTE_RETRY_DELAYS_MS = [0, 120, 320, 700];

/**
 * 带重试的定位：两个渲染面（提取正文的 markdown、原件的 docx）都用它，免得各写一套重试节奏。
 *
 * 返回一个取消句柄：调用方在卸载/切换文件时必须调它 —— 高亮是文档级注册表，
 * 不清理会让已经关掉的标签页继续占着 `CSS.highlights`。
 */
export function scheduleReviewQuoteHighlight(options: {
  /** 每次重试时现取根节点：渲染容器可能在这期间才挂上 */
  getRoot: () => HTMLElement | null;
  quote: string;
  occurrence?: number | null;
  /** 定位结束（命中或彻底没找到）时回调 */
  onSettled: (found: boolean) => void;
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const run = () => {
    if (cancelled) return;
    const root = options.getRoot();
    if (root && applyReviewQuoteHighlight(root, options.quote, options.occurrence ?? null)) {
      options.onSettled(true);
      return;
    }
    attempt += 1;
    const delay = QUOTE_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      options.onSettled(false);
      return;
    }
    timer = setTimeout(run, delay);
  };
  run();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    clearReviewQuoteHighlight();
  };
}
