/**
 * Knowledge —— 文档知识库的检索工具契约（spec §9.1）。
 *
 * ## 与 KnowledgeCheck 的区别
 *
 * - `KnowledgeCheck`（审查板块）：读**本地规则库缓存**，做标准编号比对 / 术语过滤 /
 *   规范条文检索。它服务「以库审文」，数据是审查用的结构化规则。
 * - `Knowledge`（本文件）：查**用户上传的文档**，做混合检索（关键词 + 向量 + 重排）。
 *   它服务「从资料里找答案」，数据是用户自己传的 PDF / Word / Markdown。
 *
 * 两者共用「本地优先」的纪律，但数据源、索引、权限边界完全独立，因此是两个工具
 * 而不是一个工具的多个 action —— 合成的代价是每次调用都要在描述里解释
 * 「这个 action 查哪套数据」，反而更容易误用。
 *
 * ## 四个 action
 *
 * | action | 用途 | 必填 |
 * | --- | --- | --- |
 * | `search` | 混合检索，返回片段 + 出处 | `query` |
 * | `read` | 读某篇文档的正文（分页） | `docId` |
 * | `docs` | 列出库里的文档 | `kbId` |
 * | `list` | 列出知识库 | — |
 *
 * `kbId` 省略时 `search` 会搜全部库（由 sidecar 的 `kb.searchAll` 承担）。
 */
import { z } from "zod";

import { toToolJsonSchema } from "./json-schema.js";

export const KNOWLEDGE_TOOL_NAME = "Knowledge";

export const KNOWLEDGE_ACTIONS = ["search", "read", "docs", "list"] as const;

/** 检索模式：与 sidecar `handlers.SEARCH_MODES` 对齐。 */
export const KNOWLEDGE_SEARCH_MODES = ["hybrid", "keyword", "vector"] as const;

export const KnowledgeInputSchema = z
  .object({
    action: z
      .enum(KNOWLEDGE_ACTIONS)
      .describe(
        "search=混合检索片段（需 query）；read=读文档正文（需 docId）；docs=列文档（需 kbId）；list=列知识库",
      ),
    kbId: z
      .string()
      .min(1)
      .optional()
      .describe("知识库 id。search 时可省略（搜索全部库）；docs/read 建议提供"),
    query: z.string().min(1).optional().describe("检索词或自然语言问题（search 必填）"),
    docId: z.string().min(1).optional().describe("文档 id（read 必填）"),
    topK: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("返回条数，默认 8；search 用"),
    mode: z
      .enum(KNOWLEDGE_SEARCH_MODES)
      .optional()
      .describe(
        "hybrid（默认，关键词+向量+重排）/ keyword（只按字面，适合精确编号、术语）/ vector（只按语义，适合同义表述）",
      ),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(200_000)
      .optional()
      .describe("read 返回的正文字符上限，默认 12000"),
  })
  .strict();

export const KnowledgeOutputSchema = z
  .object({
    action: z.enum(KNOWLEDGE_ACTIONS),
    /** 检索结果（search）。 */
    items: z
      .array(
        z.object({
          chunkId: z.string(),
          docId: z.string(),
          title: z.string(),
          fileName: z.string().nullable(),
          folderPath: z.string().nullable(),
          contextHeader: z.string().nullable(),
          content: z.string(),
          /** 融合后排序分（越大越靠前）；不同来源不可直接比较，仅用于观察排序。 */
          score: z.number().nullable(),
          source: z.enum(["keyword", "vector", "hybrid", "title"]).nullable(),
        }),
      )
      .optional(),
    /** 文档正文（read）。 */
    content: z
      .object({
        docId: z.string(),
        title: z.string(),
        text: z.string(),
        truncated: z.boolean(),
      })
      .nullable()
      .optional(),
    /** 文档清单（docs）。 */
    documents: z
      .array(
        z.object({
          docId: z.string(),
          title: z.string(),
          fileName: z.string(),
          folderPath: z.string().nullable(),
          parseStatus: z.string(),
          chunkCount: z.number().int().nonnegative().nullable(),
        }),
      )
      .optional(),
    /** 知识库清单（list）。 */
    bases: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable(),
          documentCount: z.number().int().nonnegative().nullable(),
          embeddingModel: z.string().nullable(),
          embeddingDim: z.number().int().nullable(),
        }),
      )
      .optional(),
    /**
     * 降级标记：向量或重排服务不可用时为 true，结果仍可用但精度下降。
     * **必须如实回传** —— 谎报 degraded=false 会让 agent 误以为召回完整。
     */
    degraded: z.boolean().optional(),
    /** 面向模型的简短说明（无结果时给出下一步建议）。 */
    notice: z.string().nullable(),
  })
  .strict();

export const KnowledgeInputJsonSchema = toToolJsonSchema(KnowledgeInputSchema);
export const KnowledgeOutputJsonSchema = toToolJsonSchema(KnowledgeOutputSchema);

export type KnowledgeInput = z.infer<typeof KnowledgeInputSchema>;
export type KnowledgeOutput = z.infer<typeof KnowledgeOutputSchema>;
