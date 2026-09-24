/**
 * 审查结果卡 display 载荷的回归
 * （`npx tsx --test test/review-result-display.test.ts`，在 packages/core 下执行）。
 *
 * 守的是**「卡片数据到不了前端」这一类静默缺陷**：工具输出经 resultBudget 后只剩文本，
 * 结构化结果唯一的出口是这个 display。它缺失或字段名对不上时，两端都不报错，
 * 表现只是「审查卡片退化成一行文字」。所以这里钉三件事：kind 正确、字段够前端用、超限如实计数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createReviewResultDisplay } from "../src/tool/executor/review-result-display.js";

function standardsOutput(issueCount: number): unknown {
  return {
    action: "standards",
    stale: false,
    cacheDir: "C:/Users/u/.reactor/knowledge",
    stamp: { maxUpdatedAt: null, fetchedAt: new Date().toISOString(), count: 1 },
    issues: Array.from({ length: issueCount }, (_, index) => ({
      code: "abolished",
      severity: "error",
      quoted: `GB 50222-2017 第 ${index} 处`,
      normalized: "GB50222-2017",
      line: index + 1,
      startOffset: index * 10,
      endOffset: index * 10 + 14,
      libraryNo: "GB 55037-2022",
      libraryName: "建筑防火通用规范",
      libraryStatus: "current",
      suggestion: "GB 55037-2022",
      message: "引用了已废止标准",
    })),
    textPath: "C:/Users/u/.reactor/knowledge/review-text/abc.txt",
    summary: {
      total: issueCount,
      ok: 0,
      abolished: issueCount,
      noYear: 0,
      noVersion: 0,
      notInLibrary: 0,
      familyNotCollected: 0,
      missing: 0,
      upcoming: 0,
    },
    coverage: { citedFamilies: ["GB"], uncoveredFamilies: [] },
    whitelisted: [],
    remaining: [],
    notice: null,
    items: [],
  };
}

test("display：KnowledgeCheck 产出 review_issues 载荷，前端要用的字段都在", () => {
  const display = createReviewResultDisplay("KnowledgeCheck", standardsOutput(2));
  assert.ok(display, "必须产出 display，否则卡片拿不到任何数据");
  assert.equal(display.kind, "review_issues");
  assert.equal(display.action, "standards");
  assert.equal(display.issues.length, 2);
  assert.equal(display.issues[0]!.code, "abolished");
  assert.equal(display.issues[0]!.startOffset, 0, "偏移是点击定位的唯一依据，不能丢");
  assert.equal(display.issues[0]!.endOffset, 14);
  assert.equal(display.textPath, "C:/Users/u/.reactor/knowledge/review-text/abc.txt");
  assert.equal(display.summary?.["abolished"], 2);
  assert.equal(display.droppedIssues, 0);
});

test("display：ReportReviewIssues 保留定位元数据（located / 第几次出现）", () => {
  const display = createReviewResultDisplay("ReportReviewIssues", {
    action: "issues",
    stale: false,
    textPath: "C:/tmp/extracted.txt",
    sourcePath: "C:/docs/设计说明.docx",
    notice: "有 1 条是归一化后匹配到的。",
    summary: { total: 2, error: 1, warning: 1, info: 0, unlocated: 1 },
    issues: [
      {
        code: "TYPO-001",
        severity: "error",
        quoted: "水磊",
        line: 12,
        startOffset: 300,
        endOffset: 302,
        occurrences: 3,
        matchedOccurrence: 2,
        matchKind: "exact",
        located: true,
        suggestion: "水泵",
        message: "疑似错别字",
      },
      {
        code: "TYPO-002",
        severity: "warning",
        quoted: "找不到的片段",
        line: 0,
        startOffset: -1,
        endOffset: -1,
        occurrences: 0,
        matchedOccurrence: 0,
        matchKind: "not_found",
        located: false,
        suggestion: null,
        message: "无法定位",
      },
    ],
  });
  assert.ok(display);
  assert.equal(display.action, "issues");
  assert.equal(display.sourcePath, "C:/docs/设计说明.docx");
  assert.equal(display.issues[0]!.located, true);
  assert.equal(display.issues[0]!.occurrences, 3);
  assert.equal(display.issues[0]!.matchedOccurrence, 2);
  assert.equal(display.issues[1]!.located, false, "未定位必须如实传下去，前端才好禁用点击");
  assert.equal(display.issues[1]!.startOffset, -1);
  assert.equal(display.summary?.["unlocated"], 1);
});

test("display：术语模式带白名单与剩余候选", () => {
  const display = createReviewResultDisplay("KnowledgeCheck", {
    action: "terminology",
    stale: false,
    cacheDir: "C:/x",
    stamp: null,
    issues: [],
    textPath: null,
    summary: null,
    coverage: null,
    whitelisted: ["核安全", "循环水泵"],
    remaining: ["水磊"],
    notice: null,
    items: [],
  });
  assert.ok(display);
  assert.equal(display.action, "terminology");
  assert.deepEqual(display.whitelisted, ["核安全", "循环水泵"]);
  assert.deepEqual(display.remaining, ["水磊"]);
});

test("display：问题条超上限时截断并如实计数，不假装完整", () => {
  const display = createReviewResultDisplay("KnowledgeCheck", standardsOutput(260));
  assert.ok(display);
  assert.equal(display.issues.length, 200);
  assert.equal(display.droppedIssues, 60, "丢弃条数必须写进载荷，卡片要据此提示");
});

test("display：超长文本逐字段限长（display 不走 resultBudget）", () => {
  const long = "错".repeat(300);
  const display = createReviewResultDisplay("ReportReviewIssues", {
    action: "issues",
    stale: false,
    textPath: "C:/tmp/a.txt",
    sourcePath: null,
    notice: "警".repeat(2000),
    summary: { total: 1, error: 0, warning: 1, info: 0, unlocated: 0 },
    issues: [
      {
        code: "TYPO-001",
        severity: "warning",
        quoted: long,
        line: 1,
        startOffset: 0,
        endOffset: 300,
        occurrences: 1,
        matchedOccurrence: 1,
        matchKind: "exact",
        located: true,
        suggestion: long,
        message: long,
      },
    ],
  });
  assert.ok(display);
  assert.ok(Buffer.byteLength(display.issues[0]!.quoted, "utf8") <= 400);
  assert.ok(Buffer.byteLength(display.issues[0]!.message, "utf8") <= 600);
  assert.ok(Buffer.byteLength(display.notice ?? "", "utf8") <= 1_000);
});

test("display：结构对不上的输出不产载荷（宁可不画，也不画半张卡）", () => {
  assert.equal(createReviewResultDisplay("KnowledgeCheck", { action: "standards" }), undefined);
  assert.equal(createReviewResultDisplay("ReportReviewIssues", { action: "issues" }), undefined);
  assert.equal(createReviewResultDisplay("Read", standardsOutput(1)), undefined);
});
