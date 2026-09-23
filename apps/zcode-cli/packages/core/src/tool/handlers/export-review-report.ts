/**
 * ExportReviewReport —— 审查结论 → `.docx` / `.xlsx` 报告。
 *
 * 设计取舍：
 * - **报告是交付物，格式要稳定**，所以排版固定（docx：标题 + 元信息 + 汇总 + 问题表；
 *   xlsx：问题清单 + 摘要两个 sheet），不把版式交给模型。
 * - **内容全部来自输入**，工具只做机械转换 —— 不解析、不改写、不补内容。
 * - 写入位置默认落在**被审文件同目录**：报告是给人拿去交付的，放在源文件旁边最容易找到；
 *   路径可由 `outputPath` 覆盖。
 * - Excel 单元格有两个硬限制必须自己处理（超了会静默截断或写坏文件）：
 *   单格 ≤ 32767 字符、且不允许控制字符（除 \t\n）。docx 同样受不了裸控制字符。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";

import {
  CoreErrorType,
  ExportReviewReportInputJsonSchema,
  ExportReviewReportInputSchema,
  ExportReviewReportOutputJsonSchema,
  ExportReviewReportOutputSchema,
  createCoreError,
  type ExportReviewReportInput,
  type ExportReviewReportOutput,
  type ReviewReportIssue,
} from "@zcode/contracts";

import type { ToolEntry, ToolHandler } from "../types.js";

/** 单个 Excel 单元格上限 32767，留出余量。 */
const EXCEL_CELL_LIMIT = 32_000;

const SEVERITY_LABEL: Record<ReviewReportIssue["severity"], string> = {
  error: "必须修改",
  warning: "建议修改",
  info: "提示",
};

/**
 * 文本净化：去掉控制字符（保留 \t\n），并截断超长单元格。
 * 不做这一步，Excel 会因为非法字符直接判文件损坏，而词法上"看起来"写入是成功的。
 */
export function sanitizeReportText(value: string, limit = EXCEL_CELL_LIMIT): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 默认输出路径：`<被审文件同目录>/<文件名>-审查报告-<时间戳>.<ext>`。 */
export function resolveReportPath(input: ExportReviewReportInput, fallbackDir: string): string {
  if (input.outputPath) return resolve(input.outputPath);
  const stamp = (() => {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  })();
  if (input.sourcePath) {
    const source = resolve(input.sourcePath);
    const stem = basename(source, extname(source));
    return join(dirname(source), `${stem}-审查报告-${stamp}.${input.format}`);
  }
  return join(resolve(fallbackDir), `${input.title}-审查报告-${stamp}.${input.format}`);
}

