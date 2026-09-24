/**
 * 「按原文片段找第几处」的纯函数（渲染后的 DOM 高亮用它定位）。
 *
 * 为什么前端还要再找一次：工具已经把偏移算好了，但**渲染后的 markdown/Office DOM 里没有
 * 偏移的概念** —— 源码的 `**粗体**`、表格 `|`、被折叠的换行在渲染结果里都变了形，源码偏移
 * 在那里没有对应位置。能跨过去的只有片段文字本身：拿片段在渲染文本里重新找一次，
 * 序号（第几处）沿用工具给的那个，重复句子才不会落到错的那一处。
 *
 * 归一化规则必须与 CLI 侧 `normalizeWithMap`（core/src/tool/handlers/report-review-issues.ts）
 * **逐条一致**，否则同一份文档两侧数出来的「第 N 处」会不同：
 * 全角转半角、全角空格/普通空白一律丢弃、各种连字符统一成 `-`、斜杠统一、大写归一。
 */
export interface QuoteOccurrence {
  /** 命中片段在原文里的起止（原文下标，`end` 不含） */
  start: number;
  end: number;
  /** 片段在整段文本里一共出现几次 */
  total: number;
}

const FULL_WIDTH_START = 0xff01;
const FULL_WIDTH_END = 0xff5e;
const FULL_WIDTH_OFFSET = 0xfee0;
/** 一次扫描最多数多少处：只用于「取第 N 处」与计数，不需要无限扫。 */
const MAX_MATCH_SCAN = 500;

/**
 * 归一化文本 + 逐字符回指原文下标。
 *
 * `map[i]` 是归一化串第 `i` 个字符在原文里的下标。转换可能一变多（全角大写等），所以按
 * 字符逐个 push，不做字符串替换 —— 替换表会让下标错位。
 */
export function normalizeWithIndexMap(raw: string): { text: string; indices: number[] } {
  let text = "";
  const indices: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const code = char.charCodeAt(0);
    let converted: string | null;
    if (code >= FULL_WIDTH_START && code <= FULL_WIDTH_END) {
      converted = String.fromCharCode(code - FULL_WIDTH_OFFSET);
    } else if (char === "\u3000" || char === "\u00a0") {
      converted = null;
    } else if (char === "\u2215" || char === "\uff0f") {
      converted = "/";
    } else if (/[\u2010-\u2015\u2212~〜～]/u.test(char)) {
      converted = "-";
    } else if (/\s/u.test(char)) {
      converted = null;
    } else {
      converted = char;
    }
    if (converted === null) continue;
    for (const piece of converted.toUpperCase()) {
      text += piece;
      indices.push(index);
    }
  }
  return { text, indices };
}

function countOccurrences(haystack: string, needle: string): number[] {
  const starts: number[] = [];
  let from = 0;
  while (starts.length < MAX_MATCH_SCAN) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    starts.push(found);
    from = found + 1;
  }
  return starts;
}

/**
 * 在 `raw` 里找 `quote` 的第 `occurrence` 处（1 起；越界或未给时取第一处）。
 * 找不到返回 null —— 调用方**不得**据此假装高亮。
 */
export function locateQuoteOccurrence(
  raw: string,
  quote: string,
  occurrence: number | null | undefined = 1,
): QuoteOccurrence | null {
  const haystack = normalizeWithIndexMap(raw);
  const needle = normalizeWithIndexMap(quote);
  if (needle.text.length === 0) return null;
  const starts = countOccurrences(haystack.text, needle.text);
  if (starts.length === 0) return null;
  const wanted = occurrence && occurrence > 0 && occurrence <= starts.length ? occurrence - 1 : 0;
  const startInNormalized = starts[wanted]!;
  const start = haystack.indices[startInNormalized]!;
  const endInNormalized = startInNormalized + needle.text.length - 1;
  const end = (haystack.indices[endInNormalized] ?? start) + 1;
  return { start, end, total: starts.length };
}
