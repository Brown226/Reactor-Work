// 内容与能力 · 规范库（RUL）
//
// 为什么这页要存在：审查要能回答「你这条写法违反了什么」—— 依据就是**条文**（规范原文）
// 与**审点**（把条文转成"要审什么"的 prompt）。这份数据在核审通里叫 rule_libraries /
// rule_library_items，本期收敛成管理台「知识」板块的第三个子域。
//
// 页面是**两层资源**，所以用左右两栏（左库列表 / 右条文列表），而不是两页：
// 条文脱离库没有意义（幂等键就是 (库, 条文内容)），分开两页会让"给哪个库加条文"变成
// 需要来回跳转的状态。左栏选中态是本页唯一的"当前库"来源。
//
// 状态（draft/published/archived）不是装饰：**只有 published 的库会被消费面下发**
// （/v1/rule-libraries/:id/items）。草稿库还在编辑，端侧拿到半成品会让
// 「同一文件 + 同一库 = 同一结论」这条纪律失效，所以这里要能一眼看出库是否已发布。

import { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise,
  Plus,
  Trash,
  PencilSimple,
  UploadSimple,
  Stack,
} from "@phosphor-icons/react";
import { toast } from "../lib/toast";
import { Empty, PageHead, SkeletonRows } from "../ui";
import { ToneBadge } from "../components/reactor";
import type { Tone } from "../components/reactor";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import {
  RULE_LIBRARY_STATUS_LABELS,
  RULE_MANDATORY_LABELS,
  RULE_SEVERITY_LABELS,
  ruleLibrariesApi,
  type AdminRuleItem,
  type AdminRuleLibrary,
  type RuleItemInput,
  type RuleLibraryStatus,
  type RuleMandatory,
  type RuleSeverity,
} from "../services/ruleLibraries";

const ALL = "__all__";
const ITEM_PAGE_SIZE = 20;
const STATUS_TONE: Record<RuleLibraryStatus, Tone> = {
  draft: "warn",
  published: "success",
  archived: "neutral",
};
const SEVERITY_TONE: Record<RuleSeverity, Tone> = {
  error: "danger",
  warning: "warn",
  info: "info",
};

interface LibraryForm {
  name: string;
  description: string;
  standardNo: string;
  status: RuleLibraryStatus;
}

interface ItemForm {
  ruleCode: string;
  ruleName: string;
  category: string;
  clauseText: string;
  checkPrompt: string;
  severity: RuleSeverity;
  mandatory: RuleMandatory;
  sourceLocation: string;
  enabled: boolean;
}

const emptyItemForm: ItemForm = {
  ruleCode: "",
  ruleName: "",
  category: "",
  clauseText: "",
  checkPrompt: "",
  severity: "warning",
  mandatory: "mandatory",
  sourceLocation: "",
  enabled: true,
};

