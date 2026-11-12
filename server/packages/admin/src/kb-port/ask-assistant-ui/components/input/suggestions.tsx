// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/input/suggestions.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Button } from "../../../ui/components/ui/button";
import { memo } from "react";

export interface SuggestionData {
  id: string;
  text: string;
}

export interface SuggestionsProps {
  suggestions?: SuggestionData[];
  onSuggestionClick?: (suggestion: SuggestionData) => void;
}

export const Suggestions = memo(
  ({ suggestions = [], onSuggestionClick }: SuggestionsProps) => {
    if (suggestions.length === 0) {
      return null;
    }

    return (
      <div className="mx-auto w-full max-w-3xl py-4 pr-4">
        <div className="flex flex-wrap gap-2">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion.id}
              className="border-border bg-background text-foreground hover:bg-accent max-w-full rounded-lg border px-4 py-2 text-sm transition-colors"
              onClick={() => onSuggestionClick?.(suggestion)}
              type="button"
            >
              <span className="truncate">{suggestion.text}</span>
            </Button>
          ))}
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    const prevSuggestions = prevProps.suggestions ?? [];
    const nextSuggestions = nextProps.suggestions ?? [];

    if (prevSuggestions.length !== nextSuggestions.length) {
      return false;
    }
    return prevSuggestions.every(
      (suggestion, index) => suggestion.id === nextSuggestions[index]?.id,
    );
  },
);
