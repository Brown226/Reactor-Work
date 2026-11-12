/**
 * 共享表格引擎（W3-①）—— 设计照搬 LeAgent `docgen/tables.py`（Apache-2.0）。
 *
 * ## 为什么要有它
 *
 * 「列对齐、千分位、合计行加粗、涨跌红绿、CJK 列宽」这些是**业务语义**，不是绘制细节。
 * 若在 docx / xlsx / 未来的 pdf 渲染器里各写一遍，行为必然发散（同一张表在三种导出里
 * 长得不一样）。LeAgent 的做法是把它们**下沉到一个共享引擎**，各渲染器只做绘制。
 *
 * ## 口径（与 LeAgent `resolve_table_style` / `process_table` 对齐）
 *
 * - **列类型推断**：`text | number | percent | currency | delta | date`（按整列取值投票）
 * - **数字润色**：千分位、保留原小数位
 * - **涨跌极性**：`+12%` / `-3.5%` / `(1,234)`（会计负数）→ `positive` / `negative`
 * - **合计行识别**：首列文本含「合计/总计/小计/total/sum」→ 该行按合计样式
 * - **CJK 列宽**：中文按 **2 个显示宽度** 计（`_display_width`），据此分配列宽分数
 * - **样式契约**：输出**具体取值**（对齐/粗体/极性），渲染器不再自行判断
 *
 * 纯函数、零依赖、可单测。
 */

import type { Alignment } from "./ir.js";

// ---------------------------------------------------------------------------
// 列类型与极性
// ---------------------------------------------------------------------------

export type ColumnKind = "text" | "number" | "percent" | "currency" | "delta" | "date";
export type CellPolarity = "positive" | "negative";

/** 合计行关键字（照 LeAgent `_detect_total_row`） */
const TOTAL_ROW_HINTS = ["合计", "总计", "小计", "总合", "total", "subtotal", "sum"];

const NUMBER_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;
const PERCENT_RE = /^-?\d+(\.\d+)?\s*%$/;
const CURRENCY_RE = /^[$¥€£]\s*-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d{1,3}(,\d{3})*(\.\d+)?\s*(元|万|亿)$/;
/**
 * 涨跌标记（**显式 + 号**或**会计括号**）。
 *
 * ⚠️ 与 `number` 的边界：`-42` 是**负数**（number），不是 delta。
 * 只有显式 `+` 或会计括号才算 delta —— 否则整列负值会被误判成涨跌列。
 * 在 NUMBER_RE 之后判定，故这里是「数字里更特殊的一类」。
 */
const DELTA_RE = /^\+\s*\d+(\.\d+)?\s*%?$|^\(\s*[\d,]+(\.\d+)?\s*\)$/; // +12% / (1,234)
const DATE_RE = /^\d{4}[-/年]\d{1,2}([-/月]\d{1,2}日?)?$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;

/** 单元格文本 → 列类型（单格判定，空串 → null 表示「无意见」） */
export function classifyCell(text: string): ColumnKind | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  if (PERCENT_RE.test(t)) return "percent";
  if (CURRENCY_RE.test(t)) return "currency";
  if (DATE_RE.test(t)) return "date";
  if (DELTA_RE.test(t)) return "delta";
  if (NUMBER_RE.test(t)) return "number";
  return "text";
}

/**
 * 单元格涨跌极性（照 LeAgent `_cell_polarity`）。
 *
 * `+12%` → positive；`-3.5%` → negative；会计负数 `(1,234)` → negative。
 * 无符号且非括号 → null（不臆造涨跌）。
 */
export function cellPolarity(text: string): CellPolarity | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  if (/^\(.*\)$/.test(t) && /\d/.test(t)) return "negative"; // 会计负数
  if (/^\+/.test(t) && /\d/.test(t)) return "positive";
  if (/^-/.test(t) && /\d/.test(t)) return "negative";
  return null;
}

