/**
 * 我的空间：左侧容量卡。
 *
 * 只读展示，不持有状态：容量口径（含回收站、分类）由服务端 /api/space/usage 决定，
 * 这里不再本地累加——列表和容量必须是同一份事实。
 */
import { Trash2 } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes, usagePercent, type SpaceUsage } from "./spaceClient.js";

const CATEGORY_ORDER = ["document", "image", "drawing", "other"] as const;

const CATEGORY_LABEL_ID: Record<string, string> = {
  document: "mySpace.category.document",
  image: "mySpace.category.image",
  drawing: "mySpace.category.drawing",
  other: "mySpace.category.other",
};

export function MySpaceStorageCard({ usage }: { usage: SpaceUsage | null }) {
  const { intl } = useZCodeIntl();
  const percent = usagePercent(usage);
  // 80% 起提醒、95% 起视为已满：与上传 413 的行为对齐，避免进度条还是蓝色却传不上去。
  const barTone = percent >= 95 ? "bg-destructive" : percent >= 80 ? "bg-warning" : "bg-primary";
  const orderedCategories = CATEGORY_ORDER.filter((key) => usage?.byCategory?.[key] !== undefined);
  const extraCategories = usage
    ? Object.keys(usage.byCategory).filter(
        (key) => !(CATEGORY_ORDER as readonly string[]).includes(key),
      )
    : [];

  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "mySpace.storage.title" })}
        </h3>
        <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
          {intl.formatMessage({ id: "mySpace.storage.percent" }, { percent })}
        </span>
      </div>

      <div className="mt-3 flex min-w-0 items-baseline gap-1.5">
        <span className="truncate font-mono text-ui-lg font-semibold text-foreground">
          {usage ? formatBytes(usage.usedBytes) : "—"}
        </span>
        <span className="shrink-0 font-mono text-ui-sm text-foreground-subtle">
          / {usage ? formatBytes(usage.quotaBytes) : "—"}
        </span>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-[width]", barTone)}
          style={{ width: `${percent}%` }}
        />
      </div>

      {usage && usage.trashBytes > 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-ui-xs text-foreground-subtle">
          <Trash2 className="mt-px size-3 shrink-0" aria-hidden="true" />
          {intl.formatMessage(
            { id: "mySpace.storage.trashNote" },
            { size: formatBytes(usage.trashBytes) },
          )}
        </p>
      ) : null}
      {percent >= 100 ? (
        <p className="mt-1.5 text-ui-xs text-destructive">
          {intl.formatMessage({ id: "mySpace.storage.full" })}
        </p>
      ) : null}

      {orderedCategories.length + extraCategories.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <h4 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "mySpace.storage.categories" })}
          </h4>
          <ul className="mt-2 space-y-2">
            {[...orderedCategories, ...extraCategories].map((key) => {
              const bytes = usage?.byCategory[key] ?? 0;
              const share = usage && usage.usedBytes > 0 ? (bytes / usage.usedBytes) * 100 : 0;
              return (
                <li key={key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-ui-sm">
                    <span className="truncate text-foreground-subtle">
                      {CATEGORY_LABEL_ID[key]
                        ? intl.formatMessage({ id: CATEGORY_LABEL_ID[key]! })
                        : key}
                    </span>
                    <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                      {formatBytes(bytes)}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-surface">
                    <div
                      className="h-full rounded-full bg-foreground-subtlest/40"
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
