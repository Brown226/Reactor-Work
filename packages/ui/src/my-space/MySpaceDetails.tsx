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

      <div className="space-y-2 border-t border-border px-3 py-2">
        {!isDirectory ? (
          <div className="grid grid-cols-2 gap-1.5">
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
          </div>
        ) : null}

        <div className="flex items-center gap-0.5">
          {!isDirectory ? (
            <>
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
              <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
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
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-ui-sm">
        <dt className="text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.details.type" })}
        </dt>
        <dd className="min-w-0 truncate text-right text-foreground">
          {spaceFileTypeLabel(name, entry.kind)}
        </dd>
        <dt className="text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.details.size" })}
        </dt>
        <dd className="text-right font-mono text-foreground">
          {isDirectory ? "—" : formatBytes(entry.size)}
        </dd>
        <dt className="text-foreground-subtle">
          {intl.formatMessage({ id: "mySpace.details.modified" })}
        </dt>
        <dd className="text-right text-foreground">
          <span title={new Date(entry.mtime).toLocaleString()}>{formatSpaceWhen(entry.mtime)}</span>
        </dd>
      </dl>

      {!isDirectory ? (
        <div className="border-t border-border px-3 py-2">
          <div className="flex items-center gap-1.5">
            <History className="size-3.5 text-foreground-subtle" aria-hidden="true" />
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "mySpace.details.versions" })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              disabled={versionsLoading}
              onClick={() => void loadVersions()}
            >
              {intl.formatMessage({ id: "mySpace.details.loadVersions" })}
            </Button>
          </div>
          {versions !== null ? (
            versions.length === 0 ? (
              <p className="mt-1 text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "mySpace.details.versionsEmpty" })}
              </p>
            ) : (
              <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto">
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
            )
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
