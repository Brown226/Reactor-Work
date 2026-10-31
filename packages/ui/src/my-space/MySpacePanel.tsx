/**
 * 我的空间：每用户 1GB 空间的资产管理面板。
 *
 * 与「工作区文件树」的分工（见 docs/未完成-我的空间-方案-v1.md §1）：
 * 文件树面向 agent 干活，这里面向人——容量可见、批量操作、回收站、分享。
 * 两者指向同一份磁盘数据（登录后工作区就是该用户的空间根），不复制不同步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FolderPlus,
  Link2 as LinkSimple,
  RotateCcw as ArrowCounterClockwise,
  Send as PaperPlaneTilt,
  Share2 as ShareNetwork,
  Trash2 as Trash,
  Upload as UploadSimple,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SpaceQuotaError,
  formatBytes,
  spaceClient,
  usagePercent,
  type SpaceEntriesResult,
  type SpaceEntry,
  type SpaceShareItem,
  type SpaceTrashItem,
  type SpaceUsage,
} from "./spaceClient.js";

type View = "files" | "trash" | "shares";

export interface MySpacePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 把选中的文件加入当前对话（宿主注入 composer 附件） */
  onAddToChat?: (relPaths: string[]) => void;
  /** 交给宿主已有预览器；不传则面板内部对图片/PDF 兜底预览 */
  onPreview?: (relPath: string) => void;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function MySpacePanel({ open, onOpenChange, onAddToChat, onPreview }: MySpacePanelProps) {
  const { intl } = useZCodeIntl();
  const [view, setView] = useState<View>("files");
  const [path, setPath] = useState("");
  const [data, setData] = useState<SpaceEntriesResult | null>(null);
  const [trash, setTrash] = useState<SpaceTrashItem[]>([]);
  const [shares, setShares] = useState<SpaceShareItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaHit, setQuotaHit] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [shareTarget, setShareTarget] = useState<string | null>(null);
  const [shareTtl, setShareTtl] = useState(24);
  const [sharePwd, setSharePwd] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const usage: SpaceUsage | null = data?.usage ?? null;
  const percent = usagePercent(usage);

  const handleError = useCallback((e: unknown) => {
    if (e instanceof SpaceQuotaError) setQuotaHit(true);
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "files") {
        const result = await spaceClient.entries(path);
        setData(result);
        setQuotaHit(usagePercent(result.usage) >= 100);
      } else if (view === "trash") {
        const result = await spaceClient.trash();
        setTrash(result.items);
      } else {
        const result = await spaceClient.shares();
        setShares(result.items);
      }
    } catch (e) {
      handleError(e);
    } finally {
      setLoading(false);
    }
  }, [handleError, path, view]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setActive(null);
      setError(null);
    }
  }, [open]);

  const select = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const selectedPaths = useMemo(
    () => Array.from(selected).map((name) => joinPath(path, name)),
    [path, selected],
  );

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    for (const file of list) {
      setUploading({ name: file.name, percent: 0 });
      try {
        await spaceClient.upload(path, file, (percentDone) =>
          setUploading({ name: file.name, percent: percentDone }),
        );
      } catch (e) {
        handleError(e);
        break;
      }
    }
    setUploading(null);
    await load();
  };

  const removeSelected = async () => {
    if (selectedPaths.length === 0) return;
    if (!window.confirm(`将 ${selectedPaths.length} 项移入回收站？（仍占用空间，可还原）`)) return;
    try {
      await spaceClient.remove(selectedPaths);
      setSelected(new Set());
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
    const label = ids.length === 0 ? "清空回收站" : `彻底删除 ${ids.length} 项`;
    if (!window.confirm(`${label}？不可恢复，删除后才会释放空间。`)) return;
    try {
      await spaceClient.purge(ids);
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  const createShare = async () => {
    if (!shareTarget) return;
    try {
      await spaceClient.createShare(shareTarget, shareTtl, sharePwd.trim() || undefined);
      setShareTarget(null);
      setSharePwd("");
      setView("shares");
      await load();
    } catch (e) {
      handleError(e);
    }
  };

  if (!open) return null;

  const previewUrl = active ? spaceClient.previewUrl(joinPath(path, active)) : null;
  const activeIsImage = active ? IMAGE_EXT.test(active) : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[88vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-card-border bg-card shadow-xl">
        {/* 头部：标题 + 视图切换 + 关闭 */}
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-4">
            <h2 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "workspaceHeader.mySpace" })}
            </h2>
            <nav className="flex gap-1">
              {(
                [
                  ["files", "文件"],
                  ["trash", "回收站"],
                  ["shares", "分享"],
                ] as Array<[View, string]>
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={view === key ? "default" : "ghost"}
                  onClick={() => {
                    setView(key);
                    setSelected(new Set());
                    setActive(null);
                  }}
                >
                  {label}
                </Button>
              ))}
            </nav>
          </div>
          <Button size="sm" variant="ghost" aria-label="关闭" onClick={() => onOpenChange(false)}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 左：容量卡 */}
          <aside className="w-64 shrink-0 space-y-4 border-r border-border p-4">
            <section>
              <div className="mb-1 flex items-baseline justify-between text-ui-sm">
                <span className="text-foreground-subtle">已用</span>
                <span className="font-mono text-foreground">
                  {usage ? formatBytes(usage.usedBytes) : "—"} /{" "}
                  {usage ? formatBytes(usage.quotaBytes) : "—"}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                <div
                  className={
                    percent >= 95
                      ? "h-full bg-destructive"
                      : percent >= 80
                        ? "h-full bg-warning"
                        : "h-full bg-primary"
                  }
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-1 text-ui-xs text-foreground-subtle">
                已用 {percent}%{quotaHit ? " · 空间已满，请清理" : ""}
              </p>
              {usage && usage.trashBytes > 0 ? (
                <p className="mt-1 text-ui-xs text-foreground-subtle">
                  其中回收站 {formatBytes(usage.trashBytes)}（也占空间）
                </p>
              ) : null}
            </section>

            {usage ? (
              <section className="space-y-1">
                <h3 className="text-ui-sm font-medium text-foreground">分类占用</h3>
                {Object.entries(usage.byCategory).map(([kind, bytes]) => (
                  <div key={kind} className="flex justify-between text-ui-xs text-foreground-subtle">
                    <span>{({ document: "文档", image: "图片", drawing: "图纸", other: "其他" } as Record<string, string>)[kind] ?? kind}</span>
                    <span className="font-mono">{formatBytes(bytes)}</span>
                  </div>
                ))}
              </section>
            ) : null}

            {view === "files" ? (
              <section className="space-y-2">
                <Button size="sm" className="w-full justify-start gap-2" onClick={() => fileInputRef.current?.click()}>
                  <UploadSimple className="size-4" /> 上传文件
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={() => {
                    const name = window.prompt("新建文件夹名称");
                    if (!name?.trim()) return;
                    void spaceClient
                      .mkdir(joinPath(path, name.trim()))
                      .then(load)
                      .catch(handleError);
                  }}
                >
                  <FolderPlus className="size-4" /> 新建文件夹
                </Button>
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
              </section>
            ) : null}
          </aside>

          {/* 中：列表 */}
          <main
            className="min-w-0 flex-1 overflow-auto p-4"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (view === "files" && event.dataTransfer.files.length > 0) {
                void uploadFiles(event.dataTransfer.files);
              }
            }}
          >
            {error ? (
              <div className="mb-3 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-ui-sm text-foreground">
                {error}
              </div>
            ) : null}

            {uploading ? (
              <div className="mb-3 rounded-lg border border-border px-3 py-2 text-ui-sm">
                正在上传 {uploading.name} · {uploading.percent}%
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface">
                  <div className="h-full bg-primary" style={{ width: `${uploading.percent}%` }} />
                </div>
              </div>
            ) : null}

            {loading ? (
              <p className="text-ui-sm text-foreground-subtle">加载中…</p>
            ) : view === "files" ? (
              <>
                <nav className="mb-3 flex items-center gap-2 text-ui-sm text-foreground-subtle">
                  <button type="button" className="hover:text-foreground" onClick={() => setPath("")}>
                    根目录
                  </button>
                  {path
                    ? path.split("/").filter(Boolean).map((part, index, all) => (
                        <span key={part} className="flex items-center gap-2">
                          /
                          <button
                            type="button"
                            className="hover:text-foreground"
                            onClick={() => setPath(all.slice(0, index + 1).join("/"))}
                          >
                            {part}
                          </button>
                        </span>
                      ))
                    : null}
                </nav>
                {data && data.entries.length === 0 ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    这里还没有文件。可以上传文件，或直接让 agent 在这里生成。
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {data?.entries.map((entry: SpaceEntry) => (
                      <li
                        key={entry.name}
                        className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-ui-sm hover:bg-hover ${
                          selected.has(entry.name) ? "bg-selected" : ""
                        }`}
                        onClick={() => (entry.kind === "directory" ? setPath(joinPath(path, entry.name)) : setActive(entry.name))}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(entry.name)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => select(entry.name)}
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {entry.kind === "directory" ? `${entry.name}/` : entry.name}
                        </span>
                        <span className="w-20 text-right font-mono text-ui-xs text-foreground-subtle">
                          {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : view === "trash" ? (
              trash.length === 0 ? (
                <p className="text-ui-sm text-foreground-subtle">回收站为空。</p>
              ) : (
                <>
                  <div className="mb-2 flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => void restoreTrash(trash.map((item) => item.id))}>
                      全部还原
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void purgeTrash([])}>
                      清空回收站
                    </Button>
                  </div>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {trash.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-ui-sm">
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                        <span className="w-20 text-right font-mono text-ui-xs text-foreground-subtle">
                          {formatBytes(item.size)}
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => void restoreTrash([item.id])}>
                          <ArrowCounterClockwise className="size-4" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void purgeTrash([item.id])}>
                          <Trash className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : shares.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                还没有分享。在文件列表选中文件后点「分享」即可生成带有效期的下载链接。
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {shares.map((item) => (
                  <li key={item.token} className="flex items-center gap-3 px-3 py-2 text-ui-sm">
                    <span className="min-w-0 flex-1 truncate">{item.path}</span>
                    <span className="text-ui-xs text-foreground-subtle">
                      {item.hasPassword ? "有口令 · " : ""}到期 {new Date(item.expiresAt).toLocaleString()}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        // 服务端返回的是相对地址（/api/space/shared/<token>）；复制时补当前源，
                        // 否则同事拿到链接粘到别处打不开。
                        void navigator.clipboard.writeText(
                          item.url.startsWith("http")
                            ? item.url
                            : `${window.location.origin}${item.url}`,
                        )
                      }
                    >
                      <LinkSimple className="size-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void spaceClient.revokeShare(item.token).then(load).catch(handleError)}
                    >
                      <Trash className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </main>

          {/* 右：详情与操作 */}
          <aside className="w-72 shrink-0 space-y-3 border-l border-border p-4">
            {active ? (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="min-w-0 truncate text-ui-sm font-medium">{active}</h3>
                  <Button size="sm" variant="ghost" onClick={() => setActive(null)}>
                    <X className="size-4" />
                  </Button>
                </div>
                <div className="h-40 overflow-hidden rounded-lg border border-border bg-surface">
                  {activeIsImage ? (
                    <img src={previewUrl ?? ""} alt={active} className="h-full w-full object-contain" />
                  ) : (
                    <iframe title={active} src={previewUrl ?? ""} className="h-full w-full" />
                  )}
                </div>
                <div className="space-y-2">
                  <Button
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      if (onPreview) onPreview(joinPath(path, active));
                      else window.open(previewUrl ?? "", "_blank", "noopener,noreferrer");
                    }}
                  >
                    <Download className="size-4" /> 预览
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => onAddToChat?.([joinPath(path, active)])}
                  >
                    <PaperPlaneTilt className="size-4" /> 加入对话
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => setShareTarget(joinPath(path, active))}
                  >
                    <ShareNetwork className="size-4" /> 分享
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => void removeSelected()}
                    disabled={selectedPaths.length === 0}
                  >
                    <Trash className="size-4" /> 删除选中（{selectedPaths.length}）
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-ui-sm text-foreground-subtle">
                选中文件查看详情。删除会进回收站（仍占空间），彻底删除后才释放。
              </p>
            )}
          </aside>
        </div>

        {/* 分享弹窗 */}
        {shareTarget ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-4">
            <div className="w-96 space-y-3 rounded-xl border border-card-border bg-card p-4">
              <h3 className="text-ui-base font-semibold">分享 {shareTarget}</h3>
              <label className="block text-ui-sm">
                有效期（小时）
                <Input
                  type="number"
                  value={shareTtl}
                  min={1}
                  max={24 * 30}
                  onChange={(event) => setShareTtl(Number(event.currentTarget.value) || 24)}
                />
              </label>
              <label className="block text-ui-sm">
                提取码（可选）
                <Input value={sharePwd} onChange={(event) => setSharePwd(event.currentTarget.value)} />
              </label>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setShareTarget(null)}>
                  取消
                </Button>
                <Button size="sm" onClick={() => void createShare()}>
                  生成链接
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
