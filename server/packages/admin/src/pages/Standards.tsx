// 内容与能力 · 标准规范清单（STD）
//
// 为什么这页要存在：文件审查的「标准引用自检」是一条**确定性**链路 —— 把文档里引用的标准
// 拿到标准库里比对编号/名称/状态/版本年份（零 LLM）。这条链路的输入是**治理数据**，
// 必须由管理员维护，而不是让用户各自上传（原核审通的「临时标准库」就是为此被砍掉的，
// 见 docs/审查板块-方案-v1.md §4.4.1）。所以：管理入口只在管理台，普通用户看不到任何入口，
// 但审查执行时能读（走 /v1/standards/index，与本页无关）。
//
// 页面结构照原核审通 LocalStandardTab 的形状复刻：工具条（搜索/筛选/动作）→ 表格 → 分页。
// 差别有三处：
//  1. 不做「展开行编辑标准全文」：标准全文（Standard.content）不进自检链路，也不该进管理台；
//  2. 导入是 **JSON** 不是 multipart：一次性迁移用运维脚本提交，不为它引入 exceljs；
//  3. 分页是服务端的（13k+ 行不能拉全量），排序/筛选一律走 query 参数。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Trash, PencilSimple, UploadSimple } from "@phosphor-icons/react";
import { toast } from "../lib/toast";
import { PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  STANDARD_STATUS_LABELS,
  standardsApi,
  type AdminStandard,
  type StandardImportItem,
  type StandardListQuery,
  type StandardStatus,
} from "../services/standards";

const ALL = "__all__";
const PAGE_SIZE = 20;
const STATUS_TONE = {
  current: "success",
  upcoming: "warn",
  abolished: "neutral",
  unknown: "neutral",
} as const;

