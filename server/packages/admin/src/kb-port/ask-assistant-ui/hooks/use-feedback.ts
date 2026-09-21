// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/hooks/use-feedback.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useCreateFeedbackMutation } from "../../../kb-shims/console-services";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * 从消息中解析真实的消息ID
 * 优先使用 data-assistant-message-id part 中的 data，否则使用 messageKey
 */
function resolveMessageId(message: UIMessage | undefined, messageKey: string): string {
  if (!message) return messageKey;

  const assistantMessageIdPart = message.parts?.find(
    (part) => part.type === "data-assistant-message-id",
  );

  if (assistantMessageIdPart && "data" in assistantMessageIdPart && assistantMessageIdPart.data) {
    return assistantMessageIdPart.data as string;
  }

  return messageKey;
}

export function useFeedback(streamMessages: UIMessage[], conversationId?: string) {
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [disliked, setDisliked] = useState<Record<string, boolean>>({});
  const createFeedbackMutation = useCreateFeedbackMutation();

  useEffect(() => {
    if (!streamMessages.length) return;

    const likedMap: Record<string, boolean> = {};
    const dislikedMap: Record<string, boolean> = {};

    for (const message of streamMessages) {
      const resolvedId = resolveMessageId(message, message.id);
      const key = resolvedId || message.id;
      const feedback = (message as unknown as { feedback?: { type?: "like" | "dislike" } })
        .feedback;
      const type = feedback?.type;
      if (type === "like") {
        likedMap[key] = true;
      } else if (type === "dislike") {
        dislikedMap[key] = true;
      }
    }

    setLiked(likedMap);
    setDisliked(dislikedMap);
  }, [streamMessages]);

  useEffect(() => {
    if (!conversationId) {
      setLiked({});
      setDisliked({});
    }
  }, [conversationId]);

  const updateFeedbackState = useCallback(
    (messageKey: string, type: "like" | "dislike", value: boolean) => {
      if (type === "like") {
        if (value) {
          setLiked((prev) => ({ ...prev, [messageKey]: true }));
          setDisliked((prev) => {
            const newState = { ...prev };
            delete newState[messageKey];
            return newState;
          });
        } else {
          setLiked((prev) => {
            const newState = { ...prev };
            delete newState[messageKey];
            return newState;
          });
        }
      } else {
        if (value) {
          setDisliked((prev) => ({ ...prev, [messageKey]: true }));
          setLiked((prev) => {
            const newState = { ...prev };
            delete newState[messageKey];
            return newState;
          });
        } else {
          setDisliked((prev) => {
            const newState = { ...prev };
            delete newState[messageKey];
            return newState;
          });
        }
      }
    },
    [],
  );

  const handleLike = useCallback(
    async (messageKey: string, value: boolean) => {
      try {
        const message = streamMessages.find((m) => m.id === messageKey);
        const messageId = resolveMessageId(message, messageKey);

        await createFeedbackMutation.mutateAsync({
          messageId,
          type: "like",
        });

        updateFeedbackState(messageKey, "like", value);
      } catch (error) {
        toast.error("操作失败", {
          description: error instanceof Error ? error.message : "未知错误",
        });
      }
    },
    [streamMessages, createFeedbackMutation, updateFeedbackState],
  );

  const handleDislike = useCallback(
    async (messageKey: string, value: boolean, dislikeReason?: string) => {
      try {
        const message = streamMessages.find((m) => m.id === messageKey);
        const messageId = resolveMessageId(message, messageKey);

        if (value) {
          await createFeedbackMutation.mutateAsync({
            messageId,
            type: "dislike",
            dislikeReason: dislikeReason || undefined,
          });
        } else {
          await createFeedbackMutation.mutateAsync({
            messageId,
            type: "dislike",
          });
        }

        updateFeedbackState(messageKey, "dislike", value);
      } catch (error) {
        toast.error("操作失败", {
          description: error instanceof Error ? error.message : "未知错误",
        });
      }
    },
    [streamMessages, createFeedbackMutation, updateFeedbackState],
  );

  return {
    liked,
    disliked,
    onLike: handleLike,
    onDislike: handleDislike,
  };
}
