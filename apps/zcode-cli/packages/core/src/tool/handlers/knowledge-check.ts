/**
 * KnowledgeCheck —— 知识板块执行期只读工具（standards / terminology / rules）。
 *
 * ## 为什么读本地缓存，而不是自己去请求服务端
 *
 * 企业令牌只存在于桌面主进程的凭据存储里，Agent 进程既拿不到也不该拿到。端侧缓存由
 * 主仓的同步服务（`packages/services/src/knowledge`）写入用户数据目录，本工具只读文件 ——
 * 于是「审查要读知识库」与「令牌不进 Agent 进程」两件事同时成立，且离线可用、结论可复现。
 *
 * ## 标准引用比对为什么必须是确定性的
 *
 * 审查结论要可复现（同一文件 + 同一库 = 同一结论），语义检索做不到；而这件事的本质是
 * 字符串/规则匹配。**归一化是全部难点**：库数据里 `GB/T 12459-2017`、`GB/T8163-1999`、
 * `GB12238-89` 三种写法并存，文档里又常见全角标点、破折号变体、编号内空格、两位年号。
 * 下面 `parseNo` / `toHalf` 是这套口径的唯一实现，改动必须同步 `knowledge-check` 的回归用例。
 *
 * ## 两个必须守住的诚实边界（否则结论会误导人）
 *
 * ① **缓存缺失要说 stale，不能当作「未收录」**：库没同步下来时，任何引用都会判成"库里没有"，
 *    那是**假结论**。所以缓存读不到就 stale=true + notice，让调用方先同步再下结论。
 * ② **版本标注必须参与匹配**：文档写 `GB50016-2014（2018年版）` 引的其实是现行的 2018 年版，
 *    把尾注吃掉会误报「引用了已废止的 GB 50016-2014」——误报比漏报更快摧毁信任。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CoreErrorType,
  KnowledgeCheckInputJsonSchema,
  KnowledgeCheckInputSchema,
  KnowledgeCheckOutputJsonSchema,
  KnowledgeCheckOutputSchema,
  createCoreError,
  type KnowledgeCacheStamp,
  type KnowledgeCheckInput,
  type KnowledgeCheckOutput,
  type KnowledgeRuleItem,
  type KnowledgeStandardIssue,
} from "@zcode/contracts";
import { USER_DATA_DIR_NAME } from "@zcode/shared";

import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

/* ── 缓存位置：工具与主仓同步服务必须一致 ─────────────────────────── */

/** 缓存目录：`<用户数据目录>/knowledge`；`REACTOR_KNOWLEDGE_DIR` 可覆盖（测试/多环境用）。 */
export function resolveKnowledgeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["REACTOR_KNOWLEDGE_DIR"]?.trim();
  if (override) return override;
  return join(homedir(), USER_DATA_DIR_NAME, "knowledge");
}

/* ── 归一化：这套口径是自检的核心，见文件头注 ─────────────────────── */

/** 全角→半角、各种破折号→`-`、去所有空白、大写。 */
export function normalizeReferenceText(value: string): string {
  return value
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\u00A0]/g, "")
    .replace(/[∕／]/g, "/")
    .replace(/[\u2010-\u2015\u2212~〜～]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
}

export interface ParsedStandardNo {
  ident: string;
  num: string;
  year: string | null;
  /** 版本标注（`2018版` / `局部修订` / `英文版` / `勘误表`），参与匹配 */
  version: string;
}

/**
 * 拆 `(标识符, 数字, 年代号, 版本标注)`。
 *
 * 标识符表**由调用方传入**：库里出现过的前缀 ∪ 一份基础超集。抽取端必须用超集 ——
 * 只用库里的前缀会让「库里根本没有的行业标准」（DL/CECS 等）直接扫不出来，
 * 而它们恰恰是最该报「未收录」的一类。
 */
export function parseStandardNo(input: string, idents: readonly string[]): ParsedStandardNo | null {
  const compact = normalizeReferenceText(input);
  if (!compact) return null;
  const pattern = new RegExp(
    `^(${idents.map((s) => s.replace(/[/]/g, "\\/")).join("|")})[:\\-]?(\\d{1,5}(?:[./]\\d{1,4})*)(?:[-:](\\d{2,4}))?(.*)$`,
  );
  const match = pattern.exec(compact);
  if (!match) return null;
  let year = match[3] ?? null;
  if (year) {
    const numeric = Number(year);
    if (year.length === 2) year = String(numeric >= 50 ? 1900 + numeric : 2000 + numeric);
    // 4 位但不像年份的（源数据里有 `GB 1222-2323` 这类脏值）判为解析失败，不静默当成年份。
    else if (numeric < 1900 || numeric > 2100) return null;
  }
  const tail = match[4] ?? "";
  const versionMatch = /[(（]\s*(\d{4}\s*年?版|局部修订|修订版?|英文版|勘误表)\s*[)）]/.exec(tail);
  const version = versionMatch ? versionMatch[1]!.replace(/\s+/g, "").replace("年版", "版") : "";
  return { ident: match[1]!, num: match[2]!, year, version };
}

