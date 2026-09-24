/**
 * 文档产出的排版令牌 —— Reactor 生成 `.docx` / `.xlsx` 时**唯一**的字体、字号、颜色、版心来源。
 *
 * 为什么要有这一层：OOXML 的字体字号如果不在 `styles.xml` 里显式声明，渲染结果就由
 * **读者本机 Word 的默认值**决定 —— 同一份报告在不同机器上排版不同，中西文混排也不统一。
 * 所以生成器只准挑样式名，值一律从这里取。
 *
 * 为什么放在 `@zcode/shared`：产出侧有两个互不相干的包（CLI 的报告生成、UI 的 Markdown 导出），
 * 而 UI 不能反向依赖 CLI。这里只放**纯数据与纯换算**，不依赖 `docx`，两边各自映射成自己的 API。
 *
 * 单位约定（这是最容易写错的地方，所以换算只准有一份实现）：
 * 令牌用人的单位 —— pt、mm、倍行距、十六进制色；OOXML 要的是 half-point（字号）、
 * twip（间距/宽度）、240 分之一行（行距）。换算函数在本文件末尾。
 */

/** 字体栈：`ascii` 管西文数字，`eastAsia` 管中日韩 —— 两个都写才不会出现中西文两套字体。 */
export interface DocumentFontStack {
  readonly ascii: string;
  readonly eastAsia: string;
}

export interface DocumentStyleTokens {
  readonly font: {
    readonly heading: DocumentFontStack;
    readonly body: DocumentFontStack;
    readonly mono: DocumentFontStack;
  };
  /** 字号，单位 pt（`w:sz` 里是它的两倍）。 */
  readonly sizePt: {
    readonly reportTitle: number;
    readonly heading1: number;
    readonly heading2: number;
    readonly heading3: number;
    readonly body: number;
    readonly tableHeader: number;
    readonly tableBody: number;
    readonly note: number;
    readonly footer: number;
  };
  /** 十六进制色，不带 `#`（OOXML 的写法）。 */
  readonly color: {
    readonly text: string;
    readonly subtle: string;
    readonly ruleStrong: string;
    readonly ruleLight: string;
    readonly tableHeaderShade: string;
    readonly noteShade: string;
    readonly error: string;
    readonly warning: string;
    readonly info: string;
    /** 建议用色：与客户端「建议修改」的绿是同一语义。 */
    readonly success: string;
  };
  readonly spacing: {
    /** 正文倍行距（1 就是单倍）。 */
    readonly bodyLineMultiple: number;
    readonly bodyAfterPt: number;
    readonly titleAfterPt: number;
    readonly heading1BeforePt: number;
    readonly heading1AfterPt: number;
    readonly heading2BeforePt: number;
    readonly heading2AfterPt: number;
    readonly heading3BeforePt: number;
    readonly heading3AfterPt: number;
    /** 表格单元格内边距：上下 / 左右，单位 pt。 */
    readonly tableCellVerticalPt: number;
    readonly tableCellHorizontalPt: number;
  };
  /** 纸张与版心，单位 mm（A4 = 210×297）。 */
  readonly page: {
    readonly widthMm: number;
    readonly heightMm: number;
    readonly marginTopMm: number;
    readonly marginBottomMm: number;
    readonly marginLeftMm: number;
    readonly marginRightMm: number;
  };
  /** 表格线宽，单位 pt（8 分之一磅的倍数，1pt = sz 8）。 */
  readonly table: {
    readonly ruleStrongPt: number;
    readonly ruleLightPt: number;
  };
}

export const DOCUMENT_STYLE_TOKENS: DocumentStyleTokens = {
  font: {
    // 中文工程文件的惯例：标题黑体系、正文宋体系、等宽留给编号与代码。
    heading: { ascii: "Arial", eastAsia: "微软雅黑" },
    body: { ascii: "Times New Roman", eastAsia: "宋体" },
    mono: { ascii: "Consolas", eastAsia: "宋体" },
  },
  sizePt: {
    reportTitle: 18,
    heading1: 14,
    heading2: 12,
    heading3: 10.5,
    body: 10.5,
    tableHeader: 9,
    tableBody: 9,
    note: 9,
    footer: 9,
  },
  color: {
    text: "000000",
    subtle: "595959",
    ruleStrong: "808080",
    ruleLight: "BFBFBF",
    tableHeaderShade: "E7E6E6",
    noteShade: "F2F2F2",
    // 严重度用 Word 系深色（打印后仍能区分）：红 / 深黄 / 灰。
    error: "C00000",
    warning: "BF8F00",
    info: "595959",
    success: "1F7A3D",
  },
  spacing: {
    bodyLineMultiple: 1.3,
    bodyAfterPt: 6,
    titleAfterPt: 14,
    heading1BeforePt: 12,
    heading1AfterPt: 8,
    heading2BeforePt: 10,
    heading2AfterPt: 6,
    heading3BeforePt: 8,
    heading3AfterPt: 4,
    tableCellVerticalPt: 3,
    tableCellHorizontalPt: 5.4,
  },
  page: {
    widthMm: 210,
    heightMm: 297,
    marginTopMm: 20,
    marginBottomMm: 20,
    marginLeftMm: 18,
    marginRightMm: 18,
  },
  table: {
    ruleStrongPt: 1,
    ruleLightPt: 0.5,
  },
};

/** 严重度 → 颜色令牌键：报告里「必须修改 / 建议修改 / 提示」的文字着色。 */
export const DOCUMENT_SEVERITY_COLOR_KEYS = {
  error: "error",
  warning: "warning",
  info: "info",
} as const;

/** pt → `w:sz`（half-point）。10.5pt(五号) → 21。 */
export function halfPointsFromPt(pt: number): number {
  return Math.round(pt * 2);
}

/** pt → twip（间距、线宽以外的宽度）。1pt = 20 twip。 */
export function twipsFromPt(pt: number): number {
  return Math.round(pt * 20);
}

/** mm → twip。1mm = 56.6929 twip。 */
export function twipsFromMm(mm: number): number {
  return Math.round(mm * 56.6929);
}

/** pt → OOXML 的线宽（8 分之一磅）。1pt → 8。 */
export function lineWidthFromPt(pt: number): number {
  return Math.max(2, Math.round(pt * 8));
}

/** 倍行距 → `w:line`（240 为单倍）。 */
export function lineUnitsFromMultiple(multiple: number): number {
  return Math.round(multiple * 240);
}

/**
 * 按百分比拆列宽（twip）。
 *
 * 关键在最后一步：**余数补给最后一列**。直接 `round` 每一列会让总和少几个 twip，
 * Word 见到 `tblGrid` 总宽与 `tblW` 对不上时会把表格拉出正文区（或在窄列上再挤一次）——
 * 这正是「序号」列被压成两行字的成因。
 */
export function columnWidthsFromPercents(
  totalTwips: number,
  percents: readonly number[],
): number[] {
  const widths: number[] = [];
  let assigned = 0;
  for (const [index, percent] of percents.entries()) {
    if (index === percents.length - 1) {
      widths.push(Math.max(1, totalTwips - assigned));
      break;
    }
    const width = Math.max(1, Math.round((totalTwips * percent) / 100));
    widths.push(width);
    assigned += width;
  }
  return widths;
}

/** 版心宽度（twip）：纸宽减左右页边距。列宽分配要用它，不能凭空猜。 */
export function contentWidthTwips(
  page: DocumentStyleTokens["page"],
  landscape = false,
): number {
  const widthMm = landscape ? page.heightMm : page.widthMm;
  return twipsFromMm(widthMm - page.marginLeftMm - page.marginRightMm);
}