/** 千分位润色（保留原小数位；非数字原样返回） */
export function formatNumber(text: string): string {
  const t = (text ?? "").trim();
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(t.replace(/,/g, ""));
  if (!m) return text;
  const [, sign = "", intPart = "", decPart = ""] = m;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${decPart}`;
}

/**
 * 显示宽度（照 LeAgent `_display_width`）—— CJK 按 2 计。
 *
 * 用途：列宽分配。纯按字符数分会让中文列过窄（中文字形宽度约为西文的两倍）。
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text ?? "") {
    const cp = ch.codePointAt(0) ?? 0;
    // 常见 CJK/全角区间按 2 计（够用即可，不做完整 Unicode EastAsianWidth 表）
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首/汉字/日文假名
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul 音节
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
      (cp >= 0xff00 && cp <= 0xff60) || // 全角
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

// ---------------------------------------------------------------------------
// 列 / 表处理
// ---------------------------------------------------------------------------

export interface ProcessedCell {
  /** 原始文本 */
  raw: string;
  /** 展示文本（数字已千分位） */
  text: string;
  /** 列类型（决定对齐） */
  kind: ColumnKind;
  /** 该单元格的对齐（由列类型推导；渲染器直接用，不自行判断） */
  align: Alignment;
  /** 涨跌极性（仅 delta/percent 类可能有） */
  polarity: CellPolarity | null;
  /** 是否合计单元格 */
  isTotal: boolean;
}

export interface ProcessedColumn {
  index: number;
  kind: ColumnKind;
  /** 该列对齐方式（由类型推导：数字/百分比/货币右对齐，其余左对齐） */
  align: Alignment;
  /** 列宽分数（0..1，按 displayWidth 加权，含 CJK 双宽） */
  widthFraction: number;
}

export interface ProcessedTable {
  columns: ProcessedColumn[];
  /** 表头（可能为空数组 = 无表头） */
  header: ProcessedCell[];
  body: ProcessedCell[][];
  /** 合计行在 body 里的下标（无则 -1） */
  totalRowIndex: number;
  /** 是否含表头 */
  hasHeader: boolean;
  /** 表格样式（由调用方按主题传入；本引擎只原样带回） */
  style: TableStyleSpec;
}

export interface TableStyleSpec {
  /** 表头单元格加粗 */
  headerBold: boolean;
  /** 合计行加粗 */
  totalBold: boolean;
  /** 表头底色（hex，无 # ；undefined = 无底色） */
  headerFill?: string;
  /** 斑马纹底色 */
  zebraFill?: string;
  /** 合计行底色 */
  totalFill?: string;
  /** 正/负极性的文字色 */
  positiveColor: string;
  negativeColor: string;
}

/** 默认样式（与 md-docx 既有的浅灰底一致；主题化时由调用方覆盖） */
export const DEFAULT_TABLE_STYLE: TableStyleSpec = {
  headerBold: true,
  totalBold: true,
  headerFill: "f5f6f7",
  zebraFill: undefined,
  totalFill: "fafafa",
  positiveColor: "1E8449",
  negativeColor: "C0392B",
};

/** 该列类型是否右对齐（数字类右对齐是排版惯例） */
function alignForKind(kind: ColumnKind): Alignment {
  return kind === "number" || kind === "percent" || kind === "currency" || kind === "delta" ? "right" : "left";
}

/**
 * 整列类型推断：按非空格**投票**，并以**保守取向**定结果。
 *
 * 两条规则（都是被真实数据逼出来的）：
 * ① **出现纯文本即判 text** —— 「1 个数字 + 一句说明」的列若判数字，渲染时会右对齐，
 *    还会把说明文字当数字润色。宁可判 text（少做样式），不要错做。
 * ② 全部数字类时取**票数最多**者；平票按固定优先级（越具体越优先）。
 */
export function inferColumnKind(cells: readonly string[]): ColumnKind {
  const votes = new Map<ColumnKind, number>();
  for (const c of cells) {
    const k = classifyCell(c);
    if (k === null) continue;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  // ① 出现纯文本 → 整列按文本处理
  if ((votes.get("text") ?? 0) > 0) return "text";
  if (votes.size === 0) return "text";
  // ② 取票数最多；平票时按「越具体越优先」的固定顺序
  const priority: ColumnKind[] = ["percent", "currency", "delta", "date", "number"];
  let best: ColumnKind = "text";
  let bestCount = -1;
  for (const k of priority) {
    const n = votes.get(k) ?? 0;
    if (n > bestCount) {
      best = k;
      bestCount = n;
    }
  }
  return best;
}

/**
 * 合计行识别：首列文本命中关键字（照 LeAgent `_detect_total_row`）。
 * 返回 body 内下标；无则 -1。只找**最后 3 行**（合计总在尾部）。
 */
export function detectTotalRow(body: readonly (readonly string[])[]): number {
  for (let i = body.length - 1; i >= Math.max(0, body.length - 3); i--) {
    const first = (body[i]?.[0] ?? "").trim().toLowerCase();
    if (TOTAL_ROW_HINTS.some((h) => first.includes(h.toLowerCase()))) return i;
  }
  return -1;
}

/**
 * 处理一张表：类型推断 → 数字润色 → 极性 → 合计行 → CJK 列宽。
 *
 * `header` 为空数组表示无表头（此时第一行是数据）。渲染器拿到本结果后**只做绘制**，
 * 不再自行判断对齐/加粗/颜色。
 */
export function processTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: { style?: Partial<TableStyleSpec>; hasHeader?: boolean } = {},
): ProcessedTable {
  const style: TableStyleSpec = { ...DEFAULT_TABLE_STYLE, ...options.style };
  const hasHeader = options.hasHeader ?? header.length > 0;
  const colCount = Math.max(header.length, ...rows.map((r) => r.length), 0);

  // 列类型：优先用数据行投票（表头文本会污染类型）
  const kinds: ColumnKind[] = [];
  for (let c = 0; c < colCount; c++) {
    const columnValues = rows.map((r) => r[c] ?? "").filter((v) => v.trim() !== "");
    kinds.push(columnValues.length > 0 ? inferColumnKind(columnValues) : inferColumnKind([header[c] ?? ""]));
  }

  const totalRowIndex = hasHeader ? detectTotalRow(rows) : -1;

  const toCell = (raw: string, c: number, isTotal: boolean): ProcessedCell => {
    const kind = kinds[c] ?? "text";
    const numericish = kind === "number" || kind === "currency" || kind === "delta" || kind === "percent";
    return {
      raw,
      text: numericish ? formatNumber(raw) : raw,
      kind,
      align: alignForKind(kind),
      polarity: kind === "delta" || kind === "percent" ? cellPolarity(raw) : null,
      isTotal,
    };
  };

  const headerCells = header.map((h, c) => toCell(h, c, false));
  const bodyCells = rows.map((r, ri) => {
    const isTotal = ri === totalRowIndex;
    const out: ProcessedCell[] = [];
    for (let c = 0; c < colCount; c++) out.push(toCell(r[c] ?? "", c, isTotal));
    return out;
  });

  // 列宽：按最大 displayWidth 加权（含 CJK 双宽），归一成 0..1
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const values = [header[c] ?? "", ...rows.map((r) => r[c] ?? "")];
    widths.push(Math.max(...values.map((v) => displayWidth(v)), 1));
  }
  const totalWidth = widths.reduce((a, b) => a + b, 0) || 1;
  const columns: ProcessedColumn[] = widths.map((w, i) => ({
    index: i,
    kind: kinds[i] ?? "text",
    align: alignForKind(kinds[i] ?? "text"),
    widthFraction: w / totalWidth,
  }));

  return { columns, header: headerCells, body: bodyCells, totalRowIndex, hasHeader, style };
}
