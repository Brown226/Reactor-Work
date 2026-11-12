/**
 * 我的空间：文件类型判定与图标来源。
 *
 * 图标不在这里另画一套：直接复用工作区文件树的 Material 图标
 * （`lib/fileDisplay.tsx`），所以空间页与文件树、预览头里的同一种文件长得一样。
 */
import { getMediaPreviewFormat } from "@zcode/shared";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";

export type SpacePreviewKind =
  | "image"
  | "pdf"
  | "office"
  | "pptx"
  | "dwg"
  | "audio"
  | "video"
  | "markdown"
  | "code"
  | "unsupported";

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/** 纯文本预览白名单：宁可少列，也不要把二进制文件当文本读进内存。 */
const CODE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "csv",
  "diff",
  "env",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "mjs",
  "php",
  "properties",
  "ps1",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

/** 文本预览上限：超过这个大小直接提示下载，不把整个文件拉进浏览器。 */
export const SPACE_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Office/PPTX 要整包进内存解析，上限与桌面端二进制预览口径保持一致。 */
export const SPACE_BINARY_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

export function spaceFileExtension(name: string): string {
  const leaf = name.trim().toLowerCase();
  const index = leaf.lastIndexOf(".");
  return index > 0 ? leaf.slice(index + 1) : "";
}

export function resolveSpacePreviewKind(name: string): SpacePreviewKind {
  const extension = spaceFileExtension(name);
  if (!extension) return "unsupported";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (extension === "dwg" || extension === "dxf") return "dwg";
  if (getOfficeFilePreviewKind(name)) return "office";
  if (extension === "pptx") return "pptx";
  const media = getMediaPreviewFormat(name);
  if (media) return media.kind;
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "unsupported";
}

/** 文件类型在图标之外的展示名（详情面板「类型」一行）。 */
export function spaceFileTypeLabel(name: string, kind: "file" | "directory" | "other"): string {
  if (kind === "directory") return "Folder";
  const extension = spaceFileExtension(name);
  return extension ? extension.toUpperCase() : "File";
}

export function spaceFileIconSrc(name: string, kind: "file" | "directory" | "other"): string {
  // 「other」是符号链接等特殊项（服务端 kind）：图标按文件处理，不当作目录。
  return resolveFileDisplayDescriptor(name, { kind: kind === "directory" ? "directory" : "file" })
    .fileIconSrc;
}

/** 列表里的时间只给到分钟，完整时间放 title，避免一列被年份撑宽。 */
export function formatSpaceWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
