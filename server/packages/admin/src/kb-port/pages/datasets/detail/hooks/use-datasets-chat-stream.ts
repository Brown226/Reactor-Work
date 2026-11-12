// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web, @buildingai/stores, @/utils/api, @/utils/error）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/hooks/use-datasets-chat-stream.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useChat } from "@ai-sdk/react";
import {
  type DatasetsMessageRecord,
  getDatasetsConversationInfo,
  getDatasetsConversationMessages,
} from "../../../../../kb-shims/console-services";
import { useAuthStore } from "../../../../../kb-shims/ui";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatStatus, FileUIPart, UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

import { getApiBaseUrl } from "../../../../../kb-shims/ui";
import { getErrorMessage } from "../../../../../kb-shims/ui";

const STOP_FINALIZE_DELAY_MS = 350;
const USAGE_HYDRATE_RETRY_INTERVAL_MS = 1000;
const USAGE_HYDRATE_MAX_ATTEMPTS = 10;
const USAGE_HYDRATE_PAGE_SIZE = 2;

export interface UseDatasetsChatStreamOptions {
  datasetId: string;
  modelId: string;
  feature?: Record<string, boolean>;
  lastMessageDbIdRef: React.RefObject<string | null>;
  pendingParentIdRef: React.RefObject<string | null>;
  conversationIdRef: React.RefObject<string | undefined>;
  prevDatasetIdRef: React.RefObject<string | undefined>;
}

export interface UseDatasetsChatStreamReturn {
  currentConversationId: string | undefined;
  setConversationId: (id: string | undefined) => void;
  messages: UIMessage[];
  status: ChatStatus;
  streamingMessageId: string | null;
  setMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  regenerate: (messageId: string) => void;
  send: (
    content: string,
    parentId?: string | null,
    files?: Array<{ type: "file"; url: string; mediaType?: string; filename?: string }>,
  ) => void;
  stop: () => void;
  addToolApprovalResponse?: (args: { id: string; approved: boolean; reason?: string }) => void;
}

