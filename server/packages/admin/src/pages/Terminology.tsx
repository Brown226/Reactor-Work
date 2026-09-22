// 内容与能力 · 术语白名单（TRM）
//
// 为什么这页要存在：审查要先把「安全壳 / 一回路 / 常规岛」这类专业词从错别字候选里排除，
// 否则一份核岛设计说明会被报出满屏误报。白名单就是这张排除表，属于**治理数据**，
// 只由管理员维护（走 /admin/terminology/*）；端侧执行审查时全量拉走进内存 Set（/v1/terminology/index），
// 与本页无关，普通用户看不到任何入口。
//
// 与标准清单一页的差别只有两处：
//  ① 数据量小（112 内置 + 人工补充），不需要分页器以外的东西，但**分类分面**要有，
//     因为白名单是按专业维护的（核安全/设备/工艺/建筑/电气）；
//  ② 内置词条不可删除 —— 用 `isBuiltin` 控制按钮禁用，服务端也会拒绝（两道都要有，
//     前端禁用只是提示，服务端才是规则）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, Plus, Trash, PencilSimple, UploadSimple } from "@phosphor-icons/react";
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
  splitAliases,
  terminologyApi,
  type AdminTerm,
  type TermInput,
  type TermListQuery,
} from "../services/terminology";

const ALL = "__all__";
const PAGE_SIZE = 20;

interface EditForm {
  term: string;
  category: string;
  aliases: string;
}

