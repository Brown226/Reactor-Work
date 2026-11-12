/**
 * 报告 `.docx` 渲染 —— 标题 + 元信息 + 结论摘要 + 问题表 + 注释。
 *
 * 三条硬规矩（`docs/已完成/已完成-文档产出-规范-v1.md`）：
 * ① 排版只走样式表，生成器不写内联字体字号 —— 否则渲染结果由读者本机 Word 决定；
 * ② 表格必须显式给 `tblGrid` / `tcW` / `tblLayout=fixed`，宽度分配不能交给 Word 自动算法；
 * ③ 内容全部来自输入，这里只做机械转换，不解析、不改写、不补内容。
 */
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import type { ExportReviewReportInput, ReviewReportIssue } from "@zcode/contracts";

import {
  REPORT_CELL_VERTICAL_ALIGN,
  REPORT_HEADER_SHADE,
  REPORT_META_BORDERS,
  REPORT_META_TABLE_WIDTHS,
  REPORT_STYLE_IDS,
  REPORT_TABLE_COLUMNS,
  REPORT_TABLE_PROPERTIES,
  reportDocumentStyles,
  reportSectionProperties,
} from "./docx-style.js";
import {
  ISSUE_TABLE_HEADERS,
  REPORT_DISCLAIMER,
  emptyIssuesStatement,
  issueRowValues,
  reportMetaRows,
  sanitizeReportText,
} from "./report-content.js";

/** 单元格正文用 4000 字符上限：报告不是日志，超长的原文片段应当回去截断输入而不是撑爆版面。 */
const CELL_TEXT_LIMIT = 4_000;

const SEVERITY_STYLE: Record<ReviewReportIssue["severity"], string> = {
  error: REPORT_STYLE_IDS.severityError,
  warning: REPORT_STYLE_IDS.severityWarning,
  info: REPORT_STYLE_IDS.severityInfo,
};

function dxa(width: number) {
  return { size: width, type: WidthType.DXA };
}

function text(paragraphStyle: string, value: string, runStyle?: string): Paragraph {
  return new Paragraph({
    style: paragraphStyle,
    children: [new TextRun({ text: sanitizeReportText(value, CELL_TEXT_LIMIT), style: runStyle })],
  });
}

/** 元信息：两列无框小表。比一长串等权正文更好扫 —— 眼睛能直接落到「结论状态」这一行。 */
function metaTable(input: ExportReviewReportInput, generatedAt: string): Table {
  const rows = reportMetaRows(input, generatedAt).map(
    ([label, value]) =>
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: dxa(REPORT_META_TABLE_WIDTHS[0]!),
            verticalAlign: REPORT_CELL_VERTICAL_ALIGN,
            children: [text(REPORT_STYLE_IDS.metaLabel, label)],
          }),
          new TableCell({
            width: dxa(REPORT_META_TABLE_WIDTHS[1]!),
            verticalAlign: REPORT_CELL_VERTICAL_ALIGN,
            children: [text(REPORT_STYLE_IDS.metaValue, value)],
          }),
        ],
      }),
  );
  return new Table({
    rows,
    layout: REPORT_TABLE_PROPERTIES.layout,
    columnWidths: REPORT_META_TABLE_WIDTHS,
    borders: REPORT_META_BORDERS,
    margins: REPORT_TABLE_PROPERTIES.margins,
    width: REPORT_TABLE_PROPERTIES.width,
  });
}

