/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/ui/textarea.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { cn } from "../../lib/utils";
import * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-2.5 py-2 text-sm break-all shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[3px]",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
