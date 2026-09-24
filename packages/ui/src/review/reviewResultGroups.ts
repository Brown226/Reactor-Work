/**
 * 一轮对话里审查结果的聚合（纯函数，便于单测）。
 *
 * 为什么有这一层：审查结论过去跟着工具调用行逐条渲染 —— 有几次工具调用就几张卡，有几千条
 * 问题就几千个条块。产品要的是「一轮一个面板」：把本轮所有审查类结果收进一张面板，按
 * 「来源文件 → 规则码」两级分组给计数（`docs/审查板块-方案-v1.md` §3.2）。
 *
 * 数据只来自已投影的 `display` 载荷（经 `toolCallRowToLegacyNode` 取 raw 后由
 * `readKnowledgeResult` 读取），不额外请求、不读文件、不猜内容。识别不出结果的工具行直接跳过，
 * 交给它自己的渲染器 —— 这里不做兜底拼装。
 */
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import {
  actionableIssues,
  readKnowledgeResult,
  type ReviewIssueSeverity,
  type ReviewIssueView,
} from "@/ToolCallBlocks/knowledgeCheckResult.js";

/** 问题条来自哪类审查工具：决定它有没有「通过」条数与来源文件。 */
export type ReviewIssueOrigin = "standards" | "issues";

/** 规则码 → i18n 标签 key。codes 是接口契约，显式映射，不靠拼字符串。 */
export const REVIEW_ISSUE_LABEL_KEYS: Record<string, string> = {
  abolished: "review.issue.abolished",
  no_year: "review.issue.noYear",
  no_version: "review.issue.noVersion",
  not_in_library: "review.issue.notInLibrary",
  family_not_collected: "review.issue.familyNotCollected",
  missing: "review.issue.missing",
  upcoming: "review.issue.upcoming",
  ok: "review.issue.ok",
};

export interface ReviewResultItem {
  /** 同一轮内稳定 key（面板列表用） */
  key: string;
  origin: ReviewIssueOrigin;
  code: string;
  severity: ReviewIssueSeverity;
  quoted: string;
  message: string;
  suggestion: string | null;
  line: number;
  startOffset: number;
  endOffset: number;
  occurrences: number;
  matchedOccurrence: number;
  located: boolean;
  /** 提取正文快照：定位目标（缺它则本条不可点） */
  textPath: string | null;
  /** 原始文件：打开原件用 */
  sourcePath: string | null;
}

export interface ReviewResultTotals {
  total: number;
  error: number;
  warning: number;
  info: number;
  unlocated: number;
}

/**
 * 规则码归族：`PUNCT-001` / `PUNCT-004` 同属 `PUNCT`，`no_version` 自成一族。
 *
 * 为什么按族分组而不是按整码：模型给的规则码粒度很细（实测一轮 27 条问题摊出 20+ 个不同码），
 * 按整码分组会得到一堆「只有一条的组标题」，比不分组的平铺还难读。族级分组既保住「同类批量处理」
 * 这个用途，又不会把面板变成标题墙；具体码仍在每行右侧原样显示。
 */
export function reviewIssueCodeFamily(code: string): string {
  const dash = code.indexOf("-");
  return dash > 0 ? code.slice(0, dash) : code;
}

/** 同一来源（文件）下按规则码「族」分组的问题条。 */
export interface ReviewResultCodeGroup {
  key: string;
  /** 族名（`PUNCT` / `abolished`），用于分组标题 */
  family: string;
  items: ReviewResultItem[];
  totals: ReviewResultTotals;
}

/** 一个来源文件（没有来源的审查合并进同一节）。 */
export interface ReviewResultSection {
  key: string;
  sourcePath: string | null;
  textPath: string | null;
  codeGroups: ReviewResultCodeGroup[];
  totals: ReviewResultTotals;
}

export interface ReviewTerminologyCard {
  key: string;
  stale: boolean;
  notice: string | null;
  whitelisted: string[];
  remaining: string[];
}

export interface ReviewResultGathering {
  hasContent: boolean;
  sections: ReviewResultSection[];
  terminology: ReviewTerminologyCard[];
  totals: ReviewResultTotals;
  /** 标准自检里的「通过」条数：不进问题列表，但要在面板里交代检查过的量 */
  passed: number;
  stale: boolean;
  notices: string[];
  /** 面板打开原件/正文所用的快照路径（按来源优先取原件） */
  textPaths: string[];
}

const SEVERITY_RANK: Record<ReviewIssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  none: 3,
};

const SOURCE_LESS_KEY = "__source_less__";

function emptyTotals(): ReviewResultTotals {
  return { total: 0, error: 0, warning: 0, info: 0, unlocated: 0 };
}

function addToTotals(totals: ReviewResultTotals, item: ReviewResultItem): void {
  totals.total += 1;
  if (item.severity === "error") totals.error += 1;
  else if (item.severity === "warning") totals.warning += 1;
  else if (item.severity === "info") totals.info += 1;
  if (!item.located) totals.unlocated += 1;
}

