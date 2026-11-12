/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/document-empty.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Upload } from "lucide-react";

interface DocumentEmptyProps {
  canUpload?: boolean;
}

export function DocumentEmpty({ canUpload }: DocumentEmptyProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20">
      <div className="bg-muted rounded-full p-4">
        <Upload className="text-muted-foreground size-8" />
      </div>
      <p className="text-muted-foreground text-sm">
        {canUpload ? "点击上方「上传文件」添加文档" : "暂无文档"}
      </p>
    </div>
  );
}
