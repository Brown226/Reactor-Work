import { cn } from "@/components/lib/utils.js";
import reactorMarkUrl from "@/assets/reactor-mark.png";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // Logo 底座和外部占位统一为 20px，保留原中心点（27px / 29px）。
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <img
        src={reactorMarkUrl}
        alt="Reactor"
        className={cn("pointer-events-none size-5 select-none rounded-[22%]", imageClassName)}
        draggable={false}
      />
    </div>
  );
}
