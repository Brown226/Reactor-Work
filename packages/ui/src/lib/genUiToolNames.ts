/**
 * GenUI 工具按名判定（与 reviewToolNames 同款：不在 shared 已知工具表时也命中）。
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolToken(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/gu, "") : "";
}

interface GenUiToolNameSource {
  toolName?: string | null;
  kind?: string | null;
  title?: string | null;
  raw?: unknown;
}

function matchesToolName(source: GenUiToolNameSource, token: string): boolean {
  const rawNames = isPlainRecord(source.raw)
    ? [source.raw.toolName, source.raw.tool_name, source.raw.name]
    : [];
  return [source.toolName, source.kind, source.title, ...rawNames].some(
    (value) => normalizeToolToken(value) === token,
  );
}

export function isEmitUiTreeToolCall(source: GenUiToolNameSource): boolean {
  return matchesToolName(source, "emituitree");
}

export function isEmitUiPatchToolCall(source: GenUiToolNameSource): boolean {
  return matchesToolName(source, "emituipatch");
}

export function isEmitUiToolCall(source: GenUiToolNameSource): boolean {
  return isEmitUiTreeToolCall(source) || isEmitUiPatchToolCall(source);
}
