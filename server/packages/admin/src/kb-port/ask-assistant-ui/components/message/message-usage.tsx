// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@/components/provider-icons）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/message-usage.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "../../../ui/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/components/ui/tooltip";
import { BarChart3Icon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { ProviderIcon } from "../../../../kb-shims/ui";

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  extraTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface MessageUsageProps {
  usage?: Usage;
  userConsumedPower?: number | null;
  provider?: string;
  modelName?: string;
}

type ViewMode = "token" | "power";

export const MessageUsage = memo(function MessageUsage({
  usage,
  userConsumedPower,
  provider,
  modelName,
}: MessageUsageProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("token");
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? 0;
  const extraTokens = usage?.extraTokens ?? 0;
  const inputDetails = usage?.inputTokenDetails;
  const outputDetails = usage?.outputTokenDetails;
  const reasoningTokens = usage?.reasoningTokens ?? outputDetails?.reasoningTokens ?? 0;
  const cachedInputTokens = usage?.cachedInputTokens ?? inputDetails?.cacheReadTokens ?? 0;
  const consumedPower = userConsumedPower ?? 0;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex size-8 items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <BarChart3Icon className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>Token用量</p>
        </TooltipContent>
      </Tooltip>
      <PopoverContent ref={popoverRef} className="w-62" align="center" side="top">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {provider && <ProviderIcon provider={provider} className="size-4" />}
              {modelName ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="line-clamp-1 max-w-[120px] text-sm font-semibold">
                      {modelName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{modelName}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div className="text-sm font-semibold">
                  {viewMode === "token" ? "Token用量" : "积分消耗"}
                </div>
              )}
            </div>
            <Tabs
              value={viewMode}
              onValueChange={(value) => {
                if (value === "token" || value === "power") {
                  setViewMode(value);
                }
              }}
              className="w-fit"
            >
              <TabsList className="h-7">
                <TabsTrigger value="token" className="text-xs">
                  Token
                </TabsTrigger>
                <TabsTrigger value="power" className="text-xs">
                  积分
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {viewMode === "token" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-muted-foreground text-xs">输入</div>
                  <div className="text-lg font-semibold">{inputTokens.toLocaleString()}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-muted-foreground text-xs">输出</div>
                  <div className="text-lg font-semibold">{outputTokens.toLocaleString()}</div>
                </div>
              </div>
              <div className="border-t pt-3">
                <div className="space-y-1">
                  <div className="text-muted-foreground text-xs">总计</div>
                  <div className="text-xl font-bold">{totalTokens.toLocaleString()}</div>
                </div>
                {extraTokens > 0 && (
                  <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                    <div className="text-muted-foreground">额外模型 Tokens</div>
                    <div className="text-right font-medium">{extraTokens.toLocaleString()}</div>
                  </div>
                )}
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="text-muted-foreground">文本 Tokens</div>
                    <div className="text-right font-medium">
                      {(outputDetails?.textTokens ?? outputTokens).toLocaleString()}
                    </div>
                    <div className="text-muted-foreground">思考 Tokens</div>
                    <div className="text-right font-medium">{reasoningTokens.toLocaleString()}</div>
                  </div>
                  {inputDetails && (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="text-muted-foreground">非缓存输入</div>
                      <div className="text-right font-medium">
                        {(inputDetails.noCacheTokens ?? inputTokens).toLocaleString()}
                      </div>
                      <div className="text-muted-foreground">缓存命中</div>
                      <div className="text-right font-medium">
                        {(inputDetails.cacheReadTokens ?? cachedInputTokens).toLocaleString()}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="text-muted-foreground">缓存输入 Tokens</div>
                    <div className="text-right font-medium">
                      {cachedInputTokens.toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="text-muted-foreground text-xs">消耗积分</div>
                <div className="text-2xl font-bold">{consumedPower.toLocaleString()}</div>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
});
