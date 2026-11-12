// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/index.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
export type { ChatProps } from "./chat";
export { Chat } from "./chat";
export type { PromptInputHiddenTool, PromptInputProps } from "./components/input/prompt-input";
export { PromptInput } from "./components/input/prompt-input";
export type { SuggestionData, SuggestionsProps } from "./components/input/suggestions";
export { Suggestions } from "./components/input/suggestions";
export type { MessageProps } from "./components/message/message";
export { Message as MessageComponent } from "./components/message/message";
export type { MessageActionsProps } from "./components/message/message-actions";
export { MessageActions } from "./components/message/message-actions";
export type { MessageBranchProps } from "./components/message/message-branch";
export { MessageBranch } from "./components/message/message-branch";
export type { MessageItemProps } from "./components/message/message-item";
export { MessageItem } from "./components/message/message-item";
export { StreamingIndicator } from "./components/message/streaming-indicator";
export type {
  ModelData,
  ModelSelectorProps,
  ModelSelectorTriggerVariant,
  ModelTypeForQuery,
} from "./components/model-selector";
export { ModelSelector } from "./components/model-selector";
export type { GenericToolProps } from "./components/tools/generic-tool";
export { GenericTool } from "./components/tools/generic-tool";
export { Weather } from "./components/tools/weather";
export type { WeatherToolProps } from "./components/tools/weather-tool";
export { WeatherTool } from "./components/tools/weather-tool";
export {
  AssistantContext,
  AssistantProvider,
  useAssistantContext,
  useOptionalAssistantContext,
} from "./context";
export type { UseAssistantOptions } from "./hooks/use-assistant";
export { useAssistant } from "./hooks/use-assistant";
export type { UseChatStreamOptions, UseChatStreamReturn } from "./hooks/use-chat-stream";
export { useChatStream } from "./hooks/use-chat-stream";
export type { UseMessageRepositoryReturn } from "./hooks/use-message-repository";
export { useMessageRepository } from "./hooks/use-message-repository";
export type { UseMessagesPagingReturn } from "./hooks/use-messages-paging";
export { useMessagesPaging } from "./hooks/use-messages-paging";
export { convertUIMessageToMessage } from "./libs/message-converter";
export type { RawMessageRecord } from "./libs/message-repository";
export { MessageRepository } from "./libs/message-repository";
export { convertProvidersToModels } from "./libs/provider-converter";
export type {
  AssistantContextValue,
  ChatStatus,
  DisplayMessage,
  Message,
  MessageAttachment,
  MessageReasoning,
  MessageSource,
  MessageToolCall,
  MessageVersion,
  Model,
  Suggestion,
} from "./types";
