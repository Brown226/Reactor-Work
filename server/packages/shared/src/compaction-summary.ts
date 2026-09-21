/**
 * 压缩摘要解析（清单 #33b）—— 移植 pi-web `lib/compaction-summary.ts`（MIT）。
 *
 * pi 的压缩摘要尾部带元数据分节：
 *   <read-files>…</read-files>
 *   <modified-files>…</modified-files>
 * 把这些分节从正文中剥离并解析为文件列表，正文才适合直接展示；
 * 早期实现把整个原始摘要（含 XML 分节标记）当纯文本塞进分隔条。
 */

export interface ParsedCompactionSummary {
  body: string;
  readFiles: string[];
  modifiedFiles: string[];
}

const FILE_SECTION_RE = /<(read-files|modified-files)>\s*([\s\S]*?)\s*<\/\1>/g;
const TRAILING_FILE_SECTIONS_RE = /(?:\r?\n){2,}((?:[ \t]*<(?:read-files|modified-files)>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*<\/(?:read-files|modified-files)>[ \t]*(?:\r?\n)?)+)\s*$/;

export function parseCompactionSummary(summary: string): ParsedCompactionSummary {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const metadataMatch = summary.match(TRAILING_FILE_SECTIONS_RE);
  const metadataBlock = metadataMatch?.[1] ?? "";
  const body = metadataMatch?.index === undefined ? summary : summary.slice(0, metadataMatch.index);

  metadataBlock.replace(FILE_SECTION_RE, (_match: string, section: string, content: string) => {
    const files = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (section === "read-files") readFiles.push(...files);
    else modifiedFiles.push(...files);

    return "";
  });

  return {
    body: body.trim(),
    readFiles,
    modifiedFiles,
  };
}