export function useDatasetsChatStream(
  options: UseDatasetsChatStreamOptions,
): UseDatasetsChatStreamReturn {
  const {
    datasetId,
    modelId,
    feature,
    lastMessageDbIdRef,
    pendingParentIdRef,
    conversationIdRef,
    prevDatasetIdRef,
  } = options;

  const [currentConversationId, setCurrentConversationIdState] = useState<string | undefined>();

  const token = useAuthStore((state) => state.auth.token);
  const queryClient = useQueryClient();
  const pendingTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const finalizedTokenRef = useRef<string | null>(null);
  const messagesRef = useRef<UIMessage[]>([]);
  const messageDbIdMapRef = useRef<Map<string, string>>(new Map());
  const pendingUserDbIdRef = useRef<string | null>(null);
  const pendingAssistantDbIdRef = useRef<string | null>(null);

  const scheduleTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimeoutsRef.current.delete(id);
      fn();
    }, ms);
    pendingTimeoutsRef.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    const timeouts = pendingTimeoutsRef.current;
    return () => {
      timeouts.forEach(clearTimeout);
      timeouts.clear();
    };
  }, []);

  const datasetIdRef = useRef(datasetId);
  useEffect(() => {
    datasetIdRef.current = datasetId;
  }, [datasetId]);

  const modelIdRef = useRef(modelId);
  useEffect(() => {
    modelIdRef.current = modelId;
  }, [modelId]);

  const featureRef = useRef<Record<string, boolean> | undefined>(feature);
  useEffect(() => {
    featureRef.current = feature;
  }, [feature]);
  const [statusOverride, setStatusOverride] = useState<ChatStatus | null>(null);

  const finalizeConversationSideEffects = useCallback(
    (token?: string) => {
      if (token) {
        if (finalizedTokenRef.current === token) return;
        finalizedTokenRef.current = token;
      }

      queryClient.invalidateQueries({
        queryKey: ["datasets", datasetIdRef.current, "conversations"],
      });

      const cid = conversationIdRef.current;
      const did = datasetIdRef.current;
      if (cid && did) {
        void getDatasetsConversationInfo(did, cid)
          .then((info) => {
            queryClient.setQueryData(["datasets", did, "conversation", cid], info);
          })
          .catch(() => {});
      }
    },
    [conversationIdRef, queryClient],
  );

  const mapLatestMessageId = useCallback((role: UIMessage["role"], dbId: string): boolean => {
    const latest = [...messagesRef.current].reverse().find((message) => message.role === role);
    if (!latest) return false;

    messageDbIdMapRef.current.set(latest.id, dbId);
    return true;
  }, []);

  const {
    messages,
    setMessages: setChatMessages,
    sendMessage,
    stop,
    status,
    regenerate,
    addToolApprovalResponse,
  } = useChat({
    id: datasetId ? `datasets-${datasetId}` : "datasets-new",
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      const shouldContinue =
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true,
        ) ?? false;
      return shouldContinue;
    },
    transport: new DefaultChatTransport({
      api: `${getApiBaseUrl()}/api/ai-datasets/${datasetId}/chat`,
      headers: { Authorization: token ? `Bearer ${token}` : "" },
      body: () => {
        const parentId = pendingParentIdRef.current;
        pendingParentIdRef.current = null;
        const currentFeature = featureRef.current;

        return {
          modelId: modelIdRef.current,
          conversationId: conversationIdRef.current || undefined,
          parentId,
          ...(currentFeature &&
            Object.keys(currentFeature).length > 0 && { feature: currentFeature }),
        };
      },
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);

        const isToolApprovalContinuation = request.messages.some((msg) =>
          msg.parts?.some((part) => {
            const state = (part as { state?: string }).state;
            return state === "approval-responded" || state === "output-denied";
          }),
        );

        return {
          body: {
            ...request.body,
            ...(isToolApprovalContinuation
              ? { message: lastMessage }
              : { messages: request.messages }),
          },
        };
      },
    }),
    onData: (data) => {
      if (data.type === "data-conversation-id" && data.data) {
        const newConversationId = data.data as string;
        conversationIdRef.current = newConversationId;
        setCurrentConversationIdState(newConversationId);
        queryClient.invalidateQueries({
          queryKey: ["datasets", datasetIdRef.current, "conversations"],
        });
      }

      if (
        (data.type === "data-user-message-id" || data.type === "data-assistant-message-id") &&
        data.data
      ) {
        lastMessageDbIdRef.current = data.data as string;
        if (data.type === "data-user-message-id") {
          pendingUserDbIdRef.current = data.data as string;
          if (mapLatestMessageId("user", data.data as string)) {
            pendingUserDbIdRef.current = null;
          }
        } else {
          pendingAssistantDbIdRef.current = data.data as string;
          if (mapLatestMessageId("assistant", data.data as string)) {
            pendingAssistantDbIdRef.current = null;
          }
        }
      }
    },
    onFinish: () => {
      const conversationId = conversationIdRef.current;
      const lastAssistantId = [...messagesRef.current]
        .reverse()
        .find((m) => m.role === "assistant")?.id;
      const token =
        conversationId && lastAssistantId ? `${conversationId}:${lastAssistantId}` : undefined;
      finalizeConversationSideEffects(token);
    },
    onError: (error) => {
      console.error("Error streaming datasets chat", error);
      const message = getErrorMessage(error, "对话失败，请稍后重试");
      setStatusOverride("error");
      setChatMessages((prev) => {
        if (prev.length === 0) return prev;
        const updated = [...prev];
        const lastIndex = updated.length - 1;
        const lastMessage = updated[lastIndex];
        if (lastMessage && lastMessage.role === "assistant") {
          updated[lastIndex] = {
            ...lastMessage,
            parts: [
              ...(lastMessage.parts || []),
              {
                type: "data-error",
                data: message,
              },
            ],
          };
          return updated;
        }
        updated.push({
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "data-error", data: message }],
        });
        return updated;
      });
    },
  });

  messagesRef.current = messages;

  const hydrateLastAssistantUsageFromServer = useCallback(async (): Promise<void> => {
    const conversationId = conversationIdRef.current;
    const did = datasetIdRef.current;
    if (!conversationId || !did) return;

    const lastAssistant = [...messagesRef.current].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const targetClientId = lastAssistant.id;
    const targetDbId = messageDbIdMapRef.current.get(targetClientId);

    const isStillTargetable = (): boolean => {
      if (conversationIdRef.current !== conversationId) return false;
      if (datasetIdRef.current !== did) return false;
      return messagesRef.current.some((m) => m.id === targetClientId && m.role === "assistant");
    };

    const findRecord = (items: DatasetsMessageRecord[]): DatasetsMessageRecord | undefined => {
      const matched = items.find((record) => {
        const message = record.message as { id?: string };
        return (targetDbId != null && record.id === targetDbId) || message.id === targetClientId;
      });
      if (matched) return matched;

      return items.find((record) => record.message?.role === "assistant" && record.usage != null);
    };

    const applyUsage = (record: DatasetsMessageRecord): void => {
      const usage = record.usage ?? undefined;
      if (!usage) return;

      setChatMessages((prev) =>
        prev.map((m) => {
          if (m.id !== targetClientId) return m;
          const nextMetadata: Record<string, unknown> =
            m.metadata && typeof m.metadata === "object"
              ? { ...(m.metadata as Record<string, unknown>) }
              : {};
          nextMetadata.usage = usage;

          const usagePart = { type: "data-usage" as const, data: usage };
          const nextParts = Array.isArray(m.parts) ? [...m.parts] : [];
          const usageIndex = nextParts.findIndex(
            (part) =>
              part && typeof part === "object" && (part as { type?: string }).type === "data-usage",
          );
          if (usageIndex >= 0) {
            nextParts[usageIndex] = usagePart as (typeof nextParts)[number];
          } else {
            nextParts.push(usagePart as (typeof nextParts)[number]);
          }

          return {
            ...m,
            metadata: nextMetadata as UIMessage["metadata"],
            parts: nextParts,
          };
        }),
      );
    };

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        scheduleTimeout(resolve, ms);
      });

    for (let attempt = 0; attempt < USAGE_HYDRATE_MAX_ATTEMPTS; attempt += 1) {
      if (!isStillTargetable()) return;

      let record: DatasetsMessageRecord | undefined;
      try {
        const res = await getDatasetsConversationMessages(did, conversationId, {
          page: 1,
          pageSize: USAGE_HYDRATE_PAGE_SIZE,
        });
        record = findRecord(res.items ?? []);
      } catch (error) {
        console.warn("Failed to fetch datasets conversation messages for usage hydration", error);
      }

      if (!isStillTargetable()) return;

      if (record?.usage != null) {
        applyUsage(record);
        return;
      }

      if (attempt + 1 < USAGE_HYDRATE_MAX_ATTEMPTS) {
        await sleep(USAGE_HYDRATE_RETRY_INTERVAL_MS);
      }
    }
  }, [conversationIdRef, scheduleTimeout, setChatMessages]);

  useEffect(() => {
    conversationIdRef.current = currentConversationId;
  }, [currentConversationId, conversationIdRef]);

  useEffect(() => {
    const prevId = prevDatasetIdRef.current;
    const isDatasetChange = prevId && prevId !== datasetId;

    if (isDatasetChange) {
      if (status === "streaming") {
        stop();
      }
      setChatMessages([]);
      setCurrentConversationIdState(undefined);
    }

    pendingParentIdRef.current = null;
    lastMessageDbIdRef.current = null;
    if (isDatasetChange) {
      conversationIdRef.current = undefined;
    }
    prevDatasetIdRef.current = datasetId;
  }, [datasetId, setChatMessages, status, stop, prevDatasetIdRef]);

  const handleRegenerate = useCallback(
    (messageId: string) => {
      setStatusOverride(null);
      const msgIndex = messages.findIndex((m) => m.id === messageId);
      if (msgIndex > 0 && messages[msgIndex - 1].role === "user") {
        pendingParentIdRef.current = messages[msgIndex - 1].id;
      }
      regenerate({ messageId, body: { trigger: "regenerate-message" } });
    },
    [regenerate, messages, pendingParentIdRef],
  );

  const send = useCallback(
    (
      content: string,
      parentId?: string | null,
      files?: Array<{ type: "file"; url: string; mediaType?: string; filename?: string }>,
    ) => {
      if (status === "submitted" || status === "streaming") return;
      if (!content.trim() && (!files || files.length === 0)) return;
      setStatusOverride(null);
      pendingParentIdRef.current = parentId !== undefined ? parentId : lastMessageDbIdRef.current;

      const fileParts: FileUIPart[] | undefined =
        files && files.length > 0
          ? files.map((file) => ({
              type: "file" as const,
              url: file.url,
              mediaType: file.mediaType || "application/octet-stream",
              ...(file.filename && { filename: file.filename }),
            }))
          : undefined;

      sendMessage({
        text: content.trim() || "",
        ...(fileParts && { files: fileParts }),
      });
    },
    [sendMessage, status, lastMessageDbIdRef, pendingParentIdRef],
  );

  const streamingMessageId =
    status === "streaming" && messages.length > 0
      ? messages[messages.length - 1]?.id || null
      : null;

  useEffect(() => {
    if (messages.length === 0) {
      setStatusOverride(null);
      messageDbIdMapRef.current.clear();
      pendingUserDbIdRef.current = null;
      pendingAssistantDbIdRef.current = null;
      return;
    }

    const last = messages[messages.length - 1];
    const lastUserIndex = [...messages]
      .map((message, index) => ({ message, index }))
      .reverse()
      .find(({ message }) => message.role === "user")?.index;
    if (lastUserIndex !== undefined && pendingUserDbIdRef.current) {
      messageDbIdMapRef.current.set(messages[lastUserIndex].id, pendingUserDbIdRef.current);
      pendingUserDbIdRef.current = null;
    }
    if (last?.role === "assistant" && pendingAssistantDbIdRef.current) {
      messageDbIdMapRef.current.set(last.id, pendingAssistantDbIdRef.current);
      pendingAssistantDbIdRef.current = null;
    }
  }, [messages]);

  const setConversationId = useCallback(
    (id: string | undefined) => {
      setStatusOverride(null);
      setCurrentConversationIdState(id);
      conversationIdRef.current = id;
    },
    [conversationIdRef],
  );

  const stopWithFinalize = useCallback(() => {
    const conversationId = conversationIdRef.current;
    const targetAssistantId = [...messagesRef.current]
      .reverse()
      .find((m) => m.role === "assistant")?.id;
    const token =
      conversationId && targetAssistantId ? `${conversationId}:${targetAssistantId}` : undefined;

    stop();

    scheduleTimeout(() => {
      finalizeConversationSideEffects(token);
      void hydrateLastAssistantUsageFromServer();
    }, STOP_FINALIZE_DELAY_MS);
  }, [
    stop,
    scheduleTimeout,
    finalizeConversationSideEffects,
    hydrateLastAssistantUsageFromServer,
    conversationIdRef,
  ]);

  return {
    currentConversationId,
    setConversationId,
    messages,
    status: statusOverride ?? status,
    streamingMessageId,
    setMessages: setChatMessages,
    send,
    stop: stopWithFinalize,
    regenerate: handleRegenerate,
    addToolApprovalResponse,
  };
}
