/**
 * ReportReviewIssues 的定位口径回归
 * （`npx tsx --test packages/zcode-cli/packages/core/test/report-review-issues.test.ts` 相对包根执行）。
 *
 * 守的是「点击问题跳到哪」这条链路上最危险的一段：**模型抄回的原文片段与正文对不上时，
 * 偏移算成什么**。这段代码只有两种正确行为 —— 精确命中就给出精确偏移；对不上就如实说
 * 「没定位到」。任何"模糊匹配按相似度取最近"的改动都会让复核者点到一个无关位置，
 * 那比不能点更糟，所以这里逐条钉住。
 *
 * 第二段是工具级回归：缓存目录指到临时目录（`REACTOR_KNOWLEDGE_DIR`），验证快照落盘、
 * 汇总计数与 notice 是否如实转述定位边界。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  lineAt,
  locateIssue,
  locateOriginalText,
  normalizeWithMap,
  reportReviewIssuesToolEntry,
  resolveReviewText,
} from "../src/tool/handlers/report-review-issues.js";

const TEXT = [
  "1 总则",
  "1.1 本工程循环水泵按 GB/T 1921-2018 选型。",
  "1.2 管件材质应符合 GB/T 1921-2018 的规定。",
  "1.3 焊缝质量按 NB/T 47013 执行。",
].join("\n");

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "reactor-review-issues-"));
  const previous = process.env["REACTOR_KNOWLEDGE_DIR"];
  process.env["REACTOR_KNOWLEDGE_DIR"] = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env["REACTOR_KNOWLEDGE_DIR"];
    else process.env["REACTOR_KNOWLEDGE_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── 定位器 ───────────────────────────────────────────────────── */

test("定位：精确命中的偏移与行号落在正确位置", () => {
  const span = locateOriginalText(TEXT, "GB/T 1921-2018");
  assert.ok(span);
  assert.equal(TEXT.slice(span.startOffset, span.endOffset), "GB/T 1921-2018");
  assert.equal(span.occurrences, 2, "该片段在正文出现两次");
  assert.equal(span.matchedOccurrence, 1, "未指定 occurrence 时取第一处");
  assert.equal(lineAt(TEXT, span.startOffset), 2);
});

test("定位：occurrence 指定第几次出现", () => {
  const first = locateOriginalText(TEXT, "GB/T 1921-2018", 1)!;
  const second = locateOriginalText(TEXT, "GB/T 1921-2018", 2)!;
  assert.equal(lineAt(TEXT, first.startOffset), 2);
  assert.equal(lineAt(TEXT, second.startOffset), 3);
  assert.ok(second.startOffset > first.startOffset);
  // 越界的 occurrence 退回第一处，而不是报错或给空
  const overflow = locateOriginalText(TEXT, "GB/T 1921-2018", 9)!;
  assert.equal(overflow.matchedOccurrence, 1);
});

test("定位：全角/空白差异退到归一化匹配，且偏移仍落在原文的真实区间内", () => {
  // 正文是半角，片段是全角 + 全角空格（抄写时被输入法改过）
  const messy = "ＧＢ／Ｔ　1921-2018";
  const span = locateOriginalText(TEXT, messy);
  assert.ok(span, "归一化后应能命中");
  const hit = TEXT.slice(span.startOffset, span.endOffset);
  assert.equal(hit, "GB/T 1921-2018", "还原出的区间必须落在正文的真实片段上");
  assert.equal(span.occurrences, 2);
});

test("定位：片段与正文对不上时返回 null，不猜最近似位置", () => {
  assert.equal(locateOriginalText(TEXT, "完全不存在的一句话"), null);
  assert.equal(locateOriginalText(TEXT, ""), null);
  // 只差一个字符（1→7）也不许模糊命中
  assert.equal(locateOriginalText(TEXT, "GB/T 7921-2018"), null);
});

test("定位：CRLF 正文的行号按 \\n 计，正文区间不跨行时不含换行", () => {
  const crlf = "第一行\r\n第二行 目标片段\r\n第三行";
  const span = locateOriginalText(crlf, "目标片段")!;
  assert.equal(lineAt(crlf, span.startOffset), 2);
  assert.equal(crlf.slice(span.startOffset, span.endOffset), "目标片段");
});

