// 组织与用户（合并页）：**左部门树 + 右该层级的用户列表**（用户口径 2026-09-19）。
//
// 决定与口径见 docs/实施计划/管理台-组织与用户合并-规划-v1.md：
//   D1 菜单合一为「组织与用户」（/users 重定向到本页，D3）
//   D2 默认选中根节点；**根节点恒为整棵子树**（「含下级成员」开关开启且禁用），非根节点默认只看直接成员
//   §8 树上数字：根节点那一行=含下级总数，其余=直接归属数（`rootBadge="subtree"`）
//   D6 两块的可见性由 `blocksFor(role)` 决定 —— 只有「看用户」权限的人不该看到组织运维按钮
//   D7 选中态写进 URL：`/org?dept=<id>&sub=0|1`（刷新保持、可分享）
//
// 为什么把口径做成**导出的纯函数**（blocksFor / deptIdsFor / findDept / SubtreeSwitch）：
// 页面数据全靠 effect 拉取，SSR 探针拿不到「树已到」的那次渲染 —— 与其为了可测性把组件改成收 props，
// 不如把判断抽成纯函数，让探针直接钉住矩阵（t194 的 `toDashboardData` 同一手法）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Copy,
  DotsThree,
  Eye,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { useAuthStore } from "../stores/auth";
import { deptsApi, syncApi, usersApi } from "../services/identity-resources";
import { toast } from "../lib/toast";
import type { DeptNode, Role, SyncDiffResult, SyncRunResult } from "../types";
import { PageHead, SkeletonRows, type DataScope } from "../ui";
import { ToneBadge } from "../components/reactor";
import { DeptTree, ancestorPaths, filterDeptTree, flattenDepts, parentIdOf, subtreeIdsOf, subtreeMemberCount } from "../components/DeptTree";
import { UsersTable } from "../components/UsersTable";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";

/* ────────────────────────── 口径（纯函数，探针直接钉这几条） ────────────────────────── */

export interface Blocks {
  /** 左栏：部门树（服务端 `GET /depts/tree` 对 role=user 返回 403，所以普通用户不给这一栏） */
  tree: boolean;
  /** 右栏：用户列表（`GET /users` 对 role=user 只返回自己 —— 那是"个人中心"的活，不该在这里出现） */
  users: boolean;
  /** 组织运维（建/改/移/删 + AD 同步）—— 平台管理员专属 */
  orgOps: boolean;
  /** 用户运维（新建/改角色/改部门/停用）—— 平台管理员专属；部门负责人只能看 */
  userAdmin: boolean;
}

/**
 * 决策 D6：**权限点保持两个**（看用户 / 看组织），页面内分别渲染左右两块 ——
 * 不能让只有"看用户"权限的人看到组织运维按钮，反之亦然。
 *
 * ⚠ 诚实说明：本仓管理台目前只有 3 个角色（没有按用户粒度的权限下发，`/admin/permissions`
 * 是**只读矩阵**不参与鉴权），所以这里按角色分档，而不是读权限码。将来接入权限码时，
 * 这一处是唯一的落点（页面其余部分只消费这个矩阵）。
 */
export function blocksFor(role: Role | undefined): Blocks {
  switch (role) {
    case "platform_admin":
      return { tree: true, users: true, orgOps: true, userAdmin: true };
    case "dept_head":
      // 部门负责人：能看本部门（及以下）的人与结构，但**不动结构**（后端同样只放行平台管理员）
      return { tree: true, users: true, orgOps: false, userAdmin: false };
    default:
      // role=user 或未登录：两块都不渲染（路由层其实已经拦住，这里是纵深防御）
      return { tree: false, users: false, orgOps: false, userAdmin: false };
  }
}

/**
 * 右栏要请求的部门 id 列表 —— 「含下级成员」开关的**唯一落点**。
 * 关：只看直接归属（`[node.id]`）；开：整棵子树。
 * 返回值恒非空：空数组在契约里是"命中空集"，一旦这里返回 `[]` 就成了"选中的部门谁都不是"。
 */
export function deptIdsFor(node: DeptNode, includeSubtree: boolean): number[] {
  return includeSubtree ? [...subtreeIdsOf(node)] : [node.id];
}

