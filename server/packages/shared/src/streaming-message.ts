/**
 * 在途流式消息的独立 reducer（清单 #28 / #29 / #30）——
 * 移植 pi-web `lib/streaming-message.ts`（MIT）。
 *
 * ## 为什么必须独立于已提交消息数组
 *
 * 早期实现把**在途助手消息直接 upsert 进 `messages` 数组**，与本轮之前的
 * 已提交消息混在同一个数组里。这一个决定派生出整类难修的缺陷：
 *  - 实时路径用合成 id（`m<N>:role:ts`）、磁盘回放用 `entryId` —— 两套命名空间
 *    无法互认，`openSession` 的「按 id 去重」对同一消息的两种形态永远失效 → 渲染两条；
 *  - 迟到/重复的流式帧会把**已提交**的消息重新点亮成「生成中」并覆盖其文本；
 *  - 同毫秒消息 id 碰撞 → 用户消息被静默丢弃 / 助手消息被覆盖。
 *
 * pi-web 的解法是**从结构上消灭这类状态**：在途消息只活在独立的
 * `{isStreaming, streamingMessage}` 槽里，`messages` 只装已提交消息 ——
 * 「同一条逻辑消息存在于两处」这一前提不存在了，上述缺陷无法发生。
 *
 * ## delta 逐块增量（清单 #30）
 *
 * `message_update` 同时携带**完整部分消息**与 `assistantMessageEvent`。
 * 早期只读前者，每个 token 都要对整条消息重新 `normalizeBlocks` + `blocksToText`
 * （长回复呈 O(n²) 抖动），且 `toolcall_delta` 的工具参数流式完全不可达
 * （`MessageView` 的「正在生成调用参数…」是死代码）。这里按 pi 的 delta 协议
 * 逐块追加。
 */

/** pi 的 `AssistantMessageEvent` 子集（delta 形态；`start`/`done`/`error` 由外层处理） */
export type AssistantDeltaEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: { id: string; name: string; arguments?: unknown } };

/** 在途消息里的块形状（与 shared projector 的 ContentBlock 对应） */
export type StreamingBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments?: unknown;
      rawInput?: string;
      /** 实时执行进度行（清单 #39b）：由 tool_execution_update 写入 */
      progress?: string;
    };

export interface StreamingMessage {
  blocks: StreamingBlock[];
  model?: string;
  provider?: string;
  timestamp?: number;
}

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: StreamingMessage | null;
}

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

function withBlock(
  state: StreamingState,
  contentIndex: number,
  update: (current: StreamingBlock | undefined) => StreamingBlock | null,
): StreamingState {
  const message = state.streamingMessage;
  if (!message || !Number.isInteger(contentIndex) || contentIndex < 0) return state;
  const blocks = [...message.blocks];
  const next = update(blocks[contentIndex]);
  if (!next) return state;
  blocks[contentIndex] = next;
  return { isStreaming: true, streamingMessage: { ...message, blocks } };
}

function applyDelta(state: StreamingState, event: AssistantDeltaEvent): StreamingState {
  switch (event.type) {
    case "text_start":
      return withBlock(state, event.contentIndex, (cur) => (
        cur?.type === "text" ? cur : { type: "text", text: "" }
      ));
    case "text_delta":
      return withBlock(state, event.contentIndex, (cur) => (
        cur?.type === "text" ? { ...cur, text: cur.text + event.delta } : { type: "text", text: event.delta }
      ));
    case "text_end":
      return withBlock(state, event.contentIndex, (cur) => ({
        ...(cur?.type === "text" ? cur : {}),
        type: "text",
        text: event.content,
      }));
    case "thinking_start":
      return withBlock(state, event.contentIndex, (cur) => (
        cur?.type === "thinking" ? cur : { type: "thinking", thinking: "" }
      ));
    case "thinking_delta":
      return withBlock(state, event.contentIndex, (cur) => (
        cur?.type === "thinking" ? { ...cur, thinking: cur.thinking + event.delta } : { type: "thinking", thinking: event.delta }
      ));
    case "thinking_end":
      return withBlock(state, event.contentIndex, (cur) => ({
        ...(cur?.type === "thinking" ? cur : {}),
        type: "thinking",
        thinking: event.content,
      }));
    case "toolcall_start":
      return withBlock(state, event.contentIndex, (cur) => {
        if (cur?.type === "toolCall") return { ...cur, rawInput: cur.rawInput ?? "" };
        return { type: "toolCall", id: "", name: "", arguments: {}, rawInput: "" };
      });
    case "toolcall_delta":
      return withBlock(state, event.contentIndex, (cur) => (
        cur?.type === "toolCall"
          ? { ...cur, rawInput: (cur.rawInput ?? "") + event.delta }
          : { type: "toolCall", id: "", name: "", arguments: {}, rawInput: event.delta }
      ));
    case "toolcall_end":
      return withBlock(state, event.contentIndex, () => ({
        type: "toolCall",
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments,
      }));
    default:
      return state;
  }
}

export type StreamAction =
  | { type: "start" }
  | { type: "snapshot"; message: StreamingMessage }
  | { type: "delta"; event: AssistantDeltaEvent }
  | { type: "end" };

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "snapshot":
      return { isStreaming: true, streamingMessage: action.message };
    case "delta":
      return applyDelta(state, action.event);
    case "end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}

/** 在途块 → 文本（供「复制/去重比较」等只关心正文的场景） */
export function streamingBlocksToText(blocks: readonly StreamingBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") out += b.text;
  }
  return out;
}

