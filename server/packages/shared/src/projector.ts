/**
 * session-event → UI 消息 DTO 投影器（纯函数，无 React 依赖）。
 *
 * 渲染层零 agent 逻辑：投影在共享包收敛，client 组件只渲染 DTO。
 * v2：支持 Pi 结构化 content blocks（thinking/text/toolCall），对齐 pi-web 消息渲染；
 * 保留 text 字段作降级与历史回放兼容。
 */
import { parseCompactionSummary } from "./compaction-summary.js";
import { getToolExecutionProgress } from "./tool-execution-progress.js";

// ---------------------------------------------------------------------------
// UI DTO
// ---------------------------------------------------------------------------

/** 结构化内容块（对齐 Pi AgentMessage.content / pi-web AssistantContentBlock） */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
      /**
       * 历史思考按需加载（清单 #40）：回放时只带预览，全文经 `get_thinking` RPC 拉取。
       * 流式实时思考不受影响（deferred 恒为 false/缺省）。
       */
      deferred?: boolean;
      /** 该块在本条 assistant 消息 thinking 块序列中的序号（取全文的定位键） */
      blockIndex?: number;
    }
  | {
      /**
       * 助手返回的图片块（清单 #34）。
       * 早期实现显式「image 等 M0 忽略」→ 模型返回图表/截图/渲染图时**只剩周围文字**，
       * 图片被静默删除且无任何占位。pi-web 把 text 与 image 一并视为最终答复块并渲染
       * （`message-display.ts:35` / `MessageView.tsx:1555-1558`）。
       */
      type: "image";
      /** data URL（base64 已带 mime 前缀）或原始 base64 */
      data?: string;
      mimeType?: string;
      /** 远端图片 URL（若有） */
      url?: string;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments?: unknown;
      /** 流式参数原文（生成中） */
      rawInput?: string;
      /** 配对结果（pi-web: text + isError + details.patch/diff） */
      result?: { text: string; isError: boolean; details?: unknown };
      /** 执行耗时（秒，四舍五入） */
      duration?: number;
      /**
       * 实时进度行（清单 #39b）：tool_execution_update 的最后一行非空文本，
       * 执行结束后清空（结果在 result 里呈现）。
       */
      progress?: string;
    };

/** pi-web AssistantMessageView 所需的消息元数据（Pi 信封字段透传） */
export interface UsageInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

export interface AssistantMeta {
  model?: string;
  provider?: string;
  usage?: UsageInfo;
  /** epoch ms */
  timestamp?: number;
}

export type UiMessage =
  | { id: string; kind: "user"; text: string }
  | {
      id: string;
      kind: "assistant";
      text: string;
      streaming: boolean;
      /** 结构化块（新会话实时路径）；历史回放/降级时缺省 */
      blocks?: ContentBlock[];
      /** 模型/用量/时间（pi-web 消息头尾渲染用） */
      meta?: AssistantMeta;
      /**
       * 上游失败原因（pi `AssistantMessage.stopReason === "error"` 时存在）。
       * 早期实现从不读这两个字段 → 上游 400/鉴权失败/内容过滤只显示**空气泡**，
       * 真实错误文本在投影时被丢弃，用户完全看不到失败原因。
       */
      stopReason?: string;
      errorMessage?: string;
    }
  | { id: string; kind: "tool"; name: string; argsPreview: string; status: "running" | "done" | "error"; resultPreview?: string }
  | {
      /**
       * 压缩分隔条（清单 #33）：上下文被压缩时在对话流里显示一条明确标记，
       * 否则上下文悄悄缩小而 UI 还显示旧对话，用户不知道历史已被折叠。
       */
      id: string;
      kind: "compaction";
      summary: string;
      /** 压缩前保留的最早条目 id（pi `compaction.firstKeptEntryId`） */
      firstKeptEntryId?: string;
      /** 是否仍在压缩中（compaction_start） */
      running: boolean;
      /** 压缩过程中读取的文件（清单 #33b：摘要分节解析） */
      readFiles?: string[];
      /** 压缩过程中修改的文件（同上） */
      modifiedFiles?: string[];
    }
  | {
      /**
       * 终端执行输出（清单 #41）：pi-web 有专用 `BashExecutionMessage` 渲染
       * （`ChatWindow.tsx:1205-1222`），早期实现把它伪装成 assistant 文本 ——
       * 样式上与模型回复混淆，且无法区分「正在跑」与「已结束」。
       */
      id: string;
      kind: "bash";
      /** 已累计的输出（增量追加） */
      text: string;
      running: boolean;
    };

