/**
 * 我的空间：空态。
 *
 * 列表为空时最容易被做成「一句灰字」，这里统一成图标 + 标题 + 说明 + 主动作，
 * 与市场/自动化等主视图的空态保持同一种表达。
 */
import type { ReactNode } from "react";
import { FileText } from "lucide-react";

export function MySpaceEmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span
        aria-hidden="true"
        className="mb-1 flex size-11 items-center justify-center rounded-xl bg-surface text-foreground-subtle ring-1 ring-border"
      >
        {icon ?? <FileText className="size-5" />}
      </span>
      <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
      <p className="max-w-sm text-ui-sm text-foreground-subtle">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
