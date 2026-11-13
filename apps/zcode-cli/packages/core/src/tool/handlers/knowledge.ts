/**
 * Knowledge 工具执行器 —— 文档知识库检索（spec §9.1）。
 *
 * ## 数据来源
 *
 * 走 HTTP 网关 `/api/knowledge/owned/*`（与前端知识库页同一套 REST 契约）。
 * 不自建 RPC、不读 sidecar 的 SQLite —— 保持「网关是唯一入口」，否则
 * agent 与 UI 会看到两份可能不一致的数据。
 *
 * ## 为什么用 HTTP 而不是直接读文件
 *
 * sidecar 的索引是它的私有状态（每库一个 SQLite + FTS + vec0 表）。
 * 直接读会绕过它的并发控制与降级逻辑（embedding 故障时该退化为关键词）。
 * 走网关则复用同一套语义。
 *
 * ## 失败语义
 *
 * - 网关不可达（知识库未启用 / sidecar 起不来）→ 返回 `notice` 说明不可用，
 *   **不抛异常**：agent 应该能继续用 grep / read 等其它手段，而不是整个任务中断。
 * - 检索成功但无结果 → 返回空 items + 提示换关键词。
 * - degraded=true 如实回传，让 agent 知道精度下降。
 */
import {
  KNOWLEDGE_TOOL_NAME,
  KnowledgeInputJsonSchema,
  KnowledgeInputSchema,
  KnowledgeOutputJsonSchema,
  KnowledgeOutputSchema,
  type KnowledgeInput,
  type KnowledgeOutput,
} from "@zcode/contracts";

import type { ToolEntry } from "../types.js";

/** 网关 base。与前端 kb-api.ts 保持一致。 */
const GATEWAY_BASE = "/api/knowledge/owned";

/** 网关请求超时：检索含一次 embedding 往返，给足 20s。 */
const GATEWAY_TIMEOUT_MS = 20_000;

/** 网关地址解析：优先环境变量（桌面端会注入实际端口），否则相对路径。 */
function resolveGatewayUrl(path: string): string {
  const explicit = process.env["ZCODE_KNOWLEDGE_GATEWAY_URL"]?.trim();
  const base = explicit ? explicit.replace(/\/+$/, "") : "";
  return `${base}${GATEWAY_BASE}${path}`;
}

interface GatewayError {
  code?: string;
  error?: string;
}

