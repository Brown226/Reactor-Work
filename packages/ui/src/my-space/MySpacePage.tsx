/**
 * 我的空间：主视图（Web 宿主专属）。
 *
 * 为什么是「主视图」而不是弹窗：自动化/插件市场/专家技能都是主视图，侧栏入口
 * 自带选中态，返回会话只需选中任务。空间页要同时放下列表与预览，弹窗的可用面积
 * 和这种高密度操作不匹配（旧版 1200×88vh 的弹窗里预览只有 176px 高）。
 *
 * 与工作区文件树的分工见 docs/未完成-我的空间-方案-v1.md §1：
 * 文件树面向 agent 干活，这里面向人——容量、批量操作、回收站、分享。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CloudUpload,
  Database,
  FolderPlus,
  MoreHorizontal,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import { SegmentedTabs } from "@/components/ui/segmented-tabs.js";
import { Dialog, DialogContent } from "@/components/ui/dialog.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MySpaceDetails } from "./MySpaceDetails.js";
import { MySpaceShareDialog, MySpaceTextDialog } from "./MySpaceDialogs.js";
import { MySpaceFileTable, type SpaceSearchHit } from "./MySpaceFileTable.js";
import { MySpaceShareTable } from "./MySpaceShareTable.js";
import { MySpaceStorageCard } from "./MySpaceStorageCard.js";
import { MySpaceTrashTable } from "./MySpaceTrashTable.js";
import {
  SpaceQuotaError,
  spaceClient,
  type SpaceEntriesResult,
  type SpaceShareItem,
  type SpaceTrashItem,
  type SpaceUsage,
} from "./spaceClient.js";

type View = "files" | "trash" | "shares";

/** 大于 8MB 走分片：整包读进内存对图纸级文件会顶到峰值，失败也只能从头再来。 */
const CHUNKED_UPLOAD_BYTES = 8 * 1024 * 1024;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function parentDir(relPath: string): string {
  return relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
}

function resolveTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

type DialogState =
  | { kind: "new-folder" }
  | { kind: "rename"; relPath: string }
  | { kind: "move"; relPath: string }
  | null;

