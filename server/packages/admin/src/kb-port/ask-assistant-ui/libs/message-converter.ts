// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/libs/message-converter.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { DynamicToolUIPart, ReasoningUIPart, ToolUIPart, UIMessage } from "ai";

import type { Message, MessageToolCall } from "../types";

/**
 * Converts UIMessage to Message format (reverse conversion)
 *
 * Converts from AI SDK's UIMessage format back to custom Message type for view rendering.
 * Conversion includes:
 * 1. Extracting text content, attachments, reasoning, source URLs, and tool calls from parts
 * 2. Restoring tool call descriptions from metadata
 * 3. Building MessageVersion array
 */
export function convertUIMessageToMessage(uiMsg: UIMessage): Message {
  let content = "";
  const attachments: Array<{
    type: "file";
    url: string;
    mediaType?: string;
    filename?: string;
  }> = [];
  let reasoning: { content: string; duration: number } | undefined;
  const sources: Array<{ href: string; title: string }> = [];
  const tools: MessageToolCall[] = [];

  const metadata = uiMsg.metadata as
    | {
        toolDescriptions?: Array<{
          name: string;
          description: string;
        }>;
      }
    | undefined;
  const toolDescriptionsMap = new Map<string, string>();
  if (metadata?.toolDescriptions) {
    for (const desc of metadata.toolDescriptions) {
      toolDescriptionsMap.set(desc.name, desc.description);
    }
  }

  for (const part of uiMsg.parts) {
    switch (part.type) {
      case "text":
        content += part.text;
        break;

      case "file":
        attachments.push({
          type: "file",
          url: part.url,
          ...(part.mediaType && { mediaType: part.mediaType }),
          ...(part.filename && { filename: part.filename }),
        });
        break;

      case "reasoning": {
        const reasoningPart = part as ReasoningUIPart;
        const existingContent = reasoning?.content || "";
        const newContent = reasoningPart.text || "";
        if (!reasoning) {
          reasoning = {
            content: newContent,
            duration:
              (reasoningPart.providerMetadata as { duration?: number } | undefined)?.duration ?? 0,
          };
        } else {
          reasoning.content = existingContent + newContent;
          if (reasoningPart.providerMetadata) {
            const duration = (reasoningPart.providerMetadata as { duration?: number } | undefined)
              ?.duration;
            if (duration !== undefined) {
              reasoning.duration = duration;
            }
          }
        }
        break;
      }

      case "source-url":
        sources.push({
          href: part.url,
          title: part.title ?? "",
        });
        break;

      default:
        if (typeof part.type === "string" && part.type.startsWith("tool-")) {
          const toolName = part.type.replace("tool-", "");
          const toolPart = part as {
            toolCallId: string;
            state: ToolUIPart["state"];
            input: Record<string, unknown>;
            output?: unknown;
            errorText?: string;
          };

          const toolState = toolPart.state as ToolUIPart["state"];
          const hasResult =
            toolState === "output-available" &&
            toolPart.output !== undefined &&
            toolPart.output !== null;
          const hasError = toolState === "output-error" && !!toolPart.errorText;

          tools.push({
            name: toolName,
            description: toolDescriptionsMap.get(toolName) ?? "",
            status: toolState,
            parameters: toolPart.input,
            result: hasResult ? String(toolPart.output) : undefined,
            error: hasError ? toolPart.errorText : undefined,
          });
        } else if (part.type === "dynamic-tool") {
          const toolPart = part as DynamicToolUIPart;
          const toolName = toolPart.toolName;

          const dynamicOutput = (toolPart as { output?: unknown }).output;
          const dynamicError = (toolPart as { errorText?: string }).errorText;
          const dynamicState = toolPart.state as ToolUIPart["state"];
          const hasResult =
            dynamicState === "output-available" &&
            dynamicOutput !== undefined &&
            dynamicOutput !== null;
          const hasError = dynamicState === "output-error" && !!dynamicError;

          tools.push({
            name: toolName,
            description: toolDescriptionsMap.get(toolName) ?? "",
            status: dynamicState,
            parameters: (toolPart as { input?: unknown }).input as Record<string, unknown>,
            result: hasResult ? String(dynamicOutput) : undefined,
            error: hasError ? dynamicError : undefined,
          });
        }
        break;
    }
  }

  const version: {
    id: string;
    content: string;
    attachments?: Array<{
      type: "file";
      url: string;
      mediaType?: string;
      filename?: string;
    }>;
  } = {
    id: `${uiMsg.id}-v0`,
    content,
    ...(attachments.length > 0 && { attachments }),
  };

  return {
    key: uiMsg.id,
    from: uiMsg.role === "user" ? "user" : "assistant",
    versions: [version],
    activeVersionIndex: 0,
    ...(sources.length > 0 && { sources }),
    ...(reasoning && { reasoning }),
    ...(tools.length > 0 && { tools }),
  };
}
