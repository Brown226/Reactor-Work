// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/message-tools.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { UIMessage } from "ai";
import { memo } from "react";

import { useOptionalAssistantContext } from "../../context";
import { GenericTool } from "../tools/generic-tool";
import { ImageGenerationTool } from "../tools/image-generation-tool";
import { KnowledgeReferences } from "../tools/knowledge-references";
import { PlanTool } from "../tools/plan-tool";
import { WeatherTool } from "../tools/weather-tool";

interface ToolPartData {
  toolCallId: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string; approved?: boolean };
}

export interface MessageToolsProps {
  parts: UIMessage["parts"];
  addToolApprovalResponse?: (args: { id: string; approved: boolean; reason?: string }) => void;
}

export const MessageTools = memo(function MessageTools({
  parts,
  addToolApprovalResponse,
}: MessageToolsProps) {
  const ctx = useOptionalAssistantContext();
  const showReference = ctx?.showReference ?? true;
  const showMcpToolDetails = ctx?.showMcpToolDetails ?? true;
  const toolParts = parts.filter(
    (part) =>
      typeof part.type === "string" &&
      (part.type.startsWith("tool-") || part.type === "dynamic-tool"),
  );

  if (toolParts.length === 0) return null;

  return (
    <>
      {toolParts.map((part, index) => {
        const toolPart = part as unknown as ToolPartData;
        const key = toolPart.toolCallId || `tool-${index}`;

        if (part.type === "tool-datasetsSearch") {
          if (!showReference) return null;
          const output = toolPart.output as { found?: boolean; results?: unknown[] } | undefined;
          if (output?.found && Array.isArray(output.results) && output.results.length > 0) {
            return <KnowledgeReferences key={key} toolPart={{ output: output.results }} />;
          }
          return null;
        }

        if (part.type === "tool-getInformation") {
          if (!showReference) return null;
          const output = toolPart.output;
          if (Array.isArray(output) && output.length > 0) {
            return <KnowledgeReferences key={key} toolPart={toolPart} />;
          }
          return null;
        }

        if ("output" in toolPart && Array.isArray(toolPart.output) && toolPart.output.length > 0) {
          return null;
        }

        if (part.type === "tool-getWeather") {
          return (
            <WeatherTool
              key={key}
              toolPart={toolPart}
              addToolApprovalResponse={addToolApprovalResponse}
            />
          );
        }

        if (part.type === "tool-request_execution_plan") {
          const planningParts = parts.filter(
            (p) =>
              p &&
              typeof p === "object" &&
              "type" in p &&
              (p as { type: string }).type === "data-planning-status",
          ) as Array<{ type: string; data?: { phase?: string; planPreview?: string } }>;
          const planningStatus =
            planningParts.length > 0 ? planningParts[planningParts.length - 1].data : undefined;
          return (
            <PlanTool
              key={key}
              toolPart={toolPart}
              planningStatus={
                planningStatus
                  ? { phase: planningStatus.phase ?? "", planPreview: planningStatus.planPreview }
                  : undefined
              }
            />
          );
        }

        if (
          part.type === "tool-dalle2ImageGeneration" ||
          part.type === "tool-dalle3ImageGeneration" ||
          part.type === "tool-gptImageGeneration"
        ) {
          return (
            <ImageGenerationTool
              key={key}
              toolPart={toolPart}
              addToolApprovalResponse={addToolApprovalResponse}
            />
          );
        }

        const toolName =
          part.type === "dynamic-tool"
            ? ((part as unknown as { toolName?: string }).toolName ?? "tool")
            : (part.type as string).replace("tool-", "");
        return (
          <GenericTool
            key={key}
            toolName={toolName}
            toolPart={toolPart}
            showDetails={showMcpToolDetails}
          />
        );
      })}
    </>
  );
});