export function Terminology() {
  const [rows, setRows] = useState<AdminTerm[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  const [categories, setCategories] = useState<{ value: string; count: number }[]>([]);
  const [defaultCategories, setDefaultCategories] = useState<string[]>([]);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (next: Partial<TermListQuery> = {}) => {
      setLoading(true);
      try {
        const base: TermListQuery = { page, pageSize: PAGE_SIZE, search: query, category };
        const result = await terminologyApi.list({ ...base, ...next });
        setRows(result.items);
        setTotal(result.total);
        setPage(result.page);
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [category, page, query],
  );

  const loadCategories = useCallback(async () => {
    try {
      const result = await terminologyApi.categories();
      setCategories(result.items);
      setDefaultCategories(result.defaults);
    } catch {
      /* 分类只影响筛选下拉，拉失败不该打断主列表 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const handleSearch = useCallback(() => {
    setQuery(search);
    setPage(1);
  }, [search]);

  const handleReset = useCallback(() => {
    setSearch("");
    setQuery("");
    setCategory(ALL);
    setPage(1);
  }, []);

  const handleOpenCreate = useCallback(() => {
    setEditId(null);
    setEditForm({ term: "", category: "自定义", aliases: "" });
  }, []);

  const handleOpenEdit = useCallback((row: AdminTerm) => {
    setEditId(row.id);
    // 别名在库里是逗号分隔单列，编辑框直接显示原文：不在这里做"标签化"转换，
    // 免得用户改一个标点就被重排成另一串（写回时服务端会重新归一）。
    setEditForm({ term: row.term, category: row.category, aliases: row.aliases ?? "" });
  }, []);

  const handleDelete = useCallback(
    async (row: AdminTerm) => {
      if (!window.confirm(`确定要删除术语 "${row.term}" 吗？此操作不可恢复。`)) return;
      try {
        await terminologyApi.remove(row.id);
        toast.ok("删除成功");
        void load();
        void loadCategories();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [load, loadCategories],
  );

  const handleSubmit = useCallback(async () => {
    if (!editForm) return;
    const term = editForm.term.trim();
    if (!term) return toast.error("请输入术语");
    const payload: TermInput = {
      term,
      category: editForm.category,
      aliases: editForm.aliases.trim(),
    };
    setBusy(true);
    try {
      if (editId) {
        await terminologyApi.patch(editId, payload);
        toast.ok("保存成功");
      } else {
        await terminologyApi.create(payload);
        toast.ok("新增成功");
      }
      setEditForm(null);
      setEditId(null);
      void load();
      void loadCategories();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [editForm, editId, load, loadCategories]);

  const handleImportFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (file.size > 16 * 1024 * 1024) {
        toast.error("JSON 文件过大（上限 16MB）");
        return;
      }
      setBusy(true);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const items = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { items?: unknown }).items)
            ? ((parsed as { items: unknown[] }).items as unknown[])
            : null;
        if (!items) throw new Error("JSON 必须是数组，或形如 { items: [...] }");
        const { inserted, received, skipped } = await terminologyApi.import(
          items as TermInput[],
        );
        toast.ok(`导入完成：新增 ${inserted} 条（收到 ${received}，已存在跳过 ${skipped}）`);
        setPage(1);
        void load({ page: 1 });
        void loadCategories();
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load, loadCategories],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const categoryOptions = useMemo(() => {
    // 下拉要能选到**尚无词条的分类**（默认分类来自服务端），否则新分类永远建不出来。
    const merged = new Map<string, number>();
    for (const value of defaultCategories) merged.set(value, 0);
    for (const item of categories) merged.set(item.value, item.count);
    return [...merged.entries()].map(([value, count]) => ({ value, count }));
  }, [categories, defaultCategories]);

  return (
    <div>
      <PageHead
        title="术语白名单"
        desc="审查时命中即忽略的专业术语；内置词条不可删除，可按专业补充"
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <Input
          placeholder="搜索术语或别名"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSearch();
          }}
          className="w-[200px]"
        />
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
            {categoryOptions.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.value}
                {item.count > 0 ? `（${item.count}）` : ""}
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
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={handleOpenCreate}>
          <Plus size={14} /> 新增术语
        </Button>
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
      </div>

      <div className="tablewrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">术语</TableHead>
              <TableHead>别名</TableHead>
              <TableHead className="w-[140px]">分类</TableHead>
              <TableHead className="w-[100px]">来源</TableHead>
              <TableHead className="w-[150px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows === null ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <SkeletonRows />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-foreground-subtle">
                  没有匹配的术语
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.term}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {splitAliases(row.aliases).length === 0 ? (
                        <span className="text-foreground-subtle">—</span>
                      ) : (
                        splitAliases(row.aliases).map((alias) => (
                          <span
                            key={alias}
                            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground-subtle"
                          >
                            {alias}
                          </span>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{row.category}</TableCell>
                  <TableCell>
                    {/* 来源不是权限以外的信息：内置=随版本 seed，删除会被服务端拒绝 */}
                    {row.isBuiltin ? (
                      <ToneBadge tone="neutral">内置</ToneBadge>
                    ) : (
                      <ToneBadge tone="success">自定义</ToneBadge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5"
                        onClick={() => handleOpenEdit(row)}
                      >
                        <PencilSimple size={14} /> 编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1.5 text-destructive"
                        disabled={row.isBuiltin}
                        title={row.isBuiltin ? "内置术语不可删除（可改分类或别名）" : undefined}
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
        <span className="text-foreground-subtle">
          第 {page} / {totalPages} 页
        </span>
        <div className="spacer" />
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1 || loading}
          onClick={() => void load({ page: page - 1 })}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= totalPages || loading}
          onClick={() => void load({ page: page + 1 })}
        >
          下一页
        </Button>
      </div>

      <Dialog
        open={editForm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditForm(null);
            setEditId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? "编辑术语" : "新增术语"}</DialogTitle>
          </DialogHeader>
          {editForm ? (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="term">术语</Label>
                <Input
                  id="term"
                  value={editForm.term}
                  onChange={(event) => setEditForm({ ...editForm, term: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="category">分类</Label>
                <Select
                  value={editForm.category}
                  onValueChange={(value) => setEditForm({ ...editForm, category: value })}
                >
                  <SelectTrigger id="category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="aliases">别名（逗号分隔）</Label>
                <Input
                  id="aliases"
                  value={editForm.aliases}
                  placeholder="containment,安全壳厂房"
                  onChange={(event) => setEditForm({ ...editForm, aliases: event.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditForm(null);
                setEditId(null);
              }}
            >
              取消
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void handleSubmit()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
