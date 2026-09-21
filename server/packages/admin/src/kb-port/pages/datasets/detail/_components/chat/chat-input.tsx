// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@/components/ask-assistant-ui）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/chat/chat-input.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { PromptInputMessage } from "../../../../../ui/components/ai-elements/prompt-input";
import { InfiniteScrollTopScrollButton } from "../../../../../ui/components/infinite-scroll-top";
import { cn } from "../../../../../ui/lib/utils";
import type { FormEvent, RefObject } from "react";
import { memo, useCallback, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import type { Model } from "../../../../../ask-assistant-ui/index";
import { ModelSelector, PromptInput, Suggestions } from "../../../../../ask-assistant-ui/index";

import type { ChatStatus, Suggestion } from "./chat-container";

interface ChatInputProps {
  hasMessages: boolean;
  suggestions: Suggestion[];
  status: ChatStatus;
  onSend: (text: string, files?: PromptInputMessage["files"]) => void;
  models: Model[];
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onStop?: () => void;
}

export const ChatInput = memo(function ChatInput({
  hasMessages,
  suggestions,
  status,
  onSend,
  models,
  selectedModelId,
  onSelectModel,
  textareaRef: textareaRefProp,
  onStop,
}: ChatInputProps) {
  const { id } = useParams<{ id: string }>();
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = textareaRefProp ?? ownRef;
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);

  const handleSubmit = useCallback(
    (message: PromptInputMessage, _event: FormEvent<HTMLFormElement>) => {
      const text = message.text?.trim();
      if (text || (message.files && message.files.length > 0)) {
        onSend(text || "", message.files);
      }
    },
    [onSend],
  );

  const handleSuggestionClick = useCallback(
    (suggestion: Suggestion) => {
      onSend(suggestion.text);
    },
    [onSend],
  );

  const showSuggestions = !hasMessages && suggestions.length > 0 && status !== "streaming";

  return (
    <div className={cn("sticky z-10", id ? "bottom-13" : "bottom-0")}>
      <InfiniteScrollTopScrollButton className="-top-12 z-20" />

      <div className="bg-background mx-auto w-full max-w-3xl rounded-t-lg">
        {showSuggestions && (
          <Suggestions suggestions={suggestions} onSuggestionClick={handleSuggestionClick} />
        )}

        <PromptInput
          textareaRef={textareaRef}
          status={status}
          onSubmit={handleSubmit}
          onStop={onStop}
          models={models}
          selectedModelId={selectedModelId}
          onSelectMcpServers={() => {}}
          onSetFeature={() => {}}
          hiddenTools={["more", "mcp", "quickMenu"]}
        >
          <ModelSelector
            models={models}
            selectedModelId={selectedModelId}
            onModelChange={onSelectModel}
            open={modelSelectorOpen}
            onOpenChange={setModelSelectorOpen}
          />
        </PromptInput>
      </div>

      <div className="text-muted-foreground bg-background py-1.5 text-center text-xs">
        内容由 AI 生成，请仔细甄别
      </div>
    </div>
  );
});
