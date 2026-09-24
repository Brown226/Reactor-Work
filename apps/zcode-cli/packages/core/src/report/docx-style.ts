/**
 * 报告 `.docx` 的样式表 —— `@zcode/shared` 的令牌 → `docx` 样式定义的唯一映射。
 *
 * 生成器（`report-docx.ts`）只准在这里挑样式名，**不写内联字体字号**：
 * 只要 `word/document.xml` 里出现 `w:rFonts` / `w:sz` / `w:b`，就说明有人绕过了样式表，
 * 排版会退回「由读者本机 Word 默认值决定」——`test/document-style.test.ts` 里有这条断言。
 *
 * 为什么样式定义不能直接放进 `@zcode/shared`：那一层必须保持零依赖（UI 也要用），
 * 而这里要 import `docx`。所以共享的是**值**，映射各写一份。
 */
import {
  AlignmentType,
  BorderStyle,
  LineRuleType,
  PageOrientation,
  ShadingType,
  TableLayoutType,
  VerticalAlignTable,
  WidthType,
  type IBaseParagraphStyleOptions,
  type ISectionPropertiesOptions,
  type ITableBordersOptions,
  type IStylesOptions,
} from "docx";
import {
  DOCUMENT_STYLE_TOKENS as T,
  columnWidthsFromPercents,
  contentWidthTwips,
  halfPointsFromPt,
  lineUnitsFromMultiple,
  lineWidthFromPt,
  twipsFromMm,
  twipsFromPt,
  type DocumentFontStack,
} from "@zcode/shared";

/** 文档里只准出现这些样式名。字符样式用于给单元格内的局部文字上色。 */
export const REPORT_STYLE_IDS = {
  metaLabel: "ReactorMetaLabel",
  metaValue: "ReactorMetaValue",
  tableHeader: "ReactorTableHeader",
  tableBody: "ReactorTableBody",
  tableMeta: "ReactorTableMeta",
  note: "ReactorNote",
  footer: "ReactorFooter",
  code: "ReactorCode",
  suggest: "ReactorSuggest",
  severityError: "ReactorSeverityError",
  severityWarning: "ReactorSeverityWarning",
  severityInfo: "ReactorSeverityInfo",
} as const;

/** 报告表格的列宽配比（合计 100）。列少而挤的根因就是没有这一项 —— 交给 Word 自动分配，
 *  它会把「序号/严重度」这类窄内容列压到最小，出现「序号」竖排两行这种结果。 */
export const REPORT_TABLE_COLUMNS = [
  { key: "index", percent: 5 },
  { key: "severity", percent: 8 },
  { key: "code", percent: 12 },
  { key: "location", percent: 16 },
  { key: "quoted", percent: 18 },
  { key: "message", percent: 23 },
  { key: "suggestion", percent: 18 },
] as const;

/** 报告是七列长表：A4 纵向按这套列宽每列只剩 2cm 量级，必须横向。 */
export const REPORT_LANDSCAPE = true;

function fontOf(stack: DocumentFontStack) {
  // hint=eastAsia：中西文混排时让标点等歧义字符走中文字体，不然会出现「。”」用了西文字形。
  return { ascii: stack.ascii, hAnsi: stack.ascii, eastAsia: stack.eastAsia, cs: stack.ascii, hint: "eastAsia" };
}

/** 单元格段落：零段距单倍行距 —— 表格的呼吸感由单元格内边距给，不由段距给。 */
const CELL_PARAGRAPH = {
  spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
};

function headingStyle(sizePt: number, beforePt: number, afterPt: number): IBaseParagraphStyleOptions {
  // 注意：内置样式（Title/Heading1..）由库自己带 id 与 name，且 `{ id, name }` 是**先**展开、
  // options 是**后**展开 —— 这里多传一个 id 会把 styleId 覆盖成空，样式就废了。
  return {
    run: { font: fontOf(T.font.heading), size: halfPointsFromPt(sizePt), bold: true, color: T.color.text },
    paragraph: {
      spacing: {
        before: twipsFromPt(beforePt),
        after: twipsFromPt(afterPt),
        line: lineUnitsFromMultiple(T.spacing.bodyLineMultiple),
        lineRule: LineRuleType.AUTO,
      },
      keepNext: true,
    },
  };
}

