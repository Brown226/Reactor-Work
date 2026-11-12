/**
 * 跨协议请求体转换（Anthropic Messages ↔ OpenAI Chat Completions）。
 *
 * ## 为什么需要
 * 网关有两个固定入站端点（`/v1/messages` = Anthropic 形态、`/v1/chat/completions` = OpenAI 形态），
 * 但上游供应商只支持其中一种。此前 `provider-api.ts` 的 `canServe` 在形态不匹配时**直接报错**
 * （`protocol_mismatch`），用户只能改客户端或改供应商协议声明。本模块补上真正的转换，
 * 让「Anthropic 入站 → OpenAI 上游」与「OpenAI 入站 → Anthropic 上游」两条路都能走通。
 *
 * ## 设计取舍
 * - **纯函数、无副作用**：只做 body 的形态映射，不碰 fetch/日志/密钥 —— 便于单测与复用。
 * - **只覆盖对话必需字段**：model / messages / system / max_tokens / temperature / top_p /
 *   stop / stream / tools / tool_choice。上游特有字段不臆造，缺失即省略（宁少不错）。
 * - **多模态内容块双向映射**：text / image（base64 与 url 两种来源）/ tool_use / tool_result。
 * - **回执不做转换**：当前只转**出站请求**。回执形态由上游决定，端侧两条链路的解析器
 *   已按各自形态工作；跨协议回执转换属另一层（见 spec 的边界与遗留）。
 */

/** Anthropic Messages 请求体（只声明我们读写的字段）。 */
export interface AnthropicMessagesBody {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };

export type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

/** OpenAI Chat Completions 请求体（只声明我们读写的字段）。 */
export interface OpenAIChatBody {
  model?: string;
  messages?: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  name?: string;
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Anthropic 图片块 → OpenAI `image_url` 内容块。
 * base64 源拼成 data URL（OpenAI 兼容端点通用），url 源直接透传。
 */
function anthropicImageToOpenAI(block: AnthropicContentBlock): OpenAIContentPart | null {
  if (block.type !== "image") return null;
  const source = block.source;
  if (source.type === "base64") {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === "url") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/**
 * Anthropic 内容 → OpenAI 内容（字符串或部件数组）。
 *
 * 注意 user 消息里的 `tool_result` 块在 OpenAI 里要拆成**独立的 `role:"tool"` 消息**，
 * 因此这里只处理 text/image；tool_result 由 `anthropicMessagesToOpenAI` 在外层拆分。
 */
function anthropicContentToOpenAI(
  content: string | AnthropicContentBlock[],
): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;
  const parts: OpenAIContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const image = anthropicImageToOpenAI(block);
      if (image) parts.push(image);
    }
  }
  // 只有单个文本块时退化成纯字符串，贴近 OpenAI 客户端常见写法（也对端更友好）。
  const [onlyPart] = parts;
  if (parts.length === 1 && onlyPart && onlyPart.type === "text") {
    return onlyPart.text;
  }
  return parts;
}

/** 抽取 Anthropic 消息里的 tool_use / tool_result 块，用于在 OpenAI 侧拆成对应结构。 */
function splitAnthropicToolBlocks(content: string | AnthropicContentBlock[]): {
  toolUses: Extract<AnthropicContentBlock, { type: "tool_use" }>[];
  toolResults: Extract<AnthropicContentBlock, { type: "tool_result" }>[];
} {
  if (typeof content === "string") return { toolUses: [], toolResults: [] };
  const toolUses: Extract<AnthropicContentBlock, { type: "tool_use" }>[] = [];
  const toolResults: Extract<AnthropicContentBlock, { type: "tool_result" }>[] = [];
  for (const block of content) {
    if (block.type === "tool_use") toolUses.push(block);
    else if (block.type === "tool_result") toolResults.push(block);
  }
  return { toolUses, toolResults };
}

/** tool_result 的 content（字符串或块数组）拍平成 OpenAI `role:"tool"` 消息的 content 文本。 */
function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * Anthropic → OpenAI 请求体转换。
 * 返回新对象；无法映射的字段（如 anthropic-version 等头级信息不在 body 内）不臆造。
 */
export function anthropicToOpenAIChat(body: AnthropicMessagesBody): OpenAIChatBody {
  const out: OpenAIChatBody = {};
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;

  const messages: OpenAIMessage[] = [];
  // system 优先放最前（OpenAI 用 role:"system" 表达）。
  if (typeof body.system === "string" && body.system.length > 0) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter((t) => t.length > 0)
      .join("\n");
    if (text.length > 0) messages.push({ role: "system", content: text });
  }

  for (const message of body.messages ?? []) {
    const { toolUses, toolResults } = splitAnthropicToolBlocks(message.content);
    // tool_result 在 OpenAI 里是独立的 role:"tool" 消息，必须排在发起调用的 assistant 之后。
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: toolResultContentToText(result.content),
      });
    }
    const hasRenderable = typeof message.content === "string" || toolUses.length > 0 ||
      (Array.isArray(message.content) && message.content.some((b) => b.type === "text" || b.type === "image"));
    if (!hasRenderable && toolResults.length > 0 && toolUses.length === 0) {
      continue; // 纯 tool_result 的 user 回合已经拆成 role:"tool"，不再产出空 user 消息
    }
    const openaiMessage: OpenAIMessage = {
      role: message.role,
      content: anthropicContentToOpenAI(message.content),
    };
    if (toolUses.length > 0) {
      openaiMessage.tool_calls = toolUses.map((toolUse) => ({
        id: toolUse.id,
        type: "function" as const,
        function: {
          name: toolUse.name,
          arguments: typeof toolUse.input === "string" ? toolUse.input : JSON.stringify(toolUse.input ?? {}),
        },
      }));
      // 带 tool_calls 的 assistant 消息在 OpenAI 里 content 可为 null。
      if (Array.isArray(message.content) && message.content.every((b) => b.type === "tool_use")) {
        openaiMessage.content = null;
      }
    }
    messages.push(openaiMessage);
  }
  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
      },
    }));
  }
  return out;
}

