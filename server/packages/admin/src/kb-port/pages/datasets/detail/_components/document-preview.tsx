/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/document-preview.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Button } from "../../../../ui/components/ui/button";
import { ArrowLeft, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";

const OFFICE_VIEWER_BASE = "https://view.officeapps.live.com/op/embed.aspx";

export interface DocumentPreviewProps {
  fileUrl: string;
  fileName: string;
  onBack: () => void;
}

export function DocumentPreview({ fileUrl, fileName, onBack }: DocumentPreviewProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const viewerUrl = `${OFFICE_VIEWER_BASE}?src=${encodeURIComponent(fileUrl)}`;

  return (
    <div
      className={
        fullscreen
          ? "bg-background fixed inset-0 z-50 flex flex-col"
          : "bg-card mt-4 flex min-h-[70vh] flex-col rounded-xl border shadow-sm"
      }
    >
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (fullscreen) {
              setFullscreen(false);
            } else {
              onBack();
            }
          }}
          className="-ml-2 gap-2"
        >
          <ArrowLeft className="size-4" />
          {fullscreen ? "退出预览" : "返回列表"}
        </Button>
        <span className="text-muted-foreground truncate text-sm" title={fileName}>
          {fileName}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="gap-2"
            onClick={() => setFullscreen((v) => !v)}
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        </div>
      </div>
      <div className="bg-muted/30 relative min-h-0 flex-1 p-4">
        <iframe
          src={viewerUrl}
          title={fileName}
          className={
            fullscreen
              ? "bg-background h-full w-full border-0"
              : "bg-background h-full min-h-[60vh] w-full rounded-lg border-0 shadow-inner"
          }
        />
      </div>
    </div>
  );
}
