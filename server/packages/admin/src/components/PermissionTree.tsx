// Reactor 管理台 · 权限层级树（复刻 scaffold-master 的 PermissionTree，只读降维）
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/PermissionTree.vue
//   （Vue 版：菜单树 dir/menu/btn 三级 + 勾选授权 + 级联勾父/勾子 + 按钮 chips）
//
// 复刻取舍（为什么不是照搬）：
//   scaffold 是"给角色配菜单权限"的可编辑树（modelValue + emit update）；
//   Reactor 的权限模型是**固定三角色 + 只读**（映射硬编码在服务端
//   permissionAllowed()，没有授权写接口）——做成可勾选就是假交互。
//   所以保留树形组织与折叠，把"勾选"降维成"角色覆盖展示"：
//   每行行尾三个 chip，显示该节点在三个角色下的覆盖情况
//   （目录 = on/total，叶子 = ✓/—）。
//
// 与 Roles.tsx 既有两块的关系（互补，不重复）：
//   - PermissionMatrix（B0）：行=前两段分组，看角色×分组的授权密度
//   - 权限点清单表格：平铺查具体权限点
//   - 本组件：完整层级（目录→模块→动作），看结构与逐级覆盖
//
// 数据来源与 B0 完全一致：permissionsApi.list() 的 permissions + roles，零新接口。

import { useMemo, useState } from "react";
import { CaretRight, ShieldCheck } from "@phosphor-icons/react";
import { Empty } from "../ui";
import { ROLE_TEXT, ToneBadge } from "./reactor";
import { ACTION_LABEL, buildPermissionTree, filterPermissionTree, leavesOf, type PermTreeNode } from "../lib/permission-tree";
import type { PermissionPoint, RolePermissions } from "../services/permissions";
import type { Role } from "../types";

interface Row {
  node: PermTreeNode;
  depth: number;
  /** 目录=子树叶子总数；叶子=1 */
  leafCount: number;
  /** 每个角色在该节点子树上的可见叶子数（顺序同 roles） */
  coverage: Array<{ role: RolePermissions; on: number }>;
}

export function PermissionTree({ points, roles }: { points: PermissionPoint[]; roles: RolePermissions[] }) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const roleSet = useMemo(() => new Map(roles.map((role) => [role.key, new Set(role.permissions)])), [roles]);
  // 入参排序后再建树：同层节点按 code 字典序，目录与叶子混排时也有稳定顺序
  const tree = useMemo(() => buildPermissionTree([...points].sort((a, b) => a.code.localeCompare(b.code))), [points]);

  // 搜索态：用 autoOpen 顶掉手动折叠——否则"搜到了却看不见"（DeptTree 同款手法）
  const filtered = useMemo(() => filterPermissionTree(tree, query), [tree, query]);
  const effectiveCollapsed = query.trim() ? new Set([...collapsed].filter((key) => !filtered.autoOpen.has(key))) : collapsed;

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (nodes: PermTreeNode[]): void => {
      for (const node of nodes) {
        const leaves = leavesOf(node);
        out.push({
          node,
          depth: node.depth,
          leafCount: leaves.length,
          coverage: roles.map((role) => {
            const set = roleSet.get(role.key);
            return { role, on: set ? leaves.filter((leaf) => set.has(leaf.code)).length : 0 };
          }),
        });
        if (node.isDir && !effectiveCollapsed.has(node.key)) walk(node.children);
      }
    };
    walk(filtered.tree);
    return out;
  }, [filtered.tree, effectiveCollapsed, roles, roleSet]);

  const toggle = (key: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const dirCount = filtered.tree.reduce((n, node) => n + (node.isDir ? 1 : 0), 0);
  const leafTotal = points.length;

  if (points.length === 0) {
    return (
      <Empty
        icon={<ShieldCheck size={22} />}
        title="尚未生成权限点"
        desc="点击右上角「重新扫描权限点」从服务端路由表生成后再看层级树"
      />
    );
  }

  return (
    <div className="pt-wrap">
      <div className="pt-bar">
        <span className="pt-hint">
          按权限码层级浏览 · 行尾为各角色覆盖（目录 on/total · 叶子 ✓/—）
        </span>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="搜索权限码 / 路径 / 说明"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="pt-scroll">
        <div className="pt-tree" role="tree" aria-label="权限层级">
          {rows.map((row) => {
            const isDir = row.node.isDir;
            const point = row.node.point;
            const isOpen = isDir && !effectiveCollapsed.has(row.node.key);
            return (
              <div
                key={row.node.key}
                className={`pt-row${isDir ? " is-dir" : ""}`}
                role="treeitem"
                aria-expanded={isDir ? isOpen : undefined}
                style={{ paddingLeft: 6 + row.depth * 18 }}
              >
                {isDir ? (
                  <button
                    type="button"
                    className={`pt-twist${isOpen ? " is-open" : ""}`}
                    aria-label={isOpen ? "收起" : "展开"}
                    onClick={() => toggle(row.node.key)}
                  >
                    <CaretRight size={12} />
                  </button>
                ) : (
                  <span className="pt-twist is-leaf" aria-hidden="true" />
                )}

                <div className="pt-main">
                  <span className="pt-name">{isDir ? row.node.label : ACTION_LABEL[row.node.label] ?? row.node.label}</span>
                  {isDir ? (
                    <>
                      <span className="pt-key mono" title={row.node.key}>
                        {row.node.key}
                      </span>
                      <span className="pt-count num">{row.leafCount} 权限点</span>
                    </>
                  ) : (
                    <>
                      <span className="pt-code mono" title={point ? `${point.code}${point.description ? ` — ${point.description}` : ""}` : undefined}>
                        {point?.code}
                      </span>
                      {point && (
                        <ToneBadge tone={point.method === "GET" ? "info" : point.method === "DELETE" ? "danger" : "warn"}>
                          {point.method}
                        </ToneBadge>
                      )}
                    </>
                  )}
                </div>

                <div className="pt-roles">
                  {row.coverage.map(({ role, on }) => {
                    const state = on === 0 ? "none" : on === row.leafCount ? "full" : "part";
                    return (
                      <span
                        key={role.key}
                        className={`pt-chip is-${state}`}
                        title={`${role.label} · 覆盖 ${on}/${row.leafCount}`}
                      >
                        {ROLE_TEXT[role.key as Role]}
                        <b className="num">{isDir ? `${on}/${row.leafCount}` : on > 0 ? "✓" : "—"}</b>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {rows.length === 0 && <div className="tree-empty">没有匹配的权限点</div>}
        </div>
      </div>

      <div className="pt-foot">
        共 {dirCount} 个一级分组 · {leafTotal} 个权限点 · 角色映射由服务端固定，这里只做可视化
      </div>
    </div>
  );
}