/** OpenAI `image_url` 部件 → Anthropic 图片源（data URL 拆回 base64，否则按 url）。 */
function openAIImageToAnthropic(part: OpenAIContentPart): AnthropicContentBlock | null {
  if (part.type !== "image_url") return null;
  const url = part.image_url?.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const dataUrlMatch = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (dataUrlMatch && dataUrlMatch[1] !== undefined && dataUrlMatch[2] !== undefined) {
    return { type: "image", source: { type: "base64", media_type: dataUrlMatch[1], data: dataUrlMatch[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

/** OpenAI 内容 → Anthropic 内容块数组。 */
function openAIContentToAnthropic(content: OpenAIMessage["content"]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const image = openAIImageToAnthropic(part);
      if (image) blocks.push(image);
    }
  }
  const [onlyBlock] = blocks;
  if (blocks.length === 1 && onlyBlock && onlyBlock.type === "text") {
    return onlyBlock.text;
  }
  return blocks;
}

/**
 * OpenAI → Anthropic 请求体转换。
 *
 * OpenAI 的 `role:"system"` 折进 Anthropic 的顶层 `system` 字段；
 * `role:"tool"` 折回 `user` 消息里的 `tool_result` 块；
 * assistant 的 `tool_calls` 折成 `tool_use` 块。
 */
export function openAIChatToAnthropic(body: OpenAIChatBody): AnthropicMessagesBody {
  const out: AnthropicMessagesBody = {};
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (typeof maxTokens === "number") out.max_tokens = maxTokens;
  else out.max_tokens = 4096; // Anthropic 必填；缺省给一个保守值，避免上游 400
  if (typeof body.stop === "string") out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop)) out.stop_sequences = body.stop;

  const systemTexts: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const message of body.messages ?? []) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    if (message.role === "tool") {
      // 独立的 tool 消息 → 追加到上一条 user 消息的 tool_result 块（Anthropic 需 user 回合承载）。
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: typeof message.content === "string" ? message.content : "",
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
      continue;
    }
    const blocks: AnthropicContentBlock[] =
      typeof message.content === "string" || message.content == null
        ? typeof message.content === "string" && message.content.length > 0
          ? [{ type: "text", text: message.content }]
          : []
        : (() => {
            const converted = openAIContentToAnthropic(message.content);
            return typeof converted === "string"
              ? converted.length > 0
                ? [{ type: "text", text: converted }]
                : []
              : converted;
          })();
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let parsedInput: unknown = {};
        try {
          parsedInput = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          parsedInput = call.function.arguments;
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parsedInput });
      }
    }
    messages.push({ role: message.role, content: blocks });
  }

  if (systemTexts.length > 0) out.system = systemTexts.join("\n");
  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        ...(tool.function.parameters !== undefined ? { input_schema: tool.function.parameters } : {}),
      }));
  }
  return out;
}

/**
 * 是否需要跨协议转换：入站形态与供应商声明形态不同。
 *
 * 与 `canServe` 的区别：`canServe` 只认「直通」，本函数回答「能否用转换兜住」。
 * 目前只支持 anthropic-messages ↔ openai-chat 两两互转（`openai-responses` /
 * `google-generative-ai` 仍不支持）。
 */
export function needsConversion(
  api: "auto" | "openai-chat" | "anthropic-messages" | "openai-responses" | "google-generative-ai",
  inbound: "anthropic-messages" | "openai-chat",
): boolean {
  if (api === "auto" || api === inbound) return false;
  return api === "openai-chat" || api === "anthropic-messages";
}

/**
 * 按目标形态转换请求体。`target` 是**上游形态**（要与 provider.api 一致）。
 * 若入站已是目标形态则原样返回。
 */
export function convertRequestBody(
  rawBody: unknown,
  inbound: "anthropic-messages" | "openai-chat",
  target: "anthropic-messages" | "openai-chat",
): unknown {
  if (inbound === target || !isRecord(rawBody)) return rawBody;
  if (inbound === "anthropic-messages" && target === "openai-chat") {
    return anthropicToOpenAIChat(rawBody as AnthropicMessagesBody);
  }
  if (inbound === "openai-chat" && target === "anthropic-messages") {
    return openAIChatToAnthropic(rawBody as OpenAIChatBody);
  }
  return rawBody;
}
