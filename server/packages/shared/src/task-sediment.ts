/**
 * 长任务沉淀技能（W5-③）—— **纯函数层**。
 *
 * 设计来源：penguin-harness `skills.zh.md` 的 `continual-learning` 模式
 * （见 `docs/参考项目调研/penguin-harness-0.2.11-调研报告.md` §7）。
 *
 * ## 解决的问题
 *
 * Reactor 有技能市场（可写 SKILL.md），但**没有「沉淀」的触发机制** ——
 * 用户把一个复杂任务跑通了，经验就丢了，下次还得重讲。这一层让技能库**自己长大**。
 *
 * ## penguin 的规则（逐条照抄）
 *
 * - 刚结束的任务跑了**超过 30 个完成的轮次**才触发 → **短任务从不触发**；
 * - **窗口就是任务本身**：一个任务**至多触发一次**（不是每轮都问）；
 * - **没有安装任何技能就不会触发**（没有沉淀目标，问了也是白问）；
 * - 浓缩内容 = 截断的 user/assistant 文本 + 工具调用与输出，
 *   **不含思考（thinking）与图片** —— 思考是过程噪声，图片无法写进 SKILL.md；
 * - prompt 里给出**技能目录**与该任务**调用过的技能名**，请子会话把值得沉淀的发现
 *   写进相关 `SKILL.md` 并递增版本。
 *
 * ## 与 penguin 的差异（刻意）
 *
 * penguin 把这件事做成 stop hook 的 `subagent` 决策（外部子进程 + JSON 协议）。
 * Reactor 不需要那套骨架：我们已有 `extensionFactories` 这一**进程内**扩展通道
 * （W2/W4 的策略/上下文/质量钩子都走它）。因此本层只负责「**判断该不该沉淀 +
 * 浓缩 + 组装 prompt**」，由 `sediment-hook.ts` 在下一轮 agent 启动时把指令注入 ——
 * 于是 **不依赖 D1/D2**（那两条是「hook 包如何下发与信任」，与进程内触发无关）。
 */

import { shortHash } from "./context/types.js";

// ---------------------------------------------------------------------------
// 常量（照 penguin）
// ---------------------------------------------------------------------------

/** 触发阈值：完成的轮次**超过**该值（`> 30`，不是 `>=`） */
export const SEDIMENT_TURN_THRESHOLD = 30;

/** 浓缩结果的总字符上限 */
export const SEDIMENT_CONDENSED_MAX_CHARS = 12_000;
/** 单条 user/assistant 文本截断长度 */
export const SEDIMENT_TEXT_ITEM_CHARS = 600;
/** 单条工具输出截断长度 */
export const SEDIMENT_TOOL_ITEM_CHARS = 400;
/** 最多保留多少条消息 / 多少次工具调用（保**尾部**，最近的最相关） */
export const SEDIMENT_MAX_MESSAGES = 60;
export const SEDIMENT_MAX_TOOL_CALLS = 40;

// ---------------------------------------------------------------------------
// 触发判定
// ---------------------------------------------------------------------------

export interface SedimentContext {
  /** 本任务**已完成**的轮次数 */
  readonly completedTurns: number;
  /** 该 Agent 已安装的技能名（空 = 没有沉淀目标） */
  readonly installedSkills: readonly string[];
  /** 本任务调用过的技能名 */
  readonly usedSkills: readonly string[];
  /** 本任务是否已经沉淀过（一个任务至多一次） */
  readonly alreadySedimented: boolean;
  /**
   * 覆盖触发阈值（缺省 `SEDIMENT_TURN_THRESHOLD`）。
   *
   * 参数化的理由：阈值是**产品标定**（30 轮），但探针要用小值构造场景。
   * 修前它被写死在函数体内，于是调用方即使想调低也调不动 —— 表现为
   * 「探针用小阈值时永不触发」，只能靠假造 30 轮来测，测试又慢又假。
   */
  readonly turnThreshold?: number;
}