/** 家族：`GB` 与 `GB/T` 视为同一编号族，用于「编号存在但前缀不符」的提示。 */
export const identFamily = (ident: string): string => ident.replace(/\/T$/, "");

const KEY3 = (p: ParsedStandardNo): string => `${p.ident}|${p.num}|${p.year ?? "*"}`;
const KEY2 = (p: ParsedStandardNo): string => `${p.ident}|${p.num}`;
const KEY4 = (p: ParsedStandardNo): string => `${KEY3(p)}|${p.version}`;
const KEY_FAMILY = (p: ParsedStandardNo): string => `${identFamily(p.ident)}|${p.num}`;

/** 抽取端的基础超集：库里没有的行业标准也得能被扫出来（否则报不出「未收录」）。 */
const BASELINE_IDENTS = [
  "GB/T", "GB/Z", "GBZ/T", "GBZ", "GBJ", "GB",
  "DL/T", "DL", "NB/T", "NB", "EJ/T", "EJ", "HG/T", "HG", "CJ/T", "CJJ", "CECS",
  "SH/T", "SH", "SY/T", "SY", "SL", "JTS", "JGJ", "JG/T", "JB/T", "JB", "YS/T", "YS",
  "QC/T", "TB/T", "TB", "MT/T", "AQ", "TSG", "GA/T", "GA", "SN/T", "SN", "NY/T", "NY",
  "LS", "FZ/T", "QB/T", "YY", "SJ/T", "HJ", "DBJ", "Q/", "ISO", "IEC", "ASTM", "ASME",
  "ANSI", "EN", "DIN", "JIS", "JJF", "JJG", "HAD", "HAF", "HAB",
];

/* ── 缓存读写 ─────────────────────────────────────────────────────── */

interface CachedStandards {
  maxUpdatedAt?: string | null;
  fetchedAt?: string;
  items?: {
    standardNo?: string;
    standardName?: string;
    status?: string;
    ident?: string | null;
    publishDate?: string | null;
  }[];
}

interface CachedTerminology {
  maxUpdatedAt?: string | null;
  fetchedAt?: string;
  items?: { term?: string; category?: string; aliases?: string[] }[];
}

interface CachedRuleLibraries {
  fetchedAt?: string;
  libraries?: { id?: number; name?: string; status?: string }[];
  items?: Record<string, { maxUpdatedAt?: string | null; items?: KnowledgeRuleItem[] }>;
  cache?: Record<string, { maxUpdatedAt?: string | null; items?: KnowledgeRuleItem[] }>;
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // 缓存损坏（半截写入、手工改坏）当作「没有缓存」：抛错会让整个审查链路失败，
    // 而正确行为是让调用方 stale=true 后重新同步。
    return null;
  }
}

function toStamp(raw: { maxUpdatedAt?: string | null; fetchedAt?: string; items?: unknown[] } | null): KnowledgeCacheStamp | null {
  if (!raw) return null;
  return {
    maxUpdatedAt: raw.maxUpdatedAt ?? null,
    fetchedAt: raw.fetchedAt ?? "",
    count: Array.isArray(raw.items) ? raw.items.length : 0,
  };
}

/* ── 正文快照：供「点击问题 → 原文高亮」打开 ──────────────────────── */

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/**
 * 内联 `text` 的上限。超过它就要改用 `textFile`（大文档路径）：既绕开
 * 「一次塞几十万字符」的工具调用，也让偏移相对一个稳定存在的文件 ——
 * 手工切片会让偏移变成「合法但错的」，前端越界保护拦不住。
 */
export const MAX_INLINE_TEXT_CHARS = 400_000;

/** 把正文快照落盘（内容寻址，重复审查同一文本不重复写），返回绝对路径。 */
export function persistReviewText(text: string, dir: string): string | null {
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) return null;
  try {
    const target = join(dir, "review-text");
    mkdirSync(target, { recursive: true });
    const name = `${createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16)}.txt`;
    const path = join(target, name);
    if (!existsSync(path)) writeFileSync(path, text, "utf8");
    return path;
  } catch {
    return null;
  }
}

/* ── 缓存新鲜度 ─────────────────────────────────────────────────── */

