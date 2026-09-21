// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/tools/generic-tool.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  getStatusBadge,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "../../../ui/components/ai-elements/tool";
import { WrenchIcon } from "lucide-react";
import { memo } from "react";

interface ToolPartData {
  toolCallId: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string; approved?: boolean };
}

export interface GenericToolProps {
  toolName: string;
  toolPart: ToolPartData;
  showDetails?: boolean;
}

export const GenericTool = memo(function GenericTool({
  toolName,
  toolPart,
  showDetails = true,
}: GenericToolProps) {
  if (!showDetails) {
    return (
      <div className="group not-prose mb-4 w-full rounded-md border">
        <div className="flex w-full items-center justify-between gap-4 p-3">
          <div className="flex items-center gap-2">
            <WrenchIcon className="text-muted-foreground size-4" />
            <span className="text-sm font-medium">{toolName}</span>
            {getStatusBadge(toolPart.state as never)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Tool>
      <ToolHeader state={toolPart.state as never} title={toolName} type="tool-invocation" />
      <ToolContent>
        <ToolInput input={toolPart.input} />
        <ToolOutput errorText={toolPart.errorText} output={toolPart.output} />
      </ToolContent>
    </Tool>
  );
});
