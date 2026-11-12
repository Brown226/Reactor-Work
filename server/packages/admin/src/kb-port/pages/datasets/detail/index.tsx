// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/hooks, @buildingai/services/web, @/components/ask-assistant-ui）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/index.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useDocumentHead } from "../../../../kb-shims/ui";
import {
  type AiProvider,
  useAiProvidersQuery,
  useDatasetDetail,
  useDatasetsDocumentsInfiniteQuery,
  usePublishDatasetToSquare,
  useUnpublishDatasetFromSquare,
} from "../../../../kb-shims/console-services";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";

import { AssistantProvider } from "../../../ask-assistant-ui/index";

import { ChatContainer, DEFAULT_SUGGESTIONS } from "./_components/chat";
import { DatasetActions } from "./_components/dataset-actions";
import { DatasetInfo } from "./_components/dataset-info";
import {
  DatasetEditDialog,
  EditTagsDialog,
  MemberDialog,
  PublishDialog,
  TransferDialog,
  UploadDialog,
} from "./_components/dialogs";
import { DocumentList } from "./_components/document-list";
import { DocumentTabs } from "./_components/document-tabs";
import { ContentLayout, PageLayout } from "./_layouts";
import type { DatasetDetailContextValue, DocumentTab } from "./context";
import { DatasetDetailProvider } from "./context";
import { useDatasetDocumentUpload, useDatasetsAssistant, useDialogManager } from "./hooks";

const ChatPanel = memo(function ChatPanel({
  datasetId,
  providers,
  datasetName,
  creatorNickname,
}: {
  datasetId: string;
  providers: AiProvider[];
  datasetName: string;
  creatorNickname: string;
}) {
  const { providerValue, setConversationId } = useDatasetsAssistant({
    datasetId,
    providers,
    suggestions: DEFAULT_SUGGESTIONS,
  });

  return (
    <AssistantProvider key={datasetId} {...providerValue}>
      <ChatContainer
        datasetId={datasetId}
        currentConversationId={providerValue.currentThreadId}
        onSelectConversation={setConversationId}
        welcomeConfig={{
          title: datasetName,
          creator: creatorNickname,
          instruction: "你可以通过提问了解知识库中的相关内容",
        }}
      />
    </AssistantProvider>
  );
});

