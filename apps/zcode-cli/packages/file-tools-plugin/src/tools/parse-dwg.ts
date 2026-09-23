/**
 * parse_dwg 工具：DWG 图纸 → 图层 / 文本实体 / 尺寸标注 / 标准引用。
 *
 * 引擎：@mlightcad/libredwg-web（libredwg 编译的 wasm，GPL-3.0，随安装包分发并附源码获取声明）。
 *
 * Node 加载要点（spike 实证）：
 * - 包的 dist/ 是 Vite 浏览器构建，Node 分支里 createRequire 被 Vite 外置 stub 卡死，
 *   直接用 dist 会 TypeError。必须 import 包内 lib/libredwg.js（class 实现），
 *   它相对 import ../wasm/libredwg-web.js（原始 emscripten 胶水，自带 fs Node 分支）。
 * - 因此打包态资产布局保留 lib/ 与 wasm/ 的相对结构：
 *   <assets>/libredwg/lib/libredwg.js + <assets>/libredwg/wasm/libredwg-web.{js,wasm}。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertReadableFile, wrapFileContent } from "../guard.js";
import { resolveFileToolsAssets } from "../assets.js";

export const PARSE_DWG_DESCRIPTION = [
  "Parse a DWG drawing into structured data: layers, TEXT/MTEXT entities, DIMENSION annotations,",
  "and standard references (e.g. GB/T 14976-2012, 《...》（DL 5068-2014）) with the CAD entity handle they came from.",
  "Use it for drawing review, standard-reference self-check, and for getting the text of drawings the user attached.",
].join(" ");

export const parseDwgInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to a .dwg file."),
  max_text_entities: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .describe("Cap on returned text entities (default 5000, largest drawings are truncated with a note)."),
});

interface DwgTextEntity {
  text: string;
  layer: string;
  entityType: "TEXT" | "MTEXT";
  handle: string;
}

interface DwgDimension {
  text: string;
  layer: string;
  entityType: string;
  handle: string;
  measurement: string | null;
}

interface DwgStandardRef {
  standardNo: string;
  standardName: string;
  standardIdent: string;
  fullMatch: string;
  cadHandleId: string;
}

interface ParseDwgOutput {
  status: "success" | "failed";
  text: string;
  layers: string[];
  textEntities: DwgTextEntity[];
  dimensions: DwgDimension[];
  standardRefs: DwgStandardRef[];
  metadata: {
    version: string | null;
    layerCount: number;
    textCount: number;
    dimensionCount: number;
    entityCount: number;
  };
  note?: string;
}

// ── 标准引用正则（移植自原「核审通」前端 dwg-parser.ts，口径与后端保持一致） ──

const STANDARD_REF_PATTERN =
  /《.*?》\s*[(（]?\s*([A-Za-z/]+)\s?(\d+[-/.]?\d*([-/.:]\d+)*)[)）]?([(（].*[)）])?/g;
const CODE_ONLY_PATTERN =
  /[(（]?(GB|GB\/T|NB|NB\/T|HJ|DL|DL\/T|CECS|HAF|EJ|EJ\/T|JGJ|CJJ|JG|HG|SH|SY|YY|QB|SL|TB|JT|YB|DB|DBJ|QX|GBJ|TJ|BJG|GYJ)\s?(\d+[-/.]?\d*([-/.:]\d+)*)[)）]?([(（].*[)）」])?/g;

/** 从标准号中提取标识符（如 GB/T、NB/T、HAF）。 */
export function getStandardIdent(standardNo: string): string {
  if (!standardNo) return "";
  let ident = "";
  for (const char of standardNo) {
    if (char === "/") {
      ident += char;
      continue;
    }
    if (/[a-zA-Z]/.test(char)) ident += char.toUpperCase();
    else break;
  }
  return ident;
}

interface StandardRefInput {
  standardNo: string;
  standardName: string;
  standardIdent: string;
  fullMatch: string;
  cadHandleId: string;
}