interface EditForm {
  standardNo: string;
  standardName: string;
  status: StandardStatus;
  publishDate: string;
  implementDate: string;
  abolishDate: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

/** 日期统一回落空串：服务端把 null 当"清空日期"处理，不能发 undefined（那表示"不改"）。 */
const dateOrEmpty = (value: string): string => value;

export function Standards() {
  const [rows, setRows] = useState<AdminStandard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StandardStatus | "">("");
  const [category, setCategory] = useState(ALL);
  const [categories, setCategories] = useState<{ value: string; count: number }[]>([]);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (next: Partial<StandardListQuery> = {}) => {
      setLoading(true);
      try {
        const list: StandardListQuery = { page, pageSize: PAGE_SIZE, search: query, status, category };
        const params = { ...list, page: next.page ?? page, ...next };
        if (params.category === ALL) params.category = "";
        const result = await standardsApi.list(params);
        setRows(result.items);
        setTotal(result.total);
        setPage(result.page);
      } catch (error) {
        toast.error((error as Error).message);
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [page, query, status, category],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void standardsApi
      .categories()
      .then((result) => setCategories(result.items))
      .catch(() => setCategories([]));
  }, []);

  const handleSearch = useCallback(() => {
    setQuery(search.trim());
    setPage(1);
    // 直接改 query 会让 effect 重新拉；这里只在 Enter/点击时提交。
  }, [search]);

  const handleReset = useCallback(() => {
    setSearch("");
    setQuery("");
    setStatus("");
    setCategory(ALL);
    setPage(1);
  }, []);

  const handleEdit = useCallback((row: AdminStandard) => {
    setEditId(row.id);
    setEditForm({
      standardNo: row.standardNo,
      standardName: row.standardName,
      status: row.status,
      publishDate: row.publishDate ?? "",
      implementDate: row.implementDate ?? "",
      abolishDate: row.abolishDate ?? "",
    });
  }, []);

  const handleDelete = useCallback(
    async (row: AdminStandard) => {
      if (!window.confirm(`确定要删除标准 "${row.standardNo}" 吗？此操作不可恢复。`)) return;
      try {
        await standardsApi.remove(row.id);
        toast.ok("删除成功");
        void load();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [load],
  );

  const handleClear = useCallback(async () => {
    if (!window.confirm(`确定要清空所有标准数据（共 ${total} 条）吗？此操作不可恢复！建议先导出备份。`))
      return;
    try {
      const { cleared } = await standardsApi.clear();
      toast.ok(`已清空 ${cleared} 条标准数据`);
      setPage(1);
      void load({ page: 1 });
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [load, total]);

  const handleImportFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (file.size > 64 * 1024 * 1024) {
        toast.error("JSON 文件过大（上限 64MB）");
        return;
      }
      setBusy(true);
      try {
        const text = await file.text();
        const parsed: unknown = JSON.parse(text);
        const items = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { items?: unknown }).items)
            ? ((parsed as { items: unknown[] }).items as unknown[])
            : null;
        if (!items) throw new Error("JSON 必须是数组，或形如 { items: [...] }");
        const normalized = items.map((entry) => entry as StandardImportItem);
        const { inserted, received, skipped } = await standardsApi.import(normalized);
        toast.ok(`导入完成：新增 ${inserted} 条（收到 ${received}，已存在跳过 ${skipped}）`);
        setPage(1);
        void load({ page: 1 });
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const handleSubmitEdit = useCallback(async () => {
    if (!editId || !editForm) return;
    if (!editForm.standardNo.trim()) return toast.error("请输入标准编号");
    if (!editForm.standardName.trim()) return toast.error("请输入标准名称");
    setBusy(true);
    try {
      await standardsApi.patch(editId, {
        standardNo: editForm.standardNo.trim(),
        standardName: editForm.standardName.trim(),
        status: editForm.status,
        publishDate: dateOrEmpty(editForm.publishDate),
        implementDate: dateOrEmpty(editForm.implementDate),
        abolishDate: dateOrEmpty(editForm.abolishDate),
      });
      toast.ok("保存成功");
      setEditForm(null);
      setEditId(null);
      void load();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [editForm, editId, load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const statusOptions = useMemo(
    () =>
      Object.entries(STANDARD_STATUS_LABELS).map(([value, label]) => ({
        value: value as StandardStatus,
        label,
      })),
    [],
  );

  return (
    <div>
      <PageHead title="标准清单" desc="文件审查「标准引用自检」的比对依据；导入后按分页搜索与编辑" />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <Input
          placeholder="搜索标准编号或名称"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSearch();
          }}
          className="w-[220px]"
        />
        <Select
          value={status || ALL}
          onValueChange={(value) => {
            setStatus(value === ALL ? "" : (value as StandardStatus));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={category || ALL}
          onValueChange={(value) => {
            setCategory(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部分类</SelectItem>
            {categories.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.value}（{item.count}）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={handleSearch} disabled={loading}>
          搜索
        </Button>
        <Button size="sm" variant="outline" onClick={handleReset}>
          重置
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void load()}>
          <ArrowClockwise size={14} /> 刷新
        </Button>

        <div className="spacer" />
        <ToneBadge tone="info">共 {total} 条</ToneBadge>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              void handleImportFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} asChild>
            <span>
              <UploadSimple size={14} /> 导入 JSON
            </span>
          </Button>
        </label>
        <Button size="sm" variant="outline" className="gap-1.5 text-destructive" disabled={busy} onClick={() => void handleClear()}>
          <Trash size={14} /> 清空数据
        </Button>
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">标准编号</TableHead>
              <TableHead>标准名称</TableHead>
              <TableHead className="w-[90px]">标识符</TableHead>
              <TableHead className="w-[100px]">状态</TableHead>
              <TableHead className="w-[90px]">归类</TableHead>
              <TableHead className="w-[120px]">发布日期</TableHead>
              <TableHead className="w-[120px]">实施日期</TableHead>
              <TableHead className="w-[150px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <SkeletonRows />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <div className="empty">
                    <div className="t">没有匹配的标准</div>
                    <div className="s">调整搜索或筛选条件，或导入标准清单 JSON</div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono font-semibold">{row.standardNo}</TableCell>
                  <TableCell className="max-w-[420px] truncate" title={row.standardName}>
                    {row.standardName}
                  </TableCell>
                  <TableCell>
                    <ToneBadge tone="neutral">{row.ident ?? "—"}</ToneBadge>
                  </TableCell>
                  <TableCell>
                    <ToneBadge tone={STATUS_TONE[row.status]}>{STANDARD_STATUS_LABELS[row.status]}</ToneBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.category ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatDate(row.publishDate)}</TableCell>
                  <TableCell className="tabular-nums">{formatDate(row.implementDate)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        onClick={() => handleEdit(row)}
                      >
                        <PencilSimple size={14} /> 编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 text-destructive"
                        onClick={() => void handleDelete(row)}
                      >
                        <Trash size={14} /> 删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="cell-sub">
          共 {total} 条 · 第 {rows === null || total === 0 ? 0 : page} / {totalPages} 页
        </span>
        <div className="spacer" />
        <Button
          size="sm"
          variant="outline"
          disabled={loading || page <= 1}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={loading || page >= totalPages}
          onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
        >
          下一页
        </Button>
      </div>

      <Dialog open={editForm !== null} onOpenChange={(open) => !open && setEditForm(null)}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>编辑标准</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="standard-no">标准编号</Label>
              <Input
                id="standard-no"
                placeholder="如 GB/T 50001-2017"
                value={editForm?.standardNo ?? ""}
                onChange={(event) =>
                  setEditForm((form) => (form ? { ...form, standardNo: event.target.value } : form))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="standard-name">标准名称</Label>
              <Input
                id="standard-name"
                placeholder="请输入标准名称"
                value={editForm?.standardName ?? ""}
                onChange={(event) =>
                  setEditForm((form) => (form ? { ...form, standardName: event.target.value } : form))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>状态</Label>
              <Select
                value={editForm?.status ?? "current"}
                onValueChange={(value) =>
                  setEditForm((form) => (form ? { ...form, status: value as StandardStatus } : form))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {(
                [
                  ["publishDate", "发布日期"],
                  ["implementDate", "实施日期"],
                  ["abolishDate", "废止日期"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={key}>{label}</Label>
                  <Input
                    id={key}
                    type="date"
                    value={editForm?.[key] ?? ""}
                    onChange={(event) =>
                      setEditForm((form) => (form ? { ...form, [key]: event.target.value } : form))
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditForm(null)}>
              取消
            </Button>
            <Button onClick={() => void handleSubmitEdit()} disabled={busy}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
