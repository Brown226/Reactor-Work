/**
 * Markdown 导出的 `.docx` 样式表 —— 与 CLI 报告共用 `@zcode/shared` 的同一套排版令牌。
 *
 * 为什么不能直接复用 CLI 的 `docx-style.ts`：`ui` 与 `zcode-cli` 在架构策略里是两个独立模块，
 * UI 依赖 Agent-CLI 包会把运行时打进渲染进程。所以共享的是**令牌值**，映射各写一份 ——
 * 改字号字体只改 `@zcode/shared` 一处，两边一起变。
 *
 * 与报告的差异只在纸张：导出的是用户自己的内容（流式长文），A4 纵向；报告是七列长表，横向。
 */
import {
  BorderStyle,
  LineRuleType,
  PageOrientation,
  ShadingType,
  TableLayoutType,
  WidthType,
  type IBaseParagraphStyleOptions,
  type ICharacterStyleOptions,
  type IParagraphStyleOptions,
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

/** 导出文档里只准出现这些自定义样式名（标题层级用内置 Heading1..6）。 */
export const DOCX_STYLE_IDS = {
  codeBlock: "ReactorCodeBlock",
  quote: "ReactorQuote",
  tableHeader: "ReactorTableHeader",
  tableBody: "ReactorTableBody",
  code: "ReactorCode",
} as const;

function fontOf(stack: DocumentFontStack) {
  return {
    ascii: stack.ascii,
    hAnsi: stack.ascii,
    eastAsia: stack.eastAsia,
    cs: stack.ascii,
    hint: "eastAsia",
  };
}

function headingStyle(
  sizePt: number,
  beforePt: number,
  afterPt: number,
): IBaseParagraphStyleOptions {
  // 内置样式自带 id/name，且库是先展开 {id,name} 再展开这里 —— 多传 id 会把 styleId 覆盖成空。
  return {
    run: {
      font: fontOf(T.font.heading),
      size: halfPointsFromPt(sizePt),
      bold: true,
      color: T.color.text,
    },
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

/** 导出文档的样式表：正文体 + 标题层级 + 代码/引用/表格。 */
export function markdownDocumentStyles(): IStylesOptions {
  const codeRun = {
    font: fontOf(T.font.mono),
    size: halfPointsFromPt(T.sizePt.body),
    color: T.color.text,
  };
  return {
    default: {
      document: {
        run: {
          font: fontOf(T.font.body),
          size: halfPointsFromPt(T.sizePt.body),
          color: T.color.text,
        },
        paragraph: {
          spacing: {
            after: twipsFromPt(T.spacing.bodyAfterPt),
            line: lineUnitsFromMultiple(T.spacing.bodyLineMultiple),
            lineRule: LineRuleType.AUTO,
          },
        },
      },
      title: headingStyle(T.sizePt.reportTitle, 0, T.spacing.titleAfterPt),
      heading1: headingStyle(
        T.sizePt.heading1,
        T.spacing.heading1BeforePt,
        T.spacing.heading1AfterPt,
      ),
      heading2: headingStyle(
        T.sizePt.heading2,
        T.spacing.heading2BeforePt,
        T.spacing.heading2AfterPt,
      ),
      heading3: headingStyle(
        T.sizePt.heading3,
        T.spacing.heading3BeforePt,
        T.spacing.heading3AfterPt,
      ),
      // h4-h6 比正文更小层级：仍用标题体，字号不再往下掉（再小就与表格字混淆了）。
      heading4: headingStyle(
        T.sizePt.heading3,
        T.spacing.heading3BeforePt,
        T.spacing.heading3AfterPt,
      ),
      heading5: headingStyle(
        T.sizePt.heading3,
        T.spacing.heading3BeforePt,
        T.spacing.heading3AfterPt,
      ),
      heading6: headingStyle(
        T.sizePt.heading3,
        T.spacing.heading3BeforePt,
        T.spacing.heading3AfterPt,
      ),
    },
    paragraphStyles: [
      {
        id: DOCX_STYLE_IDS.codeBlock,
        name: "Reactor Code Block",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: codeRun,
        paragraph: {
          spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
          shading: { type: ShadingType.CLEAR, color: "auto", fill: T.color.noteShade },
        },
      },
      {
        id: DOCX_STYLE_IDS.quote,
        name: "Reactor Quote",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.body), color: T.color.subtle },
        paragraph: {
          spacing: {
            before: 0,
            after: twipsFromPt(T.spacing.bodyAfterPt),
            line: 240,
            lineRule: LineRuleType.AUTO,
          },
          border: {
            left: {
              style: BorderStyle.SINGLE,
              size: lineWidthFromPt(2),
              color: T.color.ruleStrong,
              space: 6,
            },
          },
        },
      },
      {
        id: DOCX_STYLE_IDS.tableHeader,
        name: "Reactor Table Header",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          font: fontOf(T.font.heading),
          size: halfPointsFromPt(T.sizePt.tableHeader),
          bold: true,
          color: T.color.text,
        },
        paragraph: {
          spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
          alignment: "center",
        },
      },
      {
        id: DOCX_STYLE_IDS.tableBody,
        name: "Reactor Table Body",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size: halfPointsFromPt(T.sizePt.tableBody), color: T.color.text },
        paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } },
      },
    ] satisfies IParagraphStyleOptions[],
    characterStyles: [
      {
        id: DOCX_STYLE_IDS.code,
        name: "Reactor Code",
        basedOn: "DefaultParagraphFont",
        run: codeRun,
      },
    ] satisfies ICharacterStyleOptions[],
  };
}

