/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/_layouts/index.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { useSidebar } from "../../../ui/components/ui/sidebar";
import { useLayoutEffect } from "react";
import { Outlet } from "react-router-dom";

import { DatasetsNavbar } from "./navbar";
import { DatasetsSidebar } from "./sidebar";

const KnowledgeLayout = () => {
  const { setTemporaryOpen } = useSidebar();

  useLayoutEffect(() => {
    setTemporaryOpen(false);
    return () => setTemporaryOpen(null); // Restore original state on unmount
  }, [setTemporaryOpen]);

  return (
    <div className="flex h-full min-h-0">
      <DatasetsSidebar />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DatasetsNavbar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  );
};

export default KnowledgeLayout;
