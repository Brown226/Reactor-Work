/**
 * 报告 `.xlsx` 渲染 —— 问题清单 + 摘要两个 sheet。
 *
 * 与 docx 版共用 `report-content.ts`：同一次审查在两种格式里的**措辞、口径、列顺序必须一致**，
 * 只允许排版不同（Excel 里没有「版心」，列宽按字符数给，所以比 docx 宽松）。
 *
 * 两个硬限制自己处理（超了会静默截断或写坏文件）：单格 ≤ 32767 字符、且不允许控制字符（除 \t\n）。
 */
import ExcelJS from "exceljs";

import {
  DOCUMENT_STYLE_TOKENS as T,
  type DocumentFontStack,
} from "@zcode/shared";

import type { ExportReviewReportInput, ReviewReportIssue } from "@zcode/contracts";

import { REPORT_TABLE_COLUMNS } from "./docx-style.js";
import {
  ISSUE_TABLE_HEADERS,
  countBySeverity,
  issueRowValues,
  reportMetaRows,
  sanitizeReportText,
} from "./report-content.js";

/** Excel 列宽单位是「字符数」。按同比例的 170 字符摊开：比 docx 宽，因为 Excel 可以横向滚动。 */
const TOTAL_COLUMN_CHARS = 170;

const SEVERITY_ARGB: Record<ReviewReportIssue["severity"], string> = {
  error: `FF${T.color.error}`,
  warning: `FF${T.color.warning}`,
  info: `FF${T.color.info}`,
};

function fontOf(stack: DocumentFontStack, sizePt: number, extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  // Excel 的字体名是单值：中文文档里给中日韩字体，西文数字会走它的西文部分。
  return { name: stack.eastAsia, size: sizePt, ...extra };
}

const BODY_FONT = fontOf(T.font.body, T.sizePt.tableBody);
const HEADER_FONT = fontOf(T.font.heading, T.sizePt.tableHeader, {
  bold: true,
  color: { argb: `FF${T.color.text}` },
});
const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: `FF${T.color.tableHeaderShade}` },
};
const HEADER_RULE: Partial<ExcelJS.Borders> = {
  bottom: { style: "thin", color: { argb: `FF${T.color.ruleStrong}` } },
};
const META_FONT = fontOf(T.font.body, T.sizePt.body);

/** 生成 `.xlsx`：问题清单 + 摘要两个 sheet（表头冻结、可筛选）。 */
export async function buildXlsxReport(
  input: ExportReviewReportInput,
  generatedAt: string,
): Promise<Buffer> {
  const counts = countBySeverity(input.issues);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAt);
  workbook.creator = "Reactor";
  workbook.title = input.title;

  const sheet = workbook.addWorksheet("问题清单");
  sheet.columns = REPORT_TABLE_COLUMNS.map((column, index) => ({
    header: ISSUE_TABLE_HEADERS[index] ?? column.key,
    key: column.key,
    width: Math.max(6, Math.round((TOTAL_COLUMN_CHARS * column.percent) / 100)),
  }));
  const headerRow = sheet.getRow(1);
  headerRow.font = HEADER_FONT;
  // 行高单位是磅；表头留出约 2 倍字号的余量，让底纹不与文字贴边。
  headerRow.height = Math.round(T.sizePt.tableHeader * 2.2);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = HEADER_RULE;
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  input.issues.forEach((issue, index) => {
    const values = issueRowValues(issue, index);
    const row = sheet.addRow({
      index: Number(values[0]),
      severity: sanitizeReportText(values[1]!, 200),
      code: sanitizeReportText(values[2]!, 200),
      location: sanitizeReportText(values[3]!, 500),
      quoted: sanitizeReportText(values[4]!),
      message: sanitizeReportText(values[5]!),
      suggestion: sanitizeReportText(values[6]!),
    });
    row.font = BODY_FONT;
    row.getCell("severity").font = fontOf(T.font.body, T.sizePt.tableBody, {
      bold: true,
      color: { argb: SEVERITY_ARGB[issue.severity] },
    });
    row.getCell("suggestion").font = fontOf(T.font.body, T.sizePt.tableBody, {
      color: { argb: `FF${T.color.success}` },
    });
    row.getCell("location").font = fontOf(T.font.body, T.sizePt.tableBody, {
      color: { argb: `FF${T.color.subtle}` },
    });
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (input.issues.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: input.issues.length + 1, column: REPORT_TABLE_COLUMNS.length },
    };
  }
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  const info = workbook.addWorksheet("摘要");
  info.columns = [
    { header: "项", key: "key", width: 20 },
    { header: "值", key: "value", width: 60 },
  ];
  info.getRow(1).font = HEADER_FONT;
  info.getRow(1).eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = HEADER_RULE;
  });
  const summaryRows: Array<[string, string]> = [
    ["报告标题", input.title],
    ...reportMetaRows(input, generatedAt),
    // 三个计数单独成行：Excel 里要能按严重度一眼看到条数（docx 里已并入「问题合计」）。
    ["必须修改", String(counts.error)],
    ["建议修改", String(counts.warning)],
    ["提示", String(counts.info)],
  ];
  for (const [key, value] of summaryRows) {
    const row = info.addRow({ key, value: sanitizeReportText(value) });
    row.font = META_FONT;
    row.getCell("key").font = fontOf(T.font.body, T.sizePt.body, { color: { argb: `FF${T.color.subtle}` } });
  }
  info.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
