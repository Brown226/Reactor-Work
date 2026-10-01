/**
 * 召唤专家（M2 #1）的纯逻辑：预填草稿组装与模型可用性判定。
 *
 * 为什么单独成文件：按钮行为只有一条字符串约定（草稿文本 + subagent mention 前缀），
 * 断了不会报错——召唤照样开新会话，只是草稿退化为一句干巴巴的话。纯函数抽出便于
 * `npx tsx --test packages/ui/test/expertSummon.test.ts` 钉住口径。
 * 发送通道与 starters 完全同源（`onCreateTask({initialPrompt, initialPromptMention})`，
 * 只写草稿，**绝不自动发送**）。
 */

/** 与 locale 文件里 `marketplace.dialog.summonDraft.*` 的键约定（选择器，避免组件里写三元）。 */
export function summonDraftMessageId(hasTags: boolean): string {
  return hasTags
    ? "marketplace.dialog.summonDraft.withTags"
    : "marketplace.dialog.summonDraft.plain";
}

/** 擅长领域词按 locale 连接：CJK 用「、」，其余用逗号（Intl.ListFormat 在 zh 下无分隔，不采用）。 */
export function formatExpertTags(tags: readonly string[], locale: string): string {
  const cleaned = tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (cleaned.length === 0) return "";
  const separator = /^zh\b|^ja\b|^ko\b/i.test(locale) ? "、" : ", ";
  return cleaned.join(separator);
}

/**
 * 模型可用性判定：专家定义带 model 且服务端模型目录已加载（非空）但不含该模型时为 true。
 * 目录未加载（空数组/undefined）时不判定——如实缺据，不误报（由用户自行判断）。
 */
export function isExpertModelUnavailable(
  modelId: string | null,
  availableModels: readonly string[] | null | undefined,
): boolean {
  if (!modelId) return false;
  if (!availableModels || availableModels.length === 0) return false;
  return !availableModels.includes(modelId);
}