export function countBySeverity(issues: ReviewReportIssue[]): { error: number; warning: number; info: number } {
  return {
    error: issues.filter((issue) => issue.severity === "error").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
}

/** 生成 `.docx`：标题 + 元信息 + 结论摘要 + 问题表。 */
export async function buildDocxReport(
  input: ExportReviewReportInput,
  generatedAt: string,
): Promise<Buffer> {
  const counts = countBySeverity(input.issues);
  const meta: string[] = [`生成时间：${generatedAt}`];
  if (input.sourcePath) meta.push(`被审文件：${basename(input.sourcePath)}`);
  if (input.scope) meta.push(`审查范围：${input.scope}`);
  meta.push(
    `问题合计：${input.issues.length} 条（必须修改 ${counts.error}／建议修改 ${counts.warning}／提示 ${counts.info}）`,
  );

  const header = ["序号", "严重度", "类别", "位置", "原文片段", "问题说明", "建议"];
  const rows = input.issues.map((issue, index) =>
    new TableRow({
      children: [
        String(index + 1),
        SEVERITY_LABEL[issue.severity],
        issue.code,
        issue.location ?? (issue.line ? `第 ${issue.line} 行` : "—"),
        issue.quoted,
        issue.message,
        issue.suggestion ?? "—",
      ].map(
        (text) =>
          new TableCell({
            children: [new Paragraph({ children: [new TextRun(sanitizeReportText(text, 4_000))] })],
          }),
      ),
    }),
  );

  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 }),
          ...meta.map((line) => new Paragraph({ text: line })),
          ...(input.summary
            ? [
                new Paragraph({ text: "结论摘要", heading: HeadingLevel.HEADING_2 }),
                new Paragraph({ text: sanitizeReportText(input.summary, 4_000) }),
              ]
            : []),
          new Paragraph({ text: "问题清单", heading: HeadingLevel.HEADING_2 }),
          ...(input.issues.length === 0
            ? [new Paragraph({ text: "本次审查未发现问题。" })]
            : [
                new Table({
                  width: { size: 100, type: WidthType.PERCENTAGE },
                  rows: [
                    new TableRow({
                      tableHeader: true,
                      children: header.map(
                        (text) =>
                          new TableCell({
                            children: [
                              new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new TextRun({ text, bold: true })],
                              }),
                            ],
                          }),
                      ),
                    }),
                    ...rows,
                  ],
                }),
              ]),
          // 话术边界：报告是机器生成的初稿，结论必须有人复核——写在文末，避免被当成定论。
          new Paragraph({
            text: "本报告由 Agent 依据给定依据自动生成，供复核参考；正式交付前请由专业人员确认。",
            heading: HeadingLevel.HEADING_3,
          }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

/** 生成 `.xlsx`：问题清单 + 摘要两个 sheet（表头冻结、可筛选）。 */
export async function buildXlsxReport(
  input: ExportReviewReportInput,
  generatedAt: string,
): Promise<Buffer> {
  const counts = countBySeverity(input.issues);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAt);

  const sheet = workbook.addWorksheet("问题清单");
  sheet.columns = [
    { header: "序号", key: "index", width: 6 },
    { header: "严重度", key: "severity", width: 12 },
    { header: "类别", key: "code", width: 16 },
    { header: "位置", key: "location", width: 16 },
    { header: "原文片段", key: "quoted", width: 48 },
    { header: "问题说明", key: "message", width: 48 },
    { header: "建议", key: "suggestion", width: 40 },
  ];
  sheet.getRow(1).font = { bold: true };
  input.issues.forEach((issue, index) => {
    sheet.addRow({
      index: index + 1,
      severity: SEVERITY_LABEL[issue.severity],
      code: sanitizeReportText(issue.code, 200),
      location: sanitizeReportText(issue.location ?? (issue.line ? `第 ${issue.line} 行` : "—"), 500),
      quoted: sanitizeReportText(issue.quoted),
      message: sanitizeReportText(issue.message),
      suggestion: sanitizeReportText(issue.suggestion ?? "—"),
    });
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (input.issues.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: input.issues.length + 1, column: 7 } };
  }
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  const info = workbook.addWorksheet("摘要");
  info.columns = [
    { header: "项", key: "key", width: 20 },
    { header: "值", key: "value", width: 60 },
  ];
  info.getRow(1).font = { bold: true };
  const summaryRows: [string, string][] = [
    ["报告标题", input.title],
    ["生成时间", generatedAt],
    ...(input.sourcePath ? ([["被审文件", input.sourcePath]] as [string, string][]) : []),
    ...(input.scope ? ([["审查范围", input.scope]] as [string, string][]) : []),
    ["问题合计", String(input.issues.length)],
    ["必须修改", String(counts.error)],
    ["建议修改", String(counts.warning)],
    ["提示", String(counts.info)],
    ...(input.summary ? ([["结论摘要", input.summary]] as [string, string][]) : []),
  ];
  for (const [key, value] of summaryRows) {
    info.addRow({ key, value: sanitizeReportText(value) });
  }
  info.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

const exportReviewReportHandler: ToolHandler = async (input, context) => {
  const parsed = ExportReviewReportInputSchema.parse(input) as ExportReviewReportInput;
  if (parsed.issues.length > 5_000) {
    throw createCoreError(CoreErrorType.InvalidInput, "问题条数超过 5000，请先收敛范围再导出", {
      context: { issueCount: parsed.issues.length },
    });
  }
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const target = resolveReportPath(parsed, context.workingDirectory ?? process.cwd());
  const buffer =
    parsed.format === "docx"
      ? await buildDocxReport(parsed, generatedAt)
      : await buildXlsxReport(parsed, generatedAt);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return {
    path: target,
    format: parsed.format,
    bytes: buffer.byteLength,
    issueCount: parsed.issues.length,
    bySeverity: countBySeverity(parsed.issues),
  } satisfies ExportReviewReportOutput;
};

const EXPORT_REVIEW_REPORT_DESCRIPTION = [
  "Export a review-findings report as .docx (delivery format) or .xlsx (issue details) into the workspace.",
  "Pass the issues you already produced — this tool only formats them, it does not re-analyse anything.",
  "Default output path is next to the reviewed file: <name>-审查报告-<timestamp>.<ext>.",
].join(" ");

export const exportReviewReportToolEntry: ToolEntry = {
  capability: "Render review findings into a .docx or .xlsx report file inside the workspace",
  metadata: {
    name: "ExportReviewReport",
    description: EXPORT_REVIEW_REPORT_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 60000,
    maxOutputBytes: 64 * 1024,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: exportReviewReportHandler,
  inputSchema: ExportReviewReportInputJsonSchema,
  outputSchema: ExportReviewReportOutputJsonSchema,
  runtimeInputSchema: ExportReviewReportInputSchema,
  runtimeOutputSchema: ExportReviewReportOutputSchema,
  formatModelContent: (output: unknown): string => {
    const result = output as ExportReviewReportOutput;
    return [
      `报告已生成：${result.path}`,
      `格式 ${result.format}，${result.bytes} 字节；问题 ${result.issueCount} 条` +
        `（必须修改 ${result.bySeverity.error}／建议修改 ${result.bySeverity.warning}／提示 ${result.bySeverity.info}）`,
    ].join("\n");
  },
  permission: {
    permission: "edit",
    reason: "ExportReviewReport writes a report file into the workspace",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["path"],
    alwaysAllowPatternSources: ["path"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 64 * 1024,
    maxModelBytes: 16 * 1024,
    strategy: "truncate",
    preview: { maxBytes: 16 * 1024, direction: "head" },
  },
  timeout: { defaultMs: 60000, maxMs: 120000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ExportReviewReport was cancelled before the report was written",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
