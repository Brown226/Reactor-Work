// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web, @buildingai/stores, @/components/ask-assistant-ui/hooks/use-feature-flags, @/components/ask-assistant-ui/hooks/use-message-repository, @/components/ask-assistant-ui/libs/message-repository, @/components/ask-assistant-ui/libs/provider-converter, @/components/ask-assistant-ui/types）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/hooks/use-datasets-assistant.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { AiProvider } from "../../../../../kb-shims/console-services";
import { useAssistantStore } from "../../../../../kb-shims/ui";
import type { UIMessage } from "ai";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useFeatureFlags } from "../../../../ask-assistant-ui/hooks/use-feature-flags";
import { useMessageRepository } from "../../../../ask-assistant-ui/hooks/use-message-repository";
import type { RawMessageRecord } from "../../../../ask-assistant-ui/libs/message-repository";
import { convertProvidersToModels } from "../../../../ask-assistant-ui/libs/provider-converter";
import type {
  AssistantContextValue,
  DisplayMessage,
  Suggestion,
} from "../../../../ask-assistant-ui/types";

import { useDatasetsChatStream } from "./use-datasets-chat-stream";
import { useDatasetsMessagesPaging } from "./use-datasets-messages-paging";

export interface UseDatasetsAssistantOptions {
  datasetId: string;
  providers: AiProvider[];
  suggestions?: Suggestion[];
  enableThinking?: boolean;
}

function buildMessageRecords(
  messages: UIMessage[],
  existingParentMap?: Map<string, string | null>,
): RawMessageRecord[] {
  const records: RawMessageRecord[] = [];
  let lastAssistantId: string | null = null;
  let lastUserId: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const metadataParentId = (msg.metadata as { parentId?: string } | undefined)?.parentId;
    const metadataSequence = (msg.metadata as { sequence?: number } | undefined)?.sequence;
    const sequence = typeof metadataSequence === "number" ? metadataSequence : i;

    if (metadataParentId !== undefined) {
      records.push({ id: msg.id, parentId: metadataParentId || null, sequence, message: msg });
      if (msg.role === "user") lastUserId = msg.id;
      else if (msg.role === "assistant") lastAssistantId = msg.id;
      continue;
    }

    if (existingParentMap?.has(msg.id)) {
      records.push({
        id: msg.id,
        parentId: existingParentMap.get(msg.id),
        sequence,
        message: msg,
      });
      if (msg.role === "user") lastUserId = msg.id;
      else if (msg.role === "assistant") lastAssistantId = msg.id;
      continue;
    }

    let parentId: string | null = null;
    if (msg.role === "user") {
      parentId = lastAssistantId;
      lastUserId = msg.id;
    } else if (msg.role === "assistant") {
      parentId = lastUserId;
      lastAssistantId = msg.id;
    }

    records.push({ id: msg.id, parentId, sequence, message: msg });
  }

  return records;
}

function sliceMessagesUntil(messages: UIMessage[], parentId: string | null): UIMessage[] {
  if (parentId === null) return [];
  const idx = messages.findIndex((m) => m.id === parentId);
  return idx === -1 ? messages : messages.slice(0, idx + 1);
}

