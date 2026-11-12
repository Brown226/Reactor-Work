// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/shared, @buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/hooks/use-document-upload.ts
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { uploadFilesAuto } from "../../../../../kb-shims/console-services";
import { createDatasetsDocument } from "../../../../../kb-shims/console-services";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

/**
 * 知识库文档上传 Hook
 *
 * 统一处理两处上传入口的上传逻辑：
 * 1. 侧边栏拖拽区域 (useDocumentDrop)
 * 2. 上传对话框 (UploadDialog)
 *
 * 流程：先调用 uploadFiles 上传文件获取 fileId，再调用 createDatasetsDocument 创建文档
 */
export function useDatasetDocumentUpload(datasetId: string | undefined) {
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  const uploadDocuments = useCallback(
    async (files: File[]) => {
      if (!datasetId || files.length === 0) return;

      setIsUploading(true);
      try {
        const results = await uploadFilesAuto(files);
        const createPromises = results.map((result) =>
          createDatasetsDocument(datasetId, { fileId: result.id }),
        );

        await Promise.all(createPromises);

        queryClient.invalidateQueries({ queryKey: ["datasets", datasetId, "documents"] });
        queryClient.invalidateQueries({ queryKey: ["datasets", "documents-infinite", datasetId] });
        queryClient.invalidateQueries({ queryKey: ["datasets", datasetId] });
        queryClient.invalidateQueries({ queryKey: ["user", "storage"] });

        toast.success(`已成功上传 ${results.length} 个文件`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "上传失败";
        toast.error(message);
      } finally {
        setIsUploading(false);
      }
    },
    [datasetId, queryClient],
  );

  return {
    uploadDocuments,
    uploadDocumentFromUrl: useCallback(
      async (url: string) => {
        if (!datasetId) return;
        const value = url.trim();
        if (!value) return;
        setIsUploading(true);
        try {
          await createDatasetsDocument(datasetId, { url: value });
          queryClient.invalidateQueries({ queryKey: ["datasets", datasetId, "documents"] });
          queryClient.invalidateQueries({
            queryKey: ["datasets", "documents-infinite", datasetId],
          });
          queryClient.invalidateQueries({ queryKey: ["datasets", datasetId] });
          queryClient.invalidateQueries({ queryKey: ["user", "storage"] });
          toast.success("已成功添加在线文档");
        } catch (error) {
          const message = error instanceof Error ? error.message : "上传失败";
          toast.error(message);
        } finally {
          setIsUploading(false);
        }
      },
      [datasetId, queryClient],
    ),
    isUploading,
  };
}
