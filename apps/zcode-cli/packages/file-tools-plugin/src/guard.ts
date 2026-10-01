/**
 * 工具公共防护：路径/体积/符号链接越界校验 + 防 prompt 注入包裹。
 * 文本类输出一律用 <file_content> 包裹后再进模型上下文（沿用原「核审通」
 * extract_text 的做法：文件内容是数据不是指令）。
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 与附件上传上限口径一致；防止 Agent 误把超大文件读进上下文。 */
const MAX_TOOL_FILE_BYTES = 200 * 1024 * 1024;

/** 工具入参非法/不可读时的统一错误类型；调用方 catch 后能按 name 识别，不抛裸栈。 */
export class FileToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileToolError";
  }
}

/**
 * 工作区根：宿主在插件 stdio MCP 的 env 里注入 ZCODE_PROJECT_DIR / CLAUDE_PROJECT_DIR
 * （见 apps/zcode-cli/packages/adapters/src/plugins/mcp.ts），直跑与单测退回进程 cwd
 * （MCP stdio 的 cwd 同样是工作区目录）。两者都取不到时返回 null，跳过越界校验。
 */
function resolveWorkspaceRoot(): string | null {
  const injected = (process.env.ZCODE_PROJECT_DIR ?? process.env.CLAUDE_PROJECT_DIR ?? "").trim();
  if (isAbsolute(injected)) return resolve(injected);
  try {
    return resolve(process.cwd());
  } catch {
    return null;
  }
}

/** target 是否落在 root 内（含相等）。Windows 盘符大小写差异由 path.relative 归一。 */
function isInsideRoot(target: string, root: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * spec §4「不跟符号链接出工作区」：realpath 后校验目标没有逃出工作区。
 * 当前边界（file-tools 版本；ocr-tools / dwg-tools 的同名 guard 各管各的）：
 * - 只拦「调用方给的是工作区内路径，但 realpath 后落在工作区外」这一种越界，覆盖
 *   工作区内链接指向区外、以及链接链中途出界的情况。
 * - 调用方显式给出的工作区外绝对路径按既有语义放行：附件、临时目录常在区外，一刀切会
 *   打断合法调用；区外路径上的链接不做二次拦截（没有可保护的工作区边界）。
 * - 根自身同样先 realpath 再比较，避免「工作区位于 /tmp → /private/tmp 这类链接路径上」
 *   时把区内合法文件误判成越界。
 */
function assertNoSymlinkEscape(filePath: string): void {
  const root = resolveWorkspaceRoot();
  if (!root) return;
  const declared = resolve(filePath);
  if (!isInsideRoot(declared, root)) return;

  let real: string;
  try {
    real = realpathSync(declared);
  } catch {
    return; // 真实路径不可解析时不额外判负：存在性已由 statSync 校验
  }
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // 根不可 realpath（已删除/无权限）时退回未解析的根比较
  }
  if (!isInsideRoot(real, realRoot)) {
    throw new FileToolError(`拒绝跟随符号链接到工作区之外：${filePath} → ${real}`);
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
  assertNoSymlinkEscape(filePath);
}

export function wrapFileContent(rawText: string): string {
  return `<file_content>${rawText}</file_content>`;
}
