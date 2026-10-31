/**
 * 我的空间：右侧详情面板。
 *
 * 从主面板拆出来的原因：预览、下载、加入对话、分享、重命名、版本历史都在这里，
 * 塞进主面板会让它迅速膨胀成上千行（仓库有单文件行数门禁）。
 */
import { useCallback, useEffect, useState } from "react";
import { Download, History, Paperclip, Pencil, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { MySpacePreview } from "./MySpacePreview.js";
import { formatBytes, spaceClient, type SpaceEntry } from "./spaceClient.js";

interface VersionItem {
  id: string;
  size: number;
  savedAt: string;
}

export function MySpaceDetails({
  relPath,
  entry,
  resolvedTheme,
  selectedCount,
  onClose,
  onAddToChat,
  onShare,
  onDeleteSelected,
  onChanged,
  onError,
}: {
  relPath: string | null;
  entry: SpaceEntry | null;
  resolvedTheme: "light" | "dark";
  selectedCount: number;
  onClose: () => void;
  onAddToChat: (relPath: string) => void;
  onShare: (relPath: string) => void;
  onDeleteSelected: () => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [versions, setVersions] = useState<VersionItem[] | null>(null);

  const loadVersions = useCallback(async () => {
    if (!relPath) return;
    try {
      const result = await spaceClient.versions(relPath);
      setVersions(result.items);
    } catch (e) {
      onError(e);
    }
  }, [onError, relPath]);

  useEffect(() => {
    setRenaming(false);
    setVersions(null);
  }, [relPath]);

  if (!relPath || !entry) {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        选中文件查看详情与预览。删除会进回收站（仍占空间），彻底删除后才释放。
      </p>
    );
  }

  const name = entry.name;
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";

  const submitRename = async () => {
    const next = draftName.trim();
    if (!next || next === name) {
      setRenaming(false);
      return;
    }
    try {
      // rename 接口接收的是完整相对路径与**新名称**（不是新路径）
      await spaceClient.rename(relPath, next);
      setRenaming(false);
      onChanged();
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-ui-sm font-medium" title={relPath}>
          {name}
        </h3>
        <Button size="sm" variant="ghost" aria-label="关闭预览" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <p className="text-ui-xs text-foreground-subtle">
        {formatBytes(entry.size)} · {new Date(entry.mtime).toLocaleString()}
      </p>

      <div className="h-44 overflow-hidden rounded-lg border border-border bg-surface">
        <MySpacePreview relPath={relPath} resolvedTheme={resolvedTheme} />
      </div>

      {renaming ? (
        <div className="flex items-center gap-2">
          <Input
            value={draftName}
            autoFocus
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename();
              if (event.key === "Escape") setRenaming(false);
            }}
          />
          <Button size="sm" onClick={() => void submitRename()}>
            确定
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <Button
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}
        >
          <Download className="size-4" /> 下载到本机
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => onAddToChat(relPath)}
        >
          <Paperclip className="size-4" /> 加入对话
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={() => onShare(relPath)}
        >
          <Share2 className="size-4" /> 分享链接
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start gap-2"
          onClick={() => {
            setDraftName(name);
            setRenaming(true);
          }}
        >
          <Pencil className="size-4" /> 重命名
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start gap-2"
          disabled={existingDirIsRoot(dir)}
          onClick={() => {
            const target = window.prompt("移动到哪个目录（相对空间根，留空表示根目录）", dir);
            if (target === null) return;
            void spaceClient
              .move([relPath], target.trim())
              .then(onChanged)
              .catch(onError);
          }}
        >
          移动到…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start gap-2 text-destructive"
          disabled={selectedCount === 0}
          onClick={onDeleteSelected}
        >
          删除选中（{selectedCount}）
        </Button>
      </div>

      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            <History className="size-4" /> 历史版本
          </span>
          <Button size="sm" variant="ghost" onClick={() => void loadVersions()}>
            加载
          </Button>
        </div>
        {versions === null ? null : versions.length === 0 ? (
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            暂无历史版本。用「上传新版本」覆盖同名文件时会自动留档。
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {versions.map((version) => (
              <li key={version.id} className="flex items-center gap-2 text-ui-xs">
                <span className="min-w-0 flex-1 truncate font-mono">{version.savedAt}</span>
                <span className="text-foreground-subtle">{formatBytes(version.size)}</span>
                <Button
                  size="sm"
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
                  还原
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 根目录没有必要「移动到根目录」，直接禁用避免无意义请求。 */
function existingDirIsRoot(dir: string): boolean {
  return dir.length === 0;
}
