/**
 * 我的空间：左侧容量卡。
 *
 * 只读展示，不持有状态：容量口径（含回收站、分类）由服务端 /api/space/usage 决定，
 * 这里不再本地累加——列表和容量必须是同一份事实。
 *
 * 分类占用用「一段式堆叠条 + 彩色圆点图例」表达：之前每类各画一条同色灰条，
 * 四行长得一模一样，分不清谁是谁（2026-11-01 实测反馈）。
 * 颜色取主题现有的 usage-chart 色板（亮/暗主题各有一套），和上下文用量图保持一致。
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

/** 已知类别按顺序吃 usage-chart-1..4，未知名类往后排，避免颜色串位 */
function categoryColor(key: string, index: number): string {
  return `var(--color-usage-chart-${Math.min(index + 1, 6)})`;
}

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
  const categories = [...orderedCategories, ...extraCategories];
  const colored = categories.map((key, index) => ({
    key,
    bytes: usage?.byCategory[key] ?? 0,
    color: categoryColor(key, index),
  }));
  const totalBytes = usage?.usedBytes ?? 0;

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

      {categories.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <h4 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "mySpace.storage.categories" })}
          </h4>
          {/* 一条堆叠条讲清比例：每类一个颜色段，宽度即占比；0 占用的类不出段 */}
          {totalBytes > 0 ? (
            <div className="mt-2 flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface">
              {colored.map(
                (item) =>
                  item.bytes > 0 ? (
                    <div
                      key={item.key}
                      className="h-full"
                      style={{ width: `${(item.bytes / totalBytes) * 100}%`, background: item.color }}
                    />
                  ) : null,
              )}
            </div>
          ) : null}
          <ul className="mt-2.5 space-y-1.5">
            {colored.map((item) => {
              const share = totalBytes > 0 ? Math.round((item.bytes / totalBytes) * 100) : 0;
              return (
                <li key={item.key} className="flex min-w-0 items-center gap-2 text-ui-sm">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: item.color }}
                  />
                  <span className="min-w-0 truncate text-foreground-subtle">
                    {CATEGORY_LABEL_ID[item.key]
                      ? intl.formatMessage({ id: CATEGORY_LABEL_ID[item.key]! })
                      : item.key}
                  </span>
                  <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                    {share}%
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-ui-xs text-foreground-subtle">
                    {formatBytes(item.bytes)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