function toItem(
  issue: ReviewIssueView,
  origin: ReviewIssueOrigin,
  textPath: string | null,
  sourcePath: string | null,
): ReviewResultItem {
  return {
    key: `${origin}:${textPath ?? ""}:${issue.startOffset}:${issue.code}:${issue.quoted}`,
    origin,
    code: issue.code,
    severity: issue.severity,
    quoted: issue.quoted,
    message: issue.message,
    suggestion: issue.suggestion,
    line: issue.line,
    startOffset: issue.startOffset,
    endOffset: issue.endOffset,
    occurrences: issue.occurrences,
    matchedOccurrence: issue.matchedOccurrence,
    located: issue.located,
    textPath,
    sourcePath,
  };
}

/** 小节内排序：先严重度，再按行号/偏移（无行号的排最后）。 */
function compareItems(left: ReviewResultItem, right: ReviewResultItem): number {
  const rank = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (rank !== 0) return rank;
  const leftLine = left.line > 0 ? left.line : Number.MAX_SAFE_INTEGER;
  const rightLine = right.line > 0 ? right.line : Number.MAX_SAFE_INTEGER;
  return leftLine - rightLine || left.startOffset - right.startOffset;
}

function compareCodeGroups(left: ReviewResultCodeGroup, right: ReviewResultCodeGroup): number {
  const leftRank = SEVERITY_RANK[left.items[0]?.severity ?? "none"];
  const rightRank = SEVERITY_RANK[right.items[0]?.severity ?? "none"];
  return (
    leftRank - rightRank ||
    right.totals.total - left.totals.total ||
    left.family.localeCompare(right.family)
  );
}

/**
 * 把一轮的 assistant 工作行聚合成审查结果面板的数据。
 *
 * 分组口径：**来源文件 → 规则码**。同一来源的多条工具结果合并（同一份文件被自检 + 自述型
 * 审查各扫一遍时不该出现两张卡）；没有来源标注的结果（标准自检只落正文快照）汇入无来源节。
 */
export function collectReviewResults(rows: readonly AssistantWorkRow[]): ReviewResultGathering {
  const sections = new Map<string, ReviewResultSection>();
  const terminology: ReviewTerminologyCard[] = [];
  const notices: string[] = [];
  const textPaths: string[] = [];
  const totals = emptyTotals();
  let passed = 0;
  let stale = false;

  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    const result = readKnowledgeResult(toolCallRowToLegacyNode(row).toolCall.raw);
    if (!result) continue;

    if (result.kind === "terminology") {
      if (result.stale) stale = true;
      if (result.notice && !notices.includes(result.notice)) notices.push(result.notice);
      terminology.push({
        key: String(row.rowId),
        stale: result.stale,
        notice: result.notice,
        whitelisted: result.whitelisted,
        remaining: result.remaining,
      });
      continue;
    }

    const textPath = result.textPath;
    const sourcePath = result.kind === "issues" ? result.sourcePath : null;
    if (result.stale) stale = true;
    if (result.notice && !notices.includes(result.notice)) notices.push(result.notice);
    if (textPath && !textPaths.includes(textPath)) textPaths.push(textPath);
    if (result.kind === "standards" && result.summary) passed += result.summary.ok;

    const sectionKey = sourcePath ?? SOURCE_LESS_KEY;
    let section = sections.get(sectionKey);
    if (!section) {
      section = {
        key: sectionKey,
        sourcePath,
        textPath,
        codeGroups: [],
        totals: emptyTotals(),
      };
      sections.set(sectionKey, section);
    }
    // 同一节里后到的快照只在缺省时补：同一份文件的多条结果必须指向同一份正文才对得上偏移。
    section.textPath ??= textPath;

    for (const issue of actionableIssues(result.issues)) {
      const item = toItem(issue, result.kind === "standards" ? "standards" : "issues", textPath, sourcePath);
      const family = reviewIssueCodeFamily(issue.code);
      let group = section.codeGroups.find((candidate) => candidate.family === family);
      if (!group) {
        group = { key: `${sectionKey}:${family}`, family, items: [], totals: emptyTotals() };
        section.codeGroups.push(group);
      }
      group.items.push(item);
      addToTotals(group.totals, item);
      addToTotals(section.totals, item);
      addToTotals(totals, item);
    }
  }

  const sectionList = [...sections.values()].filter((section) => section.codeGroups.length > 0);
  for (const section of sectionList) section.codeGroups.sort(compareCodeGroups);
  for (const section of sectionList) {
    for (const group of section.codeGroups) group.items.sort(compareItems);
  }
  // 文件节按问题数降序：问题最多的文件排最前，用户先看要点。
  sectionList.sort((left, right) => right.totals.total - left.totals.total);

  return {
    hasContent: sectionList.length > 0 || terminology.length > 0,
    sections: sectionList,
    terminology,
    totals,
    passed,
    stale,
    notices,
    textPaths,
  };
}

/** 面板上一节是否需要显示文件标题：只有一个无来源节时不需要。 */
export function shouldShowSectionTitles(sections: readonly ReviewResultSection[]): boolean {
  return sections.length > 1 || sections.some((section) => section.sourcePath !== null);
}