/** 报告正文与业务样式：标题层级 + 元信息 + 表格 + 注释 + 页脚。 */
export function reportDocumentStyles(): IStylesOptions {
  return {
    default: {
      // docDefaults 是这一层的地基：不写它，字体字号就由读者本机 Word 决定。
      document: {
        run: { font: fontOf(T.font.body), size: halfPointsFromPt(T.sizePt.body), color: T.color.text },
        paragraph: {
          spacing: {
            after: twipsFromPt(T.spacing.bodyAfterPt),
            line: lineUnitsFromMultiple(T.spacing.bodyLineMultiple),
            lineRule: LineRuleType.AUTO,
          },
        },
      },
      title: {
        run: { font: fontOf(T.font.heading), size: halfPointsFromPt(T.sizePt.reportTitle), bold: true, color: T.color.text },
        paragraph: {
          alignment: AlignmentType.CENTER,
          spacing: {
            before: 0,
            after: twipsFromPt(T.spacing.titleAfterPt),
            line: lineUnitsFromMultiple(T.spacing.bodyLineMultiple),
            lineRule: LineRuleType.AUTO,
          },
        },
      },
      heading1: headingStyle(T.sizePt.heading1, T.spacing.heading1BeforePt, T.spacing.heading1AfterPt),
      heading2: headingStyle(T.sizePt.heading2, T.spacing.heading2BeforePt, T.spacing.heading2AfterPt),
      heading3: headingStyle(T.sizePt.heading3, T.spacing.heading3BeforePt, T.spacing.heading3AfterPt),
    },
    paragraphStyles: [
      {
        id: REPORT_STYLE_IDS.metaLabel,
        name: "Reactor Meta Label",
        basedOn: "Normal",
        next: REPORT_STYLE_IDS.metaValue,
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.body), color: T.color.subtle },
        paragraph: { ...CELL_PARAGRAPH },
      },
      {
        id: REPORT_STYLE_IDS.metaValue,
        name: "Reactor Meta Value",
        basedOn: "Normal",
        next: REPORT_STYLE_IDS.metaLabel,
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.body), color: T.color.text },
        paragraph: { ...CELL_PARAGRAPH },
      },
      {
        id: REPORT_STYLE_IDS.tableHeader,
        name: "Reactor Table Header",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: fontOf(T.font.heading), size: halfPointsFromPt(T.sizePt.tableHeader), bold: true, color: T.color.text },
        paragraph: { ...CELL_PARAGRAPH, alignment: AlignmentType.CENTER },
      },
      {
        id: REPORT_STYLE_IDS.tableBody,
        name: "Reactor Table Body",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.tableBody), color: T.color.text },
        paragraph: { ...CELL_PARAGRAPH },
      },
      {
        id: REPORT_STYLE_IDS.tableMeta,
        name: "Reactor Table Meta",
        basedOn: REPORT_STYLE_IDS.tableBody,
        next: "Normal",
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.tableBody), color: T.color.subtle },
        paragraph: { ...CELL_PARAGRAPH },
      },
      {
        // 注释块：数据边界这类「不读会误判结论」的说明，不提升成标题（否则像章节），
        // 用浅底 + 左侧竖线做视觉隔离。
        id: REPORT_STYLE_IDS.note,
        name: "Reactor Note",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.note), color: T.color.subtle },
        paragraph: {
          spacing: { before: twipsFromPt(4), after: twipsFromPt(T.spacing.bodyAfterPt), line: 240, lineRule: LineRuleType.AUTO },
          shading: { type: ShadingType.CLEAR, color: "auto", fill: T.color.noteShade },
          border: { left: { style: BorderStyle.SINGLE, size: lineWidthFromPt(2), color: T.color.ruleStrong, space: 6 } },
          indent: { left: twipsFromPt(6) },
        },
      },
      {
        id: REPORT_STYLE_IDS.footer,
        name: "Reactor Footer",
        basedOn: "Normal",
        next: "Normal",
        run: { size: halfPointsFromPt(T.sizePt.footer), color: T.color.subtle },
        paragraph: { alignment: AlignmentType.CENTER, ...CELL_PARAGRAPH },
      },
    ],
    characterStyles: [
      {
        id: REPORT_STYLE_IDS.severityError,
        name: "Reactor Severity Error",
        basedOn: "DefaultParagraphFont",
        run: { bold: true, color: T.color.error },
      },
      {
        id: REPORT_STYLE_IDS.severityWarning,
        name: "Reactor Severity Warning",
        basedOn: "DefaultParagraphFont",
        run: { bold: true, color: T.color.warning },
      },
      {
        id: REPORT_STYLE_IDS.severityInfo,
        name: "Reactor Severity Info",
        basedOn: "DefaultParagraphFont",
        run: { color: T.color.info },
      },
      {
        id: REPORT_STYLE_IDS.suggest,
        name: "Reactor Suggest",
        basedOn: "DefaultParagraphFont",
        run: { color: T.color.success },
      },
      {
        id: REPORT_STYLE_IDS.code,
        name: "Reactor Code",
        basedOn: "DefaultParagraphFont",
        run: { font: fontOf(T.font.mono), color: T.color.subtle },
      },
    ],
  };
}

