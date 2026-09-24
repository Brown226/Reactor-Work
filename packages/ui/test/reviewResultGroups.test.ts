/**
 * 审查结果聚合的回归（`npx tsx --test packages/ui/test/reviewResultGroups.test.ts`）。
 *
 * 聚合决定「面板里到底显示哪些条、分成几组、计数对不对」—— 它是面板唯一的数据来源，
 * 一旦口径飘了，用户看到的是「结论少了 3 条」这种无法自查的错误。所以钉住三件事：
 * 一轮多个工具结果合成一个面板、按来源文件与规则码分组、`ok`/`none` 不进问题列表但进通过计数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { collectReviewResults } from "../src/review/reviewResultGroups.js";
import type { AssistantWorkRow } from "../src/v4/conversationTurnFlowItems.js";

/**
 * 造一条 v4 工具行。结果载荷走 `output.text`（JSON 串）或 `output.display`——这正是真实
 * 投影里承载结构化结果的两条路（见 `v4/toolCallRowAdapter.ts` 的 raw 构造）。
 */
function toolRow(rowId: number, toolName: string, payload: unknown): AssistantWorkRow {
  return {
    kind: "toolCall",
    rowId,
    toolName,
    toolCallId: `call-${rowId}`,
    status: "success",
    inputText: "",
    output: { text: JSON.stringify(payload) },
  } as unknown as AssistantWorkRow;
}

const STANDARDS_RESULT = {
  action: "standards",
  stale: false,
  textPath: "/tmp/review-text/a.md",
  notice: null,
  summary: { total: 3, ok: 1, abolished: 1, noYear: 0, noVersion: 1, notInLibrary: 0, familyNotCollected: 0, missing: 0, upcoming: 0 },
  issues: [
    { code: "abolished", severity: "error", quoted: "GB 12238", message: "已废止", startOffset: 10, endOffset: 18, line: 2 },
    { code: "ok", severity: "none", quoted: "GB/T 8163-2018", message: "通过", startOffset: 0, endOffset: 14, line: 2 },
    { code: "no_version", severity: "warning", quoted: "GB/T8163", message: "未写版本标注", startOffset: 30, endOffset: 38, line: 3 },
  ],
};

const ISSUES_RESULT = {
  action: "issues",
  stale: false,
  sourcePath: "E:/docs/说明书.docx",
  textPath: "/tmp/review-text/b.md",
  notice: null,
  summary: { total: 2, error: 0, warning: 1, info: 0, unlocated: 1 },
  issues: [
    { code: "TYPO-001", severity: "warning", quoted: "安装调试", message: "错别字", suggestion: "安装调试", startOffset: 5, endOffset: 9, line: 7, occurrences: 2, matchedOccurrence: 2, located: true },
    { code: "TYPO-001", severity: "warning", quoted: "找不到的句子", message: "错别字", startOffset: -1, endOffset: -1, line: 0, located: false },
  ],
};

test("一轮多个审查结果合并成一个面板：来源文件分节、规则码分组", () => {
  const gathering = collectReviewResults([
    toolRow(1, "KnowledgeCheck", STANDARDS_RESULT),
    toolRow(2, "ReportReviewIssues", ISSUES_RESULT),
  ]);

  assert.equal(gathering.hasContent, true);
  // 无来源的标准自检 + 带来源的自述型审查 = 两节；按问题数降序（各 2 条时保持插入序）
  assert.equal(gathering.sections.length, 2);
  const sections = gathering.sections;
  const sourced = sections.find((section) => section.sourcePath === "E:/docs/说明书.docx");
  assert.ok(sourced, "自述型审查必须带着原件来源分节");
  assert.equal(sourced.codeGroups.length, 1);
  assert.equal(sourced.codeGroups[0]!.family, "TYPO");
  assert.equal(sourced.codeGroups[0]!.totals.total, 2);
  assert.equal(sourced.codeGroups[0]!.totals.unlocated, 1);

  const sourceless = sections.find((section) => section.sourcePath === null);
  assert.ok(sourceless);
  // 标准自检的 ok 条不进问题列表：只剩 abolished 与 no_version 两组
  assert.deepEqual(
    sourceless.codeGroups.map((group) => group.family).sort(),
    ["abolished", "no_version"],
  );
  assert.equal(sourceless.totals.total, 2);
  assert.equal(gathering.totals.total, 4);
  assert.equal(gathering.totals.error, 1);
  assert.equal(gathering.totals.warning, 3);
  assert.equal(gathering.passed, 1);
});

