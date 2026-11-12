/**
 * 技能「使用」入口（M1 增强）纯逻辑回归（`npx tsx --test packages/ui/test/skillUsage.test.ts`）。
 *
 * 为什么值得钉：点击「使用」只有一条字符串约定（草稿里的 `$技能名` mention），
 * 断了不会报错——会话照常新建，只是草稿里缺技能引用，用户回到输入框还得手打。
 * 显示条件同理：少判一个布尔不会崩，只会变成死入口（插了也没人执行的技能）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";
import { buildSkillUsePrefill, shouldShowSkillUseAction } from "../src/marketplace/skillUsage.js";

test("buildSkillUsePrefill：markdown 为 $name 形态，category 为 skills", () => {
  const prefill = buildSkillUsePrefill("docx-writer", "文档写入");
  assert.equal(prefill.markdown, "$docx-writer");
  assert.equal(prefill.category, "skills");
  assert.equal(prefill.id, "skill:docx-writer");
  assert.equal(prefill.label, "docx-writer");
  assert.equal(prefill.value, "docx-writer");
  assert.equal(prefill.description, "文档写入");
});

test("buildSkillUsePrefill：无 title 时不带 description（不塞 undefined 键）", () => {
  assert.equal("description" in buildSkillUsePrefill("x"), false);
  assert.equal("description" in buildSkillUsePrefill("x", null), false);
  assert.equal("description" in buildSkillUsePrefill("x", ""), false);
});

test("buildSkillUsePrefill：name 前后空白剔除（服务端脏数据不入草稿）", () => {
  assert.equal(buildSkillUsePrefill("  docx-writer  ").markdown, "$docx-writer");
  assert.equal(buildSkillUsePrefill("  docx-writer  ").label, "docx-writer");
});

test("buildSkillUsePrefill：草稿文本确实被解析成技能 mention（round-trip）", () => {
  // 点击后草稿里只有这段文本；若它落不进 skill 分支，技能调用就断了而界面无感知。
  const parts = parseMentionMarkdown(buildSkillUsePrefill("docx-writer").markdown);
  assert.deepEqual(parts, [{ type: "skill", label: "docx-writer" }]);
});

test("shouldShowSkillUseAction：安装 + 启用 + 有新建会话通道才显示", () => {
  assert.equal(
    shouldShowSkillUseAction({ installed: true, enabled: true, hasCreateTask: true }),
    true,
  );
});

test("shouldShowSkillUseAction：任一条件不满足都不显示", () => {
  // 未安装：装完才有得用。
  assert.equal(
    shouldShowSkillUseAction({ installed: false, enabled: true, hasCreateTask: true }),
    false,
  );
  // 停用：与 `$` 面板过滤口径一致，停用技能在面板里不存在，给按钮即死入口。
  assert.equal(
    shouldShowSkillUseAction({ installed: true, enabled: false, hasCreateTask: true }),
    false,
  );
  // 宿主无新建会话通道：无处可去。
  assert.equal(
    shouldShowSkillUseAction({ installed: true, enabled: true, hasCreateTask: false }),
    false,
  );
});

/** 文案钉：卡片与弹层两条入口的键必须在中英两份存在且非空。 */
test("「使用」文案：中英双份存在（card 与 dialog 两键）", () => {
  for (const [locale, messages] of [
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ] as const) {
    for (const key of ["marketplace.card.use", "marketplace.dialog.use"] as const) {
      const value = messages[key];
      assert.ok(value && value.trim().length > 0, `${locale} 缺 ${key} 或为空`);
    }
  }
});
