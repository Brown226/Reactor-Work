// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/document-list.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import type { DatasetsDocument } from "../../../../../kb-shims/console-services";
import {
  useBatchDeleteDatasetsDocuments,
  useDeleteDatasetsDocument,
  useRetryDocumentVectorization,
} from "../../../../../kb-shims/console-services";
import { InfiniteScroll } from "../../../../ui/components/infinite-scroll";
import { useAlertDialog } from "../../../../ui/hooks/use-alert-dialog";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { useDatasetDetailContext } from "../context";
import { DocumentBatchActions } from "./document-batch-actions";
import { DocumentEmpty } from "./document-empty";
import { DocumentPreview } from "./document-preview";
import { DocumentTable, DocumentTableHeader, DocumentTableSkeleton } from "./document-table";

export function DocumentList() {
  const {
    dataset,
    documents,
    canManageDocuments,
    selectedIds,
    selectAll,
    clearSelection,
    dialog,
    documentsInfinite,
  } = useDatasetDetailContext();

  const [previewDoc, setPreviewDoc] = useState<DatasetsDocument | null>(null);
  const datasetId = dataset?.id ?? "";
  const { confirm } = useAlertDialog();
  const deleteDocumentMutation = useDeleteDatasetsDocument(datasetId);
  const batchDeleteMutation = useBatchDeleteDatasetsDocuments(datasetId);
  const retryVectorizationMutation = useRetryDocumentVectorization(datasetId);

  const handleDelete = useCallback(
    async (doc: DatasetsDocument) => {
      if (!datasetId) return;
      try {
        await confirm({
          title: "确认删除",
          description: `确定要删除文档「${doc.fileName}」吗？此操作不可撤销。`,
          confirmText: "删除",
          confirmVariant: "destructive",
        });
        deleteDocumentMutation.mutate(doc.id);
      } catch {
        return;
      }
    },
    [datasetId, confirm, deleteDocumentMutation],
  );

  const handleBatchDelete = useCallback(
    async (ids: string[]) => {
      if (!datasetId || ids.length === 0) return;
      try {
        await confirm({
          title: "确认批量删除",
          description: `确定要删除选中的 ${ids.length} 个文档吗？此操作不可撤销。`,
          confirmText: "删除",
          confirmVariant: "destructive",
        });
        batchDeleteMutation.mutate(ids, { onSuccess: () => clearSelection() });
      } catch {
        return;
      }
    },
    [datasetId, confirm, batchDeleteMutation, clearSelection],
  );

  const handleEditTags = useCallback(
    (doc: DatasetsDocument) => {
      dialog.open({ type: "editTags", mode: "single", document: doc, documentIds: [] });
    },
    [dialog],
  );

  const handleMove = useCallback(
    (doc: DatasetsDocument) => {
      dialog.open({ type: "transfer", mode: "move", documentIds: [doc.id] });
    },
    [dialog],
  );

  const handleCopy = useCallback(
    (doc: DatasetsDocument) => {
      dialog.open({ type: "transfer", mode: "copy", documentIds: [doc.id] });
    },
    [dialog],
  );

  const handleRetryVectorization = useCallback(
    (doc: DatasetsDocument) => {
      retryVectorizationMutation.mutate(doc.id, {
        onSuccess: () => toast.success(`文档「${doc.fileName}」已重新提交向量化`),
        onError: () => toast.error(`文档「${doc.fileName}」重新向量化失败`),
      });
    },
    [retryVectorizationMutation],
  );

  const handleDocumentClick = useCallback((doc: DatasetsDocument) => {
    if (doc.fileUrl) {
      setPreviewDoc(doc);
    } else {
      toast.error("该文件暂不支持预览");
    }
  }, []);

  if (previewDoc?.fileUrl) {
    return (
      <DocumentPreview
        fileUrl={previewDoc.fileUrl}
        fileName={previewDoc.fileName}
        onBack={() => setPreviewDoc(null)}
      />
    );
  }

  const showEmptyState = documents.length === 0 && !documentsInfinite.isFetching && dataset != null;
  if (showEmptyState) {
    return (
      <div className="flex min-h-[70vh] flex-col">
        <DocumentTableHeader canManageDocuments={canManageDocuments} />
        <DocumentEmpty canUpload={canManageDocuments} />
      </div>
    );
  }

  const showTableSkeleton =
    documents.length === 0 && (documentsInfinite.isFetching || dataset == null);

  return (
    <>
      {canManageDocuments && selectedIds.length > 0 && (
        <div className="flex items-center gap-2 py-2">
          <span className="text-muted-foreground text-sm">已选择 {selectedIds.length} 项</span>
          <DocumentBatchActions
            selectedCount={selectedIds.length}
            onEditTags={() =>
              dialog.open({ type: "editTags", mode: "batch", documentIds: [...selectedIds] })
            }
            onMove={() =>
              dialog.open({ type: "transfer", mode: "move", documentIds: [...selectedIds] })
            }
            onDelete={() => handleBatchDelete(selectedIds)}
            onCopy={() =>
              dialog.open({ type: "transfer", mode: "copy", documentIds: [...selectedIds] })
            }
            onClose={clearSelection}
          />
        </div>
      )}

      <InfiniteScroll
        loading={documentsInfinite.loading}
        hasMore={documentsInfinite.hasMore}
        onLoadMore={documentsInfinite.onLoadMore}
        emptyText=""
      >
        {showTableSkeleton ? (
          <DocumentTableSkeleton canManageDocuments={true} />
        ) : (
          <DocumentTable
            documents={documents}
            canManageDocuments={canManageDocuments}
            selectedIds={selectedIds}
            onSelectedIdsChange={selectAll}
            onDocumentClick={handleDocumentClick}
            onEditTags={handleEditTags}
            onMove={handleMove}
            onDelete={handleDelete}
            onCopy={handleCopy}
            onRetryVectorization={handleRetryVectorization}
          />
        )}
      </InfiniteScroll>
    </>
  );
}
