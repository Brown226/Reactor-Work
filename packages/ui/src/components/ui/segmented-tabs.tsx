import type { ReactNode } from "react";

import { cn } from "@/components/lib/utils.js";
import { Tabs, TabsList, TabsTrigger } from "./tabs.js";

interface SegmentedTabItem<TValue extends string> {
  label: string;
  value: TValue;
  /** 可选档位图标：与 label 同排，用于需要一眼分辨档位的场景（如编程/办公）。 */
  icon?: ReactNode;
}

type SegmentedTabsSize = "sm" | "lg";

const sharedTriggerClassName =
  "flex-none rounded-full border-transparent bg-transparent font-medium text-foreground-subtle data-active:border-transparent data-active:bg-background data-active:text-foreground dark:data-active:border-transparent dark:data-active:bg-background";

/**
 * 两档尺寸，不再各写一套：
 * - `sm`：设置详情页等密集区域（默认），controls 走 h-7/h-8 基线；
 * - `lg`：主面板入口这类需要一眼看见、容易点到的位置，档位图标随之放大。
 * 尺寸只影响大小与投影，选中态仍是同一套"亮面胶囊"，避免同层级出现第二种选中语言。
 */
const segmentedTabsSizeClassName: Record<SegmentedTabsSize, { list: string; trigger: string }> = {
  sm: {
    list: "h-8 p-0.5 group-data-horizontal/tabs:h-8",
    trigger: "h-7 gap-1.5 px-2.5 text-ui-base data-active:shadow-none",
  },
  lg: {
    list: "h-11 p-1 group-data-horizontal/tabs:h-11",
    trigger: "h-9 gap-2 px-4 text-ui-lg data-active:shadow-sm [&_svg:not([class*='size-'])]:size-5",
  },
};

/**
 * 全应用共用的紧凑分段切换（胶囊）。
 *
 * 原为设置详情页专用（settings/SettingsSegmentedTabs.tsx），草稿首页的界面模式切换也要用
 * 同款视觉，因此上移为通用原语：同一层级只允许存在一套分段切换外观。
 */
export function SegmentedTabs<TValue extends string>({
  items,
  value,
  onValueChange,
  ariaLabel,
  size = "sm",
}: {
  items: readonly SegmentedTabItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  /** 控件的可访问名；旁边没有可见标题的调用点必须传。 */
  ariaLabel?: string;
  size?: SegmentedTabsSize;
}) {
  const sizeClassName = segmentedTabsSizeClassName[size];

  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
      className="gap-0"
    >
      <TabsList
        aria-label={ariaLabel}
        className={cn(
          "flex rounded-full bg-surface group-data-horizontal/tabs:h-8",
          sizeClassName.list,
        )}
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            className={cn(sharedTriggerClassName, sizeClassName.trigger)}
          >
            {item.icon}
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
