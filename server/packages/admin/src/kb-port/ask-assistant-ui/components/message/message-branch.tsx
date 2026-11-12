// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/message-branch.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Button } from "../../../ui/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "../../../ui/components/ui/button-group";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { memo } from "react";

export interface MessageBranchProps {
  branchNumber: number;
  branchCount: number;
  branches: string[];
  onSwitchBranch?: (messageId: string) => void;
  disabled?: boolean;
}

export const MessageBranch = memo(function MessageBranch({
  branchNumber,
  branchCount,
  branches,
  onSwitchBranch,
  disabled = false,
}: MessageBranchProps) {
  if (branchCount <= 1) return null;

  const handlePrevious = () => {
    if (branchNumber > 1) {
      const prevId = branches[branchNumber - 2];
      if (prevId) onSwitchBranch?.(prevId);
    }
  };

  const handleNext = () => {
    if (branchNumber < branchCount) {
      const nextId = branches[branchNumber];
      if (nextId) onSwitchBranch?.(nextId);
    }
  };

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
      orientation="horizontal"
    >
      <Button
        aria-label="Previous branch"
        disabled={disabled || branchNumber <= 1}
        onClick={handlePrevious}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeftIcon size={14} />
      </Button>
      <ButtonGroupText className="text-muted-foreground border-none bg-transparent shadow-none">
        {branchNumber}/{branchCount}
      </ButtonGroupText>
      <Button
        aria-label="Next branch"
        disabled={disabled || branchNumber >= branchCount}
        onClick={handleNext}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronRightIcon size={14} />
      </Button>
    </ButtonGroup>
  );
});