export interface SedimentDecision {
  readonly shouldSediment: boolean;
  /** 不触发的原因（用于日志/UI：**可诊断**，不要静默不动作） */
  readonly reason: string;
}

/**
 * 判断是否该沉淀（**纯函数**）。
 *
 * 四个条件**全部**满足才触发，顺序即短路顺序（先便宜的判断）：
 *  1. 本任务尚未沉淀过（至多一次）；
 *  2. 已完成轮次 `> 30`（短任务从不触发）；
 *  3. **该 Agent 至少装了一个技能**（没有沉淀目标）；
 *  4. 本任务**至少调用过一个技能** —— 我们的补充：penguin 只把「已装技能」作为
 *     门槛，但如果一个都没用到，子会话只能对着 SKILL.md 空写；用过的技能才是
 *     真正值得更新的目标。这一条把「空转一次子会话」挡掉。
 */
export function shouldSediment(ctx: SedimentContext): SedimentDecision {
  if (ctx.alreadySedimented) {
    return { shouldSediment: false, reason: "本任务已沉淀过（一个任务至多一次）" };
  }
  const threshold = ctx.turnThreshold ?? SEDIMENT_TURN_THRESHOLD;
  if (ctx.completedTurns <= threshold) {
    return {
      shouldSediment: false,
      reason: `完成任务轮次 ${ctx.completedTurns} ≤ ${threshold}（短任务不触发）`,
    };
  }
  if (ctx.installedSkills.length === 0) {
    return { shouldSediment: false, reason: "该 Agent 未安装任何技能（无沉淀目标）" };
  }
  if (ctx.usedSkills.length === 0) {
    return { shouldSediment: false, reason: "本任务未调用任何技能（无更新对象）" };
  }
  return {
    shouldSediment: true,
    reason: `完成 ${ctx.completedTurns} 轮且用过 ${ctx.usedSkills.length} 个技能`,
  };
}

// ---------------------------------------------------------------------------
// 浓缩
// ---------------------------------------------------------------------------

/** 待浓缩的一条消息（只取我们需要的形状，便于从 Pi 消息映射过来） */
export interface SedimentMessage {
  readonly role: string;
  /** 纯文本（已由调用方从 content 数组里抽好；thinking/图片不在此列） */
  readonly text?: string;
  /** 该消息里的工具调用：名称 + 参数摘要 */
  readonly toolCalls?: readonly { readonly name: string; readonly args?: string }[];
  /** 工具结果（文本） */
  readonly toolResult?: { readonly name: string; readonly text: string; readonly isError?: boolean };
}

export interface CondensedTask {
  readonly text: string;
  readonly includedMessages: number;
  readonly includedToolCalls: number;
  readonly droppedMessages: number;
  readonly truncated: boolean;
}

