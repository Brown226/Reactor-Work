/**
 * 「本回合写入的文件」提取 —— 逐字移植 pi-web `lib/turn-written-files.ts`（MIT）。
 *
 * 每条写入记录都来自一个 **已成功返回** 的 `write`/`edit` 工具调用 —— 绝不从回复正文推断：
 * 助手在正文里提到某路径并不代表文件被写过，工具调用才是「发生了什么」的记录。
 *
 * 路径按 `cwd` 解析、去重、保持首次出现顺序。
 */

/** pi 内建名是 write/edit；MCP 服务器会暴露带前缀/命名空间的同名操作，谓词需覆盖常见装饰形式 */
export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" || name.startsWith("write_") || name.endsWith(".write") || name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor")
  );
}

function isFileWritingToolName(toolName: string): boolean {
  return isWriteToolName(toolName) || isEditToolName(toolName);
}

function readToolPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 把工具参数里的路径解析为绝对路径（相对路径以 cwd 为基准；绝对路径原样返回） */
export function resolveLocalFilePath(rawPath: string, cwd?: string): string | null {
  if (!rawPath) return null;
  // 工具参数是文件系统路径而非链接：保留 #、?、:数字 等在链接/源引用里有特殊含义的字符
  let resolved: string;
  if (/^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\\\") || rawPath.startsWith("/")) {
    resolved = rawPath;
  } else {
    if (!cwd) return null;
    const separator = cwd.includes("\\") ? "\\" : "/";
    const trimmed = cwd.replace(/[\\/]+$/, "");
    resolved = `${trimmed}${separator}${rawPath.replace(/^[\\/]+/, "")}`;
  }
  // 归一化分隔符做**去重键**：同一文件写成 src/a.ts 与 src\a.ts 应视为同一个
  // （Windows 上两者都合法；pi-web 以 realpath 语义去重，这里以分隔符归一等价实现）。
  return resolved.replace(/\\/g, "/");
}

export interface WrittenFile {
  /** 本回合写入的文件的绝对路径 */
  filePath: string;
}

/** 工具调用块的形状（与 shared projector 的 ContentBlock.toolCall 对齐） */
interface ToolCallLike {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: { text?: string; isError?: boolean };
}

/**
 * 收集单个助手回合实际写入的文件（去重、首次出现顺序）。
 * 仅统计「已返回且未出错」的写类工具调用 —— 仍在流式或失败的不算。
 */
export function extractTurnWrittenFiles(
  blocks: ToolCallLike[] | undefined,
  cwd?: string,
): WrittenFile[] {
  const seen = new Set<string>();
  const writtenFiles: WrittenFile[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== "toolCall") continue;
    const toolName = typeof block.name === "string" ? block.name : "";
    if (!toolName || !isFileWritingToolName(toolName)) continue;
    // 尚无结果（仍在流式）或调用失败 —— 没有写入发生
    if (!block.result || block.result.isError === true) continue;
    const rawPath = readToolPath(block.arguments);
    if (!rawPath) continue;
    const filePath = resolveLocalFilePath(rawPath, cwd);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    writtenFiles.push({ filePath });
  }
  return writtenFiles;
}
