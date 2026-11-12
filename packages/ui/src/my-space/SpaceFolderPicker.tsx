/**
 * Web 端「打开文件夹」的选择器：只能在你自己的空间里挑文件夹。
 *
 * 为什么不用 DirectoryBrowser：那个组件走 fileService.readdir，能浏览整个容器文件系统
 * （/etc、别的用户空间都能进），选完直接把 agent 工作区切过去——对 Web 用户既是语义错位
 * 也是越权面。这里改成走 /api/space/*（服务端本来就按登录 uid 把路径钳在空间根内），
 * 面包屑最顶层就是「我的空间」，没有上跳入口，也没有任意路径输入框。
 *
 * 选中即工作区：agent 之后写的文件天然落在该文件夹里，「我的空间」里能直接看到。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderPlus, Folder } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { spaceClient, type SpaceEntry } from "./spaceClient.js";
import { spaceFileIconSrc } from "./spaceFileType.js";

interface SpaceFolderPickerProps {
  /** 空间根的绝对路径（登录默认工作区）：/data/users/<uid> */
  rootAbsPath: string;
  /** 当前工作区绝对路径，用于标记「正在使用」 */
  currentWorkspaceAbsPath?: string;
  onSelect: (absPath: string) => void;
  onCancel: () => void;
}

function joinRel(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function SpaceFolderPicker({
  rootAbsPath,
  currentWorkspaceAbsPath,
  onSelect,
  onCancel,
}: SpaceFolderPickerProps) {
  const { intl } = useZCodeIntl();
  const [relPath, setRelPath] = useState("");
  const [entries, setEntries] = useState<SpaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await spaceClient.entries(target);
      // 只列目录：这个弹窗的语义是「选工作文件夹」，文件不参与选择。
      setEntries(result.entries.filter((entry) => entry.kind === "directory"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(relPath);
  }, [load, relPath]);

  const currentAbs = useMemo(
    () => (relPath ? `${rootAbsPath}/${relPath}` : rootAbsPath),
    [relPath, rootAbsPath],
  );

  const createFolder = async () => {
    const name = draftName.trim();
    if (!name) return;
    try {
      const target = joinRel(relPath, name);
      await spaceClient.mkdir(target);
      setCreating(false);
      setDraftName("");
      // 建完直接进去，省一次点击
      setRelPath(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const segments = relPath.split("/").filter(Boolean);

  return (
    <Dialog open onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "mySpace.picker.title" })}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: "mySpace.picker.hint" })}</DialogDescription>
        </DialogHeader>

        {/* 面包屑：最顶层固定是「我的空间」，没有上跳/任意路径输入 */}
        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-ui-sm">
          <button
            type="button"
            onClick={() => setRelPath("")}
            className="rounded-md px-1.5 py-0.5 text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
          >
            {intl.formatMessage({ id: "workspaceHeader.mySpace" })}
          </button>
          {segments.map((part, index) => {
            const target = segments.slice(0, index + 1).join("/");
            const isLast = index === segments.length - 1;
            return (
              <span key={target} className="flex min-w-0 items-center gap-0.5">
                <ChevronRight
                  className="size-3 shrink-0 text-foreground-subtlest"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => setRelPath(target)}
                  className={
                    isLast
                      ? "min-w-0 truncate rounded-md px-1.5 py-0.5 text-foreground"
                      : "min-w-0 truncate rounded-md px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
                  }
                >
                  {part}
                </button>
              </span>
            );
          })}
        </nav>

        <div className="min-h-0 overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "mySpace.list.itemCount" }, { count: entries.length })}
            </span>
            {creating ? null : (
              <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
                <FolderPlus className="mr-1 size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "mySpace.action.newFolder" })}
              </Button>
            )}
          </div>

          {creating ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Input
                autoFocus
                value={draftName}
                placeholder={intl.formatMessage({ id: "mySpace.dialog.newFolder.placeholder" })}
                onChange={(event) => setDraftName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createFolder();
                  if (event.key === "Escape") {
                    setCreating(false);
                    setDraftName("");
                  }
                }}
              />
              <Button size="sm" onClick={() => void createFolder()}>
                {intl.formatMessage({ id: "mySpace.dialog.confirm" })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setDraftName("");
                }}
              >
                {intl.formatMessage({ id: "mySpace.dialog.cancel" })}
              </Button>
            </div>
          ) : null}

          <div className="max-h-64 min-h-40 overflow-auto p-1">
            {error ? (
              <p className="px-2 py-3 text-ui-sm text-destructive">{error}</p>
            ) : loading ? (
              <p className="px-2 py-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "mySpace.list.loading" })}
              </p>
            ) : entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 px-3 py-8 text-center">
                <Folder className="size-5 text-foreground-subtlest" aria-hidden="true" />
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "mySpace.picker.empty" })}
                </p>
              </div>
            ) : (
              <ul>
                {entries.map((entry) => {
                  const childAbs = `${currentAbs}/${entry.name}`;
                  const isCurrent = childAbs === currentWorkspaceAbsPath;
                  return (
                    <li key={entry.name}>
                      <button
                        type="button"
                        onClick={() => setRelPath(joinRel(relPath, entry.name))}
                        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-base text-foreground transition-colors hover:bg-menu-hover"
                      >
                        <FileDisplayIcon
                          src={spaceFileIconSrc(entry.name, "directory")}
                          size={16}
                          className="shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {isCurrent ? (
                          <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
                            {intl.formatMessage({ id: "mySpace.picker.current" })}
                          </span>
                        ) : null}
                        <ChevronRight
                          className="size-3.5 shrink-0 text-foreground-subtlest"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="rounded-lg bg-surface px-3 py-2 font-mono text-ui-xs text-foreground-subtle">
          {currentAbs}
        </div>

        <DialogFooter>
          <Button size="lg" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "mySpace.dialog.cancel" })}
          </Button>
          <Button size="lg" onClick={() => onSelect(currentAbs)}>
            {intl.formatMessage({ id: "mySpace.picker.workHere" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
