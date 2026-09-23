/**
 * KnowledgeCheck 结果的读取与归一（纯函数，便于单测）。
 *
 * 为什么"容错读"而不是只读一个字段：工具结果在链路里会经过 CLI → Host → 渲染进程，
 * 不同工具家族落到 `raw` 的位置并不统一（`rawOutput` / `result` / `output` 都可能是承载者，
 * 且可能是 JSON 字符串或对象）。只认一条路径的渲染器会在真实链路上静默变成空卡片——
 * 那种缺陷在本机 mock 数据下测不出来，所以这里把所有已知承载者都扫一遍。
 */

export type ReviewIssueSeverity = "error" | "warning" | "info" | "none";

export interface ReviewIssueView {
  code: string;
  severity: ReviewIssueSeverity;
  quoted: string;
  normalized: string;
  line: number;
  startOffset: number;
  endOffset: number;
  libraryNo: string | null;
  libraryName: string | null;
  libraryStatus: string | null;
  suggestion: string | null;
  message: string;
}

export interface ReviewSummaryView {
  total: number;
  ok: number;
  abolished: number;
  noYear: number;
  noVersion: number;
  notInLibrary: number;
  missing: number;
  upcoming: number;
}

export interface ReviewResultView {
  kind: "standards";
  stale: boolean;
  textPath: string | null;
  notice: string | null;
  summary: ReviewSummaryView | null;
  issues: ReviewIssueView[];
}

export interface TerminologyResultView {
  kind: "terminology";
  stale: boolean;
  whitelisted: string[];
  remaining: string[];
  notice: string | null;
}

export type KnowledgeResultView = ReviewResultView | TerminologyResultView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把候选值归一成对象：字符串按 JSON 解析（失败即 null）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const KNOWN_CODES = new Set([
  "abolished",
  "no_year",
  "no_version",
  "not_in_library",
  "missing",
  "upcoming",
  "ok",
]);

const KNOWN_SEVERITIES = new Set<ReviewIssueSeverity>(["error", "warning", "info", "none"]);

function parseIssue(raw: unknown): ReviewIssueView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const code = readString(record["code"]);
  const quoted = readString(record["quoted"]);
  const message = readString(record["message"]);
  // 三个字段缺一个就无法展示/复核：宁可不显示这条，也不显示半条。
  if (!code || !quoted || !message) return null;
  const severity = readString(record["severity"]);
  return {
    code,
    severity:
      severity && KNOWN_SEVERITIES.has(severity as ReviewIssueSeverity)
        ? (severity as ReviewIssueSeverity)
        : "warning",
    quoted,
    normalized: readString(record["normalized"]) ?? "",
    line: readNumber(record["line"]) ?? 0,
    startOffset: readNumber(record["startOffset"]) ?? -1,
    endOffset: readNumber(record["endOffset"]) ?? -1,
    libraryNo: readString(record["libraryNo"]),
    libraryName: readString(record["libraryName"]),
    libraryStatus: readString(record["libraryStatus"]),
    suggestion: readString(record["suggestion"]),
    message,
  };
}

function parseSummary(raw: unknown): ReviewSummaryView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const number = (key: string): number => readNumber(record[key]) ?? 0;
  return {
    total: number("total"),
    ok: number("ok"),
    abolished: number("abolished"),
    noYear: number("noYear"),
    noVersion: number("noVersion"),
    notInLibrary: number("notInLibrary"),
    missing: number("missing"),
    upcoming: number("upcoming"),
  };
}

/**
 * 从工具调用原始载荷里取出 KnowledgeCheck 结果。
 * 认出即返回；`action` 不认识时返回 null（交给别的渲染器）。
 */
export function readKnowledgeResult(raw: unknown): KnowledgeResultView | null {
  const root = asRecord(raw);
  if (!root) return null;
  const direct = [
    root["rawOutput"],
    root["result"],
    root["output"],
    root["metadata"],
    root,
  ];
  // `raw.log` 那一层还可能套一层 `display`（与 ToolCallBlocks/toolResultDisplay.ts 同口径）：
  // 结构化结果有时挂在 `<承载者>.display` 上，不拍平就会漏认。
  const candidates = [...direct, ...direct.map((entry) => asRecord(entry)?.["display"])];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;
    const action = readString(record["action"]);
    const stale = record["stale"] === true;
    if (action === "standards" && Array.isArray(record["issues"])) {
      return {
        kind: "standards",
        stale,
        textPath: readString(record["textPath"]),
        notice: readString(record["notice"]),
        summary: parseSummary(record["summary"]),
        issues: record["issues"]
          .map(parseIssue)
          .filter((issue): issue is ReviewIssueView => issue !== null),
      };
    }
    if (action === "terminology" && Array.isArray(record["whitelisted"])) {
      return {
        kind: "terminology",
        stale,
        whitelisted: record["whitelisted"].map(String),
        remaining: Array.isArray(record["remaining"]) ? record["remaining"].map(String) : [],
        notice: readString(record["notice"]),
      };
    }
  }
  return null;
}

/** 需要人工看的问题条（`ok` 与 `none` 只在汇总里计数，不占卡片）。 */
export function actionableIssues(issues: readonly ReviewIssueView[]): ReviewIssueView[] {
  return issues.filter((issue) => issue.severity !== "none");
}

/** 问题类别的展示顺序：先硬错误，再需确认，最后提示。 */
export function compareIssues(left: ReviewIssueView, right: ReviewIssueView): number {
  const rank = (issue: ReviewIssueView): number => {
    if (issue.code === "abolished" || issue.code === "not_in_library") return 0;
    if (issue.code === "no_version" || issue.code === "no_year" || issue.code === "missing") return 1;
    return 2;
  };
  return rank(left) - rank(right) || left.startOffset - right.startOffset;
}

export function isKnownIssueCode(code: string): boolean {
  return KNOWN_CODES.has(code);
}
