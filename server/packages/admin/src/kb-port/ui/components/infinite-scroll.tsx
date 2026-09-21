/**
 * 移植自 BuildingAI-26.1.2：packages/@buildingai/web/ui/src/components/infinite-scroll.tsx
 * 许可：Apache-2.0（保留出处；改动逐处见 docs/实施计划/知识库前端-移植清单-v1.md）
 * 机械变换：`@/x` 与 `@buildingai/ui/x` → 相对路径；上游取数层/零碎件 → `kb-shims/`（见文件头 @ts-nocheck 注）；其余原文不改。
 */
import { type ReactNode, useEffect, useRef } from "react";

import { Spinner } from "./ui/spinner";

interface InfiniteScrollProps {
  /** Child elements */
  children: ReactNode;
  /** Whether currently loading */
  loading?: boolean;
  /** Whether there is more data */
  hasMore?: boolean;
  /** Distance to trigger loading in pixels @default 100 */
  threshold?: number;
  /** Callback function to load more */
  onLoadMore: () => void;
  /** Container class name */
  className?: string;
  /** Empty state text */
  emptyText?: string;
  showEmptyText?: boolean;
  showLoadingIcon?: boolean;
}

/**
 * Infinite scroll component
 * Triggers load event when scrolling to specified distance from bottom
 */
export function InfiniteScroll({
  children,
  loading = false,
  hasMore = true,
  threshold = 100,
  onLoadMore,
  className,
  emptyText = "没有更多数据了",
  showEmptyText = true,
  showLoadingIcon = true,
  ...props
}: InfiniteScrollProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const loadingRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const loadingElement = loadingRef.current;

    if (!container || !loadingElement || !hasMore || loading) return;

    observer.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMore();
        }
      },
      {
        root: null,
        rootMargin: `${threshold}px`,
        threshold: 0,
      },
    );

    observer.current.observe(loadingElement);

    return () => {
      if (observer.current) {
        observer.current.disconnect();
      }
    };
  }, [hasMore, loading, onLoadMore, threshold]);

  return (
    <div ref={containerRef} className={className} {...props}>
      {children}
      <div ref={loadingRef} className="flex h-8 w-full items-center justify-center">
        {showLoadingIcon && loading && hasMore && (
          <Spinner className="text-muted-foreground size-6" />
        )}
        {showEmptyText && !hasMore && (
          <div className="text-muted-foreground text-sm">{emptyText}</div>
        )}
      </div>
    </div>
  );
}
