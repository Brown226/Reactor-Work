/**
 * 召唤专家（M2 #1）纯逻辑回归（`npx tsx --test packages/ui/test/expertSummon.test.ts`）。
 *
 * 为什么值得钉：召唤 = 一段预填草稿 + subagent mention，按钮与 i18n 模板之间只有
 * 占位符约定（{title}/{tags}），模板键名/分隔符退化了不会报错，只是草稿悄悄变差。
 */
import assert from "node:assert/strict";
import test from "node:test";

import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  formatExpertTags,
  isExpertModelUnavailable,
  summonDraftMessageId,
} from "../src/marketplace/expertSummon.js";

test("summonDraftMessageId：有 tags 用 withTags 模板，无 tags 用 plain", () => {
  assert.equal(summonDraftMessageId(true), "marketplace.dialog.summonDraft.withTags");
  assert.equal(summonDraftMessageId(false), "marketplace.dialog.summonDraft.plain");
});

test("formatExpertTags：CJK locale 用「、」，其余用逗号；空白项剔除", () => {
  assert.equal(formatExpertTags(["数据", "办公", "开发"], "zh-CN"), "数据、办公、开发");
  assert.equal(formatExpertTags(["data", "office"], "en-US"), "data, office");
  assert.equal(formatExpertTags([" a ", "", "  ", "b"], "zh-CN"), "a、b");
});

test("formatExpertTags：无有效 tags 返回空串（调用方据此切 plain 模板）", () => {
  assert.equal(formatExpertTags([], "zh-CN"), "");
  assert.equal(formatExpertTags(["", "  "], "en-US"), "");
});

test("isExpertModelUnavailable：目录未加载（null/空）不判定，不误报", () => {
  assert.equal(isExpertModelUnavailable("glm-5", null), false);
  assert.equal(isExpertModelUnavailable("glm-5", undefined), false);
  assert.equal(isExpertModelUnavailable("glm-5", []), false);
  assert.equal(isExpertModelUnavailable(null, ["other"]), false);
});

test("isExpertModelUnavailable：目录已加载时按包含关系判定", () => {
  assert.equal(isExpertModelUnavailable("glm-5", ["glm-5", "other"]), false);
  assert.equal(isExpertModelUnavailable("glm-5", ["other"]), true);
});

/**
 * 模板钉（两条链路：key 必须在中英两份存在；占位符必须与调用方传参一致）。
 * 改了模板文案不报错，只有占位符写错/键名漂移才会让草稿缺专家名或漏擅长领域——
 * 那正是「召唤专家」的产品语义，故在此把口径钉住。
 */
test("召唤草稿模板：中英双份存在，占位符与调用方一致", () => {
  for (const [locale, messages] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    const withTags = messages["marketplace.dialog.summonDraft.withTags"];
    const plain = messages["marketplace.dialog.summonDraft.plain"];
    assert.ok(withTags, `${locale} 缺 withTags 模板`);
    assert.ok(plain, `${locale} 缺 plain 模板`);
    // 专家名：两份模板都必须有 {title} 占位符。
    assert.ok(withTags.includes("{title}"), `${locale} withTags 缺 {title}`);
    assert.ok(plain.includes("{title}"), `${locale} plain 缺 {title}`);
    // 擅长领域：只有有 tags 的模板带 {tags}；plain 里出现会渲染成字面 "{tags}"。
    assert.ok(withTags.includes("{tags}"), `${locale} withTags 缺 {tags}`);
    assert.ok(!plain.includes("{tags}"), `${locale} plain 不应含 {tags}`);
    // 任务描述引导语：草稿要让用户知道要补什么（不是自动发送，用户补完才发）。
    assert.ok(withTags.trim().length > 0 && plain.trim().length > 0);
    assert.notEqual(withTags, plain);
  }
});
