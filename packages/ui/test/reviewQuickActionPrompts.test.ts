/**
 * 审查档快捷按钮 ↔ 内置技能绑定的回归（`npx tsx --test packages/ui/test/reviewQuickActionPrompts.test.ts`）。
 *
 * 为什么值得钉：按钮和技能之间只有一条字符串约定（正文以 `$<skill-name>` 技能引用开头）。
 * 这条约定断了不会报错——按钮照样能点、提示词照样发出去，只是技能不被加载，
 * 结果从「按 SKILL.md 的判定规则审查」悄悄退化成「模型自由发挥」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";
import {
  reviewQuickActionPrompts,
  withSkillReference,
} from "../src/v4/reviewQuickActionPrompts.js";

/** 内置插件 review-skills 里的技能全集（apps/zcode-cli/packages/review-skills-plugin/skills/）。 */
const REVIEW_SKILLS = [
  "review-proofread",
  "review-consistency",
  "review-compare",
  "review-contract",
  "review-standard-check",
];

/** 既有按钮 id：埋点（reportPromptTemplateClick 的 templateId）与灰度按 id 关联，不随手改。 */
const LEGACY_REVIEW_ACTION_IDS = [
  "review-type-proofread",
  "review-type-consistency",
  "review-type-compare",
  "review-type-contract",
  "review-type-standard-ref",
];

test("审查快捷按钮：5 张卡片与内置技能一一对应，id 不重复", () => {
  assert.equal(reviewQuickActionPrompts.length, REVIEW_SKILLS.length);
  const ids = reviewQuickActionPrompts.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "id 必须唯一");
  const skills = reviewQuickActionPrompts.map((item) => item.skill).sort();
  assert.deepEqual(skills, [...REVIEW_SKILLS].sort(), "技能集合必须与内置插件一致（不多不少）");
  for (const item of reviewQuickActionPrompts) {
    assert.equal(item.mode, "review");
    assert.ok(item.label.cn && item.label.en, `${item.id} 需要中英文案`);
    assert.ok(item.iconName, `${item.id} 需要图标名`);
  }
});

test("审查快捷按钮：原有 5 个 id 保持不变（埋点/灰度按 id 关联）", () => {
  const ids = new Set(reviewQuickActionPrompts.map((item) => item.id));
  for (const legacyId of LEGACY_REVIEW_ACTION_IDS) {
    assert.ok(ids.has(legacyId), `既有 id 丢失：${legacyId}`);
  }
});

test("审查快捷按钮：正文以技能引用开头，且能被 Composer 解析成技能 chip", () => {
  for (const item of reviewQuickActionPrompts) {
    for (const locale of ["cn", "en"] as const) {
      const prompt = item.prompt[locale] ?? "";
      assert.ok(
        prompt.startsWith(`$${item.skill} `),
        `${item.id}.${locale} 必须以 $${item.skill} 开头，实际：${prompt.slice(0, 40)}`,
      );
      const parts = parseMentionMarkdown(prompt);
      assert.deepEqual(
        parts[0],
        { type: "skill", label: item.skill },
        `${item.id}.${locale} 第一段应是技能引用`,
      );
    }
  }
});

test("审查快捷按钮：技能名带连字符时 token 仍完整（不会被截断成半截技能名）", () => {
  const prompt = withSkillReference("review-standard-check", "帮我检查引用的标准。");
  const parts = parseMentionMarkdown(prompt);
  assert.deepEqual(parts[0], { type: "skill", label: "review-standard-check" });
  assert.equal(parts[1]?.type, "text");
});
