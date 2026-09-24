/**
 * ExportReviewReport —— 审查结论 → `.docx` / `.xlsx` 报告（工具入口）。
 *
 * 设计取舍：
 * - **报告是交付物，格式要稳定**，所以排版固定（docx：标题 + 元信息 + 结论摘要 + 问题表 + 注释；
 *   xlsx：问题清单 + 摘要），不把版式交给模型。
 * - 但「格式稳定」指的是**结构**，版式必须由样式表决定 —— 早期版本只固定了结构，字体字号留在
 *   Word 默认值上，报告长得如何取决于读者装了哪个版本的 Word。样式表在 `src/report/docx-style.ts`，
 *   详见 `docs/文档产出-规范-v1.md`。
 * - **内容全部来自输入**，工具只做机械转换 —— 不解析、不改写、不补内容。
 * - 写入位置默认落在**被审文件同目录**：报告是给人拿去交付的，放在源文件旁边最容易找到；
 *   路径可由 `outputPath` 覆盖。
 * - docx 与 xlsx 的信息口径必须一致（措辞共用 `src/report/report-content.ts`）：收报告的人
 *   可能只看其中一种，不能让「结论状态」只存在于 xlsx。
 *
 * 实现拆在 `src/report/`：`report-content.ts`（措辞与元信息）、`docx-style.ts`（样式表）、
 * `report-docx.ts` / `report-xlsx.ts`（两个渲染器）。这里只保留入口、入参校验与写盘。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CoreErrorType,
  ExportReviewReportInputJsonSchema,
  ExportReviewReportInputSchema,
  ExportReviewReportOutputJsonSchema,
  ExportReviewReportOutputSchema,
  createCoreError,
  type ExportReviewReportInput,
  type ExportReviewReportOutput,
} from "@zcode/contracts";

import { buildDocxReport } from "../../report/report-docx.js";
import { buildXlsxReport } from "../../report/report-xlsx.js";
import { countBySeverity, resolveReportPath } from "../../report/report-content.js";

import type { ToolEntry, ToolHandler } from "../types.js";

// 纯函数与渲染器从 `src/report/` 引出：测试与调用方一直从本模块取，保持导出面不变。
export {
  CONCLUSION_LABEL,
  EXCEL_CELL_LIMIT,
  ISSUE_TABLE_HEADERS,
  REPORT_DISCLAIMER,
  SEVERITY_LABEL,
  basisMetaLines,
  countBySeverity,
  coverageDisclaimer,
  emptyIssuesStatement,
  issueRowValues,
  reportMetaRows,
  resolveReportPath,
  sanitizeReportText,
} from "../../report/report-content.js";
export { buildDocxReport } from "../../report/report-docx.js";
export { buildXlsxReport } from "../../report/report-xlsx.js";

const exportReviewReportHandler: ToolHandler = async (input, context) => {
  const parsed = ExportReviewReportInputSchema.parse(input) as ExportReviewReportInput;
  if (parsed.issues.length > 5_000) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "问题条数超过 5000：请分批导出（按章节/子目录拆成多份报告，或把 info 级条目移出问题表），不要合并成一份",
      { context: { issueCount: parsed.issues.length } },
    );
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
  "",
  "You MUST state `conclusion` (passed / no_reference / partial / not_checked): when `issues` is empty the wording",
  "depends entirely on it — no_reference and not_checked must never read as \"no problems found\".",
  "Pass `coverage` (referenceCount / extractedChars / extractionStatus) and, for standards checks,",
  "`basis` from KnowledgeCheck (standardsStamp + uncoveredFamilies) so the report can prove which library version",
  "it was judged against and which standard systems the library does not cover.",
  "Keep `location` short (章节/页/行) and `quoted` verbatim — the report renders them as table columns and long",
  "cells make the table unreadable.",
].join("\n");

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
  },  permission: {
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
