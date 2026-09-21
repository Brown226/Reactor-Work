import reactorMarkUrl from "@/assets/reactor-mark.png";
import { cn } from "@/components/lib/utils.js";

/**
 * Reactor 品牌标记：等距数据立方。
 *
 * 标记本身为多色渐变，不随 `currentColor` 变化；父级容器负责底色与尺寸约束，
 * 因此这里只保留布局类，不带任何 text-color 语义。
 */
export function ReactorLogo({ className }: { className?: string }) {
  return (
    <img
      src={reactorMarkUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0 select-none", className)}
    />
  );
}