/** pi-web `message-display.ts:getAssistantErrorMessage` 同款语义：流式中不显示错误 */
export function getAssistantErrorMessage(
  message: { streaming?: boolean; stopReason?: string; errorMessage?: string },
): string | null {
  if (message.streaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/** 投影器消费的事件子集 */
export interface ProjectEvent {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 文本抽取（防御性兼容）
// ---------------------------------------------------------------------------

export function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((part) => extractText(part))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.thinking === "string") return obj.thinking;
    if (obj.message !== undefined) return extractText(obj.message);
    if (obj.content !== undefined) return extractText(obj.content);
    if (typeof obj.delta === "string") return obj.delta;
    return "";
  }
  return "";
}

/** 规整 Pi content（blocks 数组）→ ContentBlock[]；非数组/空返回空数组 */
export function normalizeBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    if (b.type === "thinking") {
      out.push({ type: "thinking", thinking: extractText(b.thinking), ...(typeof b.signature === "string" ? { signature: b.signature } : {}) });
    } else if (b.type === "toolCall") {
      out.push({
        type: "toolCall",
        id: typeof b.id === "string" ? b.id : typeof (b as { toolCallId?: unknown }).toolCallId === "string" ? String((b as { toolCallId?: unknown }).toolCallId) : `tc-${out.length}`,
        name: typeof b.name === "string" ? b.name : "tool",
        ...(b.arguments !== undefined ? { arguments: b.arguments } : {}),
        ...(typeof b.rawInput === "string" ? { rawInput: b.rawInput } : {}),
      });
    } else if (b.type === "text") {
      out.push({ type: "text", text: extractText(b.text) });
    } else if (b.type === "image") {
      // 助手图片块（清单 #34）：不再静默丢弃 —— 模型返回图表/截图时必须可见
      const data = typeof b.data === "string" ? b.data : undefined;
      const mimeType = typeof b.mimeType === "string" ? b.mimeType : typeof (b as { mime_type?: unknown }).mime_type === "string" ? String((b as { mime_type?: unknown }).mime_type) : undefined;
      const url = typeof b.url === "string" ? b.url : undefined;
      if (data || url) {
        out.push({ type: "image", ...(data ? { data } : {}), ...(mimeType ? { mimeType } : {}), ...(url ? { url } : {}) });
      }
    }
  }
  return out;
}

/** blocks → 可读文本（markdown 正文 + 思考摘要；toolCall 省略） */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

function metaOf(msg: unknown): AssistantMeta | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as Record<string, unknown>;
  const meta: AssistantMeta = {};
  if (typeof m.model === "string") meta.model = m.model;
  if (typeof m.provider === "string") meta.provider = m.provider;
  if (typeof m.timestamp === "number") meta.timestamp = m.timestamp;
  const u = m.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object" && typeof u.input === "number" && typeof u.output === "number") {
    const cost = (u.cost ?? {}) as Record<string, unknown>;
    meta.usage = {
      input: u.input,
      output: u.output,
      cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
      cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
      cost: { total: typeof cost.total === "number" ? cost.total : 0 },
    };
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * 消息身份（**关键**）。
 *
 * pi 的 AgentMessage **没有 id 字段**（`UserMessage{role,content,timestamp}` /
 * `AssistantMessage{role,content,api,provider,model,usage,stopReason,timestamp}`），
 * 而 `message_start`/`message_update`/`message_end` 携带的是同一条无 id 消息。
 *
 * 早期实现回退成常量 "cur"，后果是**所有消息共用同一 id** → `upsert` 原地替换而非追加 →
 * 每一轮新回复都覆盖掉上一轮（表现为「所有回复都堆在第一层」），且乐观插入的用户消息
 * 与事件回传的用户消息 id 不同而渲染两条。
 *
 * 身份来源优先级：
 *  1. 显式 `id`（pi 未来若补上，或非 pi 来源的消息）；
 *  2. `timestamp` —— 实测同一消息的 start/update/end 共享同一 ts，且不同消息 ts 不同，
 *     是可靠的稳定身份（pi-web 用 `.jsonl` 的 entryId 做同一件事）；
 *  3. 兜底：见下方 inflightIds（同 (role, ts) 续接、结束即释放）。
 */

