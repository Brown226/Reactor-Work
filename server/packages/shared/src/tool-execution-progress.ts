/**
 * 工具执行进度提取（清单 #39b）—— 移植 pi-web `lib/tool-execution-progress.ts`（MIT）。
 *
 * 从 `tool_execution_update` 的 partialResult 里取**最后一行非空文本**作为进度行
 * （npm install / 构建类工具持续吐行，最后一行即当前状态）。
 */

const MAX_PROGRESS_LENGTH = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getToolExecutionProgress(partialResult: unknown): string | null {
  if (!isObject(partialResult)) return null;

  const content = partialResult.content;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((block) => isObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => (block as { text: string }).text)
    .join("\n");
  const lines = text.split(/\r?\n/);
  let latest = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    latest = (candidate ?? "").trim();
    if (latest) break;
  }
  if (!latest) return null;

  const normalized = latest.replace(/\s+/g, " ");
  return normalized.length <= MAX_PROGRESS_LENGTH
    ? normalized
    : `...${normalized.slice(-(MAX_PROGRESS_LENGTH - 3))}`;
}