function useLocalFeedback() {
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [disliked, setDisliked] = useState<Record<string, boolean>>({});

  const onLike = useCallback((messageKey: string, value: boolean) => {
    if (value) {
      setLiked((prev) => ({ ...prev, [messageKey]: true }));
      setDisliked((prev) => {
        const next = { ...prev };
        delete next[messageKey];
        return next;
      });
    } else {
      setLiked((prev) => {
        const next = { ...prev };
        delete next[messageKey];
        return next;
      });
    }
  }, []);

  const onDislike = useCallback(
    (messageKey: string, value: boolean, _reason?: string, _isUpdate?: boolean) => {
      if (value) {
        setDisliked((prev) => ({ ...prev, [messageKey]: true }));
        setLiked((prev) => {
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
      } else {
        setDisliked((prev) => {
          const next = { ...prev };
          delete next[messageKey];
          return next;
        });
      }
    },
    [],
  );

  return { liked, disliked, onLike, onDislike };
}

export function useDatasetsAssistant(options: UseDatasetsAssistantOptions): {
  providerValue: AssistantContextValue;
  setConversationId: (id: string | undefined) => void;
} {
  const { datasetId, providers, suggestions = [], enableThinking: initialEnableThinking } = options;

  const models = useMemo(() => convertProvidersToModels(providers), [providers]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedModelId = useAssistantStore((s) => s.selectedModelId);
  const setSelectedModelId = useAssistantStore((s) => s.setSelectedModelId);

  const { feature, setFeatureFlag } = useFeatureFlags(initialEnableThinking);

  useEffect(() => {
    if (models.length === 0) return;

    const isValidModel = models.some((model) => model.id === selectedModelId);
    const modelId = isValidModel ? selectedModelId : models[0].id;

    if (modelId !== selectedModelId || !selectedModelId) {
      setSelectedModelId(modelId);
    }
  }, [models, selectedModelId, setSelectedModelId]);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);
    },
    [setSelectedModelId],
  );

  const {
    messages: repositoryMessages,
    displayMessages,
    importIncremental,
    importMessages,
    switchToBranch,
    clear: clearRepository,
    getParentId,
  } = useMessageRepository();

  const parentMapRef = useRef<Map<string, string | null>>(new Map());
  const isFirstLoadRef = useRef(true);

  const lastMessageDbIdRef = useRef<string | null>(null);
  const pendingParentIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const prevDatasetIdRef = useRef<string | undefined>(undefined);

  const {
    currentConversationId,
    setConversationId: setConversationIdRaw,
    messages: streamMessages,
    setMessages,
    status,
    streamingMessageId,
    send,
    stop,
    regenerate,
    addToolApprovalResponse,
  } = useDatasetsChatStream({
    datasetId,
    modelId: selectedModelId,
    feature: Object.fromEntries(
      Object.entries(feature).filter(([_, value]) => value !== undefined),
    ) as Record<string, boolean>,
    lastMessageDbIdRef,
    pendingParentIdRef,
    conversationIdRef,
    prevDatasetIdRef,
  });

  const { isLoadingMessages, isLoadingMoreMessages, hasMoreMessages, loadMoreMessages } =
    useDatasetsMessagesPaging({
      datasetId,
      conversationId: currentConversationId,
      setMessages,
      lastMessageDbIdRef,
      shouldLoadInitial: !!currentConversationId && streamMessages.length === 0,
    });

  const { liked, disliked, onLike, onDislike } = useLocalFeedback();

  const setConversationId = useCallback(
    (id: string | undefined) => {
      if (id !== currentConversationId) {
        setMessages([]);
      }
      setConversationIdRaw(id);
    },
    [currentConversationId, setMessages, setConversationIdRaw],
  );

  useEffect(() => {
    if (streamMessages.length === 0) {
      clearRepository();
      parentMapRef.current.clear();
      isFirstLoadRef.current = true;
      return;
    }

    startTransition(() => {
      const records = buildMessageRecords(streamMessages, parentMapRef.current);

      for (const record of records) {
        parentMapRef.current.set(record.id, record.parentId ?? null);
      }

      if (isFirstLoadRef.current) {
        importMessages(records, true);
        isFirstLoadRef.current = false;
      } else {
        importIncremental(records, true);
      }
    });
  }, [streamMessages, importMessages, importIncremental, clearRepository]);

  useEffect(() => {
    prevDatasetIdRef.current = datasetId;
  }, [datasetId]);

  const onSend = useCallback(
    (
      content: string,
      files?: Array<{ type: "file"; url: string; mediaType?: string; filename?: string }>,
    ) => {
      const lastMessage = repositoryMessages[repositoryMessages.length - 1];
      const parentId = lastMessage?.id ?? null;
      queueMicrotask(() => send(content, parentId, files));
    },
    [repositoryMessages, send],
  );

  const onSwitchBranch = useCallback(
    (messageId: string) => switchToBranch(messageId),
    [switchToBranch],
  );

  const onRegenerate = useCallback(
    (messageId: string) => {
      const parentId = getParentId(messageId);
      if (parentId === undefined) return;

      setMessages(sliceMessagesUntil(streamMessages, parentId));
      regenerate(parentId ?? messageId);
    },
    [getParentId, streamMessages, setMessages, regenerate],
  );

  const onEditMessage = useCallback(
    (
      messageId: string,
      newContent: string,
      files?: Array<{ type: "file"; url: string; mediaType?: string; filename?: string }>,
    ) => {
      const parentId = getParentId(messageId);
      if (parentId === undefined) return;

      setMessages(sliceMessagesUntil(streamMessages, parentId));
      queueMicrotask(() => send(newContent, parentId, files));
    },
    [getParentId, streamMessages, setMessages, send],
  );

  const noopSelectMcpServers = useCallback(() => {}, []);

  const value = useMemo(
    () =>
      ({
        messages: repositoryMessages as UIMessage[],
        displayMessages: displayMessages as DisplayMessage[],
        currentThreadId: currentConversationId,
        status,
        streamingMessageId,
        isLoading: isLoadingMessages,
        isLoadingMoreMessages,
        hasMoreMessages,
        models,
        selectedModelId,
        selectedMcpServerIds: [] as string[],
        suggestions,
        liked,
        disliked,
        textareaRef,
        onSend,
        onLoadMoreMessages: loadMoreMessages,
        onStop: stop,
        onRegenerate,
        onEditMessage,
        onSwitchBranch,
        onSelectModel: handleSelectModel,
        onSelectMcpServers: noopSelectMcpServers,
        onSetFeature: setFeatureFlag,
        onLike,
        onDislike,
        addToolApprovalResponse,
      }) as AssistantContextValue,
    [
      repositoryMessages,
      displayMessages,
      currentConversationId,
      status,
      streamingMessageId,
      isLoadingMessages,
      isLoadingMoreMessages,
      hasMoreMessages,
      models,
      selectedModelId,
      suggestions,
      liked,
      disliked,
      textareaRef,
      onSend,
      loadMoreMessages,
      stop,
      onRegenerate,
      onEditMessage,
      onSwitchBranch,
      handleSelectModel,
      noopSelectMcpServers,
      setFeatureFlag,
      onLike,
      onDislike,
      addToolApprovalResponse,
    ],
  );

  return { providerValue: value, setConversationId };
}
