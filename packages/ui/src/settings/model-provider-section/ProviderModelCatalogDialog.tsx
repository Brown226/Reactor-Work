import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_MODEL_PROVIDER_CATALOG_CONFIRM_BUTTON,
  TID_MODEL_PROVIDER_CATALOG_DIALOG,
} from "@zcode/shared";
import type { ProviderModelCatalogEntry } from "@zcode/services";

/**
 * 一键拉取模型：展示上游目录并多选批量添加。
 *
 * 勾选状态用 override 而不是 effect 同步——目录回来、批量添加完成都会改变「可选项集合」，
 * 派生出的默认勾选（全部未添加项）随数据自然更新，只有用户手改过才覆盖它，
 * 这样添加成功后已存在项会自动退出勾选，添加失败的项仍保持勾选可重试。
 */
export function ProviderModelCatalogDialog({
  open,
  baseUrl,
  loading,
  entries,
  existingModelIds,
  errorMessage,
  adding,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  baseUrl: string;
  loading: boolean;
  entries: readonly ProviderModelCatalogEntry[];
  existingModelIds: ReadonlySet<string>;
  errorMessage: string | null;
  adding: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (modelIds: string[]) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [override, setOverride] = useState<ReadonlySet<string> | null>(null);

  const selectableIds = useMemo(
    () => entries.filter((entry) => !existingModelIds.has(entry.modelId)).map((entry) => entry.modelId),
    [entries, existingModelIds],
  );
  const selectedIds = useMemo(() => {
    const base = override ?? new Set(selectableIds);
    return selectableIds.filter((modelId) => base.has(modelId));
  }, [override, selectableIds]);

  const toggle = (modelId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(modelId);
    else next.delete(modelId);
    setOverride(next);
  };

  const busy = loading || adding;
  const selectedCount = selectedIds.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setOverride(null);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        data-testid={TID_MODEL_PROVIDER_CATALOG_DIALOG}
        className="max-h-[min(40rem,calc(100vh-4rem))] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
      >
        <DialogHeader className="pr-8">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.pullModels.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.pullModels.description" })}
          </DialogDescription>
          <p className="truncate font-mono text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.modelProvider.pullModels.source" },
              { baseUrl },
            )}
          </p>
        </DialogHeader>

        <div className="min-h-0 min-w-0 overflow-y-auto" inert={busy}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-ui-base text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelProvider.pullModels.loading" })}
            </div>
          ) : errorMessage ? (
            // 调用方已按「拉取失败 / 添加失败」拼好可读消息，这里只负责呈现，不再二次包一层文案。
            <p className="py-6 text-ui-base text-destructive">{errorMessage}</p>
          ) : entries.length === 0 ? (
            <p className="py-6 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.pullModels.empty" })}
            </p>
          ) : selectableIds.length === 0 ? (
            <p className="py-6 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.pullModels.allAdded" })}
            </p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => {
                const exists = existingModelIds.has(entry.modelId);
                const checked = !exists && selectedIds.includes(entry.modelId);
                const displayName =
                  entry.displayName && entry.displayName !== entry.modelId
                    ? entry.displayName
                    : null;
                return (
                  <li key={entry.modelId}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-surface-hover has-data-[state=disabled]:cursor-not-allowed has-data-[state=disabled]:opacity-70">
                      <Checkbox
                        checked={checked}
                        disabled={exists || busy}
                        onCheckedChange={(value) => toggle(entry.modelId, value === true)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-ui-base text-foreground">
                          {entry.modelId}
                        </span>
                        {displayName ? (
                          <span className="block truncate text-ui-sm text-foreground-subtle">
                            {displayName}
                          </span>
                        ) : null}
                      </span>
                      {exists ? (
                        <Badge variant="secondary">
                          {intl.formatMessage({
                            id: "settings.modelProvider.pullModels.exists",
                          })}
                        </Badge>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <span className="text-ui-sm text-foreground-subtle" aria-live="polite">
            {adding
              ? intl.formatMessage({ id: "settings.modelProvider.pullModels.adding" })
              : intl.formatMessage(
                  { id: "settings.modelProvider.pullModels.selected" },
                  { count: selectedCount },
                )}
          </span>
          <span className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              type="button"
              data-testid={TID_MODEL_PROVIDER_CATALOG_CONFIRM_BUTTON}
              disabled={busy || selectedCount === 0}
              onClick={() => void onConfirm(selectedIds)}
            >
              {adding
                ? intl.formatMessage({ id: "settings.modelProvider.pullModels.adding" })
                : intl.formatMessage(
                    { id: "settings.modelProvider.pullModels.addSelected" },
                    { count: selectedCount },
                  )}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