/** 页面：A4 纵向，版心与报告同一套令牌。 */
export function markdownSectionProperties(): ISectionPropertiesOptions {
  return {
    page: {
      size: {
        width: twipsFromMm(T.page.widthMm),
        height: twipsFromMm(T.page.heightMm),
        orientation: PageOrientation.PORTRAIT,
      },
      margin: {
        top: twipsFromMm(T.page.marginTopMm),
        right: twipsFromMm(T.page.marginRightMm),
        bottom: twipsFromMm(T.page.marginBottomMm),
        left: twipsFromMm(T.page.marginLeftMm),
      },
    },
  };
}

/** 导出文档的表格骨架：固定布局 + 均分列宽 + 令牌线宽与内边距。 */
export function markdownTableProperties(columnCount: number) {
  const contentWidth = contentWidthTwips(T.page, false);
  const percents = Array.from({ length: columnCount }, () => 100 / columnCount);
  return {
    layout: TableLayoutType.FIXED,
    columnWidths: columnWidthsFromPercents(contentWidth, percents),
    margins: {
      top: twipsFromPt(T.spacing.tableCellVerticalPt),
      bottom: twipsFromPt(T.spacing.tableCellVerticalPt),
      left: twipsFromPt(T.spacing.tableCellHorizontalPt),
      right: twipsFromPt(T.spacing.tableCellHorizontalPt),
    },
    borders: markdownTableBorders(),
    width: { size: 100, type: WidthType.PERCENTAGE },
  };
}

function markdownTableBorders(): ITableBordersOptions {
  const strong = {
    style: BorderStyle.SINGLE,
    size: lineWidthFromPt(T.table.ruleStrongPt),
    color: T.color.ruleStrong,
  };
  const light = {
    style: BorderStyle.SINGLE,
    size: lineWidthFromPt(T.table.ruleLightPt),
    color: T.color.ruleLight,
  };
  return {
    top: strong,
    bottom: strong,
    left: strong,
    right: strong,
    insideHorizontal: light,
    insideVertical: light,
  };
}

/** 图片最大宽度（像素）：等于版心宽度，图不会再被硬编码的 550px 提前缩掉。 */
export const MARKDOWN_IMAGE_MAX_WIDTH_PX = Math.round(
  (T.page.widthMm - T.page.marginLeftMm - T.page.marginRightMm) * 3.7795,
);

export const MARKDOWN_HEADER_SHADE = {
  type: ShadingType.CLEAR,
  color: "auto",
  fill: T.color.tableHeaderShade,
} as const;

export const MARKDOWN_RULE_COLOR = T.color.ruleLight;