/**
 * 本地乐观消息的 id 前缀（store.send 先插入再等内核回传）。
 * 投影器据此识别「这条是本地的、随后会被线上版本收编」，避免渲染成两条。
 */
export const LOCAL_USER_ID_PREFIX = "local-user:";

/**
 * 去掉乐观消息附加的图片计数后缀，得到「纯文本」以与线上消息比较。
 *
 * store 侧乐观插入时写作 `${text}\n[图片 ×N]`（给用户即时反馈），而内核回传的 user
 * 消息只含 text 块（`extractText`）—— 直接比较**永不相等**，导致带图片的消息渲染两条。
 * 这里统一剥掉后缀再比。该后缀格式与 `ChatInputZone` 的构造保持一致，勿另立第三种写法。
 */
export function stripAttachedImageSuffix(text: string): string {
  return text.replace(/\n\[图片 ×\d+\]$/, "");
}

let fallbackSeq = 0;

/**
 * 在途消息身份表（key = `role:timestamp`）。
 *
 * 目的：让**同一条**消息的 start/update/end 续接同一 id，同时让**同一毫秒内的不同消息**
 * 拿到不同 id。后者是必须的 —— 早期实现直接以 `role:timestamp` 作为 id 并在同 id 时早退，
 * 后果是：
 *  - 两条 user 消息时间戳相同 → 第二条被**静默丢弃**（丢用户输入，最坏情况）；
 *  - 两条 assistant 消息时间戳相同 → 后者**覆盖**前者（正是我们刚修掉的那类覆盖 bug）。
 * 现实中同毫秒并发完全可能：steering/followUp 同刻投递、auto_retry 重发、或宿主以秒级精度打时间戳。
 *
 * 语义：start 分配 → update/end 续接（键仍在表中）→ end 处理完后**释放键**，
 * 于是下一条同 (role, ts) 的消息会成为新的一条。
 */
const inflightIds = new Map<string, string>();

function allocateId(key: string): string {
  const existing = inflightIds.get(key);
  if (existing) return existing;
  fallbackSeq += 1;
  const id = `m${fallbackSeq}:${key}`;
  inflightIds.set(key, id);
  return id;
}

/** 一条消息结束后释放其 (role, ts) 键，使下一条同键消息成为独立的一条 */
function releaseInflightId(key: string): void {
  inflightIds.delete(key);
}

function messageId(value: unknown): string {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // 1) 显式 id（pi 未来若补上，或非 pi 来源的消息）
    if (typeof obj.id === "string" && obj.id) return obj.id;
    const inner = obj.message;
    if (inner && typeof inner === "object" && typeof (inner as Record<string, unknown>).id === "string") {
      const id = (inner as Record<string, unknown>).id as string;
      if (id) return id;
    }
    // 2) role + timestamp 作为「在途键」（不是直接当 id，见上方注释）
    const carrier = (inner && typeof inner === "object" ? inner : obj) as Record<string, unknown>;
    const role = typeof carrier.role === "string" ? carrier.role : "";
    const ts = typeof carrier.timestamp === "number" ? carrier.timestamp : undefined;
    if (ts !== undefined) return allocateId(`${role || "msg"}:${ts}`);
    return allocateId(role || "msg");
  }
  return allocateId("msg");
}

/** 取消息的 (role, ts) 在途键（供 message_end 释放用） */
function inflightKeyOf(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const carrier = msg as Record<string, unknown>;
  const role = typeof carrier.role === "string" ? carrier.role : "";
  const ts = typeof carrier.timestamp === "number" ? carrier.timestamp : undefined;
  return ts !== undefined ? `${role || "msg"}:${ts}` : (role || "msg");
}

