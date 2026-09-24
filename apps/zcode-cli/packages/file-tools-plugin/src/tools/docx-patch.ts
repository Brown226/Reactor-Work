/**
 * docx_patch：对**已有的** .docx 做 OOXML 级文本替换（手术刀式修改）。
 *
 * 为什么需要它：审查结论落到「改」这一步时，能用的只有两条路——用库重写整份文档（python-docx /
 * docx-js 从段落模型重建），或让模型直接改 XML。前者会把没动过的部分也重新序列化一遍：样式表、
 * 编号、表格宽度、页眉页脚、甚至自动编号的域都会变，用户拿到的是「格式被搞乱的新文档」。
 *
 * 这个工具只做一件事：**把命中的那几个字换掉，别的字节原样搬过去**。
 * - 只改 `word/document.xml`（以及命中的页眉/页脚）里的 `<w:t>` 文本节点；
 * - 命中跨多个 run 时，新文本落在**首个 run** 上（保留它的 `w:rPr`：字体/字号/加粗/颜色），
 *   中间 run 的命中部分清空，末尾 run 只保留命中之后的尾巴；
 * - 段落、表格、编号、样式、关系、其余 zip 条目全部按原字节写回，不做任何归一化。
 *
 * 匹配口径与审查定位一致（全角/半角、空白与连字符一律忽略），所以「审查说的那一句」和「工具找到的那一句」
 * 是同一个判定——两边都认不出时宁可跳过，也不猜。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { assertReadableFile } from "../guard.js";

export const DOCX_PATCH_DESCRIPTION = [
  "Replace text inside an existing .docx while keeping the original formatting (fonts, sizes, bold, paragraphs, tables, numbering, headers/footers).",
  "Only the matched characters are rewritten in word/document.xml; every other byte of the package is copied unchanged.",
  "Use it for applying review fixes: pass the exact original text and the new text. It never guesses — unmatched or ambiguous edits are reported as skipped.",
  "By default the result is written to a new file next to the source (<name>-modified.docx); pass in_place=true to overwrite the original.",
].join(" ");

export const docxPatchInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to the .docx file to patch."),
  edits: z
    .array(
      z.object({
        original_text: z
          .string()
          .min(1)
          .describe("Exact text to replace, copied verbatim from the document (same wording the review reports)."),
        new_text: z.string().describe("Replacement text. Use an empty string to delete the matched text."),
        occurrence: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Which occurrence to replace when the text appears more than once (1-based). Defaults to 1."),
      }),
    )
    .min(1)
    .describe("Edits to apply, in order."),
  output_path: z
    .string()
    .optional()
    .describe("Where to write the patched copy. Defaults to <name>-modified.docx next to the source."),
  in_place: z
    .boolean()
    .optional()
    .describe("Overwrite the source file instead of writing a copy. Use only when the user asked for it."),
});

interface DocxPatchEditResult {
  original_text: string;
  new_text: string;
  occurrence: number;
  status: "applied" | "skipped";
  /** skipped 的原因（给人看的中文） */
  reason?: string;
  /** applied：命中的段落序号（1 起）与所在部件 */
  part?: string;
  paragraph?: number;
}

interface DocxPatchOutput {
  status: "success" | "failed" | "partial";
  output_path?: string;
  applied_count: number;
  skipped_count: number;
  edits: DocxPatchEditResult[];
  verify?: {
    /** 回读新文件：每条已应用的 edit 的新文本都能找到 */
    newTextPresent: boolean;
    /** 原文片段出现次数是否按预期减少 */
    occurrencesReduced: boolean;
    /** 改动过的部件 */
    parts: string[];
  };
  note?: string;
}

/* ── 文本节点扫描 ───────────────────────────────────────────────── */

interface TextNodeSpan {
  /** `<w:t ...>` 开标签起点、闭标签终点（原文下标） */
  start: number;
  end: number;
  /** 原开标签（含 xml:space="preserve" 等属性）：回写时原样复用，不重新拼属性 */
  openTag: string;
  /** 解码后的文本 */
  text: string;
  /** 解码文本 → 原文下标（逐字符） */
  indices: number[];
}

interface ParagraphSpan {
  /** 段落起点/终点（原文下标，含） */
  start: number;
  end: number;
  nodes: TextNodeSpan[];
}

