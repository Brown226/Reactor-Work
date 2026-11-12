/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/document-drop-zone.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { cn } from "../../../../ui/lib/utils";
import { FileUp } from "lucide-react";

export interface DocumentDropZoneProps {
  isOver: boolean;
  visible: boolean;
}

export function DocumentDropZone({ isOver, visible }: DocumentDropZoneProps) {
  if (visible) {
    return (
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-10 flex flex-col transition-all",
          isOver ? "bg-primary/5 backdrop-blur-xs" : "bg-background/60 backdrop-blur-xs",
        )}
      >
        <div className="flex flex-1 items-center justify-center">
          <div
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-12 py-10 transition-colors",
              isOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/20 bg-background/80",
            )}
          >
            <div
              className={cn(
                "rounded-xl p-3 transition-colors",
                isOver ? "bg-primary/10" : "bg-muted",
              )}
            >
              <FileUp className={cn("size-8", isOver ? "text-primary" : "text-muted-foreground")} />
            </div>
            <p
              className={cn(
                "text-sm font-medium transition-colors",
                isOver ? "text-primary" : "text-muted-foreground",
              )}
            >
              {isOver ? "释放文件以上传" : "拖放文件到此处创建文档"}
            </p>
          </div>
        </div>

        {!isOver && (
          <div className="border-muted-foreground/20 bg-background/80 flex shrink-0 items-center justify-center gap-2 border-t py-2.5">
            <FileUp className="text-muted-foreground size-3.5" />
            <p className="text-muted-foreground text-xs">拖放文件到此处创建文档</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 py-2.5">
      <FileUp className="text-muted-foreground/40 size-3.5" />
      <p className="text-muted-foreground/40 text-xs">拖放文件到此处创建文档</p>
    </div>
  );
}
