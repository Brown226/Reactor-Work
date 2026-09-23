/**
 * 审查定位与结果读取的回归（`npx tsx --test packages/ui/test/reviewIssueAnchors.test.ts`）。
 *
 * 这两块都是**纯函数**，但它们决定「点问题 → 跳到哪一行」是否正确 —— 跳错位置比不跳更糟
 * （复核者会照着错误的位置核对，并因此怀疑结论本身）。所以口径必须钉住：
 * 偏移越界不钳位、行号优先于偏移、结果读取要容忍多种承载位置。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableIssues,
  compareIssues,
  readKnowledgeResult,
} from "../src/ToolCallBlocks/knowledgeCheckResult.js";
import { buildReviewTextModel, REVIEW_TEXT_MAX_LINES } from "../src/reviewTextModel.js";
import {
  resolveAnchorLineRange,
  resolveCodeReviewContentProjection,
  resolveLineFromOffset,
} from "../src/previewPaneCodeReview.js";
import {
  isExportReviewReportToolCall,
  isKnowledgeCheckToolCall,
  isReportReviewIssuesToolCall,
} from "../src/lib/reviewToolNames.js";

const CONTENT = ["一、引用标准", "GB/T 8163-2018、GB 12238", "管件按 GB/T8163-1999 供货。"].join("\n");

test("偏移 → 行号：按 \\n 计数，行号从 1 起", () => {
  assert.equal(resolveLineFromOffset(CONTENT, 0), 1);
  assert.equal(resolveLineFromOffset(CONTENT, 2), 1);
  assert.equal(resolveLineFromOffset(CONTENT, CONTENT.indexOf("GB 12238")), 2);
  assert.equal(resolveLineFromOffset(CONTENT, CONTENT.indexOf("供货")), 3);
});

test("偏移 → 行号：越界返回 null，**不钳到边界**", () => {
  assert.equal(resolveLineFromOffset(CONTENT, -1), null);
  assert.equal(resolveLineFromOffset(CONTENT, CONTENT.length + 1), null);
  // 恰好等于长度是合法的（光标停在文末）
  assert.equal(resolveLineFromOffset(CONTENT, CONTENT.length), 3);
});

test("锚点归一：显式行号优先于偏移；偏移换算的区间取两端所在行", () => {
  const start = CONTENT.indexOf("GB/T8163-1999");
  const explicit = resolveAnchorLineRange(
    { requestId: "r", title: "t", body: "b", startLine: 2, startOffset: start },
    CONTENT,
  );
  assert.deepEqual(explicit, { startLine: 2, endLine: 2, outOfRange: false });

  const byOffset = resolveAnchorLineRange(
    { requestId: "r", title: "t", body: "b", startOffset: start, endOffset: start + 12 },
    CONTENT,
  );
  assert.deepEqual(byOffset, { startLine: 3, endLine: 3, outOfRange: false });

  // 行号超出实际文本 → outOfRange（文件换过版本），不能悄悄回到第 1 行
  const outOfRange = resolveAnchorLineRange(
    { requestId: "r", title: "t", body: "b", startLine: 99, endLine: 100 },
    CONTENT,
  );
  assert.equal(outOfRange?.outOfRange, true);

  // 两个锚点都没有 → null（无定位信息）
  assert.equal(resolveAnchorLineRange({ requestId: "r", title: "t", body: "b" }, CONTENT), null);
});

test("投影：带偏移的问题条能定位到行，并把命中原文放进 selectedText", () => {
  const line = CONTENT.split("\n")[1]!;
  const startOffset = CONTENT.indexOf(line);
  const projection = resolveCodeReviewContentProjection(
    {
      type: "code-review",
      title: "审查问题定位",
      path: "/tmp/review-text/abc.txt",
      review: {
        requestId: "r1",
        title: "未注年代号",
        body: "引用未注年代号",
        startOffset,
        endOffset: startOffset + line.length,
        quote: "GB 12238",
        severity: "warning",
      },
    },
    CONTENT,
  );
  assert.deepEqual(projection.focusedRange, { startLine: 2, endLine: 2 });
  assert.equal(projection.inlineComments.length, 1);
  assert.equal(projection.inlineComments[0]?.selectedText, "GB 12238");
  assert.equal(projection.targetLineOutOfRange, false);
  assert.equal(projection.topComment, null);
});

test("投影：无法定位时降级成 topComment，而不是丢掉问题", () => {
  const projection = resolveCodeReviewContentProjection(
    {
      type: "code-review",
      title: "t",
      path: "/tmp/x.txt",
      review: { requestId: "r2", title: "t", body: "说明", startLine: 500 },
    },
    CONTENT,
  );
  assert.equal(projection.focusedRange, null);
  assert.equal(projection.inlineComments.length, 0);
  assert.equal(projection.targetLineOutOfRange, true);
  assert.equal(projection.topComment?.comment, "说明");
});

test("结果读取：容忍 rawOutput / result / 字符串 JSON 多种承载位置", () => {
  const payload = {
    action: "standards",
    stale: false,
    textPath: "/data/review-text/abc.txt",
    summary: { total: 3, ok: 1, abolished: 1, noYear: 1, noVersion: 0, notInLibrary: 0, missing: 0, upcoming: 0 },
    issues: [
      {
        code: "abolished",
        severity: "error",
        quoted: "GB/T 9123-2010",
        normalized: "GB/T 9123-2010",
        line: 43,
        startOffset: 100,
        endOffset: 114,
        libraryNo: "GB/T 9123-2010",
        libraryName: "钢制管法兰盖",
        libraryStatus: "abolished",
        suggestion: "GB/T 9124.1-2019（钢制管法兰第1部分：PN系列）",
        message: "已废止",
      },
      // 残缺条目（缺 message）必须被丢掉，不能让半条问题进卡片
      { code: "no_year", severity: "warning", quoted: "GB 12238" },
    ],
  };
  for (const raw of [
    { rawOutput: payload },
    { result: payload },
    { rawOutput: JSON.stringify(payload) },
    { output: { display: payload } },
  ]) {
    const view = readKnowledgeResult(raw);
    assert.equal(view?.kind, "standards");
    if (view?.kind !== "standards") continue;
    assert.equal(view.issues.length, 1, "残缺问题条应被丢弃");
    assert.equal(view.issues[0]?.line, 43);
    assert.equal(view.summary?.total, 3);
    assert.equal(view.textPath, "/data/review-text/abc.txt");
  }
  // 不是 KnowledgeCheck 的结果 → null（交给别的渲染器）
  assert.equal(readKnowledgeResult({ rawOutput: { action: "rules", items: [] } }), null);
  assert.equal(readKnowledgeResult(null), null);
});

test("问题排序与筛选：硬错误在前，按偏移稳定排序", () => {
  const make = (code: string, severity: "error" | "warning" | "info" | "none", startOffset: number) => ({
    code,
    severity,
    quoted: "x",
    normalized: "",
    line: 1,
    startOffset,
    endOffset: startOffset + 1,
    libraryNo: null,
    libraryName: null,
    libraryStatus: null,
    suggestion: null,
    message: "m",
  });
  const sorted = [
    make("missing", "warning", 5),
    make("ok", "none", 1),
    make("abolished", "error", 90),
    make("no_year", "warning", 20),
    make("not_in_library", "error", 10),
  ]
    .filter((issue) => issue.severity !== "none")
    .sort(compareIssues)
    .map((issue) => issue.code);
  assert.deepEqual(sorted, ["not_in_library", "abolished", "missing", "no_year"]);
  assert.equal(actionableIssues([make("ok", "none", 1)]).length, 0);
});

test("工具名判定：三种 wire 写法都认，且不误伤别的工具", () => {
  assert.equal(isKnowledgeCheckToolCall({ toolName: "KnowledgeCheck" }), true);
  assert.equal(isKnowledgeCheckToolCall({ toolName: "knowledge_check" }), true);
  assert.equal(isKnowledgeCheckToolCall({ raw: { tool_name: "knowledge-check" } }), true);
  assert.equal(isKnowledgeCheckToolCall({ toolName: "Read" }), false);
  assert.equal(isExportReviewReportToolCall({ toolName: "ExportReviewReport" }), true);
  assert.equal(isExportReviewReportToolCall({ toolName: "KnowledgeCheck" }), false);
  assert.equal(isReportReviewIssuesToolCall({ toolName: "ReportReviewIssues" }), true);
  assert.equal(isReportReviewIssuesToolCall({ raw: { toolName: "report_review_issues" } }), true);
  assert.equal(isReportReviewIssuesToolCall({ toolName: "KnowledgeCheck" }), false);
});

test("结果读取：ReportReviewIssues 的结果按 issues 识别，定位元数据不丢", () => {
  const view = readKnowledgeResult({
    result: {
      action: "issues",
      stale: false,
      textPath: "C:/tmp/review-text/abc.txt",
      sourcePath: "C:/docs/设计说明.docx",
      notice: "有 1 条是归一化后匹配到的。",
      summary: { total: 3, error: 1, warning: 1, info: 1, unlocated: 1 },
      issues: [
        {
          code: "TYPO-001",
          severity: "error",
          quoted: "水磊",
          message: "疑似错别字",
          line: 12,
          startOffset: 300,
          endOffset: 302,
          occurrences: 2,
          matchedOccurrence: 2,
          matchKind: "exact",
          located: true,
        },
        {
          code: "TYPO-002",
          severity: "warning",
          quoted: "找不到的片段",
          message: "无法定位",
          line: 0,
          startOffset: -1,
          endOffset: -1,
          occurrences: 0,
          matchedOccurrence: 0,
          matchKind: "not_found",
          located: false,
        },
      ],
    },
  });
  assert.ok(view && view.kind === "issues");
  assert.equal(view.summary?.unlocated, 1);
  assert.equal(view.summary?.error, 1);
  assert.equal(view.textPath, "C:/tmp/review-text/abc.txt");
  assert.equal(view.issues[0]!.matchedOccurrence, 2);
  assert.equal(view.issues[0]!.occurrences, 2);
  assert.equal(view.issues[0]!.located, true);
  assert.equal(view.issues[1]!.located, false, "未定位的条目必须如实标出来");
  assert.equal(view.issues[1]!.startOffset, -1);
});

test("结果读取：标准自检的条目默认视为已定位（老载荷没有 located 字段也不能变成不可点）", () => {
  const view = readKnowledgeResult({
    result: {
      action: "standards",
      issues: [
        {
          code: "abolished",
          severity: "error",
          quoted: "GB 50222-2017",
          message: "已废止",
          line: 3,
          startOffset: 10,
          endOffset: 23,
        },
      ],
    },
  });
  assert.ok(view && view.kind === "standards");
  assert.equal(view.issues[0]!.located, true);
  assert.equal(view.issues[0]!.occurrences, 1);
});

test("字符级高亮：命中区间落在行中间时只标那几个字", () => {
  const LF = String.fromCharCode(10);
  // 不用字面量 \n：这条用例本身就在验换行处理，字符串里混进真实换行会把它变成另一回事
  const text = ["第一行正常", "管件按 GB/T8163-1999 供货。", "第三行"].join(LF);
  const start = text.indexOf("GB/T8163-1999");
  const model = buildReviewTextModel(text, start, start + "GB/T8163-1999".length);
  assert.equal(model.rangeValid, true);
  assert.equal(model.hitLine, 2, "命中在第 2 行");
  const line = model.lines.find((item) => item.number === 2)!;
  assert.deepEqual(
    line.segments.map((segment) => [segment.text, segment.hit]),
    [
      ["管件按 ", false],
      ["GB/T8163-1999", true],
      [" 供货。", false],
    ],
  );
  // 其余行不该有任何高亮
  assert.equal(model.lines.filter((item) => item.hasHit).length, 1);
});

test("字符级高亮：跨行区间在每行各自切段", () => {
  const LF = String.fromCharCode(10);
  const text = ["AAA", "BBB", "CCC"].join(LF);
  const model = buildReviewTextModel(text, 1, 7); // 覆盖第 1 行的 AA 到第 2 行的 BB
  assert.equal(model.hitLine, 1);
  assert.deepEqual(model.lines.map((line) => line.hasHit), [true, true, false]);
  assert.equal(model.lines[0]!.segments.at(-1)!.text, "AA");
  // 偏移 7 是第 2 行末尾的换行（开区间不包含），所以第 2 行整行命中
  assert.equal(model.lines[1]!.segments[0]!.text, "BBB");
});

test("字符级高亮：CRLF 只算一次换行，且偏移坐标不被归一化打乱", () => {
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  const text = ["AAA", "BBB"].join(CRLF);
  const model = buildReviewTextModel(text, 5, 8); // "BBB"
  assert.equal(model.lines.length, 2);
  assert.equal(model.hitLine, 2);
  assert.deepEqual(model.lines[1]!.segments, [{ text: "BBB", hit: true }]);
});

test("字符级高亮：无效区间不猜位置，也不截断正文", () => {
  const text = "只有一行";
  for (const [start, end] of [
    [undefined, undefined],
    [99, 120],
    [3, 2],
    [-1, 4],
    [2, 2],
  ] as [number | undefined, number | undefined][]) {
    const model = buildReviewTextModel(text, start, end);
    assert.equal(model.rangeValid, false, `${start}-${end} 应为无效区间`);
    assert.equal(model.hitLine, null);
    assert.ok(!model.lines.some((line) => line.hasHit), "无效区间不得产生高亮");
    assert.equal(model.lines[0]!.segments[0]!.text, text, "正文仍要完整显示");
  }
});

test("字符级高亮：超长文本按上限截断并标记 truncated", () => {
  const text = Array.from({ length: 12 }, (_, index) => `L${index}`).join(String.fromCharCode(10));
  const model = buildReviewTextModel(text, 0, 2, 5);
  assert.equal(model.lines.length, 5);
  assert.equal(model.truncated, true);
  assert.equal(REVIEW_TEXT_MAX_LINES > model.lines.length, true);
  assert.equal(buildReviewTextModel(text, 0, 2).truncated, false, "默认上限内不应截断");
});