/** 从文本数组提取标准引用；纯函数，独立单测。 */
export function extractStandardRefs(texts: string[]): StandardRefInput[] {
  const results: StandardRefInput[] = [];
  const seen = new Set<string>();
  // 《xxx》（GB/T 1-2011）与独立出现的 GB/T 1-2011 是同一条标准；
  // code-only 一遍按标准号去重，避免把书名号版的 standardName 覆盖成空。
  const seenStandardNos = new Set<string>();
  const allText = texts.join("\n");

  let match: RegExpExecArray | null;
  STANDARD_REF_PATTERN.lastIndex = 0;
  while ((match = STANDARD_REF_PATTERN.exec(allText)) !== null) {
    const fullMatch = match[0];
    if (seen.has(fullMatch)) continue;
    seen.add(fullMatch);
    const bookEnd = fullMatch.indexOf("》");
    let standardNo = "";
    let standardName = "";
    if (bookEnd >= 0) {
      const bookStart = fullMatch.indexOf("《");
      standardName = fullMatch.slice(bookStart + 1, bookEnd).trim();
      standardNo = fullMatch.slice(bookEnd + 1).trim();
    } else {
      standardNo = fullMatch.trim();
    }
    standardNo = standardNo.replace(/^[\s(（]+|[\s)）]+$/g, "");
    if (standardNo) {
      seenStandardNos.add(standardNo);
      results.push({
        standardNo,
        standardName,
        standardIdent: getStandardIdent(standardNo),
        fullMatch,
        cadHandleId: "",
      });
    }
  }

  CODE_ONLY_PATTERN.lastIndex = 0;
  while ((match = CODE_ONLY_PATTERN.exec(allText)) !== null) {
    const fullMatch = match[0];
    if (seen.has(fullMatch)) continue;
    seen.add(fullMatch);
    const standardNo = fullMatch.trim().replace(/^[\s(（]+|[\s)）]+$/g, "");
    if (standardNo && !seenStandardNos.has(standardNo)) {
      seenStandardNos.add(standardNo);
      results.push({
        standardNo,
        standardName: "",
        standardIdent: getStandardIdent(standardNo),
        fullMatch,
        cadHandleId: "",
      });
    }
  }
  return results;
}

// ── WASM 引擎加载 ──

interface LibreDgwLike {
  dwg_read_data(bytes: Uint8Array, fileType: number): unknown;
  dwg_get_version_type(data: unknown): unknown;
  dwg_get_codepage(data: unknown): number;
  dwg_free(data: unknown): void;
  convert(data: unknown): unknown;
}

let libreDwgPromise: Promise<LibreDgwLike> | null = null;

/** 解析 libredwg-web 的包根（dev）或资产根（packaged）下可用的 class 实现路径。 */
function resolveLibreDwgClassPath(): string {
  const assets = resolveFileToolsAssets();
  const candidates = [
    assets.libredwgDir ? join(assets.libredwgDir, "lib", "libredwg.js") : null,
    // dev：workspace node_modules 里的包（dist 是坏的 Vite 构建，只能取 lib/）。
    (() => {
      try {
        const entry = createRequire(import.meta.url).resolve("@mlightcad/libredwg-web");
        return join(dirname(dirname(entry)), "lib", "libredwg.js");
      } catch {
        return null;
      }
    })(),
  ];
  for (const candidate of candidates) {
    if (candidate && existsFile(candidate)) return candidate;
  }
  throw new Error(
    "未找到 libredwg 资产（libredwg/lib/libredwg.js）。file-tools 资产不完整，无法解析 DWG。",
  );
}

function existsFile(path: string): boolean {
  try {
    createRequire(import.meta.url).resolve(path);
    return true;
  } catch {
    return false;
  }
}

async function loadLibreDwg(): Promise<LibreDgwLike> {
  const classPath = resolveLibreDwgClassPath();
  const mod: any = await import(pathToFileURL(classPath).href);
  return (await LibreDwgCreate(mod.LibreDwg)) as LibreDgwLike;
}

async function LibreDwgCreate(LibreDwg: any): Promise<LibreDgwLike> {
  // LibreDwg.create() 不带参数时，emscripten 胶水按自身脚本目录解析 wasm；
  // 资产布局保留了 lib/、wasm/ 的相对关系，两种来源都成立。
  const wasm = await LibreDwg.create();
  return wasm as LibreDgwLike;
}

function getLibreDwg(): Promise<LibreDgwLike> {
  libreDwgPromise ??= loadLibreDwg();
  return libreDwgPromise;
}

function resetLibreDwgForTests(): void {
  libreDwgPromise = null;
}