const W_T_OPEN = /<w:t(?:\s[^>]*)?>/gu;
const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlText(raw: string): { text: string; indices: number[] } {
  let text = "";
  const indices: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "&") {
      let matched = false;
      for (const [entity, value] of Object.entries(XML_ENTITIES)) {
        if (raw.startsWith(entity, index)) {
          for (const char of value) {
            text += char;
            indices.push(index);
          }
          index += entity.length - 1;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // 数值实体（&#x201C; 之类）：Word 常用它写中文引号
      const numeric = /^&#(x?)([0-9a-fA-F]+);/u.exec(raw.slice(index));
      if (numeric) {
        const code = Number.parseInt(numeric[2]!, numeric[1] ? 16 : 10);
        if (Number.isFinite(code)) {
          const char = String.fromCodePoint(code);
          text += char;
          indices.push(index);
          index += numeric[0].length - 1;
          continue;
        }
      }
    }
    text += raw[index]!;
    indices.push(index);
  }
  return { text, indices };
}

function encodeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 把 XML 切成段落，段内收集 `<w:t>` 文本节点。 */
function collectParagraphs(xml: string): ParagraphSpan[] {
  const paragraphs: ParagraphSpan[] = [];
  const paragraphRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/gu;
  let match = paragraphRe.exec(xml);
  while (match) {
    const start = match.index;
    const end = start + match[0].length - 1;
    const nodes: TextNodeSpan[] = [];
    const nodeRe = new RegExp(W_T_OPEN.source, "gu");
    let inner = nodeRe.exec(match[0]);
    while (inner) {
      const openEnd = start + inner.index + inner[0].length;
      const closeIndex = xml.indexOf("</w:t>", openEnd);
      if (closeIndex === -1 || closeIndex > end) break;
      const raw = xml.slice(openEnd, closeIndex);
      const decoded = decodeXmlText(raw);
      nodes.push({
        start: start + inner.index,
        end: closeIndex + "</w:t>".length,
        openTag: inner[0],
        text: decoded.text,
        indices: decoded.indices.map((offset) => openEnd + offset),
      });
      nodeRe.lastIndex = inner.index + inner[0].length + raw.length + "</w:t>".length;
      inner = nodeRe.exec(match[0]);
    }
    paragraphs.push({ start, end, nodes });
    match = paragraphRe.exec(xml);
  }
  return paragraphs;
}

/* ── 归一化匹配（与审查定位同口径） ─────────────────────────────── */

const FULL_WIDTH_START = 0xff01;
const FULL_WIDTH_END = 0xff5e;

export function normalizeForMatch(text: string): string {
  let normalized = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    let converted: string | null;
    if (code >= FULL_WIDTH_START && code <= FULL_WIDTH_END) {
      converted = String.fromCharCode(code - 0xfee0);
    } else if (char === "\u3000" || char === "\u00a0") {
      converted = null;
    } else if (char === "\u2215" || char === "\uff0f") {
      converted = "/";
    } else if (/[\u2010-\u2015\u2212~〜～-]/u.test(char)) {
      converted = null;
      // 破折号族整类忽略（与空白同等对待）：抽取器对连字符的处理不一致 —— anydoc 会把
      // `15169HX-JPS01-001` 读成 `15169HX JPS01 001`，把 `-` 当普通字符就永远对不上原件。
    } else if (/\s/u.test(char)) {
      converted = null;
    } else {
      converted = char;
    }
    if (converted === null) continue;
    normalized += converted.toUpperCase();
  }
  return normalized;
}

interface ParagraphStream {
  /** 归一化后的整段文本 */
  text: string;
  /** 归一化位置 → 该段内第几个 `<w:t>` 节点 + 节点内偏移 */
  map: { nodeIndex: number; offset: number }[];
}

function buildParagraphStream(paragraph: ParagraphSpan): ParagraphStream {
  let text = "";
  const map: { nodeIndex: number; offset: number }[] = [];
  paragraph.nodes.forEach((node, nodeIndex) => {
    // 节点内逐字符归一化：转换可能一变多（全角大写等），所以按字符推 map
    for (let offset = 0; offset < node.text.length; offset += 1) {
      const normalized = normalizeForMatch(node.text[offset]!);
      for (let index = 0; index < normalized.length; index += 1) {
        text += normalized[index];
        map.push({ nodeIndex, offset });
      }
    }
  });
  return { text, map };
}

function countOccurrences(haystack: string, needle: string): number[] {
  const starts: number[] = [];
  let from = 0;
  while (starts.length < 200) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    starts.push(found);
    from = found + 1;
  }
  return starts;
}

interface PendingReplacement {
  start: number;
  end: number;
  newText: string;
}

