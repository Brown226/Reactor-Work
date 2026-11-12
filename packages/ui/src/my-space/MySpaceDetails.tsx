/**
 * 我的空间：右侧详情面板。
 *
 * 布局按「预览优先」组织：只有一条标题行 + 一条元信息行，中间整块给预览。
 * 操作全部收在标题行右侧（加入对话 / 历史版本 / 下载 / 分享），
 * 重命名、移动、删除交给左侧列表的行菜单，避免同一动作出现两个入口。
 */
import { useState } from "react";
import { FolderOpen, History, Paperclip, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MySpacePreview } from "./MySpacePreview.js";
import { MySpaceVersionsDialog } from "./MySpaceVersionsDialog.js";
import { formatBytes, type SpaceEntry } from "./spaceClient.js";
import { formatSpaceWhen, spaceFileIconSrc, spaceFileTypeLabel } from "./spaceFileType.js";

export interface MySpaceDetailsProps {
  relPath: string | null;
  entry: SpaceEntry | null;
  resolvedTheme: "light" | "dark";
  onClose: () => void;
  onAddToChat: (relPath: string) => void;
  onShare: (relPath: string) => void;
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
  onChanged,
  onError,
}: MySpaceDetailsProps) {
  const { intl } = useZCodeIntl();
  const [versionsOpen, setVersionsOpen] = useState(false);

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
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <FileDisplayIcon src={spaceFileIconSrc(name, entry.kind)} size={16} className="shrink-0" />
        <h3
          className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
          title={relPath}
        >
          {name}
        </h3>
        {/* 操作全部收进标题行右侧的空白：文件名很少长到占满，那一行本来就空着一大截。
            顺序按常用度排「加入对话 → 历史版本 → 分享」，只有加入对话是主色按钮，
            其余做成图标，标题行才不会被一排通栏按钮撑高。
            重命名/移动/删除/下载由左侧列表的行菜单承载，这里不再重复。 */}
        <div className="flex shrink-0 items-center gap-1">
          {!isDirectory ? (
            <>
              <Button size="sm" onClick={() => onAddToChat(relPath)}>
                <Paperclip className="mr-1.5 size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "mySpace.action.addToChat" })}
              </Button>
              <ControlHintTooltip title={intl.formatMessage({ id: "mySpace.details.versions" })}>
                <Button
                  size="icon-md"
                  variant="ghost"
                  aria-label={intl.formatMessage({ id: "mySpace.details.versions" })}
                  onClick={() => setVersionsOpen(true)}
                >
                  <History className="size-4" />
                </Button>
              </ControlHintTooltip>
              {/* 下载入口在文件列表的行菜单里，标题行不再重复 */}
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
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <Button
            size="icon-md"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "mySpace.details.close" })}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
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

      {/* 元信息一行到底：类型 · 大小 · 修改时间。历史版本入口在标题行，点开是独立弹窗。 */}
      <div className="flex min-w-0 items-center gap-1.5 border-t border-border px-3 py-1 text-ui-xs text-foreground-subtle">
        <span className="shrink-0">{spaceFileTypeLabel(name, entry.kind)}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0 font-mono">{isDirectory ? "—" : formatBytes(entry.size)}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate" title={new Date(entry.mtime).toLocaleString()}>
          {formatSpaceWhen(entry.mtime)}
        </span>
      </div>

      {!isDirectory ? (
        <MySpaceVersionsDialog
          open={versionsOpen}
          name={name}
          relPath={relPath}
          onClose={() => setVersionsOpen(false)}
          onRestored={onChanged}
          onError={onError}
        />
      ) : null}
    </aside>
  );
}
