/**
 * 上下文压缩：长会话不撑爆窗口。
 *
 * 逆向自 PKPM Agent 的 middleware/context_compaction（79 个签名，739KB）。
 * 这里实现它的四条核心规则，不做完整移植：
 *
 *   1. **安全切点**：不能把 assistant 的 tool_call 与它的 tool_result 切断，
 *      否则模型看到半个调用会失真。
 *   2. **原子组**：一条 assistant 消息连同它的全部 tool 结果是一组，
 *      压缩时整组进或整组留。
 *   3. **原文可回查**：压缩不是删除，摘要里留指针，
 *      被压掉的内容仍能按需 browse 回来。
 *   4. **技能读取不压缩**：`use_skill` 读到的内容是有意拉进上下文的，
 *      压掉等于白读。
 *
 * 未实现的部分（需要模型调用）：分级摘要、tpc 动态校准、跨压缩整体摘要。
 * 这些在接入摘要模型后补，当前只做「确定性可做」的部分。
 */

/** 参与压缩的消息最小形状。字段名对齐 LangChain/LangGraph 的常见约定。 */
export interface CompactableMessage {
  /** 角色或类型标识：`human` / `ai` / `tool` / `system`。 */
  role: string;
  /** 文本内容；结构化内容不在此展开。 */
  content?: unknown;
  /** assistant 发起的工具调用。 */
  toolCalls?: { id: string; name: string }[];
  /** tool 消息回应的调用 id。 */
  toolCallId?: string;
  /** 工具名（tool 消息上）。 */
  toolName?: string;
}

export interface CompactionOptions {
  /** 保留尾部多少条消息不压缩。 */
  tailKeep?: number;
  /** 本模块不生成摘要，由调用方提供；缺省时用占位文本。 */
  summarize?: (messages: CompactableMessage[]) => Promise<string> | string;
  /** 压缩后在摘要里写入的历史文件指针，供回查。 */
  historyPointer?: string;
}

export interface CompactionResult {
  /** 压缩后的消息序列：摘要 + 保留的尾部。 */
  messages: CompactableMessage[];
  /** 被压缩掉的消息条数。 */
  compactedCount: number;
  /** 实际上是否发生了压缩。 */
  changed: boolean;
}

/** 默认保留尾部条数。 */
const DEFAULT_TAIL_KEEP = 8;

/** 判断一条消息是否是工具结果。 */
function isToolResult(message: CompactableMessage): boolean {
  return message.role === "tool" || typeof message.toolCallId === "string";
}

/** 判断一条消息是否发起了工具调用。 */
function hasToolCalls(message: CompactableMessage): boolean {
  return Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
}

/** 判断是否为技能读取（技能内容属于「有意拉进上下文」，不压缩）。 */
function isSkillRead(message: CompactableMessage): boolean {
  return (
    message.role === "tool" &&
    typeof message.toolName === "string" &&
    (message.toolName === "use_skill" || message.toolName === "read_skill")
  );
}

/**
 * 找安全切点：切点之前压缩、之后保留。
 *
 * 规则：切点不能落在「assistant 的 tool_call」与「它对应的 tool 结果」之间。
 * 如果切点后第一条是 tool 结果，向前回退到发起调用的那条 assistant 之前。
 */
export function findSafeCutoff(
  messages: CompactableMessage[],
  desired: number,
): number {
  let cutoff = Math.max(0, Math.min(desired, messages.length));

  // 向前回退：只要切点位置是工具结果，就继续回退。
  while (cutoff > 0 && cutoff < messages.length && isToolResult(messages[cutoff]!)) {
    // 往回找到发起这次调用的 assistant，从它的前一条开始切。
    const callId = messages[cutoff]!.toolCallId;
    let index = cutoff - 1;
    while (index >= 0) {
      const candidate = messages[index]!;
      if (hasToolCalls(candidate) && (!callId || candidate.toolCalls?.some((c) => c.id === callId))) {
        cutoff = index;
        break;
      }
      index -= 1;
    }
    // 找不到发起者就停在这里，避免死循环。
    if (index < 0) break;
  }

  return cutoff;
}

/**
 * 把「每条 assistant 及其后续工具结果」归为原子组。
 *
 * 返回的是起始下标数组；压缩时按组边界切。
 */
export function atomicGroupStarts(messages: CompactableMessage[]): number[] {
  const starts: number[] = [];
  let index = 0;
  while (index < messages.length) {
    starts.push(index);
    const message = messages[index]!;
    index += 1;
    // assistant 带工具调用时，把紧跟的工具结果一起吞进本组。
    if (hasToolCalls(message)) {
      while (index < messages.length && isToolResult(messages[index]!)) index += 1;
    }
  }
  return starts;
}

/**
 * 压缩消息序列。
 *
 * 保守实现：只把「头部可压缩区」换成一条摘要，尾部原样保留。
 * 技能读取的消息即使落在头部也会被提出来保留。
 */
export async function compactMessages(
  messages: CompactableMessage[],
  options: CompactionOptions = {},
): Promise<CompactionResult> {
  const tailKeep = options.tailKeep ?? DEFAULT_TAIL_KEEP;

  if (messages.length <= tailKeep) {
    return { messages, compactedCount: 0, changed: false };
  }

  const desired = messages.length - tailKeep;
  const cutoff = findSafeCutoff(messages, desired);

  if (cutoff <= 0) {
    return { messages, compactedCount: 0, changed: false };
  }

  const head = messages.slice(0, cutoff);
  const tail = messages.slice(cutoff);

  // 技能读取不能被压掉：从头部提出来，放到摘要之后、尾部之前保留。
  const pinned = head.filter(isSkillRead);
  const compactable = head.filter((message) => !isSkillRead(message));

  if (compactable.length === 0) {
    return { messages, compactedCount: 0, changed: false };
  }

  const summary = options.summarize
    ? await options.summarize(compactable)
    : defaultSummary(compactable, options.historyPointer);

  const summaryMessage: CompactableMessage = {
    role: "system",
    content: summary,
  };

  const next = [summaryMessage, ...pinned, ...tail];
  return {
    messages: next,
    compactedCount: compactable.length,
    changed: true,
  };
}

/** 无摘要模型时的兜底：如实说明压掉了多少条，并给回查指针。 */
function defaultSummary(
  messages: CompactableMessage[],
  historyPointer: string | undefined,
): string {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
  }
  const detail = Object.entries(counts)
    .map(([role, count]) => `${role} ${count} 条`)
    .join("、");
  const lines = [
    `已压缩 ${messages.length} 条历史消息（${detail}）。`,
    "以下对话是从这里继续的。",
  ];
  if (historyPointer) {
    lines.push(`被压缩的原文仍可通过 ${historyPointer} 回查。`);
  }
  return lines.join("\n");
}

export { DEFAULT_TAIL_KEEP, isSkillRead, isToolResult, hasToolCalls };
