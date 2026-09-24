/**
 * 技能介绍弹层（专家·技能市场 M1，方案 §5.4 线框）。
 * 「试试这样用」示例词与「使用案例」块依赖服务端 listing 字段——当前 catalog 契约
 * （server-skills-market-types.ts §7-U7 已核对）暂无该字段，两块整块隐藏不伪造；
 * 字段就绪后在契约里显式跟进再放开。
 */
import { Lightbulb, Star } from "lucide-react";
import type { ServerSkillCatalogItem } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface SkillDetailDialogProps {
  item: ServerSkillCatalogItem | null;
  busy: boolean;
  onClose: () => void;
  onInstall: (name: string) => void;
  onUninstall: (name: string) => void;
  onFavorite: (name: string, favorited: boolean) => void;
}

export function SkillDetailDialog({
  item,
  busy,
  onClose,
  onInstall,
  onUninstall,
  onFavorite,
}: SkillDetailDialogProps) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item ? (
        <DialogContent className="max-w-lg">
          <div className="flex min-w-0 items-start gap-3 pr-8">
            <div
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-ui-lg text-foreground-subtle ring-1 ring-border"
            >
              {item.icon || item.title.slice(0, 1)}
            </div>
            <DialogHeader className="min-w-0 flex-1">
              <DialogTitle className="truncate text-ui-lg font-semibold">{item.title}</DialogTitle>
              <p className="font-mono text-ui-sm text-foreground-subtlest">{item.name}</p>
            </DialogHeader>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {item.installed ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onUninstall(item.name)}
              >
                {intl.formatMessage({ id: "marketplace.dialog.uninstall" })}
              </Button>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={busy}
                onClick={() => onInstall(item.name)}
              >
                {intl.formatMessage({ id: "marketplace.dialog.install" })}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-pressed={item.favorited}
              title={intl.formatMessage({
                id: item.favorited
                  ? "marketplace.dialog.unfavorite"
                  : "marketplace.dialog.favorite",
              })}
              onClick={() => onFavorite(item.name, !item.favorited)}
            >
              <Star
                className={item.favorited ? "size-4 fill-current text-primary" : "size-4"}
                aria-hidden="true"
              />
            </Button>
          </div>

          <p className="text-ui-base text-foreground-subtle">
            {item.description || intl.formatMessage({ id: "marketplace.dialog.noDescription" })}
          </p>

          {item.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex min-h-5 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {/* 「💡 试试这样用」：服务端 catalog 暂无示例词字段（§7-U7），有则在此渲染（同专家 starters 行式样）。 */}
          {/* 「▦ 使用案例」（缩略图+标题+描述）：M3，待服务端补 listing 字段后再放开。 */}
          <div className="space-y-1.5 rounded-xl bg-surface p-3">
            <h4 className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
              <Lightbulb className="size-4 text-foreground-subtle" aria-hidden="true" />
              {intl.formatMessage({ id: "marketplace.dialog.baseInfo" })}
            </h4>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-sm">
              <dt className="text-foreground-subtlest">
                {intl.formatMessage({ id: "marketplace.dialog.version" })}
              </dt>
              <dd className="truncate font-mono text-foreground-subtle">{item.version || "—"}</dd>
              <dt className="text-foreground-subtlest">
                {intl.formatMessage({ id: "marketplace.dialog.source" })}
              </dt>
              <dd className="truncate text-foreground-subtle">
                {item.author || intl.formatMessage({ id: "marketplace.dialog.sourceValue" })}
              </dd>
              <dt className="text-foreground-subtlest">
                {intl.formatMessage({ id: "marketplace.dialog.category" })}
              </dt>
              <dd className="truncate text-foreground-subtle">{item.category || "—"}</dd>
            </dl>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
