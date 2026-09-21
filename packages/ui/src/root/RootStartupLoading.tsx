import type { ReactNode } from "react";
import { ReactorLogo } from "@/components/ui/ReactorLogo.js";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ReactorStartupLogo />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌标记；标记自带白底，不再依赖外层深色壳提供对比。 */
export function ReactorStartupLogo({ animated = true }: { animated?: boolean }) {
  return (
    <div className="flex items-center justify-center" aria-label="Reactor" role="img">
      <ReactorLogo className={cn("h-auto w-20", animated && "motion-safe:animate-pulse")} />
    </div>
  );
}
