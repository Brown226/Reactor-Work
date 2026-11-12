/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/document-batch-actions.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Button } from "../../../../ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../ui/components/ui/tooltip";
import { cn } from "../../../../ui/lib/utils";
import { ArrowLeftRightIcon, FilesIcon, Tag, TrashIcon, X } from "lucide-react";

export interface DocumentBatchActionsProps {
  selectedCount: number;
  onEditTags?: () => void;
  onMove?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onClose?: () => void;
  className?: string;
}

export function DocumentBatchActions({
  selectedCount,
  onEditTags,
  onMove,
  onDelete,
  onCopy,
  onClose,
  className,
}: DocumentBatchActionsProps) {
  if (selectedCount <= 0) return null;

  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      <ActionButton tooltip="编辑标签" onClick={onEditTags}>
        <Tag className="size-4" />
      </ActionButton>

      <ActionButton tooltip="移动" onClick={onMove}>
        <ArrowLeftRightIcon className="size-4" />
      </ActionButton>

      <ActionButton tooltip="复制" onClick={onCopy}>
        <FilesIcon className="size-4" />
      </ActionButton>

      <ActionButton tooltip="删除" onClick={onDelete}>
        <TrashIcon className="size-4" />
      </ActionButton>

      <ActionButton tooltip="退出" onClick={onClose}>
        <X className="size-4" />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClick}
          aria-label={tooltip}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
