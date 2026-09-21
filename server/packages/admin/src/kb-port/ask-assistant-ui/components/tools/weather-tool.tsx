// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/tools/weather-tool.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "../../../ui/components/ai-elements/tool";
import { memo } from "react";

import { Weather } from "./weather";

interface ToolPartData {
  toolCallId: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string; approved?: boolean };
}

export interface WeatherToolProps {
  toolPart: ToolPartData;
  addToolApprovalResponse?: (args: { id: string; approved: boolean; reason?: string }) => void;
}

export const WeatherTool = memo(function WeatherTool({ toolPart }: WeatherToolProps) {
  const { state, approval, input, output, errorText } = toolPart;
  const isDenied =
    state === "output-denied" || (state === "approval-responded" && approval?.approved === false);
  const widthClass = "w-[min(100%,450px)]";

  if (state === "output-available") {
    return (
      <div className={widthClass}>
        <Weather weatherAtLocation={output as Parameters<typeof Weather>[0]["weatherAtLocation"]} />
      </div>
    );
  }

  if (isDenied) {
    return (
      <div className={widthClass}>
        <Tool className="w-full" defaultOpen>
          <ToolHeader state="output-error" type="tool-getWeather" />
          <ToolContent>
            <div className="text-muted-foreground px-4 py-3 text-sm">
              Weather lookup was denied.
            </div>
          </ToolContent>
        </Tool>
      </div>
    );
  }

  if (errorText || (output as { error?: string })?.error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50">
        错误: {String(errorText || (output as { error?: string })?.error)}
      </div>
    );
  }

  return (
    <div className={widthClass}>
      <Tool className="w-full" defaultOpen>
        <ToolHeader
          state={(state === "approval-requested" ? "input-available" : state) as "input-available"}
          type="tool-getWeather"
        />
        <ToolContent>
          {(state === "input-available" || state === "approval-requested") && (
            <ToolInput input={input} />
          )}
        </ToolContent>
      </Tool>
    </div>
  );
});
