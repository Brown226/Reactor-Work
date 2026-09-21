// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/message-actions.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  MessageAction as AIMessageAction,
  MessageActions as AIMessageActions,
} from "../../../ui/components/ai-elements/message";
import {
  CopyCheck,
  CopyIcon,
  Loader2,
  RefreshCcwIcon,
  Square,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Volume2Icon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { MessageContext } from "./message-context";
import { MessageUsage, type MessageUsageProps } from "./message-usage";

export interface MessageActionsProps extends MessageUsageProps {
  messageId?: string;
  liked: boolean;
  disliked: boolean;
  content: string;
  errorMessage?: string;
  conversationContext?: Array<{ role: string; content: string }>;
  provider?: string;
  modelName?: string;
  onLikeChange?: (liked: boolean) => void;
  onDislikeChange?: (disliked: boolean, dislikeReason?: string, isUpdate?: boolean) => void;
  onRetry?: () => void;
  onShowFeedbackCard?: (show: boolean) => void;
  onSpeak?: (
    text: string,
    options?: { onReady?: (stop: () => void) => void },
  ) => void | Promise<void>;
  extraActions?: ReactNode;
}

export const MessageActions = memo(function MessageActions({
  messageId,
  liked,
  disliked,
  content,
  errorMessage,
  usage,
  conversationContext,
  userConsumedPower,
  provider,
  modelName,
  onLikeChange,
  onDislikeChange,
  onRetry,
  onShowFeedbackCard,
  onSpeak,
  extraActions,
}: MessageActionsProps) {
  const [isCopied, setIsCopied] = useState(false);
  const [isTtsLoading, setIsTtsLoading] = useState(false);
  const [isTtsPlaying, setIsTtsPlaying] = useState(false);
  const ttsStopRef = useRef<(() => void) | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasValidMessageId = !!messageId;

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleSpeakClick = useCallback(async () => {
    if (!onSpeak || !content.trim()) return;
    if (isTtsPlaying && ttsStopRef.current) {
      ttsStopRef.current();
      ttsStopRef.current = null;
      setIsTtsPlaying(false);
      return;
    }
    if (isTtsLoading) return;
    setIsTtsLoading(true);
    try {
      await onSpeak(content, {
        onReady: (stop) => {
          ttsStopRef.current = stop;
          setIsTtsLoading(false);
          setIsTtsPlaying(true);
        },
      });
    } finally {
      setIsTtsLoading(false);
      setIsTtsPlaying(false);
      ttsStopRef.current = null;
    }
  }, [onSpeak, content, isTtsLoading, isTtsPlaying]);

  const handleCopy = () => {
    const copyContent = errorMessage || content || "";
    navigator.clipboard.writeText(copyContent);
    setIsCopied(true);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => setIsCopied(false), 2000);
  };

  const handleLike = async () => {
    if (!onLikeChange) return;
    await onLikeChange(!liked);
  };

  const handleDislike = async () => {
    if (!onDislikeChange) return;
    await onDislikeChange(false);
    onShowFeedbackCard?.(false);
  };

  return (
    <AIMessageActions>
      {onRetry && (
        <AIMessageAction label="Retry" onClick={onRetry} tooltip="重新生成">
          <RefreshCcwIcon className="size-4" />
        </AIMessageAction>
      )}
      {hasValidMessageId && onLikeChange && !disliked && (
        <AIMessageAction label="Like" onClick={handleLike} tooltip="喜欢">
          <ThumbsUpIcon className="size-4" fill={liked ? "currentColor" : "none"} />
        </AIMessageAction>
      )}
      {hasValidMessageId && onDislikeChange && !liked && (
        <AIMessageAction
          label="Dislike"
          onClick={async () => {
            if (disliked) {
              await handleDislike();
            } else {
              await onDislikeChange(true);
              onShowFeedbackCard?.(true);
            }
          }}
          tooltip="不喜欢"
        >
          <ThumbsDownIcon className="size-4" fill={disliked ? "currentColor" : "none"} />
        </AIMessageAction>
      )}
      <AIMessageAction label="Copy" onClick={handleCopy} tooltip={isCopied ? "已复制" : "复制"}>
        {isCopied ? <CopyCheck className="size-4" /> : <CopyIcon className="size-4" />}
      </AIMessageAction>
      {onSpeak && content.trim() && (
        <AIMessageAction
          label={isTtsPlaying ? "停止" : "朗读"}
          onClick={handleSpeakClick}
          tooltip={isTtsLoading ? "合成中…" : isTtsPlaying ? "停止朗读" : "朗读"}
        >
          {isTtsLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : isTtsPlaying ? (
            <Square className="size-4" />
          ) : (
            <Volume2Icon className="size-4" />
          )}
        </AIMessageAction>
      )}
      <MessageUsage
        usage={usage}
        userConsumedPower={userConsumedPower}
        provider={provider}
        modelName={modelName}
      />
      {conversationContext?.length ? <MessageContext messages={conversationContext} /> : null}
      {extraActions}
    </AIMessageActions>
  );
});
