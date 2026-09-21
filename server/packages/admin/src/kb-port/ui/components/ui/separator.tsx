/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/ui/separator.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
"use client";

import { cn } from "../../lib/utils";
import { Separator as SeparatorPrimitive } from "radix-ui";
import * as React from "react";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "bg-border shrink-0 data-horizontal:h-px data-horizontal:w-full data-vertical:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
