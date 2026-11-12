// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/user-message-actions.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { MessageContent as AIMessageContent } from "../../../ui/components/ai-elements/message";
import {
  MessageAction as AIMessageAction,
  MessageActions as AIMessageActions,
  MessageToolbar as AIMessageToolbar,
} from "../../../ui/components/ai-elements/message";
import { Button } from "../../../ui/components/ui/button";
import { Textarea } from "../../../ui/components/ui/textarea";
import { CopyCheck, CopyIcon, PencilIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { MessageBranch } from "./message-branch";

export interface UserMessageActionsProps {
  content: string;
  isEditing?: boolean;
  onEdit?: () => void;
  onCancel?: () => void;
  onSend?: (content: string) => void;
  onEditingChange?: (isEditing: boolean) => void;
  branchNumber?: number;
  branchCount?: number;
  branches?: string[];
  onSwitchBranch?: (messageId: string) => void;
  disabled?: boolean;
}

export const UserMessageActions = memo(function UserMessageActions({
  content,
  isEditing: externalIsEditing,
  onEdit,
  onCancel,
  onSend,
  onEditingChange,
  branchNumber = 1,
  branchCount = 1,
  branches = [],
  onSwitchBranch,
  disabled = false,
}: UserMessageActionsProps) {
  const [internalIsEditing, setInternalIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [isCopied, setIsCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isEditing = externalIsEditing ?? internalIsEditing;

  useEffect(() => {
    setEditContent(content);
  }, [content]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleEdit = () => {
    setEditContent(content);
    setInternalIsEditing(true);
    onEdit?.();
    onEditingChange?.(true);
  };

  const handleCancel = () => {
    setInternalIsEditing(false);
    setEditContent(content);
    onCancel?.();
    onEditingChange?.(false);
  };

  const handleSend = () => {
    if (editContent.trim()) {
      onSend?.(editContent);
    }
    setInternalIsEditing(false);
    onEditingChange?.(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setIsCopied(true);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => setIsCopied(false), 2000);
  };

  if (isEditing) {
    return (
      <AIMessageContent className="w-full">
        <div className="w-full space-y-2">
          <Textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="min-h-[80px] w-full resize-none border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              取消
            </Button>
            <Button size="sm" onClick={handleSend}>
              发送
            </Button>
          </div>
        </div>
      </AIMessageContent>
    );
  }

  return (
    <>
      <AIMessageContent className="break-words whitespace-pre-wrap">{content}</AIMessageContent>
      <AIMessageToolbar className="mt-2 flex min-w-0 justify-end">
        <AIMessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
          {onSend && (
            <AIMessageAction label="Edit" onClick={handleEdit} tooltip="编辑">
              <PencilIcon className="size-4" />
            </AIMessageAction>
          )}
          <AIMessageAction label="Copy" onClick={handleCopy} tooltip={isCopied ? "已复制" : "复制"}>
            {isCopied ? <CopyCheck className="size-4" /> : <CopyIcon className="size-4" />}
          </AIMessageAction>
          {onSwitchBranch && (
            <MessageBranch
              branchNumber={branchNumber}
              branchCount={branchCount}
              branches={branches}
              onSwitchBranch={onSwitchBranch}
              disabled={disabled}
            />
          )}
        </AIMessageActions>
      </AIMessageToolbar>
    </>
  );
});
