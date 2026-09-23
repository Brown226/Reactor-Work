/**
 * ReportReviewIssues —— 把模型自述型审查的问题定位到提取正文（见 contracts/tools/report-review-issues.ts 头注）。
 *
 * 定位策略（先准后宽，绝不猜）：
 *  ① **精确匹配**：`originalText` 在正文里按原样出现的位置。这是唯一算「确定」的结果。
 *  ② **归一化匹配**：全角/半角、空白、破折号差异会让人抄的片段与正文对不上（抄的时候被输入法改了），
 *     这时按归一化后的字符串找，再经字符映射还原回原文偏移。结果标记 `matchKind="normalized"`。
 *  ③ **找不到**：如实返回 `located: false` 与 `startOffset = -1`，前端不装成精确命中。
 *     硬凑一个偏移（比如模糊匹配按相似度取最近）会让复核者点到一个无关位置，比不能点更糟。
 *
 * 片段在同一份正文里出现多次时：调用方可用 `occurrence` 指定取第几次，不指定取第一处，
 * 两种情况都把 `occurrences` 一起返回 —— 前端据此提示「该片段出现 N 次」。
 */
import { existsSync, readFileSync } from "node:fs";

import {
  CoreErrorType,
  ReportReviewIssuesInputJsonSchema,
  ReportReviewIssuesInputSchema,
  ReportReviewIssuesOutputJsonSchema,
  ReportReviewIssuesOutputSchema,
  createCoreError,
  type ReportReviewIssuesInput,
  type ReportReviewIssuesOutput,
  type ReportedReviewIssue,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { MAX_INLINE_TEXT_CHARS, persistReviewText, resolveKnowledgeDir } from "./knowledge-check.js";

/** 单条片段最多扫出的出现次数（防病态输入把结果撑爆；超过就记 99+ 的语义上限）。 */
const MAX_OCCURRENCES = 200;

/** 一段正文里同一条片段最多扫多少处：只用于计数与「取第 N 处」，不需要无限扫。 */
const MAX_MATCH_SCAN = 500;

interface LocatedSpan {
  startOffset: number;
  endOffset: number;
  occurrences: number;
  matchedOccurrence: number;
}

/** 行号（1 起）：按 `\n` 计数，与 KnowledgeCheck 的口径一致（正文里的 `\r` 不影响行数）。 */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

/**
 * 归一化 + 偏移映射：返回归一化串与「归一化下标 → 原文下标」的表。
 *
 * 口径与 `normalizeReferenceText` 同源（全角→半角、空白剔除、破折号统一、大写），
 * 但这里必须留下映射 —— 标准号匹配只要判定真假，定位还要把位置还原回去。
 */
export function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  let normalized = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const raw = text[index]!;
    const code = raw.charCodeAt(0);
    let converted: string | null = null;
    if (code >= 0xff01 && code <= 0xff5e) {
      converted = String.fromCharCode(code - 0xfee0);
    } else if (raw === "\u3000" || raw === "\u00a0") {
      converted = null;
    } else if (raw === "\u2215" || raw === "\uFF0F") {
      converted = "/";
    } else if (/[\u2010-\u2015\u2212~〜～]/.test(raw)) {
      converted = "-";
    } else if (/\s/.test(raw)) {
      converted = null;
    } else {
      converted = raw;
    }
    if (converted === null) continue;
    for (const ch of converted.toUpperCase()) {
      normalized += ch;
      map.push(index);
    }
  }
  return { normalized, map };
}

/** 取片段在正文中的第 `occurrence` 次出现（1 起；越界或未指定时取第一处）。 */
function collectOccurrences(
  haystack: string,
  needle: string,
  occurrence: number | undefined,
): { starts: number[]; matched: number } | null {
  const starts: number[] = [];
  let from = 0;
  while (starts.length < MAX_MATCH_SCAN) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    starts.push(found);
    from = found + 1;
  }
  if (starts.length === 0) return null;
  const index =
    occurrence && occurrence > 0 && occurrence <= starts.length ? occurrence - 1 : 0;
  return { starts, matched: index };
}

/**
 * 定位一条原文片段。精确匹配优先；失败退到归一化匹配；都不中返回 null。
 *
 * 导出为纯函数：这里是「点击问题跳到哪」的唯一真相，必须能被单测钉住。
 */
