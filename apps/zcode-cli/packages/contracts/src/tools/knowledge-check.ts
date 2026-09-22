/**
 * KnowledgeCheck —— 知识板块的**执行期只读**工具契约（文件审查板块，docs/审查板块-方案-v1.md §4.4）。
 *
 * 一个工具三个模式，因为三个子域的数据来源与缓存完全同源（都落在端侧知识缓存目录），
 * 分成三个工具只会把同一套「读缓存 + 版本判定」重复三遍：
 *
 *  - `standards`：把文档里引用的标准编号拿到**本地标准库索引**里做确定性比对（零 LLM），
 *    判出「已废止 / 引用未注年代号 / 编号不存在 / 未收录」，并给出库中现行版本。
 *  - `terminology`：把候选词拿到**术语白名单**里过滤（命中即丢弃）——校对型审查防专业词误报。
 *  - `rules`：取**规范库**（条文/审点）条目，供 agent 逐条核对（以库审文）。
 *
 * 为什么是「读本地缓存」而不是工具自己去请求服务端：企业令牌只存在于桌面主进程/渲染进程的
 * 凭据存储里，Agent 进程拿不到（也不该拿到）；端侧缓存由主仓的同步服务写入用户数据目录，
 * 工具只读文件 —— 令牌不进入 Agent 进程，审查也不依赖网络可达。
 */
import { z } from "zod";

import { toToolJsonSchema } from "./json-schema.js";

export const KNOWLEDGE_CHECK_TOOL_NAME = "KnowledgeCheck";

/** 三个知识子域。名字与 repo 里的目录一致（standards / terminology / rule-libraries）。 */
export const KNOWLEDGE_CHECK_ACTIONS = ["standards", "terminology", "rules"] as const;

export const KnowledgeCheckInputSchema = z
  .object({
    action: z
      .enum(KNOWLEDGE_CHECK_ACTIONS)
      .describe(
        "standards=标准引用自检（需 text）；terminology=术语白名单过滤（需 candidates）；rules=读规范库条文/审点",
      ),
    text: z
      .string()
      .optional()
      .describe(
        "action=standards 时的待检正文（已提取的纯文本）。工具会按字符偏移回报每条问题的位置，并把这份文本快照落盘供预览高亮。",
      ),
    sourcePath: z
      .string()
      .optional()
      .describe("可选：正文来源文件的绝对路径，仅用于问题条回显与报告标注"),
    candidates: z
      .array(z.string())
      .optional()
      .describe("action=terminology 时待过滤的候选词（例如校对报出的疑似错词）"),
    libraryId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("action=rules 时指定规范库 id；缺省返回所有已发布库的条目概要"),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("action=rules 时最多返回条目数，缺省 100"),
  })
  .strict();

export type KnowledgeCheckInput = z.infer<typeof KnowledgeCheckInputSchema>;

export const KnowledgeCheckInputJsonSchema = toToolJsonSchema(KnowledgeCheckInputSchema);

/** 缓存文件的版本信息：`maxUpdatedAt` 来自服务端，用于判断端侧缓存是否需要重拉。 */
export interface KnowledgeCacheStamp {
  /** 服务端下发的 maxUpdatedAt（ISO）；拿不到时为 null（老服务端/空库） */
  maxUpdatedAt: string | null;
  /** 端侧写入缓存的时间（ISO） */
  fetchedAt: string;
  /** 条目数 */
  count: number;
}

/** 标准引用问题的一条判定。 */
export interface KnowledgeStandardIssue {
  /** 问题类别：废止引用 / 未注年代号 / 编号或年代号不存在 / 未收录 / 通过 */
  code:
    | "abolished"
    | "no_year"
    | "no_version"
    | "not_in_library"
    | "missing"
    | "upcoming"
    | "ok";
  severity: "error" | "warning" | "info" | "none";
  /** 文档里原文怎么写的（保留原始大小写与空白口径） */
  quoted: string;
  /** 归一化后的编号，便于复核比对过程 */
  normalized: string;
  /** 行号（1 起）与字符偏移（相对传入的 text），供「点击问题 → 原文高亮」 */
  line: number;
  startOffset: number;
  endOffset: number;
  /** 命中的库记录（未收录时为 null） */
  libraryNo: string | null;
  libraryName: string | null;
  libraryStatus: "current" | "upcoming" | "abolished" | "unknown" | null;
  /** 库中建议改引的现行版本（废止引用时给出） */
  suggestion: string | null;
  message: string;
}