async function gatewayGet<T>(path: string): Promise<T> {
  const response = await fetch(resolveGatewayUrl(path), {
    method: "GET",
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as (T & GatewayError) | null;
  if (!response.ok) {
    const message = payload?.error ?? `知识库请求失败：HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: string };
    error.code = payload?.code;
    throw error;
  }
  return (payload ?? {}) as T;
}

async function gatewayPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(resolveGatewayUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as (T & GatewayError) | null;
  if (!response.ok) {
    const message = payload?.error ?? `知识库请求失败：HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: string };
    error.code = payload?.code;
    throw error;
  }
  return (payload ?? {}) as T;
}

/** 检索来源。只允许契约里声明的四种，其余一律 null。 */
type SearchSource = "keyword" | "vector" | "hybrid" | "title";

function normalizeSource(raw: unknown): SearchSource | null {
  return raw === "keyword" || raw === "vector" || raw === "hybrid" || raw === "title" ? raw : null;
}

/** sidecar 的命中项 → 工具输出项。字段名在网关层已是 camelCase。 */
function toSearchItem(raw: Record<string, unknown>): NonNullable<KnowledgeOutput["items"]>[number] {
  // 优先级：重排分 > RRF 融合分 > 单路分。展示给模型的 score 只用于
  // 「谁更相关」的粗略判断，不同来源的分值不可直接比较。
  const score =
    (raw["rerankScore"] as number | undefined) ??
    (raw["rrfScore"] as number | undefined) ??
    (raw["vectorScore"] as number | undefined) ??
    (raw["keywordScore"] as number | undefined) ??
    null;
  return {
    chunkId: String(raw["chunkId"] ?? ""),
    docId: String(raw["docId"] ?? ""),
    title: String(raw["title"] ?? raw["fileName"] ?? ""),
    fileName: (raw["fileName"] as string | undefined) ?? null,
    folderPath: (raw["folderPath"] as string | undefined) ?? null,
    contextHeader: (raw["contextHeader"] as string | undefined) ?? null,
    content: String(raw["content"] ?? ""),
    score: typeof score === "number" ? score : null,
    source: normalizeSource(raw["source"]),
  };
}

async function knowledgeHandler(input: KnowledgeInput): Promise<KnowledgeOutput> {
  try {
    switch (input.action) {
      case "list": {
        const res = await gatewayGet<{ bases?: Record<string, unknown>[] }>("/bases");
        const bases = (res.bases ?? []).map((base) => ({
          id: String(base["id"] ?? ""),
          name: String(base["name"] ?? ""),
          description: (base["description"] as string | undefined) ?? null,
          documentCount: (base["documentCount"] as number | undefined) ?? null,
          embeddingModel: (base["embeddingModel"] as string | undefined) ?? null,
          embeddingDim: (base["embeddingDim"] as number | undefined) ?? null,
        }));
        return {
          action: "list",
          bases,
          notice: bases.length === 0 ? "还没有知识库。请先在「知识库」页新建一个并上传文档。" : null,
        };
      }

      case "docs": {
        if (!input.kbId) {
          return { action: "docs", documents: [], notice: "docs 需要提供 kbId（可先用 action=list 查看）" };
        }
        const res = await gatewayGet<{ docs?: Record<string, unknown>[] }>(
          `/bases/${encodeURIComponent(input.kbId)}/documents`,
        );
        const documents = (res.docs ?? []).map((doc) => ({
          docId: String(doc["id"] ?? doc["docId"] ?? ""),
          title: String(doc["title"] ?? ""),
          fileName: String(doc["fileName"] ?? ""),
          folderPath: (doc["folderPath"] as string | undefined) ?? null,
          parseStatus: String(doc["parseStatus"] ?? "unknown"),
          chunkCount: (doc["chunkCount"] as number | undefined) ?? null,
        }));
        return {
          action: "docs",
          documents,
          notice: documents.length === 0 ? "该知识库还没有文档。" : null,
        };
      }

      case "read": {
        if (!input.docId) {
          return { action: "read", content: null, notice: "read 需要提供 docId（可先用 action=docs 查看）" };
        }
        const maxChars = input.maxChars ?? 12_000;
        const res = await gatewayGet<{ content?: Record<string, unknown> }>(
          `/documents/${encodeURIComponent(input.docId)}/content?maxChars=${maxChars}`,
        );
        const content = res.content ?? {};
        const text = String(content["text"] ?? content["content"] ?? "");
        return {
          action: "read",
          content: {
            docId: String(content["docId"] ?? input.docId),
            title: String(content["title"] ?? ""),
            text,
            truncated: Boolean(content["truncated"]) || text.length >= maxChars,
          },
          notice: text.length === 0 ? "该文档没有可读正文（可能仍在解析或解析失败）。" : null,
        };
      }

      case "search":
      default: {
        if (!input.query) {
          return { action: "search", items: [], notice: "search 需要提供 query" };
        }
        const body = {
          query: input.query,
          topK: input.topK ?? 8,
          mode: input.mode ?? "hybrid",
        };
        // kbId 省略 → 搜全部库
        const path = input.kbId
          ? `/bases/${encodeURIComponent(input.kbId)}/search`
          : "/search";
        const res = await gatewayPost<{
          items?: Record<string, unknown>[];
          degraded?: boolean;
        }>(path, body);
        const items = (res.items ?? []).map(toSearchItem);
        return {
          action: "search",
          items,
          degraded: Boolean(res.degraded),
          notice:
            items.length === 0
              ? "没有检索到相关内容。可以试试换同义词、减少关键词，或先用 action=docs 确认库里有哪些文档。"
              : res.degraded
                ? "向量/重排服务不可用，本次为关键词降级检索，召回可能不全。"
                : null,
        };
      }
    }
  } catch (error) {
    // 网关不可达不是「检索无结果」——必须区分，否则 agent 会以为库里没内容。
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as Error & { code?: string }).code;
    const unavailable =
      code === "KNOWLEDGE_UNAVAILABLE" ||
      message.includes("ECONNREFUSED") ||
      message.includes("fetch failed") ||
      message.includes("Failed to fetch");
    return {
      action: input.action,
      notice: unavailable
        ? `知识库服务当前不可用（${message}）。可以改用 grep / read 直接在文件里查找。`
        : `知识库查询失败：${message}`,
      ...(input.action === "search" ? { items: [] } : {}),
      ...(input.action === "list" ? { bases: [] } : {}),
      ...(input.action === "docs" ? { documents: [] } : {}),
      ...(input.action === "read" ? { content: null } : {}),
    };
  }
}