export default function DatasetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DocumentTab>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const dialog = useDialogManager();

  const { data: providers = [] } = useAiProvidersQuery({ supportedModelTypes: "llm" });
  const { data: dataset } = useDatasetDetail(id);
  const documentsInfiniteQuery = useDatasetsDocumentsInfiniteQuery(id ?? "", {
    pageSize: 20,
    sortBy: "uploadTime",
    fileType: activeTab,
  });

  useDocumentHead({
    title: dataset?.name || "知识库详情",
  });

  const { uploadDocuments, uploadDocumentFromUrl } = useDatasetDocumentUpload(id);

  const documents = useMemo(
    () => documentsInfiniteQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [documentsInfiniteQuery.data?.pages],
  );

  const setActiveTabWithReset = useCallback((tab: DocumentTab) => {
    setActiveTab(tab);
    setSelectedIds([]);
  }, []);

  const documentsInfinite = useMemo(
    () => ({
      hasMore: documentsInfiniteQuery.hasNextPage ?? false,
      loading: documentsInfiniteQuery.isFetchingNextPage,
      isFetching: documentsInfiniteQuery.isFetching,
      onLoadMore: () => documentsInfiniteQuery.fetchNextPage(),
    }),
    [
      documentsInfiniteQuery.hasNextPage,
      documentsInfiniteQuery.isFetchingNextPage,
      documentsInfiniteQuery.isFetching,
      documentsInfiniteQuery.fetchNextPage,
    ],
  );

  const selectAll = useCallback((ids: string[]) => setSelectedIds(ids), []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);

  const publishMutation = usePublishDatasetToSquare(dataset?.id ?? "");
  const unpublishMutation = useUnpublishDatasetFromSquare(dataset?.id ?? "");

  const handlePublishConfirm = useCallback(
    (publishToSquare: boolean, tagIds?: string[], memberJoinApprovalRequired?: boolean) => {
      if (!dataset?.id) return;
      if (publishToSquare) {
        publishMutation.mutate(
          { tagIds: tagIds ?? [], memberJoinApprovalRequired },
          {
            onSuccess: (data) => {
              dialog.close();
              const published = Boolean(
                data?.publishedToSquare || data?.squarePublishStatus === "approved",
              );
              toast.success(published ? "已发布到知识广场" : "已提交审核，请等待审核结果");
              queryClient.refetchQueries({ queryKey: ["datasets", dataset.id] });
            },
            onError: (error) => {
              toast.error(error instanceof Error ? error.message : "发布失败");
            },
          },
        );
      } else {
        unpublishMutation.mutate(undefined, {
          onSuccess: () => {
            dialog.close();
            toast.success("已从知识广场取消发布");
            queryClient.refetchQueries({ queryKey: ["datasets", dataset.id] });
          },
          onError: (error) => {
            toast.error(error instanceof Error ? error.message : "取消发布失败");
          },
        });
      }
    },
    [dataset?.id, publishMutation, unpublishMutation, queryClient, dialog],
  );

  const handleUploadFromDialog = useCallback(
    (files: File[]) => {
      uploadDocuments(files);
      dialog.close();
    },
    [uploadDocuments, dialog],
  );

  const handleUploadUrlFromDialog = useCallback(
    (value: string) => {
      uploadDocumentFromUrl(value);
      dialog.close();
    },
    [uploadDocumentFromUrl, dialog],
  );

  const contextValue = useMemo<DatasetDetailContextValue>(
    () => ({
      dataset,
      documents,
      canManageDocuments: dataset?.canManageDocuments ?? false,
      isOwner: dataset?.isOwner ?? false,
      activeTab,
      setActiveTab: setActiveTabWithReset,
      uploadDocuments,
      selectedIds,
      selectAll,
      clearSelection,
      dialog,
      documentsInfinite,
    }),
    [
      dataset,
      documents,
      activeTab,
      setActiveTabWithReset,
      uploadDocuments,
      selectedIds,
      selectAll,
      clearSelection,
      dialog,
      documentsInfinite,
    ],
  );

  return (
    <DatasetDetailProvider value={contextValue}>
      <PageLayout
        panel={
          <ChatPanel
            datasetId={id ?? ""}
            providers={providers}
            datasetName={dataset?.name ?? ""}
            creatorNickname={dataset?.creator?.nickname ?? ""}
          />
        }
      >
        <ContentLayout>
          <div className="flex flex-col gap-2 pt-20 pb-10">
            <div className="flex items-center justify-between">
              <DatasetInfo />
              <DatasetActions />
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              {dataset?.description ?? "快来填写简介吧～"}
            </p>
          </div>
          <DocumentTabs />
          <DocumentList />
        </ContentLayout>

        {dialog.current?.type === "upload" && (
          <UploadDialog
            open
            onOpenChange={() => dialog.close()}
            onUpload={handleUploadFromDialog}
            onUploadUrl={handleUploadUrlFromDialog}
          />
        )}

        {dialog.current?.type === "member" && dataset?.id && (
          <MemberDialog
            datasetId={dataset.id}
            isOwner={dataset.isOwner}
            open
            onOpenChange={() => dialog.close()}
          />
        )}

        {dialog.current?.type === "publish" && (
          <PublishDialog
            open
            onOpenChange={() => dialog.close()}
            defaultPublishedToSquare={Boolean(
              dataset?.publishedToSquare || dataset?.squarePublishStatus === "rejected",
            )}
            defaultTagIds={
              Array.isArray(dataset?.tags) ? dataset.tags.map((t: any) => t.id) : undefined
            }
            defaultMemberJoinApprovalRequired={dataset?.memberJoinApprovalRequired ?? true}
            squarePublishStatus={dataset?.squarePublishStatus ?? "none"}
            squareRejectReason={dataset?.squareRejectReason ?? null}
            loading={publishMutation.isPending || unpublishMutation.isPending}
            onConfirm={handlePublishConfirm}
          />
        )}

        {dialog.current?.type === "editDataset" && dataset && (
          <DatasetEditDialog
            mode="edit"
            open
            onOpenChange={() => dialog.close()}
            initialValues={{
              name: dataset.name ?? "",
              coverUrl: dataset.coverUrl ?? undefined,
              description: dataset.description ?? "",
            }}
          />
        )}

        {dialog.current?.type === "editTags" && dataset?.id && (
          <EditTagsDialog
            open
            onOpenChange={() => dialog.close()}
            datasetId={dataset.id}
            mode={dialog.current.mode}
            document={dialog.current.document}
            documentIds={dialog.current.documentIds}
            onSuccess={() => {
              if (dialog.current?.type === "editTags" && dialog.current.mode === "batch") {
                clearSelection();
              }
            }}
          />
        )}

        {dialog.current?.type === "transfer" && dataset?.id && (
          <TransferDialog
            open
            onOpenChange={() => dialog.close()}
            mode={dialog.current.mode}
            sourceDatasetId={dataset.id}
            documentIds={dialog.current.documentIds}
            onSuccess={clearSelection}
          />
        )}
      </PageLayout>
    </DatasetDetailProvider>
  );
}
