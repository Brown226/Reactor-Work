/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/datasets/_layouts/navbar.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { Button } from "../../../ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../../ui/components/ui/sheet";
import { SidebarTrigger } from "../../../ui/components/ui/sidebar";
import { Menu } from "lucide-react";

import { DatasetsSidebarMain } from "./sidebar";

export function DatasetsNavbar() {
  return (
    <div className="bg-background sticky top-0 z-2 flex h-13 shrink-0 items-center justify-between px-2 md:hidden md:px-4">
      <div>
        <SidebarTrigger className="md:hidden" />
      </div>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="md:hidden">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent showCloseButton={false} className="max-w-fit" aria-describedby={undefined}>
          <SheetHeader className="sr-only">
            <SheetTitle>datasets sidebar</SheetTitle>
            <SheetDescription>datasets</SheetDescription>
          </SheetHeader>

          <DatasetsSidebarMain className="flex!" />
        </SheetContent>
      </Sheet>
    </div>
  );
}
