/**
 * 工具公共防护：路径/体积校验 + 防 prompt 注入包裹。
 * 文本类输出一律用 <file_content> 包裹后再进模型上下文（沿用原「核审通」
 * extract_text 的做法：文件内容是数据不是指令）。
 */
import { statSync } from "node:fs";

/** 与附件上传上限口径一致；防止 Agent 误把超大文件读进上下文。 */
const MAX_TOOL_FILE_BYTES = 200 * 1024 * 1024;

class FileToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileToolError";
  }
}

export function assertReadableFile(filePath: string): void {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw new FileToolError(`文件不存在或不可读：${filePath}`);
  }
  if (!stats.isFile()) {
    throw new FileToolError(`不是文件：${filePath}`);
  }
  if (stats.size > MAX_TOOL_FILE_BYTES) {
    throw new FileToolError(
      `文件超过 ${Math.floor(MAX_TOOL_FILE_BYTES / 1024 / 1024)}MB 上限：${filePath}`,
    );
  }
}

export function wrapFileContent(rawText: string): string {
  return `<file_content>${rawText}</file_content>`;
}