/** 按 id 在树里找节点（URL 里的 `?dept=` 是 id，刷新后要能还原选中态） */
export function findDept(nodes: DeptNode[], id: number): DeptNode | null {
  if (!Number.isFinite(id)) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findDept(node.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 「含下级成员」开关的取值口径（根节点例外：恒为开且禁用） */
export function subSwitchState(isRoot: boolean, subParam: string | null): { checked: boolean; disabled: boolean } {
  return { checked: isRoot || subParam === "1", disabled: isRoot };
}

/**
 * 「含下级成员」开关。抽成组件是为了能单独渲染断言「根节点 = 开启且禁用」
 * （整页在 SSR 下拿不到树，右栏那一块渲染不出来）。
 */
export function SubtreeSwitch({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <label
      className="switchline"
      data-orgu-sub-switch
      title={disabled ? "根节点就是全公司，恒为全部成员（不可关）" : "勾选后把下级的成员也算进来"}
    >
      <Switch size="sm" checked={checked} disabled={disabled} onCheckedChange={(v) => onCheckedChange(Boolean(v))} />
      <span>含下级成员</span>
    </label>
  );
}

/* ────────────────────────── 部门结构编辑（平台管理员） ────────────────────────── */

type EditorMode = "create-child" | "create-root" | "rename" | "move";

function countOf(node: DeptNode): number {
  return 1 + node.children.reduce((s, c) => s + countOf(c), 0);
}

export function OrgUsers() {
  const user = useAuthStore((s) => s.user);
  const blocks = blocksFor(user?.role);

  const [params, setParams] = useSearchParams();
  const [tree, setTree] = useState<DeptNode[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<Map<number, number>>(new Map());
  const [treeQ, setTreeQ] = useState("");
  const [treeHidden, setTreeHidden] = useState(false);

  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [editorName, setEditorName] = useState("");
  const [editorParent, setEditorParent] = useState<string>("none");
  const [editorBusy, setEditorBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [diff, setDiff] = useState<SyncDiffResult | null>(null);
  const [run, setRun] = useState<SyncRunResult | null>(null);

  /** 树 + 全量可见用户（成员数徽标用；右表自己有带筛选的请求，不能拿它当计数源） */
  const load = useCallback(async () => {
    const [t, all] = await Promise.all([deptsApi.tree(), usersApi.list()]);
    setTree(t.tree);
    const m = new Map<number, number>();
    for (const u of all.users) if (u.dept) m.set(u.dept.id, (m.get(u.dept.id) ?? 0) + 1);
    setMembers(m);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  /* ── URL 是选中态的唯一真源（决策 D7）；本地不再存 selected ── */
  const deptParam = Number(params.get("dept"));
  const selected = useMemo(() => (tree ? findDept(tree, deptParam) ?? tree[0] ?? null : null), [tree, deptParam]);
  const selectedId = selected?.id ?? null;
  // 根节点判定：树接口不下发 parentId，用 path 反查（顶层节点没有 '/'）
  const isRoot = selected !== null && parentIdOf(selected, tree ?? []) === null;
  const { checked: includeSub } = subSwitchState(isRoot, params.get("sub"));
  const deptIds = useMemo(() => (selected ? deptIdsFor(selected, includeSub) : null), [selected, includeSub]);

  const patchParams = useCallback(
    (mut: (p: URLSearchParams) => void) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mut(next);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const selectDept = (node: DeptNode): void => {
    // 只改 dept：`sub` 是用户的浏览偏好，跨节点保留；根节点那边由 subSwitchState 强制为开
    patchParams((p) => p.set("dept", String(node.id)));
  };

  // 首次加载展开全部根节点（否则进来是一排折叠着的行）
  useEffect(() => {
    if (tree?.length) setExpanded((prev) => (prev.size > 0 ? prev : new Set(tree.map((n) => n.path))));
  }, [tree]);

  // 带 `?dept=` 直接打开深层部门时，把祖先都展开，否则选中项在树里看不见
  useEffect(() => {
    if (!selected) return;
    setExpanded((prev) => {
      const need = ancestorPaths(selected.path);
      if (need.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      for (const p of need) next.add(p);
      return next;
    });
  }, [selected]);

  const onToggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const filtered = useMemo(() => filterDeptTree(tree ?? [], treeQ), [tree, treeQ]);
  // 搜索态：用 filter 给出的 autoOpen 顶掉手动的展开集合 —— 否则"搜到了却看不见"
  const effectiveExpanded = treeQ.trim() ? filtered.autoOpen : expanded;

  const direct = selected ? members.get(selected.id) ?? 0 : 0;
  const total = selected ? subtreeMemberCount(selected, members) : 0;
  const moveOptions = useMemo(() => {
    const list = flattenDepts(tree ?? []);
    if (!selected) return list;
    const exclude = subtreeIdsOf(selected);
    return list.filter((d) => !exclude.has(d.id));
  }, [tree, selected]);

  /* ── 组织运维 ── */
  const submitEditor = async (): Promise<void> => {
    setEditorBusy(true);
    try {
      if (editor === "create-child" || editor === "create-root") {
        if (!editorName.trim()) throw new Error("请输入部门名称");
        const r = await deptsApi.create({ parentId: editorParent === "none" ? null : Number(editorParent), name: editorName.trim() });
        toast.ok("已新建部门");
        if (r?.dept?.id) selectDept({ id: r.dept.id, name: r.dept.name, path: r.dept.path, children: [] });
      } else if (editor === "rename" && selected) {
        if (!editorName.trim()) throw new Error("请输入部门名称");
        await deptsApi.patch(selected.id, { name: editorName.trim() });
        toast.ok("已重命名");
      } else if (editor === "move" && selected) {
        await deptsApi.patch(selected.id, { parentId: editorParent === "none" ? null : Number(editorParent) });
        toast.ok("已移动部门（整棵子树路径同步更新）");
      }
      setEditor(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setEditorBusy(false);
    }
  };

  const removeDept = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`删除部门「${selected.path}」？有下级或仍有成员时会被拒绝。`)) return;
    try {
      await deptsApi.remove(selected.id);
      toast.ok("已删除部门");
      patchParams((p) => p.delete("dept")); // 退回根节点，避免停在一个已不存在的 id 上
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copyPath = async (): Promise<void> => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.path);
      toast.ok("已复制部门路径");
    } catch {
      // 非安全上下文/无剪贴板权限：不装作成功
      toast.error("复制失败，请手动选中路径");
    }
  };

  /* ── AD 同步（弹窗：预览差异 → 执行） ── */
  const preview = useCallback(async (): Promise<void> => {
    setSyncBusy(true);
    setRun(null);
    try {
      const r = await syncApi.preview();
      setDiff(r.diff);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncBusy(false);
    }
  }, []);

  const openSync = (): void => {
    setSyncOpen(true);
    setDiff(null);
    setRun(null);
    void preview(); // 打开即预览：这一步只读，出差异再谈执行
  };

  const runSync = async (): Promise<void> => {
    setSyncBusy(true);
    setDiff(null);
    try {
      const r = await syncApi.run();
      setRun(r.result);
      toast.ok(`同步完成：新增 ${r.result.added} · 停用 ${r.result.disabled}`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncBusy(false);
    }
  };

  /**
   * 数据范围徒标：**只表达「能看到多少数据」**。
   * 平台管理员是全量默认态 ⇒ `all`（不渲染徒标）；部门负责人标 `dept`。
   * ⚠ 这里刻意不放「仅平台管理员」之类的**权限**说明 —— 权限不是数据范围
   * （用户口径 2026-09-19：那种 chip 没必要，以后不许再加）。
   */
  const dataScope: DataScope | undefined =
    user?.role === "dept_head" ? "dept" : user?.role === "platform_admin" ? "all" : undefined;

  if (!blocks.tree && !blocks.users) {
    return (
      <div>
        <PageHead title="组织与用户" scope={dataScope} />
        <div className="panel">
          <div className="empty">
            <MagnifyingGlass size={22} />
            <div className="t">没有可查看的内容</div>
            <div className="s">当前账号没有用户或组织数据权限</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="org-page">
      <PageHead
        title="组织与用户"
        desc="左侧选部门，右侧看这个部门的成员；部门结构由 AD OU 同步生成，可后台微调（仅平台生效）。"
        scope={dataScope}
      />

      <div className={`org-wrap ${!blocks.tree || treeHidden ? "tree-hidden" : ""}`} data-orgu-wrap>
        {blocks.tree && !treeHidden && (
          <div className="org-col-tree">
            <div className="tree-panel scrollbar">
              <div className="tree-search">
                <MagnifyingGlass size={14} />
                <Input
                  className="h-7 pl-7"
                  placeholder="搜索部门"
                  value={treeQ}
                  onChange={(e) => setTreeQ(e.target.value)}
                  data-orgu-tree-search
                />
                <Button size="sm" variant="ghost" className="h-7 px-1.5" title="收起部门树" onClick={() => setTreeHidden(true)}>
                  <CaretLeft size={13} />
                </Button>
              </div>
              <DeptTree
                tree={filtered.tree}
                expanded={effectiveExpanded}
                onToggle={onToggle}
                selectedId={selectedId}
                onSelect={selectDept}
                members={members}
                rootBadge="subtree"
              />
              {tree !== null && filtered.tree.length === 0 && <div className="tree-empty">没有匹配的部门</div>}
            </div>
          </div>
        )}

        {blocks.users && (
          <div className="org-col-right">
            {!selected ? (
              <div className="panel">{tree === null ? <SkeletonRows n={6} /> : <div className="empty"><MagnifyingGlass size={22} /><div className="t">选择左侧部门查看</div></div>}</div>
            ) : (
              <>
                <div className="panel dept-panel">
                  <div className="dept-head">
                    {(!blocks.tree || treeHidden) && (
                      <Button size="sm" variant="ghost" className="gap-1" title="展开部门树" onClick={() => setTreeHidden(false)}>
                        <CaretRight size={13} /> 部门树
                      </Button>
                    )}
                    <h3 data-orgu-dept-name title={selected.path}>
                      {selected.name}
                    </h3>
                    <span className="dept-counts" data-orgu-counts>
                      直接成员 <b>{direct}</b> · 含下级 <b>{total}</b>
                    </span>
                  </div>
                  {blocks.orgOps && (
                    <div className="dept-ops" data-orgu-ops>
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => { setEditorName(""); setEditorParent(String(selected.id)); setEditor("create-child"); }}>
                        <Plus size={13} /> 新建下级
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => { setEditorName(selected.name); setEditor("rename"); }}>
                        <PencilSimple size={13} /> 重命名
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => { const pid = parentIdOf(selected, tree ?? []); setEditorParent(pid != null ? String(pid) : "none"); setEditor("move"); }}>
                        移动
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => void removeDept()}>
                        <Trash size={13} /> 删除
                      </Button>
                      {/* 低频动作收进 ⋯ 更多：不占主行，也不需要各占一行 */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="outline" className="gap-1" title="更多组织操作">
                            <DotsThree size={16} weight="bold" /> 更多
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-44">
                          <DropdownMenuItem onClick={() => setDetailsOpen(true)}>节点详情</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void copyPath()}>
                            <Copy size={14} /> 复制路径
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => { setEditorName(""); setEditor("create-root"); }}>新建顶层部门</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <div className="spacer" />
                      <Button size="sm" variant="default" className="gap-1" onClick={openSync}>
                        <ArrowsClockwise size={13} /> 同步 AD
                      </Button>
                    </div>
                  )}
                </div>

                <UsersTable
                  deptIds={deptIds}
                  toolbarExtra={
                    <SubtreeSwitch
                      checked={includeSub}
                      disabled={isRoot}
                      onCheckedChange={(v) => patchParams((p) => (v ? p.set("sub", "1") : p.delete("sub")))}
                    />
                  }
                  // 用户增删改会改变部门成员数 ⇒ 刷新树上徽标（右表自己会重取，不用管）
                  onChanged={() => void load()}
                />
              </>
            )}
          </div>
        )}
      </div>

      {/* 部门结构编辑（新建下级/顶层、重命名、移动） */}
      <Dialog open={editor !== null} onOpenChange={(open) => { if (!open) setEditor(null); }}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>
              {editor === "create-child" ? "新建下级部门" : editor === "create-root" ? "新建顶层部门" : editor === "rename" ? "重命名部门" : "移动部门"}
            </DialogTitle>
          </DialogHeader>
          <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {editor === "move" ? null : (
              <div className="grid gap-1.5">
                <Label>部门名称</Label>
                <Input
                  autoFocus
                  value={editorName}
                  placeholder="如：设计管理部"
                  onChange={(e) => setEditorName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitEditor(); }}
                />
              </div>
            )}
            {editor === "move" ? (
              <div className="grid gap-1.5">
                <Label>移动到</Label>
                <Select value={editorParent} onValueChange={setEditorParent}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">（顶层）</SelectItem>
                    {moveOptions.map((dept) => (
                      <SelectItem key={dept.id} value={String(dept.id)}>{dept.path}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  已排除自身与下级（禁止成环）；移动后整棵子树的 path 会同步重写
                </div>
              </div>
            ) : null}
            {editor === "create-child" ? (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>上级：{selected?.path ?? "—"}</div>
            ) : null}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setEditor(null)}>取消</Button>
            <Button disabled={editorBusy} onClick={() => void submitEditor()}>{editorBusy ? "提交中…" : "确定"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 节点详情（决策 5：ID/路径属于排查信息，从首屏挪到这里 + 标题 tooltip） */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>节点详情</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            {selected && (
              <div className="dept-detail">
                <div className="kv"><div className="k">部门名称</div><div className="v">{selected.name}</div></div>
                <div className="kv"><div className="k">节点 ID</div><div className="v mono">{selected.id}</div></div>
                <div className="kv"><div className="k">路径</div><div className="v mono" style={{ fontSize: 13 }}>{selected.path}</div></div>
                <div className="kv"><div className="k">直接成员</div><div className="v num">{direct}</div></div>
                <div className="kv"><div className="k">含下级成员</div><div className="v num">{total}</div></div>
                <div className="kv"><div className="k">含下级节点数</div><div className="v num">{countOf(selected)}</div></div>
              </div>
            )}
            {selected && selected.children.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-3)" }}>
                下级部门：{selected.children.map((c) => c.name).join(" / ")}
              </div>
            )}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setDetailsOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AD 组织同步：低频动作，收进弹窗（预览差异 → 执行） */}
      <Dialog open={syncOpen} onOpenChange={(open) => { if (!open) setSyncOpen(false); }}>
        <DialogContent className="modal">
          <DialogHeader className="modal-head">
            <DialogTitle>AD 组织同步</DialogTitle>
          </DialogHeader>
          <div className="modal-body">
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 12 }}>
              方向：AD/LDAP（OU=cnpe）→ 平台；手动触发，差异预览后再执行（对齐 G3）
            </div>
            {syncBusy && <SkeletonRows n={2} />}
            {!syncBusy && !diff && !run && (
              <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", gap: 8, alignItems: "center" }}>
                <ArrowsClockwise size={13} /> 尚未执行 · 平台不会自动同步
              </div>
            )}
            {!syncBusy && diff && (
              <div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                  <ToneBadge tone="info">LDAP 在册 {diff.total}</ToneBadge>
                  <ToneBadge tone="accent">新增 {diff.addedCount}</ToneBadge>
                  <ToneBadge tone="warn">变更 {diff.changedCount}</ToneBadge>
                  <ToneBadge tone="danger">将停用 {diff.disabledCount}</ToneBadge>
                  <ToneBadge tone="success">无变化 {diff.unchangedCount}</ToneBadge>
                </div>
                {diff.addedSample.length > 0 && (
                  <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>新增示例：{diff.addedSample.join("、")}</div>
                )}
                {diff.changedSample.length > 0 && (
                  <div style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}>变更示例：{diff.changedSample.join("、")}</div>
                )}
                {diff.disabled.length > 0 && (
                  <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 6 }}>将停用（已不在 AD）：{diff.disabled.slice(0, 10).join("、")}</div>
                )}
                <Button variant="default" size="sm" className="gap-1" onClick={() => void runSync()}>
                  <CheckCircle size={14} /> 确认执行同步
                </Button>
              </div>
            )}
            {!syncBusy && run && (
              <div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <ToneBadge tone="info">LDAP 在册 {run.total}</ToneBadge>
                  <ToneBadge tone="accent">新增 {run.added}</ToneBadge>
                  <ToneBadge tone="warn">变更 {run.changed}</ToneBadge>
                  <ToneBadge tone="danger">停用 {run.disabled}</ToneBadge>
                  <ToneBadge tone="success">无变化 {run.unchanged}</ToneBadge>
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>已写入同步日志（系统 → 同步日志）</div>
              </div>
            )}
          </div>
          <DialogFooter className="modal-foot">
            <Button variant="outline" onClick={() => setSyncOpen(false)}>关闭</Button>
            <Button variant="outline" className="gap-1" disabled={syncBusy} onClick={() => void preview()}>
              <Eye size={14} /> 重新预览
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
