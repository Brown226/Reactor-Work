/**
 * 我的空间：右侧详情面板（预览 + 操作 + 历史版本）。
 *
 * 布局按「预览优先」组织：预览区吃掉剩余高度，操作区固定在底部，
 * 不再像旧版那样把预览塞进 176px 的盒子里——那样 PDF/表格根本看不清。
 */
import { useCallback, useEffect, useState } from "react";
import {
  Download,
  FolderOpen,
  History,
  Paperclip,
  Pencil,
  Share2,
  FolderInput,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MySpacePreview } from "./MySpacePreview.js";
import { formatBytes, spaceClient, type SpaceEntry } from "./spaceClient.js";
import { formatSpaceWhen, spaceFileIconSrc, spaceFileTypeLabel } from "./spaceFileType.js";

interface VersionItem {
  id: string;
  size: number;
  savedAt: string;
}

export interface MySpaceDetailsProps {
  relPath: string | null;
  entry: SpaceEntry | null;
  resolvedTheme: "light" | "dark";
  onClose: () => void;
  onAddToChat: (relPath: string) => void;
  onShare: (relPath: string) => void;
  onRename: (relPath: string) => void;
  onMove: (relPath: string) => void;
  onDelete: (relPaths: string[]) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

export function MySpaceDetails({
  relPath,
  entry,
  resolvedTheme,
  onClose,
  onAddToChat,
  onShare,
  onRename,
  onMove,
  onDelete,
  onChanged,
  onError,
}: MySpaceDetailsProps) {
  const { intl } = useZCodeIntl();
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const loadVersions = useCallback(async () => {
    if (!relPath) return;
    setVersionsLoading(true);
    try {
      const result = await spaceClient.versions(relPath);
      setVersions(result.items);
    } catch (e) {
      onError(e);
    } finally {
      setVersionsLoading(false);
    }
  }, [onError, relPath]);

  useEffect(() => {
    setVersions(null);
  }, [relPath]);

  if (!relPath || !entry) {
    return (
      <aside className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-2 rounded-xl border border-card-border bg-card p-6 text-center">
        <span
          aria-hidden="true"
          className="flex size-11 items-center justify-center rounded-xl bg-surface text-foreground-subtle ring-1 ring-border"
        >
          <FolderOpen className="size-5" />
        </span>
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "mySpace.details.empty.title" })}
        </h3>
        <p className="max-w-[15rem] text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.details.empty.body" })}
        </p>
      </aside>
    );
  }

  const isDirectory = entry.kind === "directory";
  const name = entry.name;

  return (
    <aside className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileDisplayIcon src={spaceFileIconSrc(name, entry.kind)} size={16} className="shrink-0" />
        <h3
          className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
          title={relPath}
        >
          {name}
        </h3>
        <Button
          size="icon-md"
          variant="ghost"
          aria-label={intl.formatMessage({ id: "mySpace.details.close" })}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>

      {isDirectory ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <FolderOpen className="size-6 text-foreground-subtlest" aria-hidden="true" />
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mySpace.details.folder" })}
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MySpacePreview relPath={relPath} size={entry.size} resolvedTheme={resolvedTheme} />
        </div>
      )}

      {/* 底部操作区压成两行：一行按钮 + 一行元信息。
          旧版是「两个通栏大按钮 / 图标行 / 三行 类型·大小·时间 / 历史版本」共 5 行，
          下沿吃掉 200px 以上，预览区被挤得只剩一条；信息量没变，只是不再各占一行。 */}
      <div className="flex min-w-0 items-center gap-1 border-t border-border px-3 py-1.5">
        {!isDirectory ? (
          <>
            <Button
              size="sm"
              onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}
            >
              <Download className="mr-1.5 size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "mySpace.action.download" })}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAddToChat(relPath)}>
              <Paperclip className="mr-1.5 size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "mySpace.action.addToChat" })}
            </Button>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <ControlHintTooltip title={intl.formatMessage({ id: "mySpace.action.share" })}>
              <Button
                size="icon-md"
                variant="ghost"
                aria-label={intl.formatMessage({ id: "mySpace.action.share" })}
                onClick={() => onShare(relPath)}
              >
                <Share2 className="size-4" />
              </Button>
            </ControlHintTooltip>
          </>
        ) : null}
        <ControlHintTooltip title={intl.formatMessage({ id: "mySpace.action.rename" })}>
          <Button
            size="icon-md"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "mySpace.action.rename" })}
            onClick={() => onRename(relPath)}
          >
            <Pencil className="size-4" />
          </Button>
        </ControlHintTooltip>
        <ControlHintTooltip title={intl.formatMessage({ id: "mySpace.action.move" })}>
          <Button
            size="icon-md"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "mySpace.action.move" })}
            onClick={() => onMove(relPath)}
          >
            <FolderInput className="size-4" />
          </Button>
        </ControlHintTooltip>
        <ControlHintTooltip title={intl.formatMessage({ id: "mySpace.action.delete" })}>
          <Button
            size="icon-md"
            variant="ghost"
            className="ml-auto text-destructive"
            aria-label={intl.formatMessage({ id: "mySpace.action.delete" })}
            onClick={() => onDelete([relPath])}
          >
            <Trash2 className="size-4" />
          </Button>
        </ControlHintTooltip>
      </div>

      {/* 历史版本默认收起，展开时只占自己那一块，不影响下面的元信息行 */}
      {!isDirectory && versions !== null ? (
        <div className="border-t border-border px-3 py-1.5">
          {versions.length === 0 ? (
            <p className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "mySpace.details.versionsEmpty" })}
            </p>
          ) : (
            <ul className="max-h-28 space-y-0.5 overflow-auto">
              {versions.map((version) => (
                <li key={version.id} className="flex items-center gap-2 text-ui-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground-subtle">
                    {new Date(version.savedAt).toLocaleString()}
                  </span>
                  <span className="shrink-0 font-mono text-foreground-subtlest">
                    {formatBytes(version.size)}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void spaceClient
                        .restoreVersion(relPath, version.id)
                        .then(() => {
                          onChanged();
                          void loadVersions();
                        })
                        .catch(onError)
                    }
                  >
                    {intl.formatMessage({ id: "mySpace.action.restore" })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* 元信息一行到底：类型 · 大小 · 修改时间，右侧挂历史版本入口 */}
      <div className="flex min-w-0 items-center gap-1.5 border-t border-border px-3 py-1 text-ui-xs text-foreground-subtle">
        <span className="shrink-0">{spaceFileTypeLabel(name, entry.kind)}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0 font-mono">{isDirectory ? "—" : formatBytes(entry.size)}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate" title={new Date(entry.mtime).toLocaleString()}>
          {formatSpaceWhen(entry.mtime)}
        </span>
        {!isDirectory ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto shrink-0"
            disabled={versionsLoading}
            onClick={() => {
              // 再点一次收起，避免列表常驻挤占预览高度
              if (versions !== null) setVersions(null);
              else void loadVersions();
            }}
          >
            <History className="mr-1 size-3" aria-hidden="true" />
            {intl.formatMessage({ id: "mySpace.details.versions" })}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
