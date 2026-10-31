/**
 * 我的空间：回收站列表。
 *
 * 回收站里的条目仍占额度（用户已拍板），所以这里必须显式标出「彻底删除才释放」，
 * 并且把还原/彻底删除做成行内动作，不让用户猜。
 */
import { RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MySpaceEmptyState } from "./MySpaceEmptyState.js";
import { formatBytes, type SpaceTrashItem } from "./spaceClient.js";
import { formatSpaceWhen, spaceFileIconSrc } from "./spaceFileType.js";

export function MySpaceTrashTable({
  items,
  loading,
  onRestore,
  onPurge,
}: {
  items: SpaceTrashItem[];
  loading: boolean;
  onRestore: (ids: string[]) => void;
  onPurge: (ids: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.list.itemCount" }, { count: items.length })}
        </span>
        {items.length > 0 ? (
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRestore(items.map((item) => item.id))}
            >
              {intl.formatMessage({ id: "mySpace.action.restoreAll" })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => onPurge([])}
            >
              {intl.formatMessage({ id: "mySpace.action.emptyTrash" })}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2 p-3" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-8 animate-pulse rounded-md bg-surface" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <MySpaceEmptyState
            icon={<Trash2 className="size-5" />}
            title={intl.formatMessage({ id: "mySpace.empty.trash.title" })}
            body={intl.formatMessage({ id: "mySpace.empty.trash.body" })}
          />
        ) : (
          <table className="w-full table-fixed border-collapse">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-ui-xs text-foreground-subtle">
                <th className="w-9 py-2 pl-4" aria-hidden="true" />
                <th className="py-2 pr-3 text-left font-normal">
                  {intl.formatMessage({ id: "mySpace.column.name" })}
                </th>
                <th className="w-24 py-2 pr-3 text-right font-normal">
                  {intl.formatMessage({ id: "mySpace.column.size" })}
                </th>
                <th className="w-36 py-2 pr-3 text-right font-normal">
                  {intl.formatMessage({ id: "mySpace.column.deletedAt" })}
                </th>
                <th className="w-20 py-2 pr-3 text-right font-normal" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className={cn(
                    "group border-b border-border/60 last:border-0 hover:bg-surface-hover",
                  )}
                >
                  <td className="w-9 pl-4 align-middle">
                    <FileDisplayIcon src={spaceFileIconSrc(item.name, "file")} size={16} />
                  </td>
                  <td className="min-w-0 py-1.5 pr-3 align-middle">
                    <div
                      className="min-w-0 truncate text-ui-base text-foreground"
                      title={item.name}
                    >
                      {item.name}
                    </div>
                    {item.fromPath ? (
                      <div className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                        {intl.formatMessage({ id: "mySpace.trash.from" }, { path: item.fromPath })}
                      </div>
                    ) : null}
                  </td>
                  <td className="w-24 py-1.5 pr-3 text-right align-middle font-mono text-ui-sm text-foreground-subtle">
                    {formatBytes(item.size)}
                  </td>
                  <td className="w-36 py-1.5 pr-3 text-right align-middle text-ui-sm text-foreground-subtle">
                    <span title={new Date(item.deletedAt).toLocaleString()}>
                      {formatSpaceWhen(item.deletedAt)}
                    </span>
                  </td>
                  <td className="w-20 py-1.5 pr-3 align-middle">
                    <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <ControlHintTooltip
                        title={intl.formatMessage({ id: "mySpace.action.restore" })}
                      >
                        <Button
                          size="icon-md"
                          variant="ghost"
                          aria-label={intl.formatMessage({ id: "mySpace.action.restore" })}
                          onClick={() => onRestore([item.id])}
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      </ControlHintTooltip>
                      <ControlHintTooltip
                        title={intl.formatMessage({ id: "mySpace.action.purge" })}
                      >
                        <Button
                          size="icon-md"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={intl.formatMessage({ id: "mySpace.action.purge" })}
                          onClick={() => onPurge([item.id])}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </ControlHintTooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
