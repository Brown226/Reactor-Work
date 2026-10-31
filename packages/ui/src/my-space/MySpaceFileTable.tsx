/**
 * 我的空间：文件列表（含搜索结果视图）。
 *
 * 视觉对齐工作区：文件图标复用 `lib/fileDisplay`，行悬停/选中用 `bg-surface-hover` /
 * `bg-selected`，表头 sticky。单行只做「选中 + 预览」，目录名是单独的按钮——
 * 目录点名字进入、点行选中，和文件行的行为不会互相打架。
 */
import { ChevronRight, FolderOpen, Upload } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MySpaceEmptyState } from "./MySpaceEmptyState.js";
import { formatBytes, type SpaceEntriesResult, type SpaceEntry } from "./spaceClient.js";
import { formatSpaceWhen, spaceFileIconSrc } from "./spaceFileType.js";

export interface SpaceSearchHit {
  path: string;
  entry: SpaceEntry;
}

export interface MySpaceFileTableProps {
  path: string;
  data: SpaceEntriesResult | null;
  loading: boolean;
  selected: Set<string>;
  active: string | null;
  searchResults: SpaceSearchHit[] | null;
  query: string;
  onNavigate: (path: string) => void;
  onToggleSelect: (name: string) => void;
  onToggleSelectAll: (checked: boolean) => void;
  onOpenDirectory: (name: string) => void;
  onActivate: (name: string) => void;
  onOpenSearchHit: (hit: SpaceSearchHit) => void;
  onDropFiles: (files: FileList) => void;
  onUpload: () => void;
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const { intl } = useZCodeIntl();
  const parts = path.split("/").filter(Boolean);
  return (
    <nav
      aria-label={intl.formatMessage({ id: "mySpace.tab.files" })}
      className="flex min-w-0 items-center gap-0.5"
    >
      <button
        type="button"
        onClick={() => onNavigate("")}
        className={cn(
          "shrink-0 rounded-md px-1.5 py-0.5 text-ui-sm text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground",
          parts.length === 0 && "text-foreground",
        )}
      >
        {intl.formatMessage({ id: "mySpace.root" })}
      </button>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join("/");
        const isLast = index === parts.length - 1;
        return (
          <span key={target} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className={cn(
                "min-w-0 truncate rounded-md px-1.5 py-0.5 text-ui-sm transition-colors hover:bg-hover hover:text-foreground",
                isLast ? "text-foreground" : "text-foreground-subtle",
              )}
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function FileRow({
  entry,
  name,
  active,
  selected,
  onToggleSelect,
  onActivate,
  onOpenDirectory,
  extra,
}: {
  entry: SpaceEntry;
  name: string;
  active: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onActivate: () => void;
  onOpenDirectory?: () => void;
  extra?: string;
}) {
  return (
    <tr
      tabIndex={0}
      aria-selected={active}
      onClick={onActivate}
      onDoubleClick={() => {
        if (entry.kind === "directory") onOpenDirectory?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && entry.kind === "directory") onOpenDirectory?.();
      }}
      className={cn(
        "group cursor-default border-b border-border/60 outline-none last:border-0",
        "hover:bg-surface-hover focus-visible:bg-surface-hover",
        selected || active ? "bg-selected" : "",
      )}
    >
      <td className="w-9 pl-3 align-middle">
        <Checkbox
          checked={selected}
          aria-label={name}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onToggleSelect}
        />
      </td>
      <td className="min-w-0 py-1.5 pr-3 align-middle">
        <div className="flex min-w-0 items-center gap-2">
          <FileDisplayIcon
            src={spaceFileIconSrc(name, entry.kind)}
            size={16}
            className="shrink-0"
          />
          {entry.kind === "directory" && onOpenDirectory ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenDirectory();
              }}
              className="min-w-0 truncate rounded-sm text-left text-ui-base text-foreground hover:underline"
              title={name}
            >
              {name}
            </button>
          ) : (
            <span className="min-w-0 truncate text-ui-base text-foreground" title={name}>
              {name}
            </span>
          )}
          {extra ? (
            <span
              className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtlest"
              title={extra}
            >
              {extra}
            </span>
          ) : null}
        </div>
      </td>
      <td className="w-24 py-1.5 pr-3 text-right align-middle font-mono text-ui-sm text-foreground-subtle">
        {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
      </td>
      <td className="w-36 py-1.5 pr-3 text-right align-middle text-ui-sm text-foreground-subtle">
        <span title={new Date(entry.mtime).toLocaleString()}>{formatSpaceWhen(entry.mtime)}</span>
      </td>
    </tr>
  );
}