const cap = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`);

/**
 * 把一段任务浓缩成可交给后台子会话的文本（照 penguin：截断文本 + 工具调用与输出，
 * **不含思考与图片**）。
 *
 * 两条取舍：
 *  - **保尾部**：最近的内容与「刚跑通的经验」最相关；超出上限时丢最旧的；
 *  - **显式标注截断**：告诉子会话「这里被截过」，避免它把截断处当成完整内容来总结。
 *    这与 W5-④ 里「不静默变短」是同一条纪律。
 */
export function condenseTask(messages: readonly SedimentMessage[]): CondensedTask {
  const kept = messages.length > SEDIMENT_MAX_MESSAGES ? messages.slice(messages.length - SEDIMENT_MAX_MESSAGES) : messages;
  const droppedMessages = messages.length - kept.length;

  const parts: string[] = [];
  let toolCallCount = 0;
  let truncated = droppedMessages > 0;

  for (const msg of kept) {
    const lines: string[] = [];
    const text = (msg.text ?? "").trim();
    if (text !== "") {
      const capped = cap(text, SEDIMENT_TEXT_ITEM_CHARS);
      if (capped !== text) truncated = true;
      lines.push(`${msg.role}: ${capped}`);
    }
    for (const call of msg.toolCalls ?? []) {
      if (toolCallCount >= SEDIMENT_MAX_TOOL_CALLS) {
        truncated = true;
        break;
      }
      toolCallCount += 1;
      const args = call.args === undefined ? "" : ` ${cap(call.args.replace(/\s+/g, " ").trim(), SEDIMENT_TOOL_ITEM_CHARS)}`;
      lines.push(`  → tool ${call.name}${args}`);
    }
    if (msg.toolResult !== undefined) {
      const res = cap(msg.toolResult.text.replace(/\s+/g, " ").trim(), SEDIMENT_TOOL_ITEM_CHARS);
      if (res.length !== msg.toolResult.text.length) truncated = true;
      lines.push(`  ← ${msg.toolResult.isError === true ? "ERROR " : ""}${msg.toolResult.name}: ${res}`);
    }
    if (lines.length > 0) parts.push(lines.join("\n"));
  }

  let text = parts.join("\n");
  if (text.length > SEDIMENT_CONDENSED_MAX_CHARS) {
    // 保尾部：截掉最早的部分（与「保尾部」取舍一致）
    text = `…[earlier content dropped]\n${text.slice(text.length - SEDIMENT_CONDENSED_MAX_CHARS)}`;
    truncated = true;
  }

  return {
    text,
    includedMessages: kept.length,
    includedToolCalls: toolCallCount,
    droppedMessages,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Prompt 组装
// ---------------------------------------------------------------------------

export interface SedimentPromptInput {
  readonly condensed: string;
  /** 技能根目录（子会话据此写 SKILL.md） */
  readonly skillsDir: string;
  readonly installedSkills: readonly string[];
  readonly usedSkills: readonly string[];
  readonly taskId?: string;
}

/**
 * 组装请子会话沉淀的 prompt（照 penguin：给出**技能目录**与**该任务调用过的技能名**）。
 *
 * 刻意写清三条约束，因为它们决定沉淀质量：
 *  - **只写「可复用」的**：一次性的、与具体数据绑定的结论不该进技能（否则技能库变垃圾场）；
 *  - **写进已用过的技能**，不要新建（新建会让技能爆炸，且用户没见过它）；
 *  - **递增版本**：这样更新检查能发现变化（penguin 的 `version` 语义）。
 */
export function buildSedimentPrompt(input: SedimentPromptInput): string {
  const used = input.usedSkills.length > 0 ? input.usedSkills.join("、") : "（无）";
  const installed = input.installedSkills.length > 0 ? input.installedSkills.join("、") : "（无）";
  return [
    `[长任务经验沉淀] 刚结束的任务跑了 30 轮以上，请把**可复用**的经验写进技能库。`,
    ``,
    `技能根目录：${input.skillsDir}`,
    `本任务调用过的技能：${used}`,
    `该 Agent 已安装的技能：${installed}`,
    ...(input.taskId !== undefined ? [`任务标识：${input.taskId}`] : []),
    ``,
    `要求：`,
    `1. **只沉淀可复用的**：可复用的做法、坑、约定、参数取值。与具体数据/一次性结论无关的内容不要写（技能库变垃圾场比不写更糟）。`,
    `2. **优先更新「本任务调用过的技能」**：这些是真正用到的目标；不要为此新建技能（新建会让技能列表膨胀，且用户并未选择它）。`,
    `3. 写进对应技能目录下的 \`SKILL.md\`（正文按原有结构追加/修订小节），并**递增版本**，便于更新检查发现变化。`,
    `4. 若确实没有值得沉淀的内容，**明确回复「无可沉淀」**，不要为凑数而写。`,
    ``,
    `—— 以下是该任务的浓缩记录（已截断，不含思考与图片）——`,
    input.condensed,
  ].join("\n");
}

/** 任务标识：用首条用户消息 + 轮次做稳定指纹（同一任务重复触发时同 id） */
export function sedimentTaskId(firstUserText: string, completedTurns: number): string {
  return `sed-${shortHash(`${firstUserText.slice(0, 200)}\u0000${SEDIMENT_TURN_THRESHOLD}`)}-${completedTurns}`;
}