/** 在途块 → `ContentBlock[]`（供渲染层复用既有 MessageView/BlockView） */
export function streamingBlocksToContentBlocks(blocks: readonly StreamingBlock[]): unknown[] {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "thinking") return { type: "thinking", thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) };
    return {
      type: "toolCall",
      id: b.id,
      name: b.name,
      ...(b.arguments !== undefined ? { arguments: b.arguments } : {}),
      ...(b.rawInput !== undefined ? { rawInput: b.rawInput } : {}),
      ...(b.progress !== undefined ? { progress: b.progress } : {}),
    };
  });
}

/** 在途态 → 渲染用消息（id 固定为 `__streaming__`：它不在已提交数组里，只作临时展示） */
export const STREAMING_MESSAGE_ID = "__streaming__";

export interface StreamingEnvelope {
  /** pi 信封字段（`message_end` 携带的完整消息） */
  model?: string;
  provider?: string;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
}

/**
 * 在途态 + 信封 → 一条可渲染的助手消息（`streaming: true`）。
 * 渲染层把它拼在已提交消息之后展示 —— 这是「在途与已提交分离」的对外接口。
 */
export function streamingToRenderable(
  state: StreamingState,
  envelope?: StreamingEnvelope,
): {
  id: string;
  kind: "assistant";
  text: string;
  streaming: boolean;
  blocks?: unknown[];
  meta?: { model?: string; provider?: string; timestamp?: number; usage?: unknown };
  stopReason?: string;
  errorMessage?: string;
} | null {
  const msg = state.streamingMessage;
  if (!msg || msg.blocks.length === 0) return null;
  const text = streamingBlocksToText(msg.blocks);
  const model = envelope?.model ?? msg.model;
  const provider = envelope?.provider ?? msg.provider;
  const timestamp = envelope?.timestamp ?? msg.timestamp;
  const meta = model || provider || timestamp !== undefined
    ? { ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(timestamp !== undefined ? { timestamp } : {}) }
    : undefined;
  return {
    id: STREAMING_MESSAGE_ID,
    kind: "assistant",
    text,
    streaming: true,
    blocks: streamingBlocksToContentBlocks(msg.blocks),
    ...(meta ? { meta } : {}),
    ...(envelope?.stopReason ? { stopReason: envelope.stopReason } : {}),
    ...(envelope?.errorMessage ? { errorMessage: envelope.errorMessage } : {}),
  };
}

/**
 * pi 的 delta 事件 → 本模块的 `AssistantDeltaEvent`。
 *
 * 只做字段归一（pi 的 `toolcall_end` 把工具调用放在 `toolCall` 字段里，
 * 而 `toolcall_start` 的 id/name 可能延后到 end 才齐）。`start`/`done`/`error`
 * 不属于 delta 形态，返回 null 交由调用方走 snapshot 路径。
 */
export function mapPiDeltaToStream(raw: Record<string, unknown>): AssistantDeltaEvent | null {
  const type = typeof raw.type === "string" ? raw.type : "";
  const contentIndex = typeof raw.contentIndex === "number" ? raw.contentIndex : 0;
  switch (type) {
    case "text_start":
      return { type: "text_start", contentIndex };
    case "text_delta":
      return { type: "text_delta", contentIndex, delta: typeof raw.delta === "string" ? raw.delta : "" };
    case "text_end":
      return { type: "text_end", contentIndex, content: typeof raw.content === "string" ? raw.content : "" };
    case "thinking_start":
      return { type: "thinking_start", contentIndex };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex, delta: typeof raw.delta === "string" ? raw.delta : "" };
    case "thinking_end":
      return { type: "thinking_end", contentIndex, content: typeof raw.content === "string" ? raw.content : "" };
    case "toolcall_start":
      return { type: "toolcall_start", contentIndex };
    case "toolcall_delta":
      return { type: "toolcall_delta", contentIndex, delta: typeof raw.delta === "string" ? raw.delta : "" };
    case "toolcall_end": {
      const tc = (raw.toolCall ?? {}) as Record<string, unknown>;
      return {
        type: "toolcall_end",
        contentIndex,
        toolCall: {
          id: typeof tc.id === "string" ? tc.id : "",
          name: typeof tc.name === "string" ? tc.name : "",
          ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * pi 部分消息 → 在途态（`snapshot` 动作的入参）。
 *
 * `message_start` / 每个 `message_update` 都带**完整部分消息**，这里把它的
 * content blocks 规范化成在途块。注意 content 里 toolCall 的字段名是 pi 的
 * `id`/`name`/`arguments`（回放路径由 projector 的 normalizeBlocks 处理）。
 */
export function normalizeStreamingFromPi(raw: unknown): StreamingMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return null;
  const blocks: StreamingBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    if (b.type === "text") {
      blocks.push({ type: "text", text: typeof b.text === "string" ? b.text : "" });
    } else if (b.type === "thinking") {
      blocks.push({
        type: "thinking",
        thinking: typeof b.thinking === "string" ? b.thinking : "",
        ...(typeof b.signature === "string" ? { signature: b.signature } : {}),
      });
    } else if (b.type === "toolCall") {
      const id = typeof b.id === "string" ? b.id : typeof b.toolCallId === "string" ? b.toolCallId : "";
      const name = typeof b.name === "string" ? b.name : typeof b.toolName === "string" ? b.toolName : "";
      blocks.push({
        type: "toolCall",
        id,
        name,
        ...(b.arguments !== undefined ? { arguments: b.arguments } : {}),
        ...(typeof b.rawInput === "string" ? { rawInput: b.rawInput } : {}),
      });
    }
  }
  return {
    blocks,
    ...(typeof msg.model === "string" ? { model: msg.model } : {}),
    ...(typeof msg.provider === "string" ? { provider: msg.provider } : {}),
    ...(typeof msg.timestamp === "number" ? { timestamp: msg.timestamp } : {}),
  };
}