function previewOf(value: unknown, max = 220): string {
  let s = extractText(value);
  if (!s && value !== null && value !== undefined) {
    s = typeof value === "string" ? value : JSON.stringify(value);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function argsPreviewOf(args: unknown): string {
  if (args === undefined || args === null) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((m) => m.id === item.id);
  if (i === -1) return [...list, item];
  const next = [...list];
  next[i] = item;
  return next;
}

function setStreamingAll(list: UiMessage[], streaming: boolean): UiMessage[] {
  return list.map((m) => (m.kind === "assistant" ? { ...m, streaming } : m));
}

/** 工具调用起始时刻（实时路径耗时计算） */
const toolStartTs = new Map<string, number>();

const RESULT_MAX_CHARS = 20000;

/** 尝试把工具结果写回 assistant 的 toolCall block（按 block.id == toolCallId） */
function attachToolResult(
  prev: UiMessage[],
  toolCallId: string,
  result: unknown,
  isError: boolean,
  details?: unknown,
): UiMessage[] {
  let found = false;
  const started = toolStartTs.get(toolCallId);
  const duration = started !== undefined ? Math.round((Date.now() - started) / 1000) : undefined;
  const text = previewOf(result, RESULT_MAX_CHARS);
  const next = prev.map((m) => {
    if (m.kind !== "assistant" || !m.blocks) return m;
    const hit = m.blocks.some((b) => b.type === "toolCall" && b.id === toolCallId);
    if (!hit) return m;
    found = true;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.type === "toolCall" && b.id === toolCallId
          // 执行结束 → 清实时进度位（结果在 result 呈现，进度行不应残留）
          ? { ...b, result: { text, isError, ...(details !== undefined ? { details } : {}) }, ...(duration !== undefined ? { duration } : {}), progress: undefined }
          : b,
      ),
    };
  });
  if (found) toolStartTs.delete(toolCallId);
  return found ? next : prev;
}

// ---------------------------------------------------------------------------
// 投影器
// ---------------------------------------------------------------------------

