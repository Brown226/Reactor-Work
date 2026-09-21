// @ts-nocheck —— 中间态：取数层/零碎件走 kb-shims（@buildingai/services/web）。
// 真取数层接线见 docs/实施计划/知识库前端-移植清单-v1.md §8 第 3 步（KB）与
// docs/实施计划/管理端BuildingAI移植-台账-v1.md（其余页面）；替换后删掉本行。
/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/detail/_components/document-tabs.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useDatasetsApplicationsQuery } from "../../../../../kb-shims/console-services";
import { Button } from "../../../../ui/components/ui/button";
import { Skeleton } from "../../../../ui/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "../../../../ui/components/ui/tabs";
import { cn } from "../../../../ui/lib/utils";
import { Upload, Users } from "lucide-react";

import type { DocumentTab } from "../context";
import { useDatasetDetailContext } from "../context";

function DocumentTabsActionsSkeleton() {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className="h-9 w-24" />
      <Skeleton className="h-9 w-16" />
    </div>
  );
}

export function DocumentTabs() {
  const { dataset, activeTab, setActiveTab, canManageDocuments, dialog } =
    useDatasetDetailContext();

  const canManageMembers = Boolean(dataset && (dataset.isOwner || dataset.canManageDocuments));
  const { data: applicationsData } = useDatasetsApplicationsQuery(dataset?.id ?? "", undefined, {
    enabled: canManageMembers && !!dataset?.id,
  });
  const hasPendingApplications = Boolean(
    applicationsData?.items?.some((application) => application.status === "pending"),
  );

  return (
    <div className="flex items-center justify-between pb-3">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as DocumentTab)}>
        <TabsList>
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="text">文本</TabsTrigger>
          <TabsTrigger value="table">表格</TabsTrigger>
        </TabsList>
      </Tabs>

      {!dataset ? (
        <DocumentTabsActionsSkeleton />
      ) : (
        <div className="flex items-center gap-2">
          {canManageDocuments && (
            <Button variant="outline" size="sm" onClick={() => dialog.open({ type: "upload" })}>
              <Upload className="size-4" />
              上传文件
            </Button>
          )}
          {canManageMembers && (
            <Button
              variant="outline"
              className="relative"
              size="sm"
              onClick={() => dialog.open({ type: "member" })}
            >
              <Users className="size-4" />
              成员
              {dataset.memberCount != null && (
                <span
                  className={cn("text-muted-foreground ml-1", hasPendingApplications && "mr-1")}
                >
                  {dataset.memberCount}
                </span>
              )}
              {hasPendingApplications && (
                <span
                  className="bg-destructive absolute top-1 right-1 ml-1 size-1.5 rounded-full"
                  aria-label="有待审核加入申请"
                />
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
