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

/**
 * 审查结论的**判定状态**。报告必须能区分「查了没问题」「根本没查到引用」「没查成」——
 * 否则同样的 `issues: []` 会被写成「本次审查未发现问题」，那是最危险的一类假阴性：
 * 报告是交付物，收报告的人会据此签字。
 */
export const REVIEW_REPORT_CONCLUSIONS = [
  /** 查了，且全部通过（用 `coverage.referenceCount` 说明查了多少条引用） */
  "passed",
  /** 查了，但正文里没有可机检的引用/内容（空 issues 是预期结果，不是好消息） */
  "no_reference",
  /** 只审了一部分（抽取失败、格式不支持、范围被裁剪），`scope` 必须写明缺口 */
  "partial",
  /** 没查成（抽取失败且未补救）——此时不得声称做过任何核对 */
  "not_checked",
] as const;

/** 判定所依据的知识库快照 + 覆盖缺口：报告要能自证「对着哪一版库、覆盖到哪」判的。 */
export const ReviewReportBasisSchema = z
  .object({
    standardsStamp: z
      .object({
        maxUpdatedAt: z.string().nullable(),
        fetchedAt: z.string(),
        count: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
    terminologyStamp: z
      .object({
        maxUpdatedAt: z.string().nullable(),
        fetchedAt: z.string(),
        count: z.number().int().nonnegative(),
      })
      .nullable()
      .optional(),
    /** 本次核对用到的已发布规范库名 */
    ruleLibraries: z.array(z.string()).optional(),
    /** 引用了但库中几乎没有条目的标准体系（如 `["DL","NB"]`）——必须写进免责声明 */
    uncoveredFamilies: z.array(z.string()).optional(),
  })
  .strict();

export type ReviewReportBasis = z.infer<typeof ReviewReportBasisSchema>;

export const ExportReviewReportInputSchema = z
  .object({
    format: z.enum(REVIEW_REPORT_FORMATS).describe("docx=交付用报告；xlsx=问题明细表"),
    title: z.string().min(1).describe("报告标题（通常是被审文件名或审查类型）"),
    issues: z.array(ReviewReportIssueSchema).describe("问题清单"),
    /**
     * 结论状态，**必填**：空 `issues` 时它决定报告写什么。
     * 不填就是逼调用方想清楚「到底审没审成」，而不是默认写「未发现问题」。
     */
    conclusion: z
      .enum(REVIEW_REPORT_CONCLUSIONS)
      .describe("审查结论状态；空 issues 时报告按它措辞，禁止统一写「未发现问题」"),
    /** 审查覆盖度：引用条数 / 是否检出正文 / 抽取是否成功，结论措辞与免责声明会引用它 */
    coverage: z
      .object({
        referenceCount: z.number().int().nonnegative().optional(),
        extractedChars: z.number().int().nonnegative().optional(),
        extractionStatus: z.enum(["ok", "failed", "no_text_layer", "skipped"]).optional(),
      })
      .optional(),
    basis: ReviewReportBasisSchema.optional().describe("判定依据的知识库快照与覆盖缺口"),
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
