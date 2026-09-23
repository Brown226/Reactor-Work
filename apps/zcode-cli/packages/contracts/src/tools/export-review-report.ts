/**
 * ExportReviewReport —— 把审查结论导出为可交付的报告（`.docx` / `.xlsx`）。
 *
 * 为什么由**工具**生成而不是让模型写字：报告是交付物，格式要稳定（表头、列宽、汇总口径），
 * 而模型逐字拼 OOXML 既不可靠也不可复现。工具只做机械转换，内容全部来自输入。
 *
 * 为什么放在 CLI（Node 侧）而不是服务端或渲染进程：生成 `.docx`/`.xlsx` 需要写文件，
 * Agent 已经有工作区写权限与路径解析，直接落盘最省事，也不必把报告内容上传到任何服务端。
 */
import { z } from "zod";

import { toToolJsonSchema } from "./json-schema.js";

export const EXPORT_REVIEW_REPORT_TOOL_NAME = "ExportReviewReport";

export const REVIEW_REPORT_FORMATS = ["docx", "xlsx"] as const;

/** 报告里的一条问题：与审查结论的字段一一对应，不做二次加工。 */
export const ReviewReportIssueSchema = z
  .object({
    severity: z.enum(["error", "warning", "info"]),
    /** 问题类别（如 `abolished` / `no_year` / `TYPO-001`），用于分组统计 */
    code: z.string().describe("问题类别标识（如 abolished、no_year、TYPO-001）"),
    /** 原文片段：报告里最有用的一列，缺失的问题条没有复核价值 */
    quoted: z.string().describe("原文片段（一字不改抄回）"),
    message: z.string().describe("问题说明（为什么是问题）"),
    suggestion: z.string().optional().describe("建议改成什么；无法给出时写「需人工确认」"),
    location: z.string().optional().describe("位置描述（如「第 3 页 表 2」/「§5.2」）"),
    line: z.number().int().positive().optional().describe("行号（提取文本中的行）"),
  })
  .strict();

export type ReviewReportIssue = z.infer<typeof ReviewReportIssueSchema>;

export const ExportReviewReportInputSchema = z
  .object({
    format: z.enum(REVIEW_REPORT_FORMATS).describe("docx=交付用报告；xlsx=问题明细表"),
    title: z.string().min(1).describe("报告标题（通常是被审文件名或审查类型）"),
    issues: z.array(ReviewReportIssueSchema).describe("问题清单"),
    sourcePath: z
      .string()
      .optional()
      .describe("被审文件的绝对路径；同时用于推导默认输出位置"),
    outputPath: z
      .string()
      .optional()
      .describe("输出文件绝对路径；缺省为「被审文件同目录/<文件名>-审查报告-<时间戳>.<ext>」"),
    summary: z
      .string()
      .optional()
      .describe("结论摘要（一两句话，写在报告开头）"),
    /** 审查范围说明：报告必须能自证"查了什么"，否则读者无法判断结论边界。 */
    scope: z
      .string()
      .optional()
      .describe("审查范围说明（如「正文 + 表格；未含图纸」）"),
  })
  .strict();

export type ExportReviewReportInput = z.infer<typeof ExportReviewReportInputSchema>;

export const ExportReviewReportInputJsonSchema = toToolJsonSchema(ExportReviewReportInputSchema);

export interface ExportReviewReportOutput {
  path: string;
  format: (typeof REVIEW_REPORT_FORMATS)[number];
  bytes: number;
  issueCount: number;
  /** 按严重度统计，便于模型直接复述 */
  bySeverity: { error: number; warning: number; info: number };
}

export const ExportReviewReportOutputSchema = z
  .object({
    path: z.string(),
    format: z.enum(REVIEW_REPORT_FORMATS),
    bytes: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
    bySeverity: z.object({
      error: z.number().int().nonnegative(),
      warning: z.number().int().nonnegative(),
      info: z.number().int().nonnegative(),
    }),
  })
  .strict();

export const ExportReviewReportOutputJsonSchema = toToolJsonSchema(ExportReviewReportOutputSchema);
