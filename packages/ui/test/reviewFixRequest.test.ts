/**
 * 「对已采纳的问题做修改」指令的组装（`npx tsx --test packages/ui/test/reviewFixRequest.test.ts`）。
 *
 * 这条指令是**用户拍板的意志**传达到执行端的唯一通道：条目少了，用户以为改了却没改；
 * 片段抄错，工具就定位不到；工具名写错，模型会拿别的办法（重写文档）去凑。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewFixPrompt, groupReviewMarksBySource } from "../src/review/reviewFixRequest.js";
import type { ReviewMark } from "../src/store/reviewMarksStore.js";

function mark(overrides: Partial<ReviewMark> = {}): ReviewMark {
  return {
    key: "text:10:PUNCT-001",
    code: "标点-001",
    title: "标点",
    severity: "warning",
    quoted: "退出安装向导。、",
    matchedOccurrence: 1,
    message: "句末「。」之后多出一个顿号",
    suggestion: "删除多余的「、」",
    line: 91,
    sourcePath: "E:/docs/说明书.docx",
    textPath: "/tmp/review-text/abc.md",
    markedAt: 1,
    ...overrides,
  };
}

test("指令包含工具名、逐条片段与建议，并明确「保持格式、另存副本」", () => {
  const prompt = buildReviewFixPrompt([mark()]);
  assert.ok(prompt);
  assert.match(prompt, /docx_patch/);
  assert.match(prompt, /保持原有格式/);
  assert.match(prompt, /另存为副本/);
  assert.match(prompt, /E:\/docs\/说明书\.docx/);
  assert.match(prompt, /退出安装向导。、/);
  assert.match(prompt, /删除多余的「、」/);
  assert.match(prompt, /第 91 行/);
  assert.match(prompt, /共 1 条/);
});

test("多条按用户拍板顺序编号；多次出现的片段带上第几次", () => {
  const prompt = buildReviewFixPrompt([
    mark({ markedAt: 1, code: "标点-001" }),
    mark({
      key: "text:99:CONSISTENCY",
      markedAt: 2,
      code: "一致性",
      quoted: "DN200",
      matchedOccurrence: 3,
      suggestion: null,
    }),
  ]);
  assert.ok(prompt);
  assert.match(prompt, /共 2 条/);
  assert.ok(prompt.indexOf("退出安装向导。、") < prompt.indexOf("DN200"), "顺序 = 拍板顺序");
  assert.match(prompt, /第 3 次出现/);
  // 没有建议时不许编一个改法：明确让模型按描述最小改动、拿不准就跳过
  assert.match(prompt, /无法确定时跳过并说明/);
});

test("跨文件分组；没有标记时不生成指令", () => {
  const groups = groupReviewMarksBySource([
    mark({ key: "a", sourcePath: "E:/a.docx" }),
    mark({ key: "b", sourcePath: "E:/b.docx" }),
    mark({ key: "c", sourcePath: "E:/a.docx" }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.sourcePath, group.marks.length]),
    [
      ["E:/a.docx", 2],
      ["E:/b.docx", 1],
    ],
  );
  assert.equal(buildReviewFixPrompt([]), null);
});
