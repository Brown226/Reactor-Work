/**
 * 我的空间：分享列表。
 *
 * 链接必须在复制时补全当前源：服务端返回的是相对地址，同事拿到裸路径粘到别处打不开
 * （这个坑已经踩过一次，见 spaceClient 的注释）。
 */
import { Copy, Link2, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MySpaceEmptyState } from "./MySpaceEmptyState.js";
import type { SpaceShareItem } from "./spaceClient.js";
import { spaceFileIconSrc } from "./spaceFileType.js";

export function MySpaceShareTable({
  items,
  loading,
  onCopy,
  onRevoke,
}: {
  items: SpaceShareItem[];
  loading: boolean;
  onCopy: (item: SpaceShareItem) => void;
  onRevoke: (item: SpaceShareItem) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.list.itemCount" }, { count: items.length })}
        </span>
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
            icon={<Link2 className="size-5" />}
            title={intl.formatMessage({ id: "mySpace.empty.shares.title" })}
            body={intl.formatMessage({ id: "mySpace.empty.shares.body" })}
          />
        ) : (
          <table className="w-full table-fixed border-collapse">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-ui-xs text-foreground-subtle">
                <th className="w-9 py-2 pl-4" aria-hidden="true" />
                <th className="py-2 pr-3 text-left font-normal">
                  {intl.formatMessage({ id: "mySpace.column.name" })}
                </th>
                <th className="w-32 py-2 pr-3 text-left font-normal">
                  {intl.formatMessage({ id: "mySpace.column.status" })}
                </th>
                <th className="w-20 py-2 pr-3 text-right font-normal" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const expired = new Date(item.expiresAt).getTime() <= Date.now();
                return (
                  <tr
                    key={item.token}
                    className="group border-b border-border/60 last:border-0 hover:bg-surface-hover"
                  >
                    <td className="w-9 pl-4 align-middle">
                      <FileDisplayIcon src={spaceFileIconSrc(item.path, "file")} size={16} />
                    </td>
                    <td className="min-w-0 py-1.5 pr-3 align-middle">
                      <div
                        className="min-w-0 truncate text-ui-base text-foreground"
                        title={item.path}
                      >
                        {item.path}
                      </div>
                    </td>
                    <td className="w-32 py-1.5 pr-3 align-middle">
                      <div className="flex flex-wrap items-center gap-1">
                        {expired ? (
                          <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
                            {intl.formatMessage({ id: "mySpace.shares.expired" })}
                          </span>
                        ) : (
                          <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
                            {item.hasPassword
                              ? intl.formatMessage({ id: "mySpace.shares.password" })
                              : intl.formatMessage({ id: "mySpace.shares.public" })}
                          </span>
                        )}
                        {item.hasPassword ? (
                          <ShieldCheck
                            className="size-3 text-foreground-subtlest"
                            aria-hidden="true"
                          />
                        ) : null}
                      </div>
                    </td>
                    <td className="w-20 py-1.5 pr-3 align-middle">
                      <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <ControlHintTooltip
                          title={intl.formatMessage({ id: "mySpace.action.copyLink" })}
                        >
                          <Button
                            size="icon-md"
                            variant="ghost"
                            aria-label={intl.formatMessage({ id: "mySpace.action.copyLink" })}
                            onClick={() => onCopy(item)}
                          >
                            <Copy className="size-4" />
                          </Button>
                        </ControlHintTooltip>
                        <ControlHintTooltip
                          title={intl.formatMessage({ id: "mySpace.action.revoke" })}
                        >
                          <Button
                            size="icon-md"
                            variant="ghost"
                            className="text-destructive"
                            aria-label={intl.formatMessage({ id: "mySpace.action.revoke" })}
                            onClick={() => onRevoke(item)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </ControlHintTooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
