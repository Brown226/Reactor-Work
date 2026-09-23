import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

/**
 * 审查档的审查类型快捷按钮。
 *
 * 与办公/编程推荐池同源同机制（点击即预填提示词，不自动发送），但多一条硬绑定：
 * 每张卡片对应内置插件 `review-skills` 里的**一个技能**，正文以 `$<skill-name>` 技能引用开头，
 * 进 Composer 后渲染成技能 chip，运行时由 Skill 工具加载——判定规则与输出格式都住在
 * SKILL.md 里，不在提示词里重复一遍。
 *
 * 单独成文件（而不是塞进 featureSuggestedPrompts）是因为那个文件 import 了 PNG 资源，
 * 本文件保持纯数据，单测可以直接断言「按钮 ↔ 技能」的对应关系。
 *
 * 模式集合与取舍见 docs/审查板块-方案-v1.md §2（已裁剪 RULE_ONLY / DEC_REVIEW；
 * 「以库审文」依赖的企业知识库本期不做，故此处不出现，避免死入口）。
 */
export interface ReviewQuickActionPrompt extends DraftSuggestedPromptItem {
  mode: "review";
  /** 内置插件 `review-skills` 中的技能名；正文里的 `$<skill>` 引用必须与它一致。 */
  skill: string;
}

/** Composer 技能引用的 token 语法：`$name` 需位于行首或空白之后，且后接空白或结尾。 */
export function withSkillReference(skill: string, prompt: string): string {
  return `$${skill} ${prompt}`;
}

function reviewQuickAction(input: {
  id: string;
  iconName: string;
  skill: string;
  label: ReviewQuickActionPrompt["label"];
  prompt: ReviewQuickActionPrompt["prompt"];
}): ReviewQuickActionPrompt {
  return {
    id: input.id,
    mode: "review",
    iconName: input.iconName,
    label: input.label,
    skill: input.skill,
    prompt: {
      cn: withSkillReference(input.skill, input.prompt.cn ?? ""),
      en: withSkillReference(input.skill, input.prompt.en ?? ""),
    },
  };
}

export const reviewQuickActionPrompts: ReviewQuickActionPrompt[] = [
  reviewQuickAction({
    id: "review-type-proofread",
    iconName: "spell-check",
    skill: "review-proofread",
    label: { cn: "基础校对", en: "Proofread" },
    prompt: {
      cn: "帮我校对这份文件，检查错别字、语法、标点和术语一致性。逐条指出问题所在的原文片段与修改建议，不要整篇重写。",
      en: "Proofread this file for typos, grammar, punctuation, and terminology consistency. List each issue with the original snippet and a suggested fix; do not rewrite the whole document.",
    },
  }),
  reviewQuickAction({
    id: "review-type-consistency",
    iconName: "list-checks",
    skill: "review-consistency",
    label: { cn: "全文一致性", en: "Consistency" },
    prompt: {
      cn: "帮我检查这份文件前后的一致性，重点看数值参数、单位、设备编号、名称与称谓是否统一。列出不一致的位置和正确值，并说明判定依据。",
      en: "Check this document's internal consistency, focusing on values, units, equipment IDs, names, and terminology. List each inconsistency with the correct value and the basis for your judgment.",
    },
  }),
  reviewQuickAction({
    id: "review-type-compare",
    iconName: "file-diff",
    skill: "review-compare",
    label: { cn: "以文审文", en: "Review against reference" },
    prompt: {
      cn: "我会上传一份参照文件和一份待审文件。以参照文件为权威基准，逐条核对待审文件是否有遗漏、数值或规格不符、编号错误。只报告确信的差异，措辞不同不算问题。",
      en: "I will provide a reference document and a document under review. Treat the reference as authoritative and check the target for omissions, value or spec mismatches, and wrong identifiers. Report only confident differences; wording differences do not count.",
    },
  }),
  reviewQuickAction({
    id: "review-type-contract",
    iconName: "scale",
    skill: "review-contract",
    label: { cn: "合同风险审查", en: "Contract risk" },
    prompt: {
      cn: "帮我审查这份合同的风险条款，重点关注付款条件、违约责任、质保与保险、争议解决。按风险等级给出条款出处、风险说明和建议修改方向。",
      en: "Review this contract's risk clauses, focusing on payment terms, liability, warranty and insurance, and dispute resolution. Rank by risk level with the clause location, the risk, and a suggested change.",
    },
  }),
  reviewQuickAction({
    id: "review-type-standard-ref",
    iconName: "book-check",
    skill: "review-standard-check",
    label: { cn: "标准引用自检", en: "Standard reference check" },
    prompt: {
      cn: "帮我检查这份文件里引用的标准规范：编号是否写错、标准是否已废止、版本年份是否是最新的。逐条给出文件中的写法与应当的写法。",
      en: "Check the standards cited in this document: wrong identifiers, abolished standards, and outdated version years. For each, show what the file says versus what it should say.",
    },
  }),
];
