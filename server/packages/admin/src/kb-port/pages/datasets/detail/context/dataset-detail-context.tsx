// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/context/dataset-detail-context.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { Dataset, DatasetsDocument } from "../../../../../kb-shims/console-services";
import { createContext, useContext } from "react";

import type { DialogManager } from "../hooks/use-dialog-manager";

export type DocumentTab = "all" | "text" | "table" | "image";

export interface DatasetDetailContextValue {
  dataset: Dataset | undefined;
  documents: DatasetsDocument[];
  canManageDocuments: boolean;
  isOwner: boolean;
  activeTab: DocumentTab;
  setActiveTab: (tab: DocumentTab) => void;
  uploadDocuments: (files: File[]) => void;
  selectedIds: string[];
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
  dialog: DialogManager;
  documentsInfinite: {
    hasMore: boolean;
    loading: boolean;
    isFetching: boolean;
    onLoadMore: () => void;
  };
}

const DatasetDetailContext = createContext<DatasetDetailContextValue | null>(null);

export const DatasetDetailProvider = DatasetDetailContext.Provider;

export function useDatasetDetailContext() {
  const ctx = useContext(DatasetDetailContext);
  if (!ctx) throw new Error("useDatasetDetailContext must be used within DatasetDetailProvider");
  return ctx;
}