/** 条文摘要：表格里只给一行，避免长条文把行高撑开（全文在编辑弹窗里看）。 */
function brief(text: string | null, max = 60): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function RuleLibraries() {
  const [libraries, setLibraries] = useState<AdminRuleLibrary[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [libSearch, setLibSearch] = useState("");
  const [libQuery, setLibQuery] = useState("");
  const [libStatus, setLibStatus] = useState<RuleLibraryStatus | "">("");

  const [items, setItems] = useState<AdminRuleItem[] | null>(null);
  const [itemTotal, setItemTotal] = useState(0);
  const [itemPage, setItemPage] = useState(1);
  const [itemSearch, setItemSearch] = useState("");
  const [itemQuery, setItemQuery] = useState("");
  const [itemEnabled, setItemEnabled] = useState(ALL);
  const [categories, setCategories] = useState<{ value: string; count: number }[]>([]);
  const [itemCategory, setItemCategory] = useState(ALL);

  const [libraryForm, setLibraryForm] = useState<LibraryForm | null>(null);
  const [libraryEditId, setLibraryEditId] = useState<number | null>(null);
  const [itemForm, setItemForm] = useState<ItemForm | null>(null);
  const [itemEditId, setItemEditId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = libraries?.find((library) => library.id === selectedId) ?? null;

  const loadLibraries = useCallback(async () => {
    try {
      const result = await ruleLibrariesApi.list({
        search: libQuery,
        status: libStatus,
        sortOrder: "desc",
      });
      setLibraries(result.items);
      // 选中态用**函数式更新**从当前值推导，而不是读闭包里的 selectedId：
      // 读闭包会把 selectedId 拖进依赖，于是每次选中变化都重新拉一次库列表（并且又改选中，绕圈）。
      // 语义：还在列表里就保持，否则落到第一条 —— 删掉当前库后右栏不会停留在已不存在的库上。
      setSelectedId((current) =>
        result.items.some((item) => item.id === current) ? current : (result.items[0]?.id ?? null),
      );
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [libQuery, libStatus]);

  const loadItems = useCallback(
    async (libraryId: number, next: { page?: number } = {}) => {
      try {
        const targetPage = next.page ?? itemPage;
        const result = await ruleLibrariesApi.items(libraryId, {
          page: targetPage,
          pageSize: ITEM_PAGE_SIZE,
          search: itemQuery,
          enabled: itemEnabled === ALL ? undefined : itemEnabled === "true",
          category: itemCategory === ALL ? undefined : itemCategory,
        });
        setItems(result.items);
        setItemTotal(result.total);
        setItemPage(result.page);
        const cats = await ruleLibrariesApi.itemCategories(libraryId);
        setCategories(cats.items);
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [itemCategory, itemEnabled, itemPage, itemQuery],
  );

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  useEffect(() => {
    if (selectedId === null) {
      setItems([]);
      setItemTotal(0);
      setCategories([]);
      return;
    }
    void loadItems(selectedId);
  }, [selectedId, loadItems]);

  const handleLibSearch = useCallback(() => {
    setLibQuery(libSearch);
  }, [libSearch]);

  const handleItemSearch = useCallback(() => {
    setItemQuery(itemSearch);
    setItemPage(1);
  }, [itemSearch]);

  const handleOpenCreateLibrary = useCallback(() => {
    setLibraryEditId(null);
    setLibraryForm({ name: "", description: "", standardNo: "", status: "draft" });
  }, []);

  const handleOpenEditLibrary = useCallback((library: AdminRuleLibrary) => {
    setLibraryEditId(library.id);
    setLibraryForm({
      name: library.name,
      description: library.description ?? "",
      standardNo: library.standardNo ?? "",
      status: library.status,
    });
  }, []);

  const handleSubmitLibrary = useCallback(async () => {
    if (!libraryForm) return;
    const name = libraryForm.name.trim();
    if (!name) return toast.error("请输入规范库名称");
    const payload = {
      name,
      description: libraryForm.description.trim(),
      standardNo: libraryForm.standardNo.trim(),
      status: libraryForm.status,
    };
    setBusy(true);
    try {
      if (libraryEditId) {
        await ruleLibrariesApi.patch(libraryEditId, payload);
        toast.ok("保存成功");
      } else {
        const created = await ruleLibrariesApi.create(payload);
        toast.ok("新增成功");
        setSelectedId(created.id);
      }
      setLibraryForm(null);
      setLibraryEditId(null);
      // 重新拉一次列表：新建的库要出现、编辑过的名称/状态要刷新（左栏计数同理）。
      void loadLibraries();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [libraryEditId, libraryForm, loadLibraries]);

  const handleDeleteLibrary = useCallback(
    async (library: AdminRuleLibrary) => {
      const hint =
        library.itemCount > 0
          ? `该库下还有 ${library.itemCount} 条条文，会一并删除。`
          : "";
      if (!window.confirm(`确定要删除规范库 "${library.name}" 吗？${hint}此操作不可恢复。`)) return;
      try {
        const result = await ruleLibrariesApi.remove(library.id);
        toast.ok(`已删除规范库，连带 ${result.deletedItems} 条条文`);
        setSelectedId(null);
        void loadLibraries();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [loadLibraries],
  );

  const handleOpenCreateItem = useCallback(() => {
    setItemEditId(null);
    setItemForm({ ...emptyItemForm });
  }, []);

  const handleOpenEditItem = useCallback((row: AdminRuleItem) => {
    setItemEditId(row.id);
    setItemForm({
      ruleCode: row.ruleCode ?? "",
      ruleName: row.ruleName ?? "",
      category: row.category ?? "",
      clauseText: row.clauseText ?? "",
      checkPrompt: row.checkPrompt ?? "",
      severity: row.severity,
      mandatory: row.mandatory,
      sourceLocation: row.sourceLocation ?? "",
      enabled: row.enabled,
    });
  }, []);

  const handleSubmitItem = useCallback(async () => {
    if (!itemForm || selectedId === null) return;
    if (!itemForm.clauseText.trim() && !itemForm.ruleName.trim())
      return toast.error("条文与名称至少要填一个");
    const payload: RuleItemInput = {
      ruleCode: itemForm.ruleCode.trim(),
      ruleName: itemForm.ruleName.trim(),
      category: itemForm.category.trim(),
      clauseText: itemForm.clauseText.trim(),
      checkPrompt: itemForm.checkPrompt.trim(),
      severity: itemForm.severity,
      mandatory: itemForm.mandatory,
      sourceLocation: itemForm.sourceLocation.trim(),
      enabled: itemForm.enabled,
    };
    setBusy(true);
    try {
      if (itemEditId) {
        await ruleLibrariesApi.patchItem(selectedId, itemEditId, payload);
        toast.ok("保存成功");
      } else {
        await ruleLibrariesApi.createItem(selectedId, payload);
        toast.ok("新增成功");
      }
      setItemForm(null);
      setItemEditId(null);
      void loadItems(selectedId);
      void loadLibraries(); // 条目数会变，左栏计数要跟着更新
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [itemEditId, itemForm, loadItems, loadLibraries, selectedId]);

  const handleDeleteItem = useCallback(
    async (row: AdminRuleItem) => {
      if (selectedId === null) return;
      if (!window.confirm(`确定要删除条文 "${row.ruleCode ?? row.ruleName ?? row.clauseHash}" 吗？`))
        return;
      try {
        await ruleLibrariesApi.removeItem(selectedId, row.id);
        toast.ok("删除成功");
        void loadItems(selectedId);
        void loadLibraries();
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [loadItems, loadLibraries, selectedId],
  );

  const handleImportItems = useCallback(
    async (file: File | null) => {
      if (!file || selectedId === null) return;
      if (file.size > 32 * 1024 * 1024) {
        toast.error("JSON 文件过大（上限 32MB）");
        return;
      }
      setBusy(true);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const list = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { items?: unknown }).items)
            ? ((parsed as { items: unknown[] }).items as unknown[])
            : null;
        if (!list) throw new Error("JSON 必须是数组，或形如 { items: [...] }");
        const { inserted, received, skipped } = await ruleLibrariesApi.importItems(
          selectedId,
          list as RuleItemInput[],
        );
        toast.ok(`导入完成：新增 ${inserted} 条（收到 ${received}，内容重复跳过 ${skipped}）`);
        setItemPage(1);
        void loadItems(selectedId, { page: 1 });
        void loadLibraries();
      } catch (error) {
        toast.error((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [loadItems, loadLibraries, selectedId],
  );

  const itemTotalPages = Math.max(1, Math.ceil(itemTotal / ITEM_PAGE_SIZE));

  return (
    <div>
      <PageHead
        title="规范库"
        desc="条文与审点的管理库；只有「已发布」的库会被审查端拉取"
      />

      <div className="two-col">
        {/* ── 左：规范库 ── */}
        <section className="panel">
          <div className="panel-head">
            <h3>规范库</h3>
            <span className="sub">{libraries === null ? "加载中" : `${libraries.length} 个`}</span>
          </div>
          <div className="grid gap-2 p-2">
            <Input
              placeholder="搜索库名称或说明"
              value={libSearch}
              onChange={(event) => setLibSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleLibSearch();
              }}
            />
            <div className="flex gap-2">
              <Select
                value={libStatus || ALL}
                onValueChange={(value) => setLibStatus(value === ALL ? "" : (value as RuleLibraryStatus))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部状态</SelectItem>
                  {Object.entries(RULE_LIBRARY_STATUS_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={handleLibSearch}>
                搜索
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={busy}
              onClick={handleOpenCreateLibrary}
            >
              <Plus size={14} /> 新建规范库
            </Button>
          </div>
          <div className="grid gap-1 p-2 pt-0">
            {libraries === null ? (
              <SkeletonRows n={4} />
            ) : libraries.length === 0 ? (
              <div className="empty">
                <Stack size={22} />
                <div className="t">还没有规范库</div>
                <div className="s">新建一个库，再往里加条文</div>
              </div>
            ) : (
              libraries.map((library) => {
                const on = library.id === selectedId;
                return (
                  <button
                    key={library.id}
                    type="button"
                    onClick={() => setSelectedId(library.id)}
                    className={`flex w-full flex-col gap-1 rounded border p-2 text-left transition-colors ${
                      on
                        ? "border-foreground/40 bg-card-selected"
                        : "border-transparent hover:bg-surface-hover"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{library.name}</span>
                      <ToneBadge tone={STATUS_TONE[library.status]}>
                        {RULE_LIBRARY_STATUS_LABELS[library.status]}
                      </ToneBadge>
                    </span>
                    <span className="text-[11px] text-foreground-subtle">
                      {library.enabledItemCount} / {library.itemCount} 条启用
                      {library.standardNo ? ` · ${library.standardNo}` : ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* ── 右：条文/审点 ── */}
        <section>
          {selected === null ? (
            <div className="panel">
              <div className="empty">
                <Stack size={22} />
                <div className="t">选择左侧规范库查看条文</div>
              </div>
            </div>
          ) : (
            <>
              <div className="panel" style={{ marginBottom: 12 }}>
                <div className="panel-head">
                  <h3>{selected.name}</h3>
                  <span className="sub">
                    <ToneBadge tone={STATUS_TONE[selected.status]}>
                      {RULE_LIBRARY_STATUS_LABELS[selected.status]}
                    </ToneBadge>
                  </span>
                </div>
                <div className="p-2 text-[12px] text-foreground-subtle">
                  {selected.description || "（无说明）"}
                  {selected.standardNo ? ` · 关联标准 ${selected.standardNo}` : ""}
                  {selected.status !== "published"
                    ? " · 未发布，审查端不会拉取本库"
                    : ""}
                </div>
                <div className="toolbar" style={{ marginTop: 0, marginBottom: 8 }}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => handleOpenEditLibrary(selected)}
                  >
                    <PencilSimple size={14} /> 编辑库
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-destructive"
                    onClick={() => void handleDeleteLibrary(selected)}
                  >
                    <Trash size={14} /> 删除库
                  </Button>
                </div>
              </div>

              <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
                <Input
                  placeholder="搜索编号/名称/条文/prompt"
                  value={itemSearch}
                  onChange={(event) => setItemSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleItemSearch();
                  }}
                  className="w-[220px]"
                />
                <Select
                  value={itemCategory || ALL}
                  onValueChange={(value) => {
                    setItemCategory(value);
                    setItemPage(1);
                  }}
                >
                  <SelectTrigger className="w-[150px]">
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
                <Select
                  value={itemEnabled}
                  onValueChange={(value) => {
                    setItemEnabled(value);
                    setItemPage(1);
                  }}
                >
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>全部条目</SelectItem>
                    <SelectItem value="true">仅启用</SelectItem>
                    <SelectItem value="false">仅停用</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={handleItemSearch}>
                  搜索
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => void loadItems(selected.id)}
                >
                  <ArrowClockwise size={14} /> 刷新
                </Button>

                <div className="spacer" />
                <ToneBadge tone="info">共 {itemTotal} 条</ToneBadge>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={handleOpenCreateItem}
                >
                  <Plus size={14} /> 新增条文
                </Button>
                <label className="inline-flex cursor-pointer items-center gap-2">
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(event) => {
                      void handleImportItems(event.target.files?.[0] ?? null);
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
                      <TableHead className="w-[130px]">编号</TableHead>
                      <TableHead className="w-[180px]">名称</TableHead>
                      <TableHead>条文</TableHead>
                      <TableHead className="w-[100px]">分类</TableHead>
                      <TableHead className="w-[80px]">严重度</TableHead>
                      <TableHead className="w-[80px]">强制性</TableHead>
                      <TableHead className="w-[70px]">启用</TableHead>
                      <TableHead className="w-[150px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items === null ? (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <SkeletonRows />
                        </TableCell>
                      </TableRow>
                    ) : items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8}>
                          <Empty title="该库下还没有条文" desc="可以新增，或导入 JSON 清单" />
                        </TableCell>
                      </TableRow>
                    ) : (
                      items.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{row.ruleCode ?? "—"}</TableCell>
                          <TableCell>{row.ruleName ?? "—"}</TableCell>
                          <TableCell title={row.clauseText ?? undefined}>
                            {brief(row.clauseText)}
                          </TableCell>
                          <TableCell>{row.category ?? "—"}</TableCell>
                          <TableCell>
                            <ToneBadge tone={SEVERITY_TONE[row.severity]}>
                              {RULE_SEVERITY_LABELS[row.severity]}
                            </ToneBadge>
                          </TableCell>
                          <TableCell>{RULE_MANDATORY_LABELS[row.mandatory]}</TableCell>
                          <TableCell>
                            {row.enabled ? (
                              <ToneBadge tone="success">启用</ToneBadge>
                            ) : (
                              <ToneBadge tone="neutral">停用</ToneBadge>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1.5"
                                onClick={() => handleOpenEditItem(row)}
                              >
                                <PencilSimple size={14} /> 编辑
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1.5 text-destructive"
                                onClick={() => void handleDeleteItem(row)}
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
                  第 {itemPage} / {itemTotalPages} 页
                </span>
                <div className="spacer" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={itemPage <= 1}
                  onClick={() => void loadItems(selected.id, { page: itemPage - 1 })}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={itemPage >= itemTotalPages}
                  onClick={() => void loadItems(selected.id, { page: itemPage + 1 })}
                >
                  下一页
                </Button>
              </div>
            </>
          )}
        </section>
      </div>

      {/* 规范库弹窗 */}
      <Dialog
        open={libraryForm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLibraryForm(null);
            setLibraryEditId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{libraryEditId ? "编辑规范库" : "新建规范库"}</DialogTitle>
          </DialogHeader>
          {libraryForm ? (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="lib-name">名称</Label>
                <Input
                  id="lib-name"
                  value={libraryForm.name}
                  onChange={(event) =>
                    setLibraryForm({ ...libraryForm, name: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lib-standard">关联标准编号（可选）</Label>
                <Input
                  id="lib-standard"
                  placeholder="GB 50974-2014"
                  value={libraryForm.standardNo}
                  onChange={(event) =>
                    setLibraryForm({ ...libraryForm, standardNo: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lib-status">状态</Label>
                <Select
                  value={libraryForm.status}
                  onValueChange={(value) =>
                    setLibraryForm({ ...libraryForm, status: value as RuleLibraryStatus })
                  }
                >
                  <SelectTrigger id="lib-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(RULE_LIBRARY_STATUS_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-foreground-subtle">
                  只有「已发布」的库会被审查端拉取
                </span>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="lib-desc">说明</Label>
                <Textarea
                  id="lib-desc"
                  rows={3}
                  value={libraryForm.description}
                  onChange={(event) =>
                    setLibraryForm({ ...libraryForm, description: event.target.value })
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLibraryForm(null);
                setLibraryEditId(null);
              }}
            >
              取消
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void handleSubmitLibrary()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 条文弹窗 */}
      <Dialog
        open={itemForm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setItemForm(null);
            setItemEditId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{itemEditId ? "编辑条文" : "新增条文"}</DialogTitle>
          </DialogHeader>
          {itemForm ? (
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="item-code">编号</Label>
                  <Input
                    id="item-code"
                    value={itemForm.ruleCode}
                    onChange={(event) => setItemForm({ ...itemForm, ruleCode: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="item-name">名称</Label>
                  <Input
                    id="item-name"
                    value={itemForm.ruleName}
                    onChange={(event) => setItemForm({ ...itemForm, ruleName: event.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="item-clause">条文原文</Label>
                <Textarea
                  id="item-clause"
                  rows={4}
                  value={itemForm.clauseText}
                  onChange={(event) =>
                    setItemForm({ ...itemForm, clauseText: event.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="item-prompt">判定 prompt（审点）</Label>
                <Textarea
                  id="item-prompt"
                  rows={3}
                  value={itemForm.checkPrompt}
                  onChange={(event) =>
                    setItemForm({ ...itemForm, checkPrompt: event.target.value })
                  }
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="item-category">分类</Label>
                  <Input
                    id="item-category"
                    value={itemForm.category}
                    onChange={(event) =>
                      setItemForm({ ...itemForm, category: event.target.value })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="item-severity">严重度</Label>
                  <Select
                    value={itemForm.severity}
                    onValueChange={(value) =>
                      setItemForm({ ...itemForm, severity: value as RuleSeverity })
                    }
                  >
                    <SelectTrigger id="item-severity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(RULE_SEVERITY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="item-mandatory">强制性</Label>
                  <Select
                    value={itemForm.mandatory}
                    onValueChange={(value) =>
                      setItemForm({ ...itemForm, mandatory: value as RuleMandatory })
                    }
                  >
                    <SelectTrigger id="item-mandatory">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(RULE_MANDATORY_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="item-location">出处位置（可选）</Label>
                <Input
                  id="item-location"
                  placeholder="第 5.2.3 条"
                  value={itemForm.sourceLocation}
                  onChange={(event) =>
                    setItemForm({ ...itemForm, sourceLocation: event.target.value })
                  }
                />
              </div>
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={itemForm.enabled}
                  onChange={(event) =>
                    setItemForm({ ...itemForm, enabled: event.target.checked })
                  }
                />
                启用（停用的条文不会下发到审查端）
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setItemForm(null);
                setItemEditId(null);
              }}
            >
              取消
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void handleSubmitItem()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
