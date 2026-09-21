/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/hooks/use-document-selection.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useCallback, useState } from "react";

interface DocumentSelectionState {
  selectedIds: string[];
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
}

export function useDocumentSelection(): DocumentSelectionState {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const selectAll = useCallback((ids: string[]) => {
    setSelectedIds(ids);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  return { selectedIds, selectAll, clearSelection };
}