export function MySpacePage({
  onAddToChat,
}: {
  /** 宿主把选中文件注入当前 composer；由 WorkspaceShellLayout 提供。 */
  onAddToChat?: (relPaths: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  const [view, setView] = useState<View>("files");
  const [path, setPath] = useState("");
  const [data, setData] = useState<SpaceEntriesResult | null>(null);
  const [trash, setTrash] = useState<SpaceTrashItem[]>([]);
  const [shares, setShares] = useState<SpaceShareItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SpaceSearchHit[] | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [shareTarget, setShareTarget] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  // 窄屏没有第三栏：选中文件后用弹窗承载预览与操作，保证任何宽度都能看到内容。
  const [compactDetailsOpen, setCompactDetailsOpen] = useState(false);
  const isWide = useIsWideLayout();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const versionInputRef = useRef<HTMLInputElement | null>(null);
  const resolvedTheme = resolveTheme();

  const usage: SpaceUsage | null = data?.usage ?? null;

  const handleError = useCallback(
    (e: unknown) => {
      // 配额不足单独给一句可执行的话，而不是把 413 的通用文案甩给用户。
      setError(
        e instanceof SpaceQuotaError
          ? intl.formatMessage({ id: "mySpace.storage.full" })
          : e instanceof Error
            ? e.message
            : String(e),
      );
    },
    [intl],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "files") {
        const result = await spaceClient.entries(path);
        setData(result);
      } else if (view === "trash") {
        setTrash((await spaceClient.trash()).items);
      } else {
        setShares((await spaceClient.shares()).items);
      }
    } catch (e) {
      handleError(e);
    } finally {
      setLoading(false);
    }
  }, [handleError, path, view]);

  useEffect(() => {
    void load();
  }, [load]);

  // 搜索防抖：服务端按文件名递归扫盘（O(n)），不能每敲一个字都打一次。
  useEffect(() => {
    const keyword = query.trim();
    if (view !== "files" || keyword.length === 0) {
      setSearchResults(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void spaceClient
        .search(keyword)
        .then((result) => setSearchResults(result.results))
        .catch(handleError);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [handleError, query, view]);

  useEffect(() => {
    if (!copyHint) return;
    const timer = window.setTimeout(() => setCopyHint(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyHint]);

  const activeEntry = useMemo(() => {
    if (!data || !active) return null;
    return data.entries.find((entry) => entry.name === active) ?? null;
  }, [active, data]);

  const selectedPaths = useMemo(
    () => Array.from(selected).map((name) => joinPath(path, name)),
    [path, selected],
  );

  const switchView = (next: View) => {
    setView(next);
    setSelected(new Set());
    setActive(null);
    setSearchResults(null);
  };

  const toggleSelect = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelected(checked ? new Set(data?.entries.map((entry) => entry.name) ?? []) : new Set());
  };

  const activate = (name: string) => {
    setActive(name);
    if (!isWide) setCompactDetailsOpen(true);
  };

  const openDirectory = (name: string) => {
    setPath(joinPath(path, name));
    setSelected(new Set());
    setActive(null);
    setQuery("");
  };

  const uploadFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploading({ name: file.name, percent: 0 });
      try {
        const onProgress = (percent: number) => setUploading({ name: file.name, percent });
        if (file.size > CHUNKED_UPLOAD_BYTES) {
          await spaceClient.uploadChunked(path, file, onProgress);
        } else {
          await spaceClient.upload(path, file, onProgress);
        }
      } catch (e) {
        handleError(e);
        break;
      }
    }
    setUploading(null);
    await load();
  };

  const uploadNewVersion = async (files: FileList | null) => {
    if (!files?.length || !active || !activeEntry) return;
    const source = files[0];
    if (!source) return;
    // 版本上传必须沿用当前文件名，否则会变成一个新文件。
    const renamed = new File([source], active, { type: source.type });
    setUploading({ name: active, percent: 0 });
    try {
      await spaceClient.uploadVersioned(path, renamed, (percent) =>
        setUploading({ name: active, percent }),
      );
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setUploading(null);
    }
  };

  const deletePaths = async (relPaths: string[]) => {
    if (relPaths.length === 0) return;
    const ok = await confirm({
      title: intl.formatMessage({ id: "mySpace.confirm.delete.title" }),
      description: intl.formatMessage(
        { id: "mySpace.confirm.delete.body" },
        { count: relPaths.length },
      ),
      confirmVariant: "destructive",
      confirmLabel: intl.formatMessage({ id: "mySpace.action.delete" }),
      cancelLabel: intl.formatMessage({ id: "mySpace.dialog.cancel" }),
    });
    if (!ok) return;
    try {
      await spaceClient.remove(relPaths);
      setSelected(new Set());
      setActive(null);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const restoreTrash = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await spaceClient.restore(ids);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const purgeTrash = async (ids: string[]) => {
    const all = ids.length === 0;
    const ok = await confirm({
      title: intl.formatMessage({
        id: all ? "mySpace.confirm.purgeAll.title" : "mySpace.confirm.purge.title",
      }),
      description: intl.formatMessage({
        id: all ? "mySpace.confirm.purgeAll.body" : "mySpace.confirm.purge.body",
      }),
      confirmVariant: "destructive",
      confirmLabel: intl.formatMessage({ id: "mySpace.action.purge" }),
      cancelLabel: intl.formatMessage({ id: "mySpace.dialog.cancel" }),
    });
    if (!ok) return;
    try {
      await spaceClient.purge(ids);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const submitShare = async (params: { ttlHours: number; password?: string }) => {
    if (!shareTarget) return;
    setShareBusy(true);
    try {
      await spaceClient.createShare(shareTarget, params.ttlHours, params.password);
      setShareTarget(null);
      setView("shares");
      setSelected(new Set());
      setActive(null);
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setShareBusy(false);
    }
  };

  const copyShareLink = async (item: SpaceShareItem) => {
    // 服务端给的是相对地址，复制时补当前源，否则粘到别处打不开。
    const url = item.url.startsWith("http") ? item.url : `${window.location.origin}${item.url}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopyHint(url);
    } catch (e) {
      handleError(e);
    }
  };

  const submitDialogValue = (value: string) => {
    if (!dialog) return;
    const current = dialog;
    setDialog(null);
    if (current.kind === "new-folder") {
      if (!value) return;
      void spaceClient.mkdir(joinPath(path, value)).then(load).catch(handleError);
      return;
    }
    if (current.kind === "rename") {
      const next = value || activeEntry?.name || "";
      if (!next) return;
      void spaceClient
        .rename(current.relPath, next)
        .then(() => {
          setActive(next);
          return load();
        })
        .catch(handleError);
      return;
    }
    void spaceClient
      .move([current.relPath], value)
      .then(() => {
        setActive(null);
        return load();
      })
      .catch(handleError);
  };

  const dialogProps = (() => {
    if (!dialog) return null;
    if (dialog.kind === "new-folder") {
      return {
        title: intl.formatMessage({ id: "mySpace.dialog.newFolder.title" }),
        placeholder: intl.formatMessage({ id: "mySpace.dialog.newFolder.placeholder" }),
        initialValue: "",
        allowEmpty: false,
      };
    }
    if (dialog.kind === "rename") {
      return {
        title: intl.formatMessage({ id: "mySpace.dialog.rename.title" }),
        placeholder: undefined,
        initialValue: dialog.relPath.split("/").pop() ?? "",
        allowEmpty: false,
      };
    }
    return {
      title: intl.formatMessage({ id: "mySpace.dialog.move.title" }),
      description: intl.formatMessage({ id: "mySpace.dialog.move.placeholder" }),
      placeholder: intl.formatMessage({ id: "mySpace.dialog.move.placeholder" }),
      initialValue: parentDir(dialog.relPath),
      allowEmpty: true,
    };
  })();

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col px-4 py-4 md:px-6">
      {/* 工具栏：视图切换 + 搜索 + 动作 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
        <SegmentedTabs
          value={view}
          onValueChange={(next) => switchView(next)}
          ariaLabel={intl.formatMessage({ id: "workspaceHeader.mySpace" })}
          items={[
            { value: "files", label: intl.formatMessage({ id: "mySpace.tab.files" }) },
            { value: "trash", label: intl.formatMessage({ id: "mySpace.tab.trash" }) },
            { value: "shares", label: intl.formatMessage({ id: "mySpace.tab.shares" }) },
          ]}
        />

        {view === "files" ? (
          <div className="relative w-56">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-foreground-subtlest"
              aria-hidden="true"
            />
            <Input
              className="pl-7"
              value={query}
              placeholder={intl.formatMessage({ id: "mySpace.search.placeholder" })}
              data-testid="my-space-search"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {copyHint ? (
            <span className="max-w-52 truncate text-ui-xs text-success" title={copyHint}>
              {intl.formatMessage({ id: "mySpace.action.copyLink" })} ✓
            </span>
          ) : null}
          {view === "files" && selectedPaths.length > 0 ? (
            <>
              {/* 批量删除是选中态的主操作：勾选后最常做的就是删，不放进「更多」菜单里埋着 */}
              <Button
                variant="ghost"
                className="text-destructive"
                data-testid="my-space-delete-selected"
                onClick={() => void deletePaths(selectedPaths)}
              >
                {intl.formatMessage(
                  { id: "mySpace.action.deleteSelected" },
                  { count: selectedPaths.length },
                )}
              </Button>
              <Button
                variant="outline"
                data-testid="my-space-download-selected"
                onClick={() => void spaceClient.downloadArchive(selectedPaths).catch(handleError)}
              >
                {intl.formatMessage({ id: "mySpace.action.archive" })}
              </Button>
            </>
          ) : null}
          {/* 容量详情不常驻：鼠标悬浮工具栏按钮才弹出，腾出主区空间 */}
          {usage ? (
            <HoverCard openDelay={150} closeDelay={120}>
              <HoverCardTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={intl.formatMessage({ id: "mySpace.storage.title" })}
                  data-testid="my-space-storage-trigger"
                >
                  <Database className="size-4" />
                </Button>
              </HoverCardTrigger>
              <HoverCardContent align="end" className="w-72 p-0">
                <MySpaceStorageCard usage={usage} />
              </HoverCardContent>
            </HoverCard>
          ) : null}
          {view === "files" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={intl.formatMessage({ id: "mySpace.action.more" })}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog({ kind: "new-folder" })}>
                  <FolderPlus className="size-4" />
                  {intl.formatMessage({ id: "mySpace.action.newFolder" })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!activeEntry || activeEntry.kind === "directory"}
                  onSelect={() => versionInputRef.current?.click()}
                >
                  <CloudUpload className="size-4" />
                  {intl.formatMessage({ id: "mySpace.action.uploadVersion" })}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void load()}>
                  <RefreshCw className="size-4" />
                  {intl.formatMessage({ id: "mySpace.action.refresh" })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {view === "files" ? (
            <Button data-testid="my-space-upload" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-1.5 size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "mySpace.action.upload" })}
            </Button>
          ) : null}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.currentTarget.files) void uploadFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={versionInputRef}
        type="file"
        className="hidden"
        onChange={(event) => {
          void uploadNewVersion(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />

      {error ? (
        <div className="mb-2 shrink-0 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-ui-sm text-foreground">
          {error}
        </div>
      ) : null}

      {uploading ? (
        <div className="mb-2 shrink-0 rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            <CloudUpload className="size-4" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{uploading.name}</span>
            <span className="font-mono text-ui-xs">{uploading.percent}%</span>
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${uploading.percent}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* 主体：左窄（文件列表）+ 右宽（预览/详情）。
          预览要的是面积，列表只需要名字/大小/时间三列——比例反过来后 PDF、图纸、表格
          才有地方展开（2026-11-01 实测反馈）。窄屏没有第三栏，列表占满、预览走弹窗。 */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 w-full min-w-0 flex-col lg:w-[var(--workspace-sidebar-panel-width,264px)] lg:max-w-[320px] lg:min-w-[240px] lg:shrink-0">
          {view === "files" ? (
            <MySpaceFileTable
              path={path}
              data={data}
              loading={loading}
              selected={selected}
              active={active}
              searchResults={searchResults}
              query={query}
              onNavigate={(next) => {
                setPath(next);
                setSelected(new Set());
                setActive(null);
              }}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              onOpenDirectory={openDirectory}
              onActivate={activate}
              onOpenSearchHit={(hit) => {
                setPath(parentDir(hit.path));
                setActive(hit.entry.name);
                setQuery("");
              }}
              onDropFiles={(files) => void uploadFiles(files)}
              onUpload={() => fileInputRef.current?.click()}
            />
          ) : view === "trash" ? (
            <MySpaceTrashTable
              items={trash}
              loading={loading}
              onRestore={(ids) => void restoreTrash(ids)}
              onPurge={(ids) => void purgeTrash(ids)}
            />
          ) : (
            <MySpaceShareTable
              items={shares}
              loading={loading}
              onCopy={(item) => void copyShareLink(item)}
              onRevoke={(item) =>
                void spaceClient.revokeShare(item.token).then(load).catch(handleError)
              }
            />
          )}
        </div>

        <aside className="hidden min-w-0 flex-1 lg:flex">
          <MySpaceDetails
            relPath={active ? joinPath(path, active) : null}
            entry={activeEntry}
            resolvedTheme={resolvedTheme}
            onClose={() => setActive(null)}
            onAddToChat={(rel) => onAddToChat?.([rel])}
            onShare={(rel) => setShareTarget(rel)}
            onRename={(rel) => setDialog({ kind: "rename", relPath: rel })}
            onMove={(rel) => setDialog({ kind: "move", relPath: rel })}
            onDelete={(paths) => void deletePaths(paths)}
            onChanged={() => void load()}
            onError={handleError}
          />
        </aside>
      </div>

      {dialog && dialogProps ? (
        <MySpaceTextDialog
          open
          title={dialogProps.title}
          {...(dialogProps.description ? { description: dialogProps.description } : {})}
          placeholder={dialogProps.placeholder}
          initialValue={dialogProps.initialValue}
          allowEmpty={dialogProps.allowEmpty}
          onCancel={() => setDialog(null)}
          onSubmit={submitDialogValue}
        />
      ) : null}

      {/* 窄屏（<lg）没有第三栏：用同一份详情组件放在弹窗里，预览与操作不丢。 */}
      <Dialog
        open={!isWide && compactDetailsOpen && activeEntry !== null}
        onOpenChange={(next) => setCompactDetailsOpen(next)}
      >
        <DialogContent showCloseButton={false} className="h-[80vh] max-w-3xl overflow-hidden">
          <div className="h-full min-h-0">
            <MySpaceDetails
              relPath={active ? joinPath(path, active) : null}
              entry={activeEntry}
              resolvedTheme={resolvedTheme}
              onClose={() => setCompactDetailsOpen(false)}
              onAddToChat={(rel) => onAddToChat?.([rel])}
              onShare={(rel) => setShareTarget(rel)}
              onRename={(rel) => setDialog({ kind: "rename", relPath: rel })}
              onMove={(rel) => setDialog({ kind: "move", relPath: rel })}
              onDelete={(paths) => void deletePaths(paths)}
              onChanged={() => void load()}
              onError={handleError}
            />
          </div>
        </DialogContent>
      </Dialog>

      <MySpaceShareDialog
        open={shareTarget !== null}
        name={shareTarget?.split("/").pop() ?? ""}
        busy={shareBusy}
        onCancel={() => setShareTarget(null)}
        onSubmit={(params) => void submitShare(params)}
      />
    </div>
  );
}

/** 断点判断只在 JS 需要决定「详情走侧栏还是弹窗」时使用，布局本身仍由 Tailwind 断点控制。 */
function useIsWideLayout(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}