export function reduceUiMessages(prev: UiMessage[], ev: ProjectEvent): UiMessage[] {
  switch (ev.type) {
    case "message_start":
    case "message_update":
    case "message_end": {
      const msg = ev.message;
      const id = messageId(msg);
      const role = (msg as Record<string, unknown> | undefined)?.role;
      // 在途键在消息结束后释放：下一条同 (role, ts) 的消息才会成为独立的一条
      // （否则同毫秒的两条消息会塌缩成一条 —— user 被丢弃 / assistant 被覆盖）。
      if (ev.type === "message_end") {
        const k = inflightKeyOf(msg);
        if (k) releaseInflightId(k);
      }
      if (role === "user") {
        const text = extractText(msg);
        /**
         * 乐观插入收敛：store.send() 会先本地插入一条用户消息（即时反馈），
         * 随后内核经 message_start/message_end 回传同一条。两者 id 不同
         * （本地 `local-user:<ts>` vs 线上 id），直接入库会**渲染两条**。
         * 这里把最后一条同文本的本地乐观消息「升格」为线上身份，而不是再追加一条。
         *
         * 判据顺序（缺一不可）：
         *  1) 尾部 id 与本条相同 → 同一条消息的后续事件（如 message_end），**原地更新**；
         *  2) 尾部是本地乐观消息且文本一致 → **收编**（升格为线上身份）；
         *  3) 否则**一律追加**。不得按 id 在全表里早退 —— 那样会在两条 user 消息同
         *     毫秒（同 ts）时把第二条**静默丢弃**（丢用户输入，最坏情况）。
         *
         * 比较前必须剥掉乐观侧的 `[图片 ×N]` 后缀：带图片时线上侧只有纯文本，
         * 直接全等比较**永不成立**，仍会渲染两条。
         */
        const tail0 = prev[prev.length - 1];
        if (tail0 !== undefined && tail0.kind === "user" && tail0.id === id) {
          const next = [...prev];
          next[next.length - 1] = { id, kind: "user", text };
          return next;
        }
        const canAdopt =
          tail0 !== undefined &&
          tail0.kind === "user" &&
          tail0.id.startsWith(LOCAL_USER_ID_PREFIX) &&
          stripAttachedImageSuffix(tail0.text) === text;
        if (canAdopt) {
          const next = [...prev];
          next[next.length - 1] = { id, kind: "user", text };
          return next;
        }
        return [...prev, { id, kind: "user", text }];
      }
      if (role === "toolResult") {
        // 工具结果消息（pi 信封含 details.patch/diff）→ 关联回写 toolCall block
        const tcid = typeof (msg as Record<string, unknown>).toolCallId === "string" ? String((msg as Record<string, unknown>).toolCallId) : "";
        if (!tcid) return prev;
        const m = msg as Record<string, unknown>;
        return attachToolResult(prev, tcid, m.content, m.isError === true, m.details);
      }
      const blocks = normalizeBlocks((msg as Record<string, unknown> | undefined)?.content);
      const text = blocks.length > 0 ? blocksToText(blocks) : extractText(msg);
      const existing = prev.find((m) => m.id === id);
      const streaming = ev.type !== "message_end";
      return upsert(prev, {
        id,
        kind: "assistant",
        text,
        streaming,
        ...(blocks.length > 0 ? { blocks } : existing && existing.kind === "assistant" && existing.blocks ? { blocks: existing.blocks } : {}),
        ...(metaOf(msg) ?? (existing && existing.kind === "assistant" && existing.meta ? { meta: existing.meta } : {})),
        // 上游失败原因（pi `AssistantMessage` 信封字段；流式中不显示，见 getAssistantErrorMessage）
        ...(typeof (msg as Record<string, unknown> | undefined)?.stopReason === "string"
          ? { stopReason: (msg as Record<string, unknown>).stopReason as string }
          : existing && existing.kind === "assistant" && existing.stopReason ? { stopReason: existing.stopReason } : {}),
        ...(typeof (msg as Record<string, unknown> | undefined)?.errorMessage === "string"
          ? { errorMessage: (msg as Record<string, unknown>).errorMessage as string }
          : existing && existing.kind === "assistant" && existing.errorMessage ? { errorMessage: existing.errorMessage } : {}),
      });
    }

    case "tool_execution_start": {
      const id = String(ev.toolCallId ?? "");
      if (id) toolStartTs.set(id, Date.now());
      if (id && prev.some((m) => m.kind === "assistant" && m.blocks?.some((b) => b.type === "toolCall" && b.id === id))) {
        return prev; // 已作为 assistant 的 toolCall block 展示
      }
      const fallbackId = id || `tool-${prev.length}`;
      const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
      return upsert(prev, { id: fallbackId, kind: "tool", name, argsPreview: argsPreviewOf(ev.args), status: "running" });
    }
    case "tool_execution_end": {
      const id = String(ev.toolCallId ?? "");
      const isError = ev.isError === true;
      const isBlock = id && prev.some((m) => m.kind === "assistant" && m.blocks?.some((b) => b.type === "toolCall" && b.id === id));
      if (isBlock) {
        const details = (ev as { details?: unknown }).details;
        return attachToolResult(prev, id, ev.result, isError, details);
      }
      if (!id) return prev;
      const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
      const prevTool = prev.find((m) => m.id === id && m.kind === "tool") as Extract<UiMessage, { kind: "tool" }> | undefined;
      return upsert(prev, {
        id,
        kind: "tool",
        name,
        argsPreview: prevTool?.argsPreview ?? "",
        status: isError ? "error" : "done",
        ...(ev.result !== undefined ? { resultPreview: previewOf(ev.result) } : {}),
      });
    }

    case "agent_start":
    case "turn_start":
      return prev;

    case "agent_end":
    case "agent_settled":
      return setStreamingAll(prev, false);

    /**
     * 终端执行输出（清单 #41）：专用 {kind:"bash"}，增量追加。
     */
    case "bash_execution_update": {
      const id = `bash:${String(ev.id ?? "bash")}`;
      const delta = typeof ev.delta === "string" ? ev.delta : previewOf(ev.output, 2000) ?? "";
      const existing = prev.find((m) => m.id === id && m.kind === "bash") as Extract<UiMessage, { kind: "bash" }> | undefined;
      return upsert(prev, { id, kind: "bash", text: (existing?.text ?? "") + delta, running: true });
    }

    /**
     * 工具执行进度（清单 #39 + #39b）：`tool_execution_update` 早期被丢弃 ——
     * 长任务（如 npm install / 大文件读写）期间 UI 完全无反馈，用户以为卡死。
     * 进度行取 partialResult 的**最后一行非空文本**（对齐 pi-web
     * `tool-execution-progress.ts`，比截取整段更贴近「当前状态」），
     * 写入对应 toolCall block 的实时进度位（有则）/ 遗留 tool 行（无则）。
     */
    case "tool_execution_update": {
      const id = String(ev.toolCallId ?? "");
      const progress =
        getToolExecutionProgress(ev.partialResult)
        ?? previewOf(ev.delta ?? ev.output ?? ev.result, 400);
      if (!id || !progress) return prev;
      const hasBlock = prev.some((m) => m.kind === "assistant" && m.blocks?.some((b) => b.type === "toolCall" && b.id === id));
      if (hasBlock) {
        // 已作为 assistant 的 toolCall block 展示 → 进度写入该 block 的实时进度位
        return prev.map((m) => {
          if (m.kind !== "assistant" || !m.blocks) return m;
          const hit = m.blocks.some((b) => b.type === "toolCall" && b.id === id);
          if (!hit) return m;
          return {
            ...m,
            blocks: m.blocks.map((b) =>
              b.type === "toolCall" && b.id === id ? { ...b, progress } : b,
            ),
          };
        });
      }
      const prevTool = prev.find((m) => m.id === id && m.kind === "tool") as Extract<UiMessage, { kind: "tool" }> | undefined;
      return upsert(prev, { id, kind: "tool", name: prevTool?.name ?? (typeof ev.toolName === "string" ? ev.toolName : "tool"), argsPreview: prevTool?.argsPreview ?? "", status: "running", resultPreview: progress });
    }

    /**
     * 终端执行（清单 #41）：专用 {kind:"bash"} 条目，不再伪装成 assistant 文本。
     * start → 建条目；update → 增量追加输出；end/exit → running=false。
     */
    case "bash_execution_start": {
      const id = `bash:${String(ev.id ?? Date.now())}`;
      return upsert(prev, { id, kind: "bash", text: "", running: true });
    }
    case "bash_execution_end":
    case "bash_execution_exit": {
      const id = `bash:${String(ev.id ?? "")}`;
      const existing = prev.find((m) => m.id === id && m.kind === "bash") as Extract<UiMessage, { kind: "bash" }> | undefined;
      const extra = previewOf(ev.delta ?? ev.output ?? ev.result, 2000);
      const text = existing ? (extra ? `${existing.text}\n${extra}` : existing.text) : (extra ?? "");
      return upsert(prev, { id, kind: "bash", text, running: false });
    }

    /**
     * 压缩（清单 #33）：`compaction_start` / `compaction_end` 早期落进 default 被丢弃 ——
     * 自动压缩发生后上下文悄悄缩小而 UI 还显示旧对话；`/compact` 也无任何反馈。
     * 这里产出一条 {kind:"compaction"} 分隔条：start 显示「压缩中」，end 显示摘要。
     */
    case "compaction_start":
    case "auto_compaction_start": {
      const id = `compaction:${String(ev.id ?? Date.now())}`;
      return upsert(prev, { id, kind: "compaction", summary: "正在压缩上下文…", running: true });
    }
    case "compaction_end":
    case "auto_compaction_end": {
      const id = `compaction:${String(ev.id ?? Date.now())}`;
      const detail = previewOf(ev.summary ?? ev.result ?? ev.message, 4000) || "上下文已压缩";
      const kept = typeof ev.firstKeptEntryId === "string" ? ev.firstKeptEntryId : undefined;
      /**
       * 摘要分节解析（清单 #33b）：剥离尾部 <read-files>/<modified-files> 元数据分节，
       * 正文与文件列表分开呈现（早期把 XML 标记当纯文本塞进分隔条）。
       */
      const parsed = parseCompactionSummary(detail);
      return upsert(prev, {
        id,
        kind: "compaction",
        summary: parsed.body || "上下文已压缩",
        running: false,
        ...(kept ? { firstKeptEntryId: kept } : {}),
        ...(parsed.readFiles.length > 0 ? { readFiles: parsed.readFiles } : {}),
        ...(parsed.modifiedFiles.length > 0 ? { modifiedFiles: parsed.modifiedFiles } : {}),
      });
    }
    case "compaction_error": {
      const id = `compaction:${String(ev.id ?? Date.now())}`;
      return upsert(prev, { id, kind: "compaction", summary: `压缩失败：${previewOf(ev.error ?? ev.message, 300) || "未知错误"}`, running: false });
    }

    default:
      return prev;
  }
}