/** 问题表：表头行加底纹并跨页重复，每行 `cantSplit` 保证一条问题不会被页码切开。 */
function issuesTable(issues: ReviewReportIssue[]): Table {
  const widths = REPORT_TABLE_PROPERTIES.columnWidths;
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: ISSUE_TABLE_HEADERS.map(
      (label, index) =>
        new TableCell({
          width: dxa(widths[index] ?? 0),
          shading: REPORT_HEADER_SHADE.shading,
          verticalAlign: REPORT_CELL_VERTICAL_ALIGN,
          children: [text(REPORT_STYLE_IDS.tableHeader, label)],
        }),
    ),
  });
  const rows = issues.map((issue, index) => {
    const values = issueRowValues(issue, index);
    return new TableRow({
      cantSplit: true,
      children: values.map((value, column) => {
        const key = REPORT_TABLE_COLUMNS[column]?.key;
        const paragraphStyle =
          key === "location" || key === "index" ? REPORT_STYLE_IDS.tableMeta : REPORT_STYLE_IDS.tableBody;
        // 颜色只表达「这条要干什么」：严重度用它自己的色，建议用绿色，编号用等宽灰。
        // 占位的「—」不着色 —— 绿「—」会被读成「这里有建议」。
        const runStyle =
          key === "severity"
            ? SEVERITY_STYLE[issue.severity]
            : key === "suggestion" && issue.suggestion
              ? REPORT_STYLE_IDS.suggest
              : key === "code"
                ? REPORT_STYLE_IDS.code
                : undefined;
        return new TableCell({
          width: dxa(widths[column] ?? 0),
          verticalAlign: REPORT_CELL_VERTICAL_ALIGN,
          children: [text(paragraphStyle, value, runStyle)],
        });
      }),
    });
  });
  return new Table({
    rows: [header, ...rows],
    layout: REPORT_TABLE_PROPERTIES.layout,
    columnWidths: widths,
    borders: REPORT_TABLE_PROPERTIES.borders,
    margins: REPORT_TABLE_PROPERTIES.margins,
    width: REPORT_TABLE_PROPERTIES.width,
  });
}

function headerBlock(title: string): Header {
  return new Header({
    children: [
      new Paragraph({
        style: REPORT_STYLE_IDS.footer,
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: sanitizeReportText(title, 200) })],
      }),
    ],
  });
}

/** 页码字段必须让 Word 打开时更新，否则「共 Y 页」会停在生成时的缓存值。 */
function footerBlock(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        style: REPORT_STYLE_IDS.footer,
        children: [
          new TextRun({ text: "第 " }),
          new TextRun({ children: [PageNumber.CURRENT] }),
          new TextRun({ text: " 页 / 共 " }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
          new TextRun({ text: " 页" }),
        ],
      }),
    ],
  });
}

/** 生成 `.docx`：标题 + 元信息 + 结论摘要 + 问题表 + 注释。 */
export async function buildDocxReport(
  input: ExportReviewReportInput,
  generatedAt: string,
): Promise<Buffer> {
  // 数据边界不在这里重复：它已经作为元信息的一行出现在表格里（放在结论状态旁边，
  // 比放在文末更容易在读数前读到）；文末只留「机器生成初稿」这条免责。
  const document = new Document({
    title: input.title,
    subject: "文件审查报告",
    creator: "Reactor",
    lastModifiedBy: "Reactor",
    keywords: "Reactor,审查报告",
    description: sanitizeReportText(input.summary ?? input.scope ?? REPORT_DISCLAIMER, 1_000),
    // 页码是域：不置 updateFields，Word 打开时「共 Y 页」可能是旧值。
    features: { updateFields: true },
    styles: reportDocumentStyles(),
    sections: [
      {
        properties: reportSectionProperties(),
        headers: { default: headerBlock(input.title) },
        footers: { default: footerBlock() },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, text: sanitizeReportText(input.title, 300) }),
          metaTable(input, generatedAt),
          ...(input.summary
            ? [
                new Paragraph({ heading: HeadingLevel.HEADING_1, text: "结论摘要" }),
                new Paragraph({ text: sanitizeReportText(input.summary, CELL_TEXT_LIMIT) }),
              ]
            : []),
          new Paragraph({ heading: HeadingLevel.HEADING_1, text: "问题清单" }),
          ...(input.issues.length === 0
            ? [new Paragraph({ text: emptyIssuesStatement(input) })]
            : [issuesTable(input.issues)]),
          new Paragraph({ style: REPORT_STYLE_IDS.note, text: REPORT_DISCLAIMER }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
