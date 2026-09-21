// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/http, @buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/hooks/use-messages-paging.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { type HttpError } from "../../../kb-shims/ui";
import { getConversationMessages, useConversationMessagesQuery } from "../../../kb-shims/console-services";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

export interface UseMessagesPagingReturn {
  isLoadingMessages: boolean;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  loadMoreMessages: () => void;
  mergeAndSortMessages: (base: UIMessage[], incoming: UIMessage[]) => UIMessage[];
}

export interface UseMessagesPagingOptions {
  setMessages: (messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void;
  lastMessageDbIdRef: React.RefObject<string | null>;
  getDbMessageId: (clientMessageId: string) => string | undefined;
}

export function useMessagesPaging({
  setMessages,
  lastMessageDbIdRef,
  getDbMessageId,
}: UseMessagesPagingOptions): UseMessagesPagingReturn {
  const { id: currentThreadId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pageSize = 20;

  const {
    data: messagesData,
    isLoading: isLoadingMessages,
    error,
  } = useConversationMessagesQuery(
    { conversationId: currentThreadId || "", page: 1, pageSize },
    { enabled: !!currentThreadId, refetchOnWindowFocus: false, retry: false },
  );

  useEffect(() => {
    if ((error as HttpError)?.status === 404) {
      navigate("/", { replace: true });
    }
  }, [error, navigate]);

  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const nextPageRef = useRef(2);
  const loadMoreLockRef = useRef(false);

  const mergeAndSortMessages = useCallback(
    (base: UIMessage[], incoming: UIMessage[]) => {
      const map = new Map<string, UIMessage>();
      const dbIdToLocalId = new Map<string, string>();

      const remapMessageParentId = (message: UIMessage): UIMessage => {
        const metadata = (message.metadata as Record<string, unknown> | undefined) ?? undefined;
        const parentId =
          typeof metadata?.parentId === "string" ? (metadata.parentId as string) : undefined;

        if (!parentId) return message;

        const localParentId = dbIdToLocalId.get(parentId);
        if (!localParentId || localParentId === parentId) return message;

        return {
          ...message,
          metadata: {
            ...metadata,
            parentId: localParentId,
          },
        } as UIMessage;
      };

      for (const m of base) {
        map.set(m.id, m);
        const dbId = getDbMessageId(m.id);
        if (dbId) {
          dbIdToLocalId.set(dbId, m.id);
        }
      }

      for (const m of incoming) {
        const normalizedIncoming = remapMessageParentId(m);
        const localId = dbIdToLocalId.get(m.id);
        if (localId && localId !== m.id) {
          const localMessage = map.get(localId);
          if (localMessage) {
            map.set(localId, {
              ...normalizedIncoming,
              ...localMessage,
              id: localId,
              metadata: {
                ...((localMessage.metadata as Record<string, unknown> | undefined) ?? {}),
                ...((normalizedIncoming.metadata as Record<string, unknown> | undefined) ?? {}),
              },
            } as UIMessage);
          }
          continue;
        }

        if (!map.has(m.id)) {
          map.set(normalizedIncoming.id, normalizedIncoming);
        }
      }
      const arr = Array.from(map.values());
      arr.sort((a, b) => {
        const sa = (a.metadata as { sequence?: number } | undefined)?.sequence;
        const sb = (b.metadata as { sequence?: number } | undefined)?.sequence;
        const na = typeof sa === "number" ? sa : Number.POSITIVE_INFINITY;
        const nb = typeof sb === "number" ? sb : Number.POSITIVE_INFINITY;
        return na - nb;
      });
      return arr;
    },
    [getDbMessageId],
  );

  useEffect(() => {
    if (!currentThreadId) {
      setMessages([]);
      return;
    }

    if (messagesData?.items.length) {
      setHasMoreMessages(messagesData.page < messagesData.totalPages);
      nextPageRef.current = Math.max(2, messagesData.page + 1);

      const sortedItems = [...messagesData.items].sort((a, b) => a.sequence - b.sequence);
      let lastAssistantId: string | null = null;
      let lastUserId: string | null = null;

      const pageMessages = sortedItems.map((item) => {
        const role = item.message.role === "tool" ? "assistant" : item.message.role;
        let parentId = item.parentId ?? null;

        if (parentId == null) {
          if (role === "user") {
            parentId = lastAssistantId;
            lastUserId = item.id;
          } else if (role === "assistant") {
            parentId = lastUserId;
            lastAssistantId = item.id;
          }
        } else {
          if (role === "user") lastUserId = item.id;
          else if (role === "assistant") lastAssistantId = item.id;
        }

        return {
          ...item.message,
          id: item.id,
          metadata: {
            ...(item.message.metadata ?? {}),
            sequence: item.sequence,
            parentId,
            ...(item.createdAt && { createdAt: item.createdAt }),
          },
        };
      }) as UIMessage[];

      setMessages((prev) => {
        const merged = mergeAndSortMessages(prev, pageMessages);
        if (merged.length > 0) {
          lastMessageDbIdRef.current = merged[merged.length - 1].id;
        }
        return merged;
      });
    }
  }, [currentThreadId, messagesData, mergeAndSortMessages, setMessages, lastMessageDbIdRef]);

  const loadMoreMessages = useCallback(() => {
    const conversationId = currentThreadId;
    if (!conversationId) return;
    if (!hasMoreMessages) return;
    if (isLoadingMoreMessages) return;
    if (loadMoreLockRef.current) return;

    loadMoreLockRef.current = true;
    setIsLoadingMoreMessages(true);

    const page = nextPageRef.current;
    void getConversationMessages({ conversationId, page, pageSize })
      .then((res) => {
        setHasMoreMessages(res.page < res.totalPages);
        nextPageRef.current = res.page + 1;

        const sortedItems = [...res.items].sort((a, b) => a.sequence - b.sequence);
        let lastAssistantId: string | null = null;
        let lastUserId: string | null = null;

        const incoming = sortedItems.map((item) => {
          const role = item.message.role === "tool" ? "assistant" : item.message.role;
          let parentId = item.parentId ?? null;

          if (parentId == null) {
            if (role === "user") {
              parentId = lastAssistantId;
              lastUserId = item.id;
            } else if (role === "assistant") {
              parentId = lastUserId;
              lastAssistantId = item.id;
            }
          } else {
            if (role === "user") lastUserId = item.id;
            else if (role === "assistant") lastAssistantId = item.id;
          }

          return {
            ...item.message,
            id: item.id,
            metadata: {
              ...(item.message.metadata ?? {}),
              sequence: item.sequence,
              parentId,
              ...(item.createdAt && { createdAt: item.createdAt }),
            },
          };
        }) as UIMessage[];

        setMessages((prev) => mergeAndSortMessages(prev, incoming));
      })
      .catch(() => {})
      .finally(() => {
        setIsLoadingMoreMessages(false);
        loadMoreLockRef.current = false;
      });
  }, [
    currentThreadId,
    hasMoreMessages,
    isLoadingMoreMessages,
    mergeAndSortMessages,
    pageSize,
    setMessages,
  ]);

  return {
    isLoadingMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    loadMoreMessages,
    mergeAndSortMessages,
  };
}