test("同一来源的多条工具结果合并成一节，不重复开卡", () => {
  const second = {
    ...ISSUES_RESULT,
    issues: [
      { code: "CONSISTENCY", severity: "info", quoted: "见图 3", message: "前后不一致", startOffset: 40, endOffset: 44, line: 12, located: true },
    ],
  };
  const gathering = collectReviewResults([
    toolRow(1, "ReportReviewIssues", ISSUES_RESULT),
    toolRow(2, "ReportReviewIssues", second),
  ]);
  assert.equal(gathering.sections.length, 1);
  assert.deepEqual(
    gathering.sections[0]!.codeGroups.map((group) => group.family),
    ["TYPO", "CONSISTENCY"],
  );
  assert.equal(gathering.sections[0]!.totals.total, 3);
});

test("规则码按族聚合：PUNCT-001 与 PUNCT-004 同组，具体码仍留在行上", () => {
  const puncts = {
    ...ISSUES_RESULT,
    issues: [
      { code: "PUNCT-001", severity: "warning", quoted: "，，", message: "重复标点", startOffset: 3, endOffset: 5, line: 1, located: true },
      { code: "PUNCT-004", severity: "warning", quoted: "（见附件）", message: "括号不全角", startOffset: 30, endOffset: 35, line: 4, located: true },
      { code: "GRAMMAR-002", severity: "info", quoted: "的的", message: "助词重复", startOffset: 60, endOffset: 62, line: 9, located: true },
    ],
  };
  const gathering = collectReviewResults([toolRow(1, "ReportReviewIssues", puncts)]);
  const groups = gathering.sections[0]!.codeGroups;
  assert.equal(groups.length, 2, "两个 PUNCT 码必须合成一族，避免「每条一个组标题」");
  const punct = groups.find((group) => group.family === "PUNCT");
  assert.ok(punct);
  assert.equal(punct.items.length, 2);
  assert.deepEqual(punct.items.map((item) => item.code).sort(), ["PUNCT-001", "PUNCT-004"]);
});

test("未定位条目标记 located=false，且仍出现在面板里（只是不可点）", () => {
  const gathering = collectReviewResults([toolRow(1, "ReportReviewIssues", ISSUES_RESULT)]);
  const items = gathering.sections[0]!.codeGroups[0]!.items;
  assert.equal(items.length, 2);
  const unlocated = items.find((item) => !item.located);
  assert.ok(unlocated, "无法定位的问题必须照常显示，缺的只是点击能力");
  assert.equal(unlocated.textPath, "/tmp/review-text/b.md");
});

test("术语结果不占问题计数，单独成组", () => {
  const gathering = collectReviewResults([
    toolRow(1, "KnowledgeCheck", {
      action: "terminology",
      stale: false,
      whitelisted: ["阀门"],
      remaining: ["截止阀"],
      notice: null,
    }),
  ]);
  assert.equal(gathering.hasContent, true);
  assert.equal(gathering.totals.total, 0);
  assert.equal(gathering.terminology.length, 1);
  assert.deepEqual(gathering.terminology[0]!.whitelisted, ["阀门"]);
});

test("识别不出结果的工具行被跳过，不产生空面板", () => {
  const gathering = collectReviewResults([
    toolRow(1, "Bash", { action: "something-else" }),
    { kind: "reasoning", rowId: 2 } as unknown as AssistantWorkRow,
  ]);
  assert.equal(gathering.hasContent, false);
  assert.equal(gathering.sections.length, 0);
});

test("notice 去重后逐条上抛，stale 只要有一条出现就为真", () => {
  const gathering = collectReviewResults([
    toolRow(1, "KnowledgeCheck", { ...STANDARDS_RESULT, stale: true, notice: "知识库未同步" }),
    toolRow(2, "ReportReviewIssues", { ...ISSUES_RESULT, notice: "知识库未同步" }),
  ]);
  assert.equal(gathering.stale, true);
  assert.deepEqual(gathering.notices, ["知识库未同步"]);
});
