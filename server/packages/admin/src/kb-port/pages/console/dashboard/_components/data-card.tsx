/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/../../../../client/src/pages/console/dashboard/_components/data-card.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../ui/components/ui/card";
import { cn } from "../../../../ui/lib/utils";
import { Info } from "lucide-react";

const DataCard = ({
  children,
  title,
  className,
  action,
  description,
  contentClassName,
}: {
  children: React.ReactNode;
  title: string;
  description: string;
  contentClassName?: string;
  className?: string;
  action?: React.ReactNode;
}) => {
  return (
    <Card className={cn("gap-0 py-4", className)}>
      <CardHeader className="flex justify-between px-4">
        <div className="flex flex-1 shrink-0 flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription className="flex items-center gap-1 text-xs">
            <Info className="size-3" />
            <span className="leading-none">{description}</span>
          </CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent className={cn("mt-4", contentClassName)}>{children}</CardContent>
    </Card>
  );
};

export default DataCard;
