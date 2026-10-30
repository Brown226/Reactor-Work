// 管理台 · 授权范围可视化选择器（2026-10-29）
//
// 为什么新增而不是改 ScopePicker：技能（Skills.tsx）与套件（SkillBundles.tsx）也用它，
// 那两页的账号还是手输场景。直接改共用组件会波及它们，且它们的交互未经过评审。
// 这里只服务「界面模式权限」页 —— 那一页的受众是全体 800+ 员工，
// 手输账号名既慢又容易打错，必须能看着组织树点。
//
// 布局对照「组织与用户」页：左侧部门树（带人数），右侧随模式切换：
//   · mode=dept → 树节点带勾选框，右侧列出已选部门；
//   · mode=user → 点部门看该部门人员，右侧勾选到人，支持搜索 / 含下级 / 分页。
//
// ⚠ 后端 `codingAllowedFor` 是 `switch(policy.kind)` 单值匹配，dept 与 user **不能叠加**。
// 所以这里不提供「部门+人员」混合选择 —— 那会让界面承诺一个后端并不执行的口径。

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type { AdminUser, DeptNode } from "../types";
import { deptsApi, usersApi } from "../services/identity-resources";
import { DeptTree, ancestorPaths, subtreeIdsOf } from "./DeptTree";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { toast } from "../lib/toast";

const PAGE = 20;

export interface OrgScopePickerProps {
  /** dept = 勾选整个部门；user = 勾选具体人员 */
  mode: "dept" | "user";
  deptIds: number[];
  uids: string[];
  onDeptIdsChange: (next: number[]) => void;
  onUidsChange: (next: string[]) => void;
}