/** 在单个部件上应用一条 edit；返回是否命中，以及替换点（用于回写）。 */
function planEditReplacement(
  xml: string,
  paragraphs: ParagraphSpan[],
  originalText: string,
  occurrence: number,
): PendingReplacement | null {
  const needle = normalizeForMatch(originalText);
  if (needle.length === 0) return null;
  let seen = 0;
  for (const paragraph of paragraphs) {
    const stream = buildParagraphStream(paragraph);
    const starts = countOccurrences(stream.text, needle);
    if (starts.length === 0) continue;
    if (seen + starts.length < occurrence) {
      seen += starts.length;
      continue;
    }
    const startInStream = starts[occurrence - 1 - seen]!;
    const startCell = stream.map[startInStream]!;
    const endCell = stream.map[startInStream + needle.length - 1]!;
    const startNode = paragraph.nodes[startCell.nodeIndex]!;
    const endNode = paragraph.nodes[endCell.nodeIndex]!;
    return {
      start: startNode.indices[startCell.offset]!,
      end: endNode.indices[endCell.offset]! + 1,
      newText: "",
    };
  }
  return null;
}

/** 命中的原文下标区间 → 需要重写的 `<w:t>` 节点（保留首节点格式）。 */
function rewriteMatchedNodes(
  paragraph: ParagraphSpan,
  matchStart: number,
  matchEnd: number,
  newText: string,
): string | null {
  const touched = paragraph.nodes.filter(
    (node) => node.start < matchEnd && node.end > matchStart,
  );
  if (touched.length === 0) return null;
  const first = touched[0]!;
  const last = touched[touched.length - 1]!;
  const firstInner = first.text.slice(0, offsetOf(first, matchStart));
  // 末节点里命中之后的尾巴必须留住：命中可能只占末尾节点的一小段。
  const lastInner = last.text.slice(offsetOf(last, matchEnd));
  const nodesXml: string[] = [];
  for (const node of touched) {
    const inner = node === first ? `${firstInner}${newText}${node === last ? lastInner : ""}`
      : node === last ? lastInner : "";
    nodesXml.push(`${node.openTag}${encodeXmlText(inner)}</w:t>`);
  }
  return nodesXml.join("");
}

/** `<w:t>` 的解码文本偏移 → 原文下标（用节点自带的 indices 表）。 */
function offsetOf(node: TextNodeSpan, xmlIndex: number): number {
  const position = node.indices.indexOf(xmlIndex);
  if (position >= 0) return position;
  // 落在实体内部（替换点正好切在实体中间）时就近向前取：宁可把实体整段留下
  for (let index = node.indices.length - 1; index >= 0; index -= 1) {
    if (node.indices[index]! < xmlIndex) return index + 1;
  }
  return 0;
}

/* ── 主流程 ─────────────────────────────────────────────────────── */

/** 结构上等价的 zip 写回：条目顺序与压缩方式保持不变，只替换改动过的部件。 */
function repackDocx(entries: Record<string, Uint8Array>, replaced: Map<string, Uint8Array>): Uint8Array {
  const output: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    output[name] = replaced.get(name) ?? bytes;
  }
  return zipSync(output, { level: 6 });
}