function TableHead({
  allSelected,
  someSelected,
  onToggleAll,
}: {
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <thead className="sticky top-0 z-10 bg-card">
      <tr className="border-b border-border text-ui-xs text-foreground-subtle">
        <th className="w-9 py-2 pl-3 text-left font-normal">
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(value) => onToggleAll(value === true)}
            aria-label={intl.formatMessage({ id: "mySpace.column.name" })}
          />
        </th>
        <th className="py-2 pr-3 text-left font-normal">
          {intl.formatMessage({ id: "mySpace.column.name" })}
        </th>
        <th className="w-24 py-2 pr-3 text-right font-normal">
          {intl.formatMessage({ id: "mySpace.column.size" })}
        </th>
        <th className="w-36 py-2 pr-3 text-right font-normal">
          {intl.formatMessage({ id: "mySpace.column.modified" })}
        </th>
      </tr>
    </thead>
  );
}

export function MySpaceFileTable({
  path,
  data,
  loading,
  selected,
  active,
  searchResults,
  query,
  onNavigate,
  onToggleSelect,
  onToggleSelectAll,
  onOpenDirectory,
  onActivate,
  onOpenSearchHit,
  onDropFiles,
  onUpload,
}: MySpaceFileTableProps) {
  const { intl } = useZCodeIntl();
  const entries = data?.entries ?? [];
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.name));
  const someSelected = entries.some((entry) => selected.has(entry.name));

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        {searchResults === null ? (
          <Breadcrumb path={path} onNavigate={onNavigate} />
        ) : (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "mySpace.search.result" },
              { query: query.trim(), count: searchResults.length },
            )}
          </span>
        )}
        <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtlest">
          {searchResults === null
            ? intl.formatMessage({ id: "mySpace.list.itemCount" }, { count: entries.length })
            : null}
        </span>
        {selected.size > 0 ? (
          <span className="shrink-0 rounded-md bg-selected px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "mySpace.list.selectedCount" }, { count: selected.size })}
          </span>
        ) : null}
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length > 0) onDropFiles(event.dataTransfer.files);
        }}
      >
        {loading ? (
          <div className="space-y-2 p-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-8 animate-pulse rounded-md bg-surface" />
            ))}
          </div>
        ) : searchResults !== null ? (
          searchResults.length === 0 ? (
            <MySpaceEmptyState
              title={intl.formatMessage({ id: "mySpace.search.empty" })}
              body={intl.formatMessage({ id: "mySpace.empty.files.body" })}
            />
          ) : (
            <table className="w-full table-fixed border-collapse">
              <TableHead allSelected={false} someSelected={false} onToggleAll={() => undefined} />
              <tbody>
                {searchResults.map((hit) => {
                  const dir = hit.path.includes("/")
                    ? hit.path.slice(0, hit.path.lastIndexOf("/"))
                    : "";
                  return (
                    <tr
                      key={hit.path}
                      tabIndex={0}
                      onClick={() => onOpenSearchHit(hit)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onOpenSearchHit(hit);
                      }}
                      className="cursor-pointer border-b border-border/60 outline-none last:border-0 hover:bg-surface-hover focus-visible:bg-surface-hover"
                    >
                      <td className="w-9 pl-3 align-middle">
                        <FileDisplayIcon
                          src={spaceFileIconSrc(hit.entry.name, hit.entry.kind)}
                          size={16}
                        />
                      </td>
                      <td colSpan={2} className="min-w-0 py-1.5 pr-3 align-middle">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 shrink truncate text-ui-base text-foreground">
                            {hit.entry.name}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtlest">
                            {dir || "/"}
                          </span>
                        </div>
                      </td>
                      <td className="w-24 py-1.5 pr-3 text-right align-middle font-mono text-ui-sm text-foreground-subtle">
                        {hit.entry.kind === "directory" ? "—" : formatBytes(hit.entry.size)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : entries.length === 0 ? (
          <MySpaceEmptyState
            icon={<FolderOpen className="size-5" />}
            title={intl.formatMessage({ id: "mySpace.empty.files.title" })}
            body={intl.formatMessage({ id: "mySpace.empty.files.body" })}
            action={
              <Button size="sm" onClick={onUpload}>
                <Upload className="mr-1.5 size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "mySpace.action.upload" })}
              </Button>
            }
          />
        ) : (
          <table className="w-full table-fixed border-collapse">
            <TableHead
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleAll={onToggleSelectAll}
            />
            <tbody>
              {entries.map((entry) => (
                <FileRow
                  key={entry.name}
                  entry={entry}
                  name={entry.name}
                  active={active === entry.name}
                  selected={selected.has(entry.name)}
                  onToggleSelect={() => onToggleSelect(entry.name)}
                  onActivate={() => onActivate(entry.name)}
                  onOpenDirectory={() => onOpenDirectory(entry.name)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
