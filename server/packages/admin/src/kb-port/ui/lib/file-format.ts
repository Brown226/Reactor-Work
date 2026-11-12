/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/lib/file-format.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
/**
 * Utilities for deriving a normalized "file format key" from MIME type.
 *
 * The returned key is used by `FileFormatIcon` (e.g. `pdf`, `docx`, `xlsx`).
 */
const MIME_TO_FORMAT_KEY: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "docx",

  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",

  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",

  "application/pdf": "pdf",

  "text/plain": "txt",
  "text/markdown": "md",
  "text/md": "md",
  "text/rtf": "rtf",
  "application/rtf": "rtf",

  "text/html": "html",
  "application/xhtml+xml": "html",

  "application/json": "json",
  "text/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
};

const FORMAT_KEY_FALLBACK: Array<[RegExp, string]> = [
  [/wordprocessingml|msword/, "docx"],
  [/spreadsheetml/, "xlsx"],
  [/ms-excel/, "xls"],
  [/presentationml/, "pptx"],
  [/ms-powerpoint/, "ppt"],
  [/pdf/, "pdf"],
  [/markdown|^text\/md/, "md"],
  [/^text\/plain|txt$/, "txt"],
  [/csv/, "csv"],
  [/json/, "json"],
  [/xml/, "xml"],
  [/html|xhtml/, "html"],
  [/rtf/, "rtf"],
];

/**
 * Convert a MIME type into a `FileFormatIcon` key.
 *
 * @param mimeType - File MIME type (e.g. `application/pdf`).
 * @returns A normalized key like `pdf`, `docx`, `xlsx`; or empty string when unknown.
 */
export function getFileFormatKey(mimeType?: string): string {
  if (!mimeType) return "";

  const normalized = mimeType.toLowerCase().trim();
  const exact = MIME_TO_FORMAT_KEY[normalized];
  if (exact) return exact;

  for (const [rule, key] of FORMAT_KEY_FALLBACK) {
    if (rule.test(normalized)) return key;
  }

  return "";
}

