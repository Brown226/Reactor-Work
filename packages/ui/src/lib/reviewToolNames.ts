/**
 * 审查工具的按名判定（文件审查板块）。
 *
 * 为什么按名字先分流：这几个工具不在 `@zcode/shared` 的已知工具表里，`resolveToolCallIdentity`
 * 会把它们归到 unknown → 掉进「原始 JSON 兜底卡」。这与 `workflowToolNames.ts` 是同一处境
 * （登记前/登记后两种世界都要成立），所以采用同一套归一匹配：抹掉大小写与分隔符，
 * 让 `KnowledgeCheck` / `knowledge_check` / `knowledge-check` 三种 wire 写法都命中。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface ReviewToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: ReviewToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

export function isKnowledgeCheckToolCall(source: ReviewToolNameSource): boolean {
  return matchesToolName(source, "knowledgecheck");
}

export function isReportReviewIssuesToolCall(source: ReviewToolNameSource): boolean {
  return matchesToolName(source, "reportreviewissues");
}

export function isExportReviewReportToolCall(source: ReviewToolNameSource): boolean {
  return matchesToolName(source, "exportreviewreport");
}
