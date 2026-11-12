/**
 * 知识库文档解析（KB-⑥ 用户侧上传链路）——把上传的文件变成可检索的正文。
 *
 * ## 为什么解析放在服务端
 *
 * 上游的两段式是「前端 `uploadFilesAuto` 传文件拿 fileId → 再 `createDatasetsDocument` 建文档」，
 * 解析在上游服务端。本仓没有独立文件服务，上传直接落到 identity 的 `/v1/kb/*`：
 * **存原始文件 + 就地解析**，正文后续的切片/向量化与「贴文本入库」走**同一条路**
 * （`buildSegments`），两条入口不会长出两种检索口径。
 *
 * ## 解析器：复用 `@firecrawl/anydoc`
 *
 * sidecar 的 `read_office` 已经在用它（Rust + napi，MIT），且它带 `linux-x64-musl` 预编译
 * —— identity 容器（node:22-alpine）里**装得上也跑得动**，这是选它而不是 mammoth/pdf-parse
 * 拼一坨的 decision reason。支持 docx/doc/xlsx/xls/pptx/ppt/pdf 等；纯文本格式直接读，
 * 不劳烦 napi。
 *
 * ## 失败语义（与上游 UI 的「重试向量化」按钮对齐）
 *
 * 解析失败**不抛给上传方一个 500 完事**：文档照建、状态记 `failed` 并带上原因，
 * 用户在界面上看到的是「解析失败 + 重试」——这正是上游 `useRetryDocumentVectorization` 存在的意义。
 * 所以本模块只负责「尽力解析」，失败与否的落库由调用方处理。
 */

import { toMarkdownBytes } from "@firecrawl/anydoc";
import { readFileSync } from "node:fs";

/** 上传文件大小上限（与上游「单文件 ≤50MB」口径一致） */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 纯文本后缀：直接按 utf-8 读，不走 napi（快，且这些格式 anydoc 未必更好） */
const PLAIN_TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".yml", ".yaml", ".html", ".htm", ".xml"]);

export interface ParseResult {
  /** 解析出的正文（切片/向量化之前的原始文本） */
  text: string;
  /** 解析方式（落库便于排查「为什么这篇搜不到」） */
  parser: "anydoc" | "plain-text";
}

export class DocumentParseError extends Error {}

/** 任何doc 解不了的格式给一句人话（而不是让用户面对 napi 的英文堆栈） */
function unsupportedMessage(ext: string): string {
  return `暂不支持解析「${ext}」格式的文件（支持 pdf/office/纯文本），请转成 pdf 或 md 后重试`;
}

/**
 * 把上传的文件解析成正文。
 *
 * 统一走 `toMarkdownBytes`（`toDocument` 明确不支持 PDF，见 anydoc 类型注记；
 * 扫描件/纯图片 PDF 会报需要 OCR —— 本仓固定本地路径、永不送云端，见 sidecar read-office 同款红线）。
 *
 * @throws `DocumentParseError` —— 调用方应把文档标成 `parse_status=failed` 并记录本消息
 */
export async function parseUploadedFile(filePath: string, originalName: string): Promise<ParseResult> {
  const ext = (originalName.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();

  if (PLAIN_TEXT_EXTS.has(ext)) {
    const buf = readFileSync(filePath);
    return { text: buf.toString("utf-8"), parser: "plain-text" };
  }

  // 二进制格式交给 anydoc（docx/xlsx/pptx/pdf 及其余它认识的格式）
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    throw new DocumentParseError(`读取上传文件失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.length === 0) throw new DocumentParseError("上传文件为空");

  try {
    const text = await toMarkdownBytes(new Uint8Array(bytes));
    if (text.trim().length === 0) {
      throw new DocumentParseError("解析结果为空（可能是扫描件/纯图片 pdf——本仓未接 OCR）");
    }
    return { text, parser: "anydoc" };
  } catch (err) {
    if (err instanceof DocumentParseError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    // anydoc 对不认识的格式会抛「无法识别」一类——统一翻译成人话
    if (/unknown|unsupported|format|ocr|识别/i.test(msg)) {
      throw new DocumentParseError(
        /ocr/i.test(msg) ? "该文件需要 OCR（如扫描件/纯图片 PDF）——本仓固定本地解析、未接 OCR，请换文本版" : unsupportedMessage(ext || "(无后缀)"),
      );
    }
    throw new DocumentParseError(`解析失败：${msg}`);
  }
}

// ── URL 入库（「添加在线文档」）─────────────────────────────────────────────
// anydoc 的 Format 枚举没有 html ⇒ 网页用一个**保守的**标签剥离器（够提取正文，
// 不追求排版还原）；pdf 链接仍走 anydoc（按字节 + 格式）。

const MAX_URL_BYTES = 20 * 1024 * 1024;

/** 极简 html→文本：去 script/style、块级标签换行、剥其余标签、解常见实体 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|table|pre)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface UrlFetchResult {
  text: string;
  title: string | null;
  contentType: string;
}

/** 拉取 URL 并提取正文（超时 15s、上限 20MB；pdf 走 anydoc，html 走剥离器，纯文本直读） */
export async function fetchUrlText(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UrlFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DocumentParseError(`URL 非法：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DocumentParseError("仅支持 http/https 链接");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetchImpl(parsed.href, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    clearTimeout(timer);
    throw new DocumentParseError(`拉取失败：${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new DocumentParseError(`拉取失败：HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_URL_BYTES) throw new DocumentParseError("在线内容超过 20MB 上限");

  if (contentType.includes("pdf") || parsed.pathname.toLowerCase().endsWith(".pdf")) {
    const text = await toMarkdownBytes(new Uint8Array(buf), "pdf" as never).catch((err: unknown) => {
      throw new DocumentParseError(`PDF 解析失败：${err instanceof Error ? err.message : String(err)}`);
    });
    return { text, title: null, contentType };
  }
  if (contentType.includes("html")) {
    const html = buf.toString("utf-8");
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
    return { text: htmlToText(html), title, contentType };
  }
  return { text: buf.toString("utf-8"), title: null, contentType };
}