/** 快照超过这个年龄就在 notice 里提醒（不判 stale：旧库仍然可用，只是结论边界要说明）。 */
const CACHE_AGE_NOTICE_HOURS = 24;

function cacheAgeNotice(stamp: KnowledgeCacheStamp | null, scope: string): string | null {
  const fetchedAt = stamp?.fetchedAt;
  if (!fetchedAt) return null;
  const parsed = Date.parse(fetchedAt);
  if (Number.isNaN(parsed)) return null;
  const ageHours = (Date.now() - parsed) / 3_600_000;
  if (ageHours < CACHE_AGE_NOTICE_HOURS) return null;
  const days = Math.floor(ageHours / 24);
  return `${scope}快照取自 ${fetchedAt}（约 ${days} 天前），期间库可能有更新；若要按最新库下结论，请先在桌面端同步知识库。`;
}

/* ── standards：抽取引用 + 判定 ───────────────────────────────────── */

export interface StandardLibraryEntry {
  standardNo: string;
  standardName: string;
  status: "current" | "upcoming" | "abolished" | "unknown";
  ident: string | null;
  publishDate: string | null;
}

/** 某标准体系（ident 族）在库里的条目数，用于「库缺口 vs 疑似笔误」的分流。 */
export type FamilyCoverage = ReadonlyMap<string, number>;

/**
 * 统计库里每个 ident 族的条目数。`GB` 与 `GB/T` 归一族（`identFamily`），
 * 语义是「库里有没有这个体系的标准」，不是「有没有这个前缀」。
 */
export function buildFamilyCoverage(library: readonly StandardLibraryEntry[]): FamilyCoverage {
  const coverage = new Map<string, number>();
  for (const entry of library) {
    const parsed = parseStandardNo(entry.standardNo, BASELINE_IDENTS);
    if (!parsed) continue;
    const family = identFamily(parsed.ident);
    coverage.set(family, (coverage.get(family) ?? 0) + 1);
  }
  return coverage;
}

/** 族覆盖低于这个数就认为「该体系未被库覆盖」：判不出结论比判错更诚实。 */
const FAMILY_COVERAGE_FLOOR = 2;

interface Judgment {
  code: KnowledgeStandardIssue["code"];
  severity: KnowledgeStandardIssue["severity"];
  libraryNo: string | null;
  libraryName: string | null;
  libraryStatus: KnowledgeStandardIssue["libraryStatus"];
  suggestion: string | null;
  message: string;
}

/**
 * 判定一条引用。导出是为了让单测直接钉住口径（version 标注、家族不符、未注年代号）。
 *
 * `coverage` 是库里各 ident 族的条目数（`buildFamilyCoverage`）。缺省按「无法判断覆盖」
 * 处理，走保守的 `missing` 分支 —— 老调用方（单测）不传也不会静默得到乐观结论。
 */
