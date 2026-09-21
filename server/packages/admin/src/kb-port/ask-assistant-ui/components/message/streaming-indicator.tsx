// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（ask-assistant-ui 原样移植（宽松类型））。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/components/ask-assistant-ui/components/message/streaming-indicator.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { memo } from "react";

export const StreamingIndicator = memo(function StreamingIndicator() {
  return (
    <div className="flex items-center p-2">
      <div
        className="bg-foreground size-2 rounded-full"
        style={{
          animation: "streaming-pulse 1.2s ease-in-out infinite",
          transformOrigin: "center",
        }}
      />
      <style>{`
        @keyframes streaming-pulse {
          0%, 100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.6);
            opacity: 0.6;
          }
        }
      `}</style>
    </div>
  );
});
