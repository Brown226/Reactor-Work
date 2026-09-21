/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/ui/resizable.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { cn } from "../../lib/utils";
import * as React from "react";
import * as ResizablePrimitive from "react-resizable-panels";

export type { ImperativePanelHandle } from "react-resizable-panels";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className)}
      {...props}
    />
  );
}

const ResizablePanel = React.forwardRef<
  React.ComponentRef<typeof ResizablePrimitive.Panel>,
  React.ComponentProps<typeof ResizablePrimitive.Panel>
>((props, ref) => <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} ref={ref} />);
ResizablePanel.displayName = "ResizablePanel";

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        "bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2 [&[data-panel-group-direction=vertical]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && <div className="bg-border z-10 flex h-6 w-1 shrink-0 rounded-lg" />}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