const DWG_MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function parseDwg(input: z.infer<typeof parseDwgInputSchema>): Promise<ParseDwgOutput> {
  assertReadableFile(input.file_path);
  if (!input.file_path.toLowerCase().endsWith(".dwg")) {
    return {
      status: "failed",
      text: "",
      layers: [],
      textEntities: [],
      dimensions: [],
      standardRefs: [],
      metadata: { version: null, layerCount: 0, textCount: 0, dimensionCount: 0, entityCount: 0 },
      note: `不是 .dwg 文件：${input.file_path}`,
    };
  }
  const { statSync } = await import("node:fs");
  if (statSync(input.file_path).size > DWG_MAX_FILE_BYTES) {
    return {
      status: "failed",
      text: "",
      layers: [],
      textEntities: [],
      dimensions: [],
      standardRefs: [],
      metadata: { version: null, layerCount: 0, textCount: 0, dimensionCount: 0, entityCount: 0 },
      note: "DWG 文件超过 50MB 上限，跳过 WASM 解析以避免内存问题",
    };
  }

  const wasm = await getLibreDwg();
  const dataPtr = wasm.dwg_read_data(new Uint8Array(await readFile(input.file_path)), 0);
  if (!dataPtr) {
    return {
      status: "failed",
      text: "",
      layers: [],
      textEntities: [],
      dimensions: [],
      standardRefs: [],
      metadata: { version: null, layerCount: 0, textCount: 0, dimensionCount: 0, entityCount: 0 },
      note: "WASM 解析失败：DWG 版本不兼容或文件损坏",
    };
  }

  try {
    const version = wasm.dwg_get_version_type(dataPtr);
    const db = wasm.convert(dataPtr) as {
      tables?: { LAYER?: { entries?: Array<{ name?: string }> } };
      entities?: Array<Record<string, never>>;
    } | null;
    if (!db) {
      return failedOutput("WASM 解析失败：convert 返回空（可能 DWG 版本不兼容或文件损坏）");
    }

    const layers: string[] = (db.tables?.LAYER?.entries ?? []).map((layer) => String(layer.name ?? ""));
    const maxTexts = input.max_text_entities ?? 5000;
    const textEntities: DwgTextEntity[] = [];
    const dimensions: DwgDimension[] = [];
    const textContents: string[] = [];
    const allEntities: Array<Record<string, any>> = db.entities ?? [];
    let truncated = false;

    for (const entity of allEntities) {
      const layerName = String(entity.layer || "0");
      if (entity.type === "TEXT" || entity.type === "MTEXT") {
        const text = typeof entity.text === "string" ? entity.text : "";
        if (text.trim()) {
          if (textEntities.length < maxTexts) {
            textEntities.push({
              text,
              layer: layerName,
              entityType: entity.type,
              handle: String(entity.handle ?? ""),
            });
            textContents.push(text);
          } else {
            truncated = true;
          }
        }
      } else if (typeof entity.type === "string" && entity.type.startsWith("DIMENSION")) {
        const dimText = typeof entity.text === "string" ? entity.text : "";
        // "" / "<>" 表示用测量值；" " 表示抑制。
        if (dimText && dimText !== " " && dimText !== "<>") {
          dimensions.push({
            text: dimText,
            layer: layerName,
            entityType: entity.type,
            handle: String(entity.handle ?? ""),
            measurement: entity.userText != null ? String(entity.userText) : null,
          });
        } else if (dimText === "" || dimText === "<>") {
          dimensions.push({
            text: entity.measurement != null ? String(entity.measurement) : "",
            layer: layerName,
            entityType: entity.type,
            handle: String(entity.handle ?? ""),
            measurement: entity.measurement != null ? String(entity.measurement) : null,
          });
        }
      }
    }

    const refs = extractStandardRefs(textContents);
    const standardRefs: DwgStandardRef[] = refs.map((ref) => {
      const source = textEntities.find(
        (entity) => entity.text.includes(ref.standardNo) || entity.text.includes(ref.fullMatch),
      );
      return { ...ref, cadHandleId: source?.handle ?? "" };
    });

    return {
      status: "success",
      text: wrapFileContent(textContents.join("\n")),
      layers,
      textEntities,
      dimensions,
      standardRefs,
      metadata: {
        version: describeVersion(version),
        layerCount: layers.length,
        textCount: textEntities.length,
        dimensionCount: dimensions.length,
        entityCount: allEntities.length,
      },
      note: truncated ? `文本实体超过 ${maxTexts} 条上限，仅返回前 ${maxTexts} 条` : undefined,
    };
  } finally {
    try {
      wasm.dwg_free(dataPtr);
    } catch {
      /* ignore */
    }
  }
}

function describeVersion(version: unknown): string | null {
  if (version == null) return null;
  if (typeof version === "string") return version;
  if (typeof version === "number") return String(version);
  // dwg_get_version_type 在 class 里返回 dwgVersions 条目；可能是字符串或 { code, name }。
  const name = (version as { name?: unknown }).name;
  const code = (version as { code?: unknown }).code;
  if (typeof name === "string") return name;
  if (typeof code === "string" || typeof code === "number") return String(code);
  // dwgVersions 条目的其它形状：取第一个字符串字段兜底。
  for (const value of Object.values(version as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return String(version);
}

function failedOutput(note: string): ParseDwgOutput {
  return {
    status: "failed",
    text: "",
    layers: [],
    textEntities: [],
    dimensions: [],
    standardRefs: [],
    metadata: { version: null, layerCount: 0, textCount: 0, dimensionCount: 0, entityCount: 0 },
    note,
  };
}