test("归一化映射：全角、空白、破折号都被折掉，映射回原文下标", () => {
  const { normalized, map } = normalizeWithMap("Ａ　B-c");
  assert.equal(normalized, "AB-C");
  assert.equal(map.length, normalized.length);
  assert.equal(map[0], 0, "Ａ 映射回原文下标 0");
  assert.equal(map[1], 2, "B 前有一个全角空格，下标应跳过它");
});

/* ── 工具级 ───────────────────────────────────────────────────── */

test("工具：未定位的问题条给出 located=false 与 -1 偏移，并在 notice 里如实说明", async () => {
  const result = (await reportReviewIssuesToolEntry.handler(
    {
      text: TEXT,
      issues: [
        {
          severity: "warning",
          ruleCode: "TYPO-001",
          originalText: "这条在正文里没有",
          description: "疑似错别字",
        },
        {
          severity: "error",
          ruleCode: "CONSISTENCY",
          originalText: "NB/T 47013",
          description: "与上游文件不一致",
          suggestion: "改为 NB/T 47013.1",
        },
      ],
    },
    {} as never,
  )) as {
    issues: { located: boolean; startOffset: number; line: number; matchKind: string }[];
    summary: { total: number; error: number; warning: number; unlocated: number };
    notice: string | null;
    textPath: string | null;
  };

  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.unlocated, 1);
  assert.equal(result.summary.error, 1);
  assert.equal(result.issues[0]!.located, false);
  assert.equal(result.issues[0]!.matchKind, "not_found");
  assert.equal(result.issues[0]!.startOffset, -1, "未定位不得给出可用的偏移");
  assert.equal(result.issues[1]!.located, true);
  assert.match(result.notice ?? "", /找不到对应片段/);
});

test("工具：内联正文落盘快照，快照内容与传入正文一致", () =>
  withTempDir((dir) => {
    const { text, textPath } = resolveReviewText({ issues: [], text: TEXT });
    assert.equal(text, TEXT);
    assert.ok(textPath && existsSync(textPath), "快照应落盘");
    assert.ok(textPath.startsWith(join(dir, "review-text")), "快照落在知识缓存目录下");
    assert.equal(readFileSync(textPath, "utf8"), TEXT);
  }));

test("工具：textFile 模式直接把该文件当高亮目标，不复制快照", () =>
  withTempDir((dir) => {
    const source = join(dir, "被审文件.extracted.txt");
    writeFileSync(source, TEXT, "utf8");
    const resolved = resolveReviewText({ issues: [], textFile: source });
    assert.equal(resolved.textPath, source);
    assert.ok(!existsSync(join(dir, "review-text")), "textFile 模式不写快照目录");
  }));

test("工具：既没 text 也没 textFile 时报错而不是猜", () => {
  assert.throws(() => resolveReviewText({ issues: [] }), /缺少被审正文/);
});

test("工具：归一化命中的条数与多次出现的条数都进 notice", async () => {
  const result = (await reportReviewIssuesToolEntry.handler(
    {
      text: TEXT,
      issues: [
        {
          severity: "warning",
          ruleCode: "TYPO-001",
          originalText: "ＧＢ／Ｔ　1921-2018",
          description: "全角写法",
        },
        {
          severity: "info",
          ruleCode: "CONSISTENCY",
          originalText: "GB/T 1921-2018",
          description: "同编号出现两次",
        },
      ],
    },
    {} as never,
  )) as { notice: string | null; issues: { matchKind: string }[] };
  assert.equal(result.issues[0]!.matchKind, "normalized");
  assert.match(result.notice ?? "", /归一化后匹配/);
  assert.match(result.notice ?? "", /出现多次/);
});

test("工具：locateIssue 把 location 并进问题描述，供卡片显示", () => {
  const issue = locateIssue(TEXT, {
    severity: "info",
    ruleCode: "TYPO-002",
    originalText: "1 总则",
    description: "标题缺编号",
    location: "§1",
  });
  assert.match(issue.message, /§1/);
  assert.equal(issue.located, true);
});