export interface ReplayEntry {
  entryId: string;
  type: string;
  role?: string;
  contentPreview?: string;
  /** 完整结构化 content（reader 带出的 Pi blocks） */
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  /** Pi 信封字段（模型/用量/时间） */
  model?: string;
  provider?: string;
  usage?: UsageInfo;
  timestamp?: number;
  /** 条目时间（epoch ms，回放耗时计算用） */
  ts?: number;
  /** toolResult 的 details（pi edit 工具的 patch/diff 数据源） */
  details?: unknown;
}

/** pi-web `message-display.ts:getThinkingPreview`：历史思考预览的最大长度 */
export const THINKING_PREVIEW_MAX = 240;

/** pi-web `message-display.ts:getThinkingPreview`：历史思考的 ≤240 字符首行预览 */
export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

/**
 * 从历史条目初始化消息列表（恢复会话用）。
 * 有完整 content 时重建结构化 blocks（thinking/toolCall/text），toolResult 按 toolCallId 关联回写；
 * 否则降级 contentPreview 纯文本。
 *
 * 历史思考按需加载（清单 #40）：thinking 块只保留 ≤240 字符预览 + `deferred:true`
 * + `blockIndex`（供 `get_thinking` RPC 取全文）—— 大段思考全文不再随回放整体下发，
 * UI 展开该块时才拉取。
 */