const KNOWLEDGE_DESCRIPTION = [
  "检索用户上传的文档知识库（PDF / Word / Excel / PPT / Markdown）：",
  "action=search 做混合检索（关键词 + 向量 + 重排），返回最相关的文本片段和出处；",
  "action=read 读某篇文档的正文；",
  "action=docs 列出库里的文档；",
  "action=list 列出所有知识库。",
  "适合「资料里怎么规定的」「这个标准第几条写的什么」这类问题；查代码用 grep，查具体文件用 read。",
  "检索不到时不要臆造内容，如实说明并建议换关键词。",
].join("\n");

export const knowledgeToolEntry: ToolEntry = {
  capability:
    "Search the user's uploaded document knowledge base with hybrid retrieval (keyword + vector + rerank) and read back matching passages with citations",
  metadata: {
    name: KNOWLEDGE_TOOL_NAME,
    description: KNOWLEDGE_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: 512 * 1024,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: (input: unknown) => knowledgeHandler(input as KnowledgeInput),
  inputSchema: KnowledgeInputJsonSchema,
  outputSchema: KnowledgeOutputJsonSchema,
  runtimeInputSchema: KnowledgeInputSchema,
  runtimeOutputSchema: KnowledgeOutputSchema,
  // 只读检索：不写任何状态，权限档位与 Read 一致（read + 低风险 + 无需审批）。
  permission: {
    permission: "read",
    reason: "Knowledge only retrieves passages from the local knowledge base; it never modifies documents or indexes",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: [],
    alwaysAllowPatternSources: [],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 512 * 1024,
    maxModelBytes: 512 * 1024,
    strategy: "truncate",
    preview: {
      maxBytes: 512 * 1024,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30_000,
    maxMs: 120_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "required",
    userVisibleMessage: "Knowledge search was cancelled before results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
  formatModelContent: (output: unknown): string => {
    const result = output as KnowledgeOutput;
    if (result.notice && !result.items?.length && !result.content && !result.documents?.length && !result.bases?.length) {
      return result.notice;
    }

    if (result.action === "list") {
      const lines = [`知识库（${result.bases?.length ?? 0} 个）：`];
      for (const base of result.bases ?? []) {
        lines.push(
          `- ${base.name} (${base.id}) — ${base.documentCount ?? 0} 篇文档，向量模型 ${base.embeddingModel ?? "未配置"}`,
        );
      }
      if (result.notice) lines.push(result.notice);
      return lines.join("\n");
    }

    if (result.action === "docs") {
      const lines = [`文档（${result.documents?.length ?? 0} 篇）：`];
      for (const doc of result.documents ?? []) {
        lines.push(
          `- ${doc.title || doc.fileName} (${doc.docId}) — ${doc.parseStatus}，${doc.chunkCount ?? 0} 块${doc.folderPath ? `，目录 ${doc.folderPath}` : ""}`,
        );
      }
      if (result.notice) lines.push(result.notice);
      return lines.join("\n");
    }

    if (result.action === "read") {
      if (!result.content) return result.notice ?? "未读到文档正文";
      const lines = [`# ${result.content.title || result.content.docId}`, ""];
      lines.push(result.content.text);
      if (result.content.truncated) lines.push("\n（正文已截断，需要更多内容请提高 maxChars）");
      return lines.join("\n");
    }

    // search
    const items = result.items ?? [];
    if (items.length === 0) return result.notice ?? "没有检索到相关内容";
    const lines = [
      `检索到 ${items.length} 条相关内容${result.degraded ? "（向量服务不可用，已降级为关键词检索）" : ""}：`,
      "",
    ];
    items.forEach((item, index) => {
      const where = [item.title, item.contextHeader, item.folderPath].filter(Boolean).join(" › ");
      lines.push(`[${index + 1}] ${where}`);
      lines.push(item.content.trim());
      lines.push("");
    });
    return lines.join("\n").trimEnd();
  },
};
