/**
 * 技能「使用」入口（M1 增强）的纯逻辑：mention 预填组装与按钮显示判定。
 *
 * 为什么单独成文件：与 `expertSummon.ts` 同款考虑——按钮行为只有一条字符串约定
 * （`$技能名` mention），断了不会报错，只是点击后草稿里缺技能引用。纯函数抽出便于
 * `npx tsx --test packages/ui/test/skillUsage.test.ts` 钉住口径。
 *
 * 发送通道与专家召唤完全同源（`onCreateTask({initialPrompt, initialPromptMention})`，
 * 只写草稿，**绝不自动发送**）；服务端 catalog 未下发 skill path，故只能组装 `$name`
 * 形态，不做路径猜测。
 */
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

/** 组装技能 mention 预填：`category: "skills"` + `$name` markdown（与 `$` 面板同形态）。 */
export function buildSkillUsePrefill(name: string, title?: string | null): ComposerMentionPrefill {
  const trimmedName = name.trim();
  return {
    id: `skill:${trimmedName}`,
    category: "skills",
    label: trimmedName,
    value: trimmedName,
    markdown: buildSkillMentionMarkdown(trimmedName),
    ...(title ? { description: title } : {}),
  };
}

export interface SkillUseActionVisibility {
  /** 服务端安装关系（`skill_installs` 写后 re-GET）。 */
  readonly installed: boolean;
  /** 解析后的启用态（工作区覆盖 > 全局 > 默认启用）。 */
  readonly enabled: boolean;
  /** 宿主是否提供新建会话通道（缺省时相关入口隐藏，同专家 starters 的可选通道）。 */
  readonly hasCreateTask: boolean;
}

/**
 * 「使用」按钮显示判定：三者皆真才显示。
 *
 * `enabled` 条件与 mention 面板过滤口径一致（`skillsMentionProvider.ts` 只列启用态技能）——
 * 停用的技能在 `$` 面板里不存在，此时给按钮只会制造一个插了也没人执行的死入口。
 */
export function shouldShowSkillUseAction(visibility: SkillUseActionVisibility): boolean {
  return visibility.installed && visibility.enabled && visibility.hasCreateTask;
}