export function locateOriginalText(
  text: string,
  originalText: string,
  occurrence?: number,
): LocatedSpan | null {
  const needle = originalText;
  if (needle.length === 0) return null;

  const exact = collectOccurrences(text, needle, occurrence);
  if (exact) {
    const startOffset = exact.starts[exact.matched]!;
    return {
      startOffset,
      endOffset: startOffset + needle.length,
      occurrences: exact.starts.length,
      matchedOccurrence: exact.matched + 1,
    };
  }

  const normalizedText = normalizeWithMap(text);
  const normalizedNeedle = normalizeWithMap(needle);
  if (normalizedNeedle.normalized.length === 0) return null;
  const normalized = collectOccurrences(
    normalizedText.normalized,
    normalizedNeedle.normalized,
    occurrence,
  );
  if (!normalized) return null;

  const startInNormalized = normalized.starts[normalized.matched]!;
  const startOffset = normalizedText.map[startInNormalized]!;
  const endInNormalized = startInNormalized + normalizedNeedle.normalized.length - 1;
  const endOffset = (normalizedText.map[endInNormalized] ?? startOffset) + 1;
  return {
    startOffset,
    endOffset,
    occurrences: normalized.starts.length,
    matchedOccurrence: normalized.matched + 1,
  };
}

/** 单个问题条 → 已定位（或明确未定位）的结果。 */
export function locateIssue(
  text: string,
  issue: ReportReviewIssuesInput["issues"][number],
): ReportedReviewIssue {
  const span = locateOriginalText(text, issue.originalText, issue.occurrence);
  const location = issue.location?.trim();
  const message = location ? `${issue.description}（${location}）` : issue.description;
  if (!span) {
    return {
      code: issue.ruleCode,
      severity: issue.severity,
      quoted: issue.originalText,
      line: 0,
      startOffset: -1,
      endOffset: -1,
      occurrences: 0,
      matchedOccurrence: 0,
      matchKind: "not_found",
      located: false,
      suggestion: issue.suggestion ?? null,
      message,
    };
  }
  const exact = text.slice(span.startOffset, span.endOffset) === issue.originalText;
  return {
    code: issue.ruleCode,
    severity: issue.severity,
    quoted: issue.originalText,
    line: lineAt(text, span.startOffset),
    startOffset: span.startOffset,
    endOffset: span.endOffset,
    occurrences: Math.min(span.occurrences, MAX_OCCURRENCES),
    matchedOccurrence: span.matchedOccurrence,
    matchKind: exact ? "exact" : "normalized",
    located: true,
    suggestion: issue.suggestion ?? null,
    message,
  };
}

/** 读取被审正文：优先 `textFile`（大文档），否则内联 `text`；两者都缺时报错而不是猜。 */
export function resolveReviewText(input: ReportReviewIssuesInput): {
  text: string;
  textPath: string | null;
} {
  const textFile = input.textFile?.trim();
  if (textFile) {
    if (!existsSync(textFile)) {
      throw createCoreError(
        CoreErrorType.InvalidInput,
        `textFile 不存在：${textFile}。请先用 parse_document 抽取正文并写成本地文本文件，再传它的绝对路径。`,
        { context: { textFile } },
      );
    }
    return { text: readFileSync(textFile, "utf8"), textPath: textFile };
  }

  const text = input.text ?? "";
  if (text.length === 0) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      "缺少被审正文：请传 text（短正文）或 textFile（已抽取的纯文本文件绝对路径）。",
      { context: {} },
    );
  }
  if (text.length > MAX_INLINE_TEXT_CHARS) {
    throw createCoreError(
      CoreErrorType.InvalidInput,
      `内联正文过长（${text.length} > ${MAX_INLINE_TEXT_CHARS} 字符）：请先落成文本文件再传 textFile，` +
        "手工切片会让字符偏移变成「合法但错的」，前端高亮会跳错位置。",
      { context: { length: text.length, limit: MAX_INLINE_TEXT_CHARS } },
    );
  }
  return { text, textPath: persistReviewText(text, resolveKnowledgeDir()) };
}

