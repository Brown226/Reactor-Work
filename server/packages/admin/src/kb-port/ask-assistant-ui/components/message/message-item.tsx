// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/message-item.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { UIMessage } from "ai";
import { memo, type ReactNode } from "react";

import { useOptionalAssistantContext } from "../../context";
import type { DisplayMessage } from "../../types";
import { Message } from "./message";

export interface MessageItemProps {
  displayMessage: DisplayMessage;
  isStreaming: boolean;
  liked?: boolean;
  disliked?: boolean;
  onLike?: (id: string, value: boolean) => void;
  onDislike?: (id: string, value: boolean, dislikeReason?: string, isUpdate?: boolean) => void;
  onRegenerate?: (id: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onSwitchBranch?: (messageId: string) => void;
  addToolApprovalResponse?: (args: { id: string; approved: boolean; reason?: string }) => void;
  extraActions?: ReactNode;
}

export const MessageItem = memo(
  function MessageItem({
    displayMessage,
    isStreaming,
    liked,
    disliked,
    onLike,
    onDislike,
    onRegenerate,
    onEditMessage,
    onSwitchBranch,
    addToolApprovalResponse,
    extraActions,
  }: MessageItemProps) {
    const { id, message, branchNumber, branchCount, branches, isLast } = displayMessage;
    const { onSpeak, showConversationContext, assistantAvatar } =
      useOptionalAssistantContext() ?? {};

    return (
      <Message
        message={message}
        liked={liked}
        disliked={disliked}
        isStreaming={isStreaming}
        branchNumber={branchNumber}
        branchCount={branchCount}
        branches={branches}
        isLast={isLast}
        onLikeChange={onLike ? (v) => onLike(id, v) : undefined}
        onDislikeChange={
          onDislike ? (v, reason, isUpdate) => onDislike(id, v, reason, isUpdate) : undefined
        }
        onRetry={onRegenerate ? () => onRegenerate(id) : undefined}
        onEditMessage={onEditMessage}
        onSwitchBranch={onSwitchBranch}
        addToolApprovalResponse={addToolApprovalResponse}
        extraActions={extraActions}
        onSpeak={onSpeak}
        showConversationContext={showConversationContext}
        assistantAvatar={assistantAvatar}
      />
    );
  },
  (prev, next) => {
    const {
      displayMessage: prevDm,
      isStreaming: prevStreaming,
      liked: prevLiked,
      disliked: prevDisliked,
    } = prev;
    const {
      displayMessage: nextDm,
      isStreaming: nextStreaming,
      liked: nextLiked,
      disliked: nextDisliked,
    } = next;

    if (
      prevDm.id !== nextDm.id ||
      prevDm.branchNumber !== nextDm.branchNumber ||
      prevDm.branchCount !== nextDm.branchCount ||
      prevDm.isLast !== nextDm.isLast ||
      prevStreaming !== nextStreaming ||
      prevLiked !== nextLiked ||
      prevDisliked !== nextDisliked
    )
      return false;

    const serializeParts = (parts: UIMessage["parts"]) =>
      parts
        ?.map((p) => {
          const type = p.type;
          if (type === "text" || type === "reasoning") {
            return `${type}:${(p as { text?: string }).text || ""}`;
          }
          if (type === "file") {
            const fp = p as { url?: string; filename?: string; mediaType?: string };
            return `file:${fp.url || ""}:${fp.filename || ""}:${fp.mediaType || ""}`;
          }
          if (type === "source-url") {
            const sp = p as { url?: string; title?: string };
            return `source-url:${sp.url || ""}:${sp.title || ""}`;
          }
          if (typeof type === "string" && type.startsWith("tool-")) {
            const tp = p as { toolCallId?: string; state?: string };
            return `${type}:${tp.toolCallId || ""}:${tp.state || ""}`;
          }
          if (type === "dynamic-tool") {
            const tp = p as { toolCallId?: string; state?: string; toolName?: string };
            return `dynamic-tool:${tp.toolName || ""}:${tp.toolCallId || ""}:${tp.state || ""}`;
          }
          if (type === "data-follow-up-suggestions") {
            const data = (p as { data?: unknown }).data;
            return `${type}:${Array.isArray(data) ? data.join("\n") : ""}`;
          }
          return String(type);
        })
        .join("|") || "";

    return serializeParts(prevDm.message.parts) === serializeParts(nextDm.message.parts);
  },
);