export interface KnowledgeRuleItem {
  libraryId: number;
  libraryName: string;
  ruleCode: string | null;
  ruleName: string | null;
  category: string | null;
  clauseText: string | null;
  checkPrompt: string | null;
  severity: "error" | "warning" | "info";
  mandatory: "mandatory" | "guidance";
  sourceLocation: string | null;
}

export interface KnowledgeCheckOutput {
  action: (typeof KNOWLEDGE_CHECK_ACTIONS)[number];
  /** 端侧缓存状态：stale=true 表示缓存缺失或读取失败，结论不可当真 */
  stale: boolean;
  /** 缓存目录的绝对路径（便于排查与人工复核） */
  cacheDir: string;
  /** 各子域缓存的版本信息 */
  stamp: KnowledgeCacheStamp | null;
  /** standards 模式：问题条（含通过项，便于统计覆盖） */
  issues: KnowledgeStandardIssue[];
  /** standards 模式：落盘的正文快照路径（预览高亮打开它）；未落盘为 null */
  textPath: string | null;
  summary: {
    /** 共识别出多少条引用（去重前） */
    total: number;
    ok: number;
    abolished: number;
    noYear: number;
    noVersion: number;
    notInLibrary: number;
    missing: number;
    upcoming: number;
  } | null;
  /** terminology 模式：**命中的白名单词**（调用方应把命中的候选丢弃） */
  whitelisted: string[];
  /** terminology 模式：未命中、需要继续人工/模型判断的候选 */
  remaining: string[];
  /** rules 模式：条文/审点条目 */
  items: KnowledgeRuleItem[];
  /** 缓存缺失时的可执行提示（例如「请在桌面端登录后打开审查模式以同步知识库」） */
  notice: string | null;
}

export const KnowledgeCheckOutputSchema = z
  .object({
      action: z.enum(KNOWLEDGE_CHECK_ACTIONS),
      stale: z.boolean(),
      cacheDir: z.string(),
      stamp: z
        .object({
          maxUpdatedAt: z.string().nullable(),
          fetchedAt: z.string(),
          count: z.number().int().nonnegative(),
        })
        .nullable(),
      issues: z.array(
        z.object({
          code: z.enum(["abolished", "no_year", "no_version", "not_in_library", "missing", "upcoming", "ok"]),
          severity: z.enum(["error", "warning", "info", "none"]),
          quoted: z.string(),
          normalized: z.string(),
          line: z.number().int().positive(),
          startOffset: z.number().int().nonnegative(),
          endOffset: z.number().int().nonnegative(),
          libraryNo: z.string().nullable(),
          libraryName: z.string().nullable(),
          libraryStatus: z.enum(["current", "upcoming", "abolished", "unknown"]).nullable(),
          suggestion: z.string().nullable(),
          message: z.string(),
        }),
      ),
      textPath: z.string().nullable(),
      summary: z
        .object({
          total: z.number().int().nonnegative(),
          ok: z.number().int().nonnegative(),
          abolished: z.number().int().nonnegative(),
          noYear: z.number().int().nonnegative(),
          noVersion: z.number().int().nonnegative(),
          notInLibrary: z.number().int().nonnegative(),
          missing: z.number().int().nonnegative(),
          upcoming: z.number().int().nonnegative(),
        })
        .nullable(),
      whitelisted: z.array(z.string()),
      remaining: z.array(z.string()),
      items: z.array(
        z.object({
          libraryId: z.number().int(),
          libraryName: z.string(),
          ruleCode: z.string().nullable(),
          ruleName: z.string().nullable(),
          category: z.string().nullable(),
          clauseText: z.string().nullable(),
          checkPrompt: z.string().nullable(),
          severity: z.enum(["error", "warning", "info"]),
          mandatory: z.enum(["mandatory", "guidance"]),
          sourceLocation: z.string().nullable(),
        }),
      ),
    notice: z.string().nullable(),
  })
  .strict();

export const KnowledgeCheckOutputJsonSchema = toToolJsonSchema(KnowledgeCheckOutputSchema);