export function judgeReference(
  parsed: ParsedStandardNo,
  library: StandardLibraryEntry[],
  coverage?: FamilyCoverage,
): Judgment {
  /** 索引里同时带上库侧的**版本标注**：判定「引用了哪一版」必须看它（见文件头注 ②）。 */
  interface Indexed {
    entry: StandardLibraryEntry;
    version: string;
  }
  const byKey3 = new Map<string, Indexed[]>();
  const byKey2 = new Map<string, Indexed[]>();
  const byFamily = new Map<string, Indexed[]>();
  // 每次调用重建索引：一次审查最多几百条引用，重建几次也远低于一次网络往返的成本。
  for (const entry of library) {
    const parsedEntry = parseStandardNo(entry.standardNo, BASELINE_IDENTS);
    if (!parsedEntry) continue;
    const indexed: Indexed = { entry, version: parsedEntry.version };
    for (const [map, key] of [
      [byKey3, KEY3(parsedEntry)],
      [byKey2, KEY2(parsedEntry)],
      [byFamily, KEY_FAMILY(parsedEntry)],
    ] as const) {
      const list = map.get(key);
      if (list) list.push(indexed);
      else map.set(key, [indexed]);
    }
  }

  const statusCn: Record<StandardLibraryEntry["status"], string> = {
    current: "现行",
    upcoming: "即将实施",
    abolished: "已废止",
    unknown: "状态未标注",
  };
  const currentOf = (list: Indexed[]): Indexed | undefined =>
    list.find((item) => item.entry.status === "current") ??
    list.find((item) => item.entry.status === "upcoming");

  /**
   * 「库中查不到」的两种真相必须分开，否则报告信噪比崩塌：
   *  - 该体系在库里几乎没收录（NB/CECS/DL/EJ…）→ 判「无法核对」（info），
   *    并要求人工确认 —— 这**不是**笔误，把它写成笔误会让人去改正确的编号；
   *  - 体系覆盖充分却查不到 → 更可能是编号/年代号笔误（warning），需人工确认。
   */
  const notFound = (): Judgment => {
    // 注意区分两种「拿不到覆盖度」：整个覆盖度统计没传（老调用方）→ 保守判 missing；
    // 传了但该族在表里没有 → 库里就是 0 条，正是库缺口。
    if (coverage === undefined) {
      return {
        code: "missing",
        severity: "warning",
        libraryNo: null,
        libraryName: null,
        libraryStatus: null,
        suggestion: null,
        message:
          "标准库中无此编号：可能库待补充，也可能是编号笔误，需人工确认" +
          "（本次未提供库覆盖度统计，无法进一步区分）",
      };
    }
    const family = identFamily(parsed.ident);
    const familyCount = coverage.get(family) ?? 0;
    if (familyCount < FAMILY_COVERAGE_FLOOR) {
      return {
        code: "family_not_collected",
        severity: "info",
        libraryNo: null,
        libraryName: null,
        libraryStatus: null,
        suggestion: null,
        message: `库中未收录 ${family} 体系的标准（共 ${familyCount} 条），无法核对；需人工确认，不能据此判定该标准不存在`,
      };
    }
    return {
      code: "missing",
      severity: "warning",
      libraryNo: null,
      libraryName: null,
      libraryStatus: null,
      suggestion: null,
      message: `标准库中无此编号（同体系已收录 ${familyCount} 条）：疑似编号或年代号笔误，需人工确认`,
    };
  };

  if (parsed.year) {
    const hits = byKey3.get(KEY3(parsed)) ?? [];
    if (hits.length > 0) {
      const exact = parsed.version ? hits.filter((item) => item.version === parsed.version) : [];
      // 文档没写版本标注、而库恰恰靠标注区分「已废止的原版」与「现行版」时，直接判通过会放过
      // 一类真实缺陷（设计文件里很常见：漏写「（2018年版）」）。所以这里单独报 no_version。
      const versioned = hits.filter((item) => item.version !== "");
      if (!parsed.version && exact.length === 0 && versioned.length > 0) {
        const current = currentOf(hits);
        return {
          code: "no_version",
          severity: "warning",
          libraryNo: current?.entry.standardNo ?? hits[0]!.entry.standardNo,
          libraryName: (current ?? hits[0]!).entry.standardName,
          libraryStatus: (current ?? hits[0]!).entry.status,
          suggestion: current?.entry.standardNo ?? null,
          message: `引用未写版本标注，而库中同一年代号分多个版本：${hits
            .map((item) => `${item.entry.standardNo}[${statusCn[item.entry.status]}]`)
            .join("、")}${current ? `；应写明版本（如 ${current.entry.standardNo}）` : ""}`,
        };
      }
      const chosen = exact[0] ?? currentOf(hits) ?? hits[0]!;
      if (chosen.entry.status === "current" || chosen.entry.status === "upcoming") {
        return {
          code: chosen.entry.status === "upcoming" ? "upcoming" : "ok",
          severity: chosen.entry.status === "upcoming" ? "info" : "none",
          libraryNo: chosen.entry.standardNo,
          libraryName: chosen.entry.standardName,
          libraryStatus: chosen.entry.status,
          suggestion: null,
          message:
            chosen.entry.status === "upcoming"
              ? `${statusCn.upcoming}（${chosen.entry.standardName}）：实施日期未到，引用需确认`
              : `现行（${chosen.entry.standardName}）`,
        };
      }
      const siblings = [
        ...(byKey2.get(KEY2(parsed)) ?? []),
        ...(byFamily.get(KEY_FAMILY(parsed)) ?? []),
      ];
      const sibling = currentOf(siblings);
      return {
        code: "abolished",
        severity: "error",
        libraryNo: chosen.entry.standardNo,
        libraryName: chosen.entry.standardName,
        libraryStatus: chosen.entry.status,
        suggestion: sibling ? `${sibling.entry.standardNo}（${sibling.entry.standardName}）` : null,
        message: `${statusCn[chosen.entry.status]}（${chosen.entry.standardName}）${
          sibling
            ? `；库中现行版本：${sibling.entry.standardNo}`
            : "；库中无同编号的现行版本，需核对引用来源"
        }`,
      };
    }
    const sameNum = byKey2.get(KEY2(parsed)) ?? [];
    if (sameNum.length > 0) {
      return {
        code: "not_in_library",
        severity: "error",
        libraryNo: null,
        libraryName: null,
        libraryStatus: null,
        suggestion: currentOf(sameNum)?.entry.standardNo ?? null,
        message: `该编号的 ${parsed.year} 版库中不存在；库中有：${sameNum
          .map((item) => `${item.entry.standardNo}[${statusCn[item.entry.status]}]`)
          .join("、")}`,
      };
    }
    const family = byFamily.get(KEY_FAMILY(parsed)) ?? [];
    if (family.length > 0) {
      return {
        code: "not_in_library",
        severity: "error",
        libraryNo: null,
        libraryName: null,
        libraryStatus: null,
        suggestion: currentOf(family)?.entry.standardNo ?? null,
        message: `编号前缀与库中记录不符（文档写 ${parsed.ident}）；库中有：${family
          .map((item) => `${item.entry.standardNo}[${statusCn[item.entry.status]}]`)
          .join("、")}`,
      };
    }
    return notFound();
  }

  // 未注年代号：引用规范要求注明年号，且无法判定引用的是哪一版。
  // 同编号的「同前缀」与「同编号族」必须**合并**看：库数据里 `GB12238-89`（前缀 GB）与
  // `GB/T 12238-2008`（前缀 GB/T）并存，只取同前缀会看不见现行版（实测踩过）。
  const sameNum = byKey2.get(KEY2(parsed)) ?? [];
  const merged = [...sameNum];
  for (const item of byFamily.get(KEY_FAMILY(parsed)) ?? []) {
    if (!merged.some((existing) => existing.entry.standardNo === item.entry.standardNo)) {
      merged.push(item);
    }
  }
  if (merged.length > 0) {
    const current = currentOf(merged);
    const missingSlashT = merged.some((item) =>
      item.entry.standardNo.startsWith(`${identFamily(parsed.ident)}/T`),
    );
    return {
      code: "no_year",
      severity: "warning",
      libraryNo: current?.entry.standardNo ?? merged[0]!.entry.standardNo,
      libraryName: (current ?? merged[0]!).entry.standardName,
      libraryStatus: (current ?? merged[0]!).entry.status,
      suggestion: current?.entry.standardNo ?? null,
      message: `引用未注年代号，库中同编号有 ${merged.length} 个条目${
        current ? `，现行为 ${current.entry.standardNo}` : "，且无现行版本"
      }${missingSlashT ? "；该标准为推荐性，文档写法缺 /T" : ""}`,
    };
  }
  return notFound();
}

