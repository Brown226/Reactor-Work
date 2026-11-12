/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/dialogs/upload-dialog.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Button } from "../../../../../ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../../../ui/components/ui/dialog";
import { Input } from "../../../../../ui/components/ui/input";
import { cn } from "../../../../../ui/lib/utils";
import { ArrowUp } from "lucide-react";
import { useCallback, useState } from "react";

export interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload?: (files: File[]) => void;
  onUploadUrl?: (url: string) => void;
}

export function UploadDialog({ open, onOpenChange, onUpload, onUploadUrl }: UploadDialogProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [url, setUrl] = useState("");

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        onUpload?.(Array.from(e.dataTransfer.files));
        onOpenChange(false);
      }
    },
    [onUpload, onOpenChange],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        onUpload?.(Array.from(e.target.files));
        onOpenChange(false);
      }
    },
    [onUpload, onOpenChange],
  );

  const handleUploadUrl = useCallback(() => {
    const value = url.trim();
    if (!value) return;
    onUploadUrl?.(value);
    setUrl("");
    onOpenChange(false);
  }, [url, onUploadUrl, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-0 shadow-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>上传文件</DialogTitle>
          <DialogDescription>
            支持常用 .pdf、.docx、.pptx、.xlsx、.csv、.txt 等各种格式
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            "rounded-lg p-8 text-center transition-colors",
            isDragging ? "bg-primary/5" : "bg-muted/30 hover:bg-muted/50",
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            multiple
            className="hidden"
            id="file-upload-dialog"
            onChange={handleFileSelect}
            accept="*/*"
          />
          <label
            htmlFor="file-upload-dialog"
            className="flex cursor-pointer flex-col items-center gap-3"
          >
            <div className="bg-muted rounded-full p-4">
              <ArrowUp className="text-muted-foreground size-6" />
            </div>
            <div className="text-sm font-semibold">拖入文件或从本地上传</div>
            <Button variant="ghost" size="sm" asChild>
              <span>选择文件</span>
            </Button>
          </label>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Input
            placeholder="输入在线文件链接，例如 https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button variant="outline" onClick={handleUploadUrl} disabled={!url.trim()}>
            确认
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