export function OrgScopePicker(props: OrgScopePickerProps): ReactElement {
  const [tree, setTree] = useState<DeptNode[] | null>(null);
  const [members, setMembers] = useState<Map<number, number>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedDept, setSelectedDept] = useState<DeptNode | null>(null);
  const [deptQuery, setDeptQuery] = useState("");
  const [q, setQ] = useState("");
  const [includeSub, setIncludeSub] = useState(false);
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(false);

  /** 树的初始加载：部门结构 + 每个部门的直接人数（一次全量，800 级别的量级可接受） */
  useEffect(() => {
    Promise.all([deptsApi.tree(), usersApi.list({})])
      .then(([t, u]) => {
        setTree(t.tree);
        const m = new Map<number, number>();
        for (const usr of u.users) {
          const id = usr.dept?.id;
          if (typeof id === "number") m.set(id, (m.get(id) ?? 0) + 1);
        }
        setMembers(m);
        // 默认展开根节点，否则一开始看到的是几个折叠行，不知道该点哪
        setExpanded(new Set(t.tree.map((n) => n.path)));
      })
      .catch((e) => toast.error((e as Error).message));
  }, []);

  /** 右侧按「选中部门 + 含下级 + 搜索词」拉人员；键用字符串，避免数组引用变化导致刷新风暴 */
  const deptIdsForQuery = useMemo(() => {
    if (!selectedDept) return null;
    return includeSub ? [...subtreeIdsOf(selectedDept)] : [selectedDept.id];
  }, [selectedDept, includeSub]);
  const deptKey = deptIdsForQuery === null ? "" : deptIdsForQuery.join(",");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await usersApi.list({
        q: q.trim() || undefined,
        deptIds: deptKey ? deptKey.split(",").map(Number) : undefined,
      });
      setUsers(r.users);
      setPage(1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [q, deptKey]);

  useEffect(() => {
    if (props.mode !== "user") return;
    void loadUsers();
  }, [loadUsers, props.mode]);

  const pageRows = useMemo(() => {
    const all = users ?? [];
    return all.slice((page - 1) * PAGE, page * PAGE);
  }, [users, page]);
  const pageCount = Math.max(1, Math.ceil((users?.length ?? 0) / PAGE));

  const toggleExpanded = (path: string): void => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** 打开某个深层部门时，把祖先都展开，否则选中项在树里看不见 */
  const selectDept = (node: DeptNode): void => {
    setSelectedDept(node);
    setExpanded((cur) => {
      const next = new Set(cur);
      for (const p of ancestorPaths(node.path)) next.add(p);
      return next;
    });
  };

  /** 部门搜索：命中节点及其祖先可见（祖先展开靠 selectDept / expanded） */
  const filteredTree = useMemo(() => {
    const kw = deptQuery.trim().toLowerCase();
    if (!kw || tree === null) return tree;
    const keep = (n: DeptNode): DeptNode | null => {
      const kids = n.children.map(keep).filter((c): c is DeptNode => c !== null);
      const self = n.name.toLowerCase().includes(kw) || n.path.toLowerCase().includes(kw);
      if (!self && kids.length === 0) return null;
      return { ...n, children: kids };
    };
    return tree.map(keep).filter((n): n is DeptNode => n !== null);
  }, [tree, deptQuery]);

  const selectedDeptPaths = props.deptIds.map((id) => {
    const found = findNode(tree, id);
    return { id, path: found?.path ?? `#${id}` };
  });

  const toggleUid = (uid: string, next: boolean): void => {
    props.onUidsChange(next ? [...props.uids, uid] : props.uids.filter((u) => u !== uid));
  };

  const removeUid = (uid: string): void => {
    props.onUidsChange(props.uids.filter((u) => u !== uid));
  };

  return (
    <div className="org-scope-picker">
      <aside className="org-scope-side">
        <Input
          value={deptQuery}
          onChange={(e) => setDeptQuery(e.target.value)}
          placeholder="搜索部门"
          style={{ marginBottom: 8 }}
        />
        <div className="org-scope-tree">
          <DeptTree
            tree={filteredTree}
            expanded={expanded}
            onToggle={toggleExpanded}
            selectedId={selectedDept?.id ?? null}
            onSelect={selectDept}
            members={members}
            // 部门模式下节点带勾选框；账号模式下只用来筛选右侧人员
            checkedIds={props.mode === "dept" ? new Set(props.deptIds) : undefined}
            onCheck={
              props.mode === "dept"
                ? (node, next) =>
                    props.onDeptIdsChange(
                      next ? [...props.deptIds, node.id] : props.deptIds.filter((id) => id !== node.id),
                    )
                : undefined
            }
          />
        </div>
      </aside>

      <div className="org-scope-main">
        {props.mode === "dept" ? (
          <>
            <div className="org-scope-summary">
              已选 <b>{props.deptIds.length}</b> 个部门
              <span className="cell-sub"> · 勾选左侧部门前的方框；只授权该部门「直接归属」的成员，不含下级</span>
            </div>
            <div className="org-scope-chips">
              {selectedDeptPaths.length === 0 ? (
                <span className="cell-sub">还没有选部门</span>
              ) : (
                selectedDeptPaths.map((d) => (
                  <span key={d.id} className="org-scope-chip">
                    {d.path}
                    <button type="button" onClick={() => props.onDeptIdsChange(props.deptIds.filter((x) => x !== d.id))} aria-label="移除">
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div className="org-scope-toolbar">
              <div className="org-scope-search">
                <MagnifyingGlass size={13} />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索账号 / 姓名"
                />
              </div>
              <label className="org-scope-check">
                <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} />
                含下级成员
              </label>
              <span className="spacer" />
              <span className="cell-sub">已选 <b>{props.uids.length}</b> 人</span>
            </div>

            {props.uids.length > 0 ? (
              <div className="org-scope-chips">
                {props.uids.map((uid) => (
                  <span key={uid} className="org-scope-chip">
                    {uid}
                    <button type="button" onClick={() => removeUid(uid)} aria-label="移除">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="org-scope-users">
              {loading ? (
                <div className="org-scope-empty">加载中…</div>
              ) : pageRows.length === 0 ? (
                <div className="org-scope-empty">
                  {selectedDept ? "该部门没有匹配的成员" : "先在左侧选一个部门，或直接搜索"}
                </div>
              ) : (
                pageRows.map((u) => {
                  const on = props.uids.includes(u.uid);
                  return (
                    <label key={u.id} className={`org-scope-row${on ? " is-on" : ""}`}>
                      <input type="checkbox" checked={on} onChange={(e) => toggleUid(u.uid, e.target.checked)} />
                      <span className="org-scope-name">{u.name}</span>
                      <span className="uid">{u.uid}</span>
                      <span className="spacer" />
                      <span className="cell-sub">{u.dept?.path ?? "—"}</span>
                    </label>
                  );
                })
              )}
            </div>

            <div className="org-scope-foot">
              <span className="cell-sub">
                共 {users?.length ?? 0} 人 · 第 {page}/{pageCount} 页
              </span>
              <span className="spacer" />
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                上一页
              </Button>
              <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
                下一页
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 在树里按 id 找节点（已选部门的路径展示用；找不到就退化成 #id） */
function findNode(nodes: DeptNode[] | null, id: number): DeptNode | null {
  if (nodes === null) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit !== null) return hit;
  }
  return null;
}
