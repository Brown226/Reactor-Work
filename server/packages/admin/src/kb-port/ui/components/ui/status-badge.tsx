/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/ui/status-badge.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { cn } from "../../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import SvgIcons from "../svg-icons";
import { Badge } from "./badge";

const statusIconVariants = cva("", {
  variants: {
    variant: {
      success: "fill-green-500 dark:fill-green-400",
      destructive: "fill-destructive",
      muted: "fill-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "success",
  },
});

type StatusBadgeProps = {
  active?: boolean;
  children?: ReactNode;
  activeText?: string;
  inactiveText?: string;
  activeVariant?: VariantProps<typeof statusIconVariants>["variant"];
  inactiveVariant?: VariantProps<typeof statusIconVariants>["variant"];
  className?: string;
};

/**
 * A reusable status indicator badge with configurable active/inactive states.
 * Supports custom text, icon color variants, and className overrides.
 */
function StatusBadge({
  active = true,
  children,
  activeText = "已启用",
  inactiveText = "已禁用",
  activeVariant = "success",
  inactiveVariant = "destructive",
  className,
}: StatusBadgeProps) {
  const variant = active ? activeVariant : inactiveVariant;
  const Icon = active ? SvgIcons.circleCheckFilled : SvgIcons.circleXFilled;
  const text = children ?? (active ? activeText : inactiveText);

  return (
    <Badge variant="outline" className={cn("text-muted-foreground pr-1.5 pl-1", className)}>
      <Icon className={cn(statusIconVariants({ variant }))} />
      {text}
    </Badge>
  );
}

export { StatusBadge, statusIconVariants };
