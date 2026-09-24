/**
 * ReportReviewIssues —— 模型自述型审查的问题承载工具（文件审查板块，docs/审查板块-方案-v1.md §3.3）。
 *
 * ## 为什么必须有这个工具
 *
 * 五个审查技能里，只有「标准引用自检」背后有确定性工具（`KnowledgeCheck`）：它自己算出字符偏移，
 * 于是卡片能点、能跳、能高亮。另外四个（基础校对 / 全文一致性 / 以文审文 / 合同风险）的结论是
 * 模型判断出来的，此前只能写成回复正文 —— 结果是同一排按钮点下去，一个能点问题条定位原文，
 * 四个只能靠人眼在文档里搜。
 *
 * 本工具把那四个的结论接进同一条链路：
 *
 *  - **模型只抄原文，不算偏移**：调用方给 `originalText`（一字不改的原文片段），
 *    工具在提取正文里做查找（精确匹配优先，失败退到归一化匹配）算出 `startOffset`/`endOffset`/`line`。
 *    让模型自己算偏移是这条链路上最不可靠的一环 —— 它会给出「看起来合法但错」的数字，
 *    而跳错位置比不跳更误导复核者。
 *  - **匹配不确定就如实说**：片段找不到时返回 `located: false`，命中多处且调用方没指定 `occurrence`
 *    时返回全部出现次数并取第一处，前端对不确定的条目不装成精确命中。
 *  - **不判断问题本身**：它不校验"这算不算问题"，只负责把问题定位到正文。
 *
 * 与 `KnowledgeCheck` 的输出保持同形（`action` / `issues[]` / `textPath` / `summary`），
 * 前端因此能复用同一套问题卡片与「点击问题 → 原文高亮」。
 */
import { z } from "zod";

import { toToolJsonSchema } from "./json-schema.js";

export const REPORT_REVIEW_ISSUES_TOOL_NAME = "ReportReviewIssues";

export const REVIEW_ISSUE_SEVERITIES = ["error", "warning", "info"] as const;

/** 片段在正文里的匹配方式：精确 / 归一化后 / 未找到。 */
export const REVIEW_ISSUE_MATCH_KINDS = ["exact", "normalized", "not_found"] as const;

export const ReportReviewIssuesInputSchema = z
  .object({
    issues: z
      .array(
        z
          .object({
            severity: z
              .enum(REVIEW_ISSUE_SEVERITIES)
              .describe("error=必须修改，warning=建议修改，info=提示；不要全报 error"),
            ruleCode: z
              .string()
              .min(1)
              .describe(
                "本条依据的规则标识，写成 `<中文类别>-<三位序号>`（如 `标点-001`、`编号-002`）；" +
                  "不适用时写审查类型名。**用中文类别，不要用英文缩写**——面板把这个标识直接显示给用户看",
              ),
            originalText: z
              .string()
              .min(1)
              .describe(
                "**原文片段，一字不改地抄回**（用于定位与复核）。不要改写、不要补省略号；片段越长定位越稳",
              ),
            description: z.string().min(1).describe("一句话说明为什么是问题（引规则/标准/条款）"),
            suggestion: z
              .string()
              .optional()
              .describe("建议改成什么；无法给出时写“需人工确认”"),
            location: z
              .string()
              .optional()
              .describe("人类可读的位置（章节号/表格名），仅用于展示；字符偏移由工具算，不要填偏移"),
            occurrence: z
              .number()
              .int()
              .positive()
              .optional()
              .describe(
                "同一片段在正文里出现多次时，指定取第几次（1 起）。不填则取第一处，返回里会给出总出现次数",
              ),
          })
          .strict(),
      )
      .min(1)
      .describe("本次审查发现的问题清单；`originalText` 缺失的问题条视为无效，宁可不报也不要编一个片段"),
    text: z
      .string()
      .optional()
      .describe(
        "被审正文（已提取的纯文本）。与 KnowledgeCheck 同口径：短正文直接传 text，工具会落盘快照供预览高亮",
      ),
    textFile: z
      .string()
      .optional()
      .describe(
        "大正文替代方案：已提取纯文本文件的绝对路径。工具读它做匹配，并直接以它为高亮目标，不再复制快照",
      ),
    sourcePath: z
      .string()
      .optional()
      .describe("可选：正文来源文件的绝对路径（如 docx），仅用于回显与报告标注"),
  })
  .strict();

export type ReportReviewIssuesInput = z.infer<typeof ReportReviewIssuesInputSchema>;

export const ReportReviewIssuesInputJsonSchema = toToolJsonSchema(ReportReviewIssuesInputSchema);

/** 一条已定位（或明确未定位）的问题。 */
export interface ReportedReviewIssue {
  /** 规则标识，原样来自 `ruleCode`；前端拿不到类别标签时直接显示它 */
  code: string;
  severity: (typeof REVIEW_ISSUE_SEVERITIES)[number];
  /** 原文片段（调用方给的 `originalText`），用于复核 */
  quoted: string;
  line: number;
  /** 未定位时为 -1，前端不得据此高亮（会跳到无关位置） */
  startOffset: number;
  endOffset: number;
  /** 片段在正文里出现的次数；未定位时为 0 */
  occurrences: number;
  /** 实际取的是第几次出现（1 起）；未定位时为 0 */
  matchedOccurrence: number;
  matchKind: (typeof REVIEW_ISSUE_MATCH_KINDS)[number];
  located: boolean;
  suggestion: string | null;
  message: string;
}

export interface ReportReviewIssuesOutput {
  action: "issues";
  /** 与 KnowledgeCheck 同形：本工具不依赖知识缓存，恒为 false（保留字段让前端走同一条读取路径） */
  stale: false;
  /** 正文快照路径（预览高亮打开它）；未落盘时为 null，此时问题条不可点 */
  textPath: string | null;
  sourcePath: string | null;
  issues: ReportedReviewIssue[];
  summary: {
    total: number;
    error: number;
    warning: number;
    info: number;
    /** 没能定位到正文的问题条数：报告里必须说明「有 N 条无法定位」 */
    unlocated: number;
  };
  notice: string | null;
}

export const ReportedReviewIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(REVIEW_ISSUE_SEVERITIES),
  quoted: z.string(),
  line: z.number(),
  startOffset: z.number(),
  endOffset: z.number(),
  occurrences: z.number(),
  matchedOccurrence: z.number(),
  matchKind: z.enum(REVIEW_ISSUE_MATCH_KINDS),
  located: z.boolean(),
  suggestion: z.string().nullable(),
  message: z.string(),
});

export const ReportReviewIssuesOutputSchema = z.object({
  action: z.literal("issues"),
  stale: z.literal(false),
  textPath: z.string().nullable(),
  sourcePath: z.string().nullable(),
  issues: z.array(ReportedReviewIssueSchema),
  summary: z.object({
    total: z.number(),
    error: z.number(),
    warning: z.number(),
    info: z.number(),
    unlocated: z.number(),
  }),
  notice: z.string().nullable(),
});

export const ReportReviewIssuesOutputJsonSchema = toToolJsonSchema(ReportReviewIssuesOutputSchema);