const reportReviewIssuesHandler: ToolHandler = async (input) => {
  const parsed = ReportReviewIssuesInputSchema.parse(input) as ReportReviewIssuesInput;
  const { text, textPath } = resolveReviewText(parsed);

  const issues = parsed.issues.map((issue) => locateIssue(text, issue));
  const unlocated = issues.filter((issue) => !issue.located).length;
  const summary = {
    total: issues.length,
    error: issues.filter((issue) => issue.severity === "error").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
    unlocated,
  };

  const notices: string[] = [];
  if (!textPath) {
    notices.push("正文快照未落盘（超过 2MB 上限）：问题条可读但无法点击定位。");
  } else if (unlocated > 0) {
    notices.push(
      `有 ${unlocated} 条问题在正文里找不到对应片段（原文可能被改写或跨页断开）：` +
        "报告这类问题时要写明「无法定位」，不要给出位置。",
    );
  }
  const normalizedCount = issues.filter((issue) => issue.matchKind === "normalized").length;
  if (normalizedCount > 0) {
    notices.push(
      `有 ${normalizedCount} 条是归一化后匹配到的（原文片段与正文存在全角/半角或空白差异），位置按最近似处给出。`,
    );
  }
  const ambiguous = issues.filter((issue) => issue.located && issue.occurrences > 1).length;
  if (ambiguous > 0) {
    notices.push(
      `有 ${ambiguous} 条片段在正文里出现多次，已按首次出现定位；同一片段对应多处问题时请用 occurrence 指定次序。`,
    );
  }

  const output: ReportReviewIssuesOutput = {
    action: "issues",
    stale: false,
    textPath,
    sourcePath: parsed.sourcePath?.trim() ?? null,
    issues,
    summary,
    notice: notices.length > 0 ? notices.join(" ") : null,
  };
  return ReportReviewIssuesOutputSchema.parse(output);
};

const REPORT_REVIEW_ISSUES_DESCRIPTION = [
  "把审查发现的问题清单**定位到提取正文**，产出可点击的审查结果卡片。",
  "",
  "用法（四个自述型审查技能统一走它，不要在回复里手写 JSON）：",
  "  1. 先用 parse_document（或 ocr_scan / parse_dwg）抽取正文；长文档把纯文本落成文件，走 textFile。",
  "  2. 每条问题给 severity / ruleCode / originalText（**一字不改的原文片段**）/ description / suggestion。",
  "  3. 同一片段在正文出现多次时用 occurrence 指定第几次；不确定就让它取第一处并在回复里说明。",
  "",
  "工具只做定位：判定「这算不算问题」是调用方的职责。片段在正文里找不到时返回 located=false，",
  "定位不到的问题条必须如实说明「无法定位」，不要编造行号或偏移。",
].join("\n");

export const reportReviewIssuesToolEntry: ToolEntry = {
  capability:
    "Anchor model-reported review issues to character offsets in the extracted document text so the UI can jump to and highlight each finding",
  metadata: {
    name: "ReportReviewIssues",
    description: REPORT_REVIEW_ISSUES_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 20000,
    maxOutputBytes: 512 * 1024,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: reportReviewIssuesHandler,
  inputSchema: ReportReviewIssuesInputJsonSchema,
  outputSchema: ReportReviewIssuesOutputJsonSchema,
  runtimeInputSchema: ReportReviewIssuesInputSchema,
  runtimeOutputSchema: ReportReviewIssuesOutputSchema,
  // 只读、无网络、无外部副作用：与 KnowledgeCheck 同档（不弹确认、可并发）。
  permission: {
    permission: "read",
    reason: "ReportReviewIssues 只在已提取的正文里做定位，不写工作区、不联网",
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
    userVisibleMessage: "ReportReviewIssues was cancelled before it returned results",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
  formatModelContent: (output: unknown): string => {
    const result = output as ReportReviewIssuesOutput;
    const lines = [
      `审查问题清单：共 ${result.summary.total} 条 — error ${result.summary.error}，warning ${result.summary.warning}，info ${result.summary.info}` +
        (result.summary.unlocated > 0 ? `，其中 ${result.summary.unlocated} 条无法定位` : ""),
    ];
    for (const issue of result.issues.slice(0, 80)) {
      const position = issue.located
        ? `第${issue.line}行${issue.occurrences > 1 ? `（第 ${issue.matchedOccurrence}/${issue.occurrences} 处）` : ""}`
        : "**无法定位**";
      lines.push(
        `- [${issue.severity}] ${issue.code} ${position} 「${issue.quoted}」 ${issue.message}` +
          `${issue.suggestion ? ` → ${issue.suggestion}` : ""}`,
      );
    }
    if (result.issues.length > 80) {
      lines.push(`…另有 ${result.issues.length - 80} 条（详见结构化结果）`);
    }
    if (result.notice) lines.push(`注意：${result.notice}`);
    if (result.textPath) lines.push(`正文快照：${result.textPath}`);
    return lines.join("\n");
  },
};