/** 在正文里抽取标准引用（带字符偏移与行号）。 */
export function extractReferences(
  text: string,
  idents: readonly string[],
): { parsed: ParsedStandardNo; quoted: string; startOffset: number; endOffset: number; line: number }[] {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9])(${idents
      .map((s) => s.replace(/[/]/g, "\\/"))
      .join("|")})[\\s\\u00A0\\u3000]*(\\d{1,5}(?:\\.\\d{1,4})*)[\\s\\u00A0\\u3000]*(?:[:：\\-—–~〜～/][\\s\\u00A0\\u3000]*(\\d{2,4})(?!\\d))?((?:[(（][^)）]{0,20}[)）])*)`,
    "g",
  );
  const out: { parsed: ParsedStandardNo; quoted: string; startOffset: number; endOffset: number; line: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const parsed = parseStandardNo(match[0], idents);
    if (!parsed) continue;
    // `Q235-B` 这类材料牌号不是企业标准编号：家族为 Q 且没有 `/` 的一律不算引用。
    if (identFamily(parsed.ident) === "Q" && !parsed.ident.includes("/")) continue;
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    const line = text.slice(0, startOffset).split("\n").length;
    out.push({ parsed, quoted: match[0].replace(/\s+/g, " ").trim(), startOffset, endOffset, line });
  }
  return out;
}

/* ── 工具实现 ─────────────────────────────────────────────────────── */

function readStandards(dir: string): { library: StandardLibraryEntry[]; stamp: KnowledgeCacheStamp | null } {
  const raw = readJson<CachedStandards>(join(dir, "standards.json"));
  const library: StandardLibraryEntry[] = [];
  for (const item of raw?.items ?? []) {
    const standardNo = String(item.standardNo ?? "").trim();
    if (!standardNo) continue;
    const status = String(item.status ?? "unknown");
    library.push({
      standardNo,
      standardName: String(item.standardName ?? ""),
      status:
        status === "current" || status === "upcoming" || status === "abolished" ? status : "unknown",
      ident: item.ident ?? null,
      publishDate: item.publishDate ?? null,
    });
  }
  return {
    library,
    stamp: toStamp(raw ? { ...raw, items: raw.items ?? [] } : null),
  };
}

const knowledgeCheckHandler: ToolHandler = async (input, context: ToolExecutionContext) => {
  const parsedInput = KnowledgeCheckInputSchema.parse(input) as KnowledgeCheckInput;
  const { action, sourcePath, candidates, libraryId, limit } = parsedInput;
  const cacheDir = resolveKnowledgeDir();
  const notices: string[] = [];
  const notice = (message: string): KnowledgeCheckOutput => ({
    action,
    stale: true,
    cacheDir,
    stamp: null,
    issues: [],
    textPath: null,
    summary: null,
    coverage: null,
    whitelisted: [],
    remaining: [],
    items: [],
    notice: message,
  });
  void context;

  if (action === "standards") {
    const inlineText = parsedInput.text;
    const textFile = parsedInput.textFile?.trim();
    if (!inlineText && !textFile) {
      throw createCoreError(
        CoreErrorType.InvalidInput,
        "action=standards 需要 text（短正文）或 textFile（已提取纯文本文件的绝对路径，长文档用）",
        { context: { action } },
      );
    }
    if (inlineText && inlineText.length > MAX_INLINE_TEXT_CHARS) {
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `正文过长（${inlineText.length} 字符，上限 ${MAX_INLINE_TEXT_CHARS}）：请先用 Write 把提取出的纯文本落成文件，再改用 textFile 传入；不要手工切片，切片会让字符偏移失去全文基准。`,
        { context: { action, length: inlineText.length } },
      );
    }
    let text = inlineText ?? "";
    let textPath: string | null = null;
    if (textFile) {
      try {
        text = readFileSync(textFile, "utf8");
      } catch (error) {
        throw createCoreError(
          CoreErrorType.InvalidInput,
          `textFile 读取失败（${textFile}）：${error instanceof Error ? error.message : String(error)}`,
          { context: { action, textFile } },
        );
      }
      // 大文档直接用源文件做高亮目标，不复制快照（review-text 目录不该堆全文副本）。
      textPath = textFile;
    }
    const { library, stamp } = readStandards(cacheDir);
    if (library.length === 0) {
      return notice(
        `标准库缓存为空或不可读（${join(cacheDir, "standards.json")}）：请先在桌面端登录企业服务端并打开审查模式完成知识库同步，再执行自检。`,
      );
    }
    const ageNotice = cacheAgeNotice(stamp, "标准库");
    if (ageNotice) notices.push(ageNotice);
    // 抽取端用「库中出现过的前缀 ∪ 基础超集」：既能扫出库里的写法，也能扫出库里没有的行业标准。
    const libIdents = new Set<string>();
    for (const entry of library) {
      const parsed = parseStandardNo(entry.standardNo, BASELINE_IDENTS);
      if (parsed) libIdents.add(parsed.ident);
    }
    const idents = [...new Set([...BASELINE_IDENTS, ...libIdents])].sort((a, b) => b.length - a.length);

    const matches = extractReferences(text, idents);
    const coverage = buildFamilyCoverage(library);
    const issues: KnowledgeStandardIssue[] = matches.map((match) => {
      const judgment = judgeReference(match.parsed, library, coverage);
      return {
        code: judgment.code,
        severity: judgment.severity,
        quoted: match.quoted,
        normalized: `${match.parsed.ident} ${match.parsed.num}${match.parsed.year ? `-${match.parsed.year}` : ""}`,
        line: match.line,
        startOffset: match.startOffset,
        endOffset: match.endOffset,
        libraryNo: judgment.libraryNo,
        libraryName: judgment.libraryName,
        libraryStatus: judgment.libraryStatus,
        suggestion: judgment.suggestion,
        message: judgment.message,
      };
    });
    const count = (code: KnowledgeStandardIssue["code"]): number =>
      issues.filter((issue) => issue.code === code).length;
    if (sourcePath) {
      notices.push(sourcePath === textFile ? `正文来源：${sourcePath}（textFile 模式）` : `正文来源：${sourcePath}`);
    }
    return {
      action,
      stale: false,
      cacheDir,
      stamp,
      issues,
      textPath: textPath ?? persistReviewText(text, cacheDir),
      summary: {
        total: issues.length,
        ok: count("ok"),
        abolished: count("abolished"),
        noYear: count("no_year"),
        noVersion: count("no_version"),
        notInLibrary: count("not_in_library"),
        familyNotCollected: count("family_not_collected"),
        missing: count("missing"),
        upcoming: count("upcoming"),
      },
      coverage: {
        citedFamilies: [...new Set(matches.map((match) => identFamily(match.parsed.ident)))].sort(),
        uncoveredFamilies: [
          ...new Set(
            matches
              .map((match) => identFamily(match.parsed.ident))
              .filter((family) => (coverage.get(family) ?? 0) < FAMILY_COVERAGE_FLOOR),
          ),
        ].sort(),
      },
      whitelisted: [],
      remaining: [],
      items: [],
      notice: notices.length > 0 ? notices.join("；") : null,
    } satisfies KnowledgeCheckOutput;
  }

  if (action === "terminology") {
    const raw = readJson<CachedTerminology>(join(cacheDir, "terminology.json"));
    const listed = candidates ?? [];
    if (!raw) {
      return notice(
        `术语白名单缓存不可读（${join(cacheDir, "terminology.json")}）：请先同步知识库；未同步时**不要**丢弃任何候选词。`,
      );
    }
    // 白名单语义：term 与 aliases 一起进 Set，命中即丢弃（防专业词误报），逐个大小写不敏感比对。
    const whitelist = new Set<string>();
    for (const item of raw.items ?? []) {
      if (item.term) whitelist.add(item.term.trim().toLowerCase());
      for (const alias of item.aliases ?? []) {
        if (alias) whitelist.add(String(alias).trim().toLowerCase());
      }
    }
    const whitelisted: string[] = [];
    const remaining: string[] = [];
    for (const candidate of listed) {
      const key = candidate.trim().toLowerCase();
      // 候选是**句子片段**时不能整串比对：只要片段里出现白名单词，就认为该候选被白名单覆盖，
      // 这正是校对场景的用法（「安全壳的」应因「安全壳」被忽略）。
      const hit = whitelist.has(key) || [...whitelist].some((term) => term.length > 0 && key.includes(term));
      (hit ? whitelisted : remaining).push(candidate);
    }
    // 命中率过低说明白名单的覆盖域与本文档不匹配（如白名单是核安全域、文档是消防/给排水域）。
    // 这时大批候选项会留在 remaining，若不说明，用户会把「白名单没覆盖」当成「文档有问题」。
    const coverageWarning =
      listed.length >= 10 && remaining.length / listed.length > 0.95
        ? `术语白名单对本文档几乎无覆盖（${whitelisted.length}/${listed.length} 命中）：remaining 里的候选词很可能不是错别字，而是白名单未覆盖的专业词，不要据此报错。`
        : null;
    const terminologyAgeNotice = cacheAgeNotice(
      toStamp(raw ? { ...raw, items: raw.items ?? [] } : null),
      "术语白名单",
    );
    const terminologyNotice = [coverageWarning, terminologyAgeNotice].filter(Boolean).join("；");
    return {
      action,
      stale: false,
      cacheDir,
      stamp: toStamp(raw ? { ...raw, items: raw.items ?? [] } : null),
      issues: [],
      textPath: null,
      summary: null,
      coverage: null,
      whitelisted,
      remaining,
      items: [],
      notice: terminologyNotice.length > 0 ? terminologyNotice : null,
    } satisfies KnowledgeCheckOutput;
  }

  // action === "rules"
  const raw = readJson<CachedRuleLibraries>(join(cacheDir, "rule-libraries.json"));
  const buckets = raw?.items ?? raw?.cache ?? {};
  if (!raw) {
    return notice(
      `规范库缓存不可读（${join(cacheDir, "rule-libraries.json")}）：请先同步知识库；未同步时没有可核对的条文。`,
    );
  }
  const max = limit ?? 100;
  const items: KnowledgeRuleItem[] = [];
  const wanted = libraryId ? [String(libraryId)] : Object.keys(buckets);
  for (const key of wanted) {
    for (const item of buckets[key]?.items ?? []) {
      if (items.length >= max) break;
      items.push(item);
    }
    if (items.length >= max) break;
  }
  const libraries = raw.libraries ?? [];
  // stale 只表示「端侧缓存不可用」（缺失/读取失败）。服务端本来就没有已发布库、
  // 或库为空/全停用，都是**合法状态**，同步多少次都不会变：这时必须给非 stale 的
  // 结构化结果，否则调用方会以为要去修缓存，还会拿到「先同步知识库」这种无效指引。
  const rulesNotice =
    libraries.length === 0
      ? "当前没有已发布的规范库（该能力未启用）：没有可逐条核对的条文，不要在结论里声称核对过规范库。"
      : items.length === 0
        ? "已发布的规范库里暂无可用条目（库为空，或全部条目被停用）。"
        : `已发布库：${libraries.map((lib) => `${lib.name}(#${lib.id})`).join("、")}`;
  const rulesAgeNotice = cacheAgeNotice(
    { maxUpdatedAt: null, fetchedAt: raw.fetchedAt ?? "", count: 0 },
    "规范库",
  );
  return {
    action,
    stale: false,
    cacheDir,
    stamp: null,
    issues: [],
    textPath: null,
    summary: null,
    coverage: null,
    whitelisted: [],
    remaining: [],
    items,
    notice: [rulesNotice, rulesAgeNotice].filter((item) => item !== null).join("；"),
  } satisfies KnowledgeCheckOutput;
};

const KNOWLEDGE_CHECK_DESCRIPTION = [
  "查询端侧缓存的知识板块数据（文件审查的依据）：",
  "action=standards 做**标准引用自检**（零 LLM 的确定性比对，判「已废止 / 未注年代号 / 编号不存在 / 未收录」，并给出库中现行版本与问题在正文中的字符偏移）；",
  "action=terminology 把疑似错词候选拿到术语白名单里过滤（命中的应丢弃，避免把专业词报成错别字）；",
  "action=rules 取规范库的条文/审点条目（逐条核对用）。",
  "数据来自端侧缓存（桌面端同步写入），不联网、结论可复现；缓存缺失时返回 stale=true，此时不要下结论，先提示用户同步知识库。",
].join("\n");

export const knowledgeCheckToolEntry: ToolEntry = {
  capability:
    "Look up the local knowledge cache (standards / terminology whitelist / rule libraries) to check standard references and filter review candidates deterministically",
  metadata: {
    name: "KnowledgeCheck",
    description: KNOWLEDGE_CHECK_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 20000,
    maxOutputBytes: 512 * 1024,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: knowledgeCheckHandler,
  inputSchema: KnowledgeCheckInputJsonSchema,
  outputSchema: KnowledgeCheckOutputJsonSchema,
  runtimeInputSchema: KnowledgeCheckInputSchema,
  runtimeOutputSchema: KnowledgeCheckOutputSchema,
  formatModelContent: (output: unknown): string => {
    const result = output as KnowledgeCheckOutput;
    if (result.stale) return `知识库缓存不可用：${result.notice ?? "请先同步知识库"}`;
    if (result.action === "standards") {
      const summary = result.summary;
      const problems = result.issues.filter((issue) => issue.severity !== "none");
      const lines = [
        `标准引用自检：共 ${summary?.total ?? 0} 条引用 — 通过 ${summary?.ok ?? 0}，已废止 ${summary?.abolished ?? 0}，未注年代号 ${summary?.noYear ?? 0}，未写版本标注 ${summary?.noVersion ?? 0}，编号不存在 ${summary?.notInLibrary ?? 0}，库未覆盖该体系 ${summary?.familyNotCollected ?? 0}，疑似笔误 ${summary?.missing ?? 0}，即将实施 ${summary?.upcoming ?? 0}`,
      ];
      for (const issue of problems.slice(0, 80)) {
        lines.push(
          `- [${issue.code}] 第${issue.line}行 「${issue.quoted}」 ${issue.message}${issue.suggestion ? ` → 建议改引 ${issue.suggestion}` : ""}`,
        );
      }
      if (problems.length > 80) lines.push(`…另有 ${problems.length - 80} 条问题（详见结构化结果）`);
      const textPath = result.textPath ? `\n正文快照：${result.textPath}` : "";
      return lines.join("\n") + textPath;
    }
    if (result.action === "terminology") {
      return [
        `术语白名单过滤：${result.whitelisted.length} 条命中（应丢弃）、${result.remaining.length} 条需继续判断`,
        result.whitelisted.length > 0 ? `命中：${result.whitelisted.join("、")}` : "",
        result.remaining.length > 0 ? `剩余：${result.remaining.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    return [
      `规范库条目 ${result.items.length} 条${result.notice ? `（${result.notice}）` : ""}`,
      ...result.items
        .slice(0, 40)
        .map(
          (item) =>
            `- [${item.libraryName}] ${item.ruleCode ?? ""} ${item.ruleName ?? ""}（${item.mandatory === "mandatory" ? "强制" : "推荐"}｜${item.severity}）${
              item.clauseText ? `\n  条文：${item.clauseText.slice(0, 300)}` : ""
            }`,
        ),
    ].join("\n");
  },
  permission: {
    permission: "read",
    reason: "KnowledgeCheck 只读端侧知识缓存，无外部副作用",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: 64 * 1024,
    maxModelBytes: 256 * 1024,
    strategy: "artifact",
    preview: { maxBytes: 8 * 1024, direction: "head" },
    artifact: { enabled: true, retention: "session" },
  },
  timeout: { defaultMs: 20000, maxMs: 60000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "KnowledgeCheck was cancelled before it returned results",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
