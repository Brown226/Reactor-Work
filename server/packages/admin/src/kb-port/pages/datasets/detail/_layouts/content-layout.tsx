/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_layouts/content-layout.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { ScrollArea } from "../../../../ui/components/ui/scroll-area";
import type { ReactNode } from "react";

import { DocumentDropZone } from "../_components/document-drop-zone";
import { useDatasetDetailContext } from "../context";
import { useDocumentDrop } from "../hooks";

export interface ContentLayoutProps {
  children: ReactNode;
}

export function ContentLayout({ children }: ContentLayoutProps) {
  const { canManageDocuments, uploadDocuments } = useDatasetDetailContext();
  const { zoneRef, isOver, showDropZone, handlers } = useDocumentDrop({
    enabled: canManageDocuments,
    onDrop: uploadDocuments,
  });

  return (
    <div ref={zoneRef} className="relative flex h-full min-h-0 flex-col" {...handlers}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container mx-auto w-full max-w-4xl px-6 pb-6">{children}</div>
      </ScrollArea>
      {canManageDocuments && <DocumentDropZone isOver={isOver} visible={showDropZone} />}
    </div>
  );
}
