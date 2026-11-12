/**
 * 办公文档 IR（W3-①）—— 设计照搬 LeAgent `docgen/model.py`（Apache-2.0）。
 *
 * ## 为什么要有统一 IR
 *
 * 「一个 IR + N 渲染器」是 LeAgent docgen 的核心主张（其 `__init__.py` 自述
 * "One document model, one font pipeline, one theme system, N renderers"）。
 * 好处是**内容语义一致**：同一份内容出 docx / xlsx /（未来）pdf 时，
 * 表格对齐、数字格式、涨跌色不会各长一样。
 *
 * 本仓现状：`md-docx.ts` 里已有一个**极简子集**（heading/para/list/table/code/quote/hr）。
 * 本模块把它抽到 shared 并**增量扩展**成可共享的契约，供未来的 xlsx/pdf 渲染器复用。
 *
 * ## 与 LeAgent 的取舍
 *
 * - **判别键用 `type`**（与 LeAgent 一致）：`Block` 是判别联合，JSON 里靠 `type` 区分。
 * - **容忍多余字段**（照 LeAgent `ConfigDict(extra="ignore")`）：模型产出的块常带多余键，
 *   不该因此整篇失败。渲染器只读认识的键。
 * - **不追全量**：只覆盖 Agent 产出文档的高频元素（结论见 master plan §2.2 的"不做射线"）。
 */

/** 段落/单元格对齐（照 LeAgent `Alignment`） */
export type Alignment = "left" | "center" | "right" | "justify";

/** 提示框变体（照 LeAgent `CalloutVariant`） */
export type CalloutVariant = "info" | "note" | "tip" | "success" | "warning" | "danger";

/** 列样式（照 LeAgent `TableBlock.style`） */
export type TableStyleName = "default" | "minimal" | "grid";

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
  align?: Alignment;
}

export interface ListItem {
  text: string;
  /** 任务列表勾选态（undefined = 普通项） */
  checked?: boolean;
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  /** 缩进层级（0 起） */
  level: number;
  items: ListItem[];
}

export interface TableBlock {
  type: "table";
  /** 表头（空数组 = 无表头） */
  header: string[];
  rows: string[][];
  /** 表注（渲染在表下方） */
  caption?: string;
  style?: TableStyleName;
  /** 是否对数字单元格做千分位润色（默认 true） */
  numberFormat?: boolean;
  /** 是否强制画合计行（undefined = 由引擎按首列关键字自动识别） */
  totalRow?: boolean;
  /** 列对齐覆盖（未给则由引擎按列类型推导） */
  align?: Alignment[];
}

export interface CodeBlock {
  type: "code";
  lang: string;
  lines: string[];
}

export interface QuoteBlock {
  type: "quote";
  lines: string[];
}

/** 提示框（LeAgent `::: warning` 容器；本仓 markdown 解析器 W3 后续补齐） */
export interface CalloutBlock {
  type: "callout";
  variant: CalloutVariant;
  /** 可选标题（`::: warning Optional Title`） */
  title?: string;
  lines: string[];
}

export interface DividerBlock {
  type: "divider";
}

export interface ImageBlock {
  type: "image";
  /** 图片源（路径或 data URL） */
  src: string;
  alt?: string;
  caption?: string;
}

/** 指标组（LeAgent `metrics` 围栏；KPI 场景常用） */
export interface MetricsBlock {
  type: "metrics";
  items: Array<{ label: string; value: string; delta?: string }>;
}

/** 图表占位（渲染器可降级为「图表说明」文本） */
export interface ChartBlock {
  type: "chart";
  chartType: "bar" | "line" | "pie" | "scatter" | "area" | "barh";
  title?: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}

/** 分页（`\newpage` / `<!-- pagebreak -->`） */
export interface PageBreakBlock {
  type: "pagebreak";
}

/** 目录占位（`[TOC]`） */
export interface TocBlock {
  type: "toc";
}

/**
 * 块判别联合。
 *
 * `type` 即判别键 —— 新增块类型只需在此加一支 + 各渲染器补一个 case。
 */
export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | CodeBlock
  | QuoteBlock
  | CalloutBlock
  | DividerBlock
  | ImageBlock
  | MetricsBlock
  | ChartBlock
  | PageBreakBlock
  | TocBlock;

/** 文档元数据（照 LeAgent `DocumentSpec` 的可移植子集） */
export interface DocumentMeta {
  title?: string;
  subtitle?: string;
  author?: string;
  /** ISO 日期串或人类可读串（渲染器原样使用） */
  date?: string;
  subject?: string;
  keywords?: string[];
  /** 命名字题（渲染器/主题子系统解析；未识别则用默认） */
  theme?: string;
}

/** 一份文档 = 元数据 + 块序列 */
export interface DocumentIR {
  meta: DocumentMeta;
  blocks: Block[];
}

/** 空文档 */
export function emptyDocumentIR(meta: DocumentMeta = {}): DocumentIR {
  return { meta, blocks: [] };
}

/**
 * 列的展示对齐：优先用块上显式声明的 `align`，否则由表格引擎按列类型推导。
 * （渲染器统一调这里，避免各自判断。）
 */
export function columnAlignment(block: TableBlock, columnIndex: number, fallback: Alignment): Alignment {
  return block.align?.[columnIndex] ?? fallback;
}