export function messagesFromEntries(entries: ReplayEntry[]): UiMessage[] {
  const list: UiMessage[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const blocks = normalizeBlocks(e.content);
    if (e.role === "user") {
      const text = blocks.length > 0 ? blocksToText(blocks) : (e.contentPreview ?? "");
      if (text) list.push({ id: e.entryId, kind: "user", text });
      continue;
    }
    if (e.role === "assistant") {
      const meta: AssistantMeta = {};
      if (e.model) meta.model = e.model;
      if (e.provider) meta.provider = e.provider;
      if (e.usage) meta.usage = e.usage;
      if (e.timestamp) meta.timestamp = e.timestamp;
      const metaField = Object.keys(meta).length > 0 ? { meta } : {};
      if (blocks.length > 0) {
        // thinking 块 → 预览 + deferred 标记（仅在长度超阈值时）
        let thinkingIdx = -1;
        const deferredBlocks = blocks.map((b) => {
          if (b.type !== "thinking") return b;
          thinkingIdx += 1;
          if (b.thinking.length <= THINKING_PREVIEW_MAX) return b;
          return { ...b, thinking: getThinkingPreview(b.thinking), deferred: true as const, blockIndex: thinkingIdx };
        });
        list.push({ id: e.entryId, kind: "assistant", text: blocksToText(blocks), streaming: false, blocks: deferredBlocks, ...metaField });
      } else if (e.contentPreview) {
        list.push({ id: e.entryId, kind: "assistant", text: e.contentPreview, streaming: false, ...metaField });
      }
      continue;
    }
    if (e.role === "toolResult" && e.toolCallId) {
      const result = blocks.length > 0 ? blocksToText(blocks) : (e.contentPreview ?? "");
      for (const m of list) {
        if (m.kind !== "assistant" || !m.blocks) continue;
        const assistantTs = m.meta?.timestamp;
        const duration = assistantTs && e.ts ? Math.max(0, Math.round((e.ts - assistantTs) / 1000)) : undefined;
        m.blocks = m.blocks.map((b) =>
          b.type === "toolCall" && b.id === e.toolCallId
            ? { ...b, result: { text: result.slice(0, RESULT_MAX_CHARS), isError: e.isError === true, ...(e.details !== undefined ? { details: e.details } : {}) }, ...(duration !== undefined ? { duration } : {}) }
            : b,
        );
      }
    }
  }
  return list;
}