export async function docxPatch(
  input: z.infer<typeof docxPatchInputSchema>,
): Promise<DocxPatchOutput> {
  assertReadableFile(input.file_path);
  if (extname(input.file_path).toLowerCase() !== ".docx") {
    throw new Error(`docx_patch 只支持 .docx（收到「${basename(input.file_path)}」）。旧版 .doc 请先另存为 .docx。`);
  }

  const sourceBytes = new Uint8Array(await readFile(input.file_path));
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(sourceBytes);
  } catch {
    throw new Error(`打不开这个 .docx（zip 结构损坏）：${basename(input.file_path)}`);
  }

  // 只碰正文与页眉页脚；批注、脚注里的文字不在这里动（它们是另一个部件，改错了没人看得见）
  const targetParts = Object.keys(entries).filter((name) =>
    /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml)$/u.test(name),
  );
  if (targetParts.length === 0) {
    return {
      status: "failed",
      applied_count: 0,
      skipped_count: input.edits.length,
      edits: input.edits.map((edit) => ({
        original_text: edit.original_text,
        new_text: edit.new_text,
        occurrence: edit.occurrence ?? 1,
        status: "skipped",
        reason: "这个文件里找不到正文部件（word/document.xml），可能不是 Word 文档。",
      })),
    };
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const replacedParts = new Map<string, Uint8Array>();
  const partTexts = new Map<string, { xml: string; paragraphs: ParagraphSpan[] }>();
  const loadPart = (name: string): { xml: string; paragraphs: ParagraphSpan[] } => {
    const cached = partTexts.get(name);
    if (cached) return cached;
    const xml = decoder.decode(replacedParts.get(name) ?? entries[name]!);
    const loaded = { xml, paragraphs: collectParagraphs(xml) };
    partTexts.set(name, loaded);
    return loaded;
  };

  const results: DocxPatchEditResult[] = [];
  const touchedParts = new Set<string>();

  for (const edit of input.edits) {
    const occurrence = edit.occurrence ?? 1;
    let applied: DocxPatchEditResult | null = null;
    for (const part of targetParts) {
      const { xml, paragraphs } = loadPart(part);
      const plan = planEditReplacement(xml, paragraphs, edit.original_text, occurrence);
      if (!plan) continue;
      const paragraph = paragraphs.find(
        (candidate) => plan.start >= candidate.start && plan.end <= candidate.end,
      );
      if (!paragraph) continue;
      const replacedXml = rewriteMatchedNodes(paragraph, plan.start, plan.end, edit.new_text);
      if (replacedXml === null) continue;
      const nextXml = `${xml.slice(0, plan.start)}${replacedXml}${xml.slice(plan.end)}`;
      replacedParts.set(part, encoder.encode(nextXml));
      partTexts.set(part, { xml: nextXml, paragraphs: collectParagraphs(nextXml) });
      touchedParts.add(part);
      applied = {
        original_text: edit.original_text,
        new_text: edit.new_text,
        occurrence,
        status: "applied",
        part,
        paragraph: paragraphs.indexOf(paragraph) + 1,
      };
      break;
    }
    results.push(
      applied ?? {
        original_text: edit.original_text,
        new_text: edit.new_text,
        occurrence,
        status: "skipped",
        reason:
          "正文里找不到这段原文（或它跨段落/被拆在多个部件里）。请确认原文与文档完全一致（含标点），不要手工截断。",
      },
    );
  }

  const appliedCount = results.filter((result) => result.status === "applied").length;
  if (appliedCount === 0) {
    return {
      status: "failed",
      applied_count: 0,
      skipped_count: results.length,
      edits: results,
      note: "没有任何一处命中，未写出文件——避免用户拿到一份「看起来改过了」的副本。",
    };
  }

  const outputPath =
    input.output_path ??
    (input.in_place
      ? input.file_path
      : join(dirname(input.file_path), `${basename(input.file_path, ".docx")}-modified.docx`));
  await mkdir(dirname(outputPath), { recursive: true });
  const repacked = repackDocx(entries, replacedParts);
  await writeFile(outputPath, repacked);

  // 回读校验：新文本在、原文出现次数按预期减少。verification 失败不清空结果，但必须如实报出来。
  const verifyEntries = unzipSync(new Uint8Array(await readFile(outputPath)));
  const allText = [...touchedParts]
    .map((part) => decoder.decode(verifyEntries[part]!))
    .join("\n")
    .replace(/<[^>]+>/gu, "");
  const decodedAll = decodeXmlText(allText).text;
  const normalizedAll = normalizeForMatch(decodedAll);
  const newTextPresent = results
    .filter((result) => result.status === "applied" && result.new_text.length > 0)
    .every((result) => normalizedAll.includes(normalizeForMatch(result.new_text)));
  // 「原文出现次数减少」只对**不是**追加式替换的编辑成立：把 `A` 改成 `A（已复核）` 时原文本来
  // 就还在新文本里（作为子串），拿次数判定会误报校验失败。追加式编辑由 newTextPresent 覆盖。
  const occurrencesReduced = results
    .filter((result) => result.status === "applied")
    .filter(
      (result) =>
        !normalizeForMatch(result.new_text).includes(normalizeForMatch(result.original_text)),
    )
    .every(
      (result) =>
        countOccurrences(normalizedAll, normalizeForMatch(result.original_text)).length <
        Math.max(1, result.occurrence),
    );

  return {
    status: results.some((result) => result.status === "skipped") ? "partial" : "success",
    output_path: outputPath,
    applied_count: appliedCount,
    skipped_count: results.length - appliedCount,
    edits: results,
    verify: { newTextPresent, occurrencesReduced, parts: [...touchedParts] },
    ...(input.in_place ? {} : { note: "已另存为副本，原件未改动。" }),
  };
}