/** 页面：A4，横向（报告是七列长表），上下 20mm、左右 18mm 版心。 */
export function reportSectionProperties(): ISectionPropertiesOptions {
  // `docx` 的 width/height 要传**纵向**尺寸，横向由 orientation 让它自己换（换两次会换回纵向：
  // 库写出的 w:h 是「我传的 width」，所以这里传 210×297，别传 297×210）。
  return {
    page: {
      size: {
        width: twipsFromMm(T.page.widthMm),
        height: twipsFromMm(T.page.heightMm),
        orientation: REPORT_LANDSCAPE ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
      },
      margin: {
        top: twipsFromMm(T.page.marginTopMm),
        right: twipsFromMm(T.page.marginRightMm),
        bottom: twipsFromMm(T.page.marginBottomMm),
        left: twipsFromMm(T.page.marginLeftMm),
        header: twipsFromMm(10),
        footer: twipsFromMm(10),
      },
    },
  };
}

/**
 * 问题表的列宽（twip）。
 *
 * 必须同时给 `tblGrid`（`columnWidths`）与每个单元格的 `tcW`，并显式
 * `tblLayout=fixed`：三者缺一，Word 都会回到自动分配。
 */
export function reportTableColumnWidths(): number[] {
  return columnWidthsFromPercents(
    contentWidthTwips(T.page, REPORT_LANDSCAPE),
    REPORT_TABLE_COLUMNS.map((column) => column.percent),
  );
}

/** 外框实一些、内线虚一些：表格的骨架靠外框，内线只需要让人不串行。 */
export function reportTableBorders(): ITableBordersOptions {
  const strong = { style: BorderStyle.SINGLE, size: lineWidthFromPt(T.table.ruleStrongPt), color: T.color.ruleStrong };
  const light = { style: BorderStyle.SINGLE, size: lineWidthFromPt(T.table.ruleLightPt), color: T.color.ruleLight };
  return {
    top: strong,
    bottom: strong,
    left: strong,
    right: strong,
    insideHorizontal: light,
    insideVertical: light,
  };
}

/** 单元格内边距：上下各 3pt，左右各 5.4pt（Word 默认上下为 0，内容会贴着线）。 */
export function reportTableCellMargins() {
  return {
    top: twipsFromPt(T.spacing.tableCellVerticalPt),
    bottom: twipsFromPt(T.spacing.tableCellVerticalPt),
    left: twipsFromPt(T.spacing.tableCellHorizontalPt),
    right: twipsFromPt(T.spacing.tableCellHorizontalPt),
  };
}

/** 表格骨架本身（不含行）：固定布局 + 列宽 + 线 + 内边距。 */
export const REPORT_TABLE_PROPERTIES = {
  layout: TableLayoutType.FIXED,
  borders: reportTableBorders(),
  margins: reportTableCellMargins(),
  columnWidths: reportTableColumnWidths(),
  width: { size: 100, type: WidthType.PERCENTAGE },
} as const;

/** 单元格垂直居中（顶对齐在多行中文里会让短单元格显得漂浮）。 */
export const REPORT_CELL_VERTICAL_ALIGN = VerticalAlignTable.CENTER;

/** 元信息表（项 / 值）两列宽度：标签列窄、值列宽，且不画线 —— 它只是排版，不是表格。 */
export const REPORT_META_TABLE_WIDTHS = columnWidthsFromPercents(
  contentWidthTwips(T.page, REPORT_LANDSCAPE),
  [14, 86],
);

export const REPORT_META_BORDERS: ITableBordersOptions = {
  top: { style: BorderStyle.NIL, size: 0 },
  bottom: { style: BorderStyle.NIL, size: 0 },
  left: { style: BorderStyle.NIL, size: 0 },
  right: { style: BorderStyle.NIL, size: 0 },
  insideHorizontal: { style: BorderStyle.NIL, size: 0 },
  insideVertical: { style: BorderStyle.NIL, size: 0 },
};

/** 表头行底纹：只在表头行用，正文行不铺底（否则整表像被涂过）。 */
export const REPORT_HEADER_SHADE = {
  shading: { type: ShadingType.CLEAR, color: "auto", fill: T.color.tableHeaderShade },
} as const;
