// 部门树（左栏）：从 pages/Org.tsx 原样抽出，供旧「组织管理」页与新的
// 「组织与用户」合并页共用 —— 抄一份必然漂移，所以只留这一份实现。
//
// 口径（2026-09-19 用户拍板，见 docs/实施计划/管理台-组织与用户合并-规划-v1.md §8）：
//   树上数字默认 = **直接归属**成员数；
//   `rootBadge="subtree"` 时，**只有根节点那一行**改显整棵子树总数。
// 为什么只让根节点例外：合并页选中根节点时右表恒为全公司（恒定子树口径），
// 根那行若还显直接数就会出现「根显示 0、右表满页」的观感矛盾；非根节点仍是直接数，
// 才和右栏副标题「直接成员 N · 含下级 M」对得上。鼠标悬停有 tooltip 注明口径。

import { CaretRight } from "@phosphor-icons/react";
import type { DeptNode } from "../types";
import { SkeletonRows } from "../ui";

/** 展平部门树（移动目标下拉、部门路径映射用；注意是前序遍历，父在子前） */
export function flattenDepts(nodes: DeptNode[], out: Array<{ id: number; path: string }> = []): Array<{ id: number; path: string }> {
  for (const node of nodes) {
    out.push({ id: node.id, path: node.path });
    if (node.children?.length) flattenDepts(node.children, out);
  }
  return out;
}

/** 节点自身 + 全部后代 id（移动时排除，防成环；合并页「含下级成员」也用它） */
export function subtreeIdsOf(node: DeptNode, out: Set<number> = new Set()): Set<number> {
  out.add(node.id);
  for (const child of node.children ?? []) subtreeIdsOf(child, out);
  return out;
}

/** 由 path 反查父部门 id（树接口不下发 parentId） */
export function parentIdOf(node: DeptNode, roots: DeptNode[]): number | null {
  const cut = node.path.lastIndexOf("/");
  if (cut < 0) return null;
  const parentPath = node.path.slice(0, cut);
  return flattenDepts(roots).find((dept) => dept.path === parentPath)?.id ?? null;
}

/**
 * 节点自身 + 全部后代的成员合计。
 * `members` 的口径是「部门 id → **直接归属**人数」，所以这里只是把子树里的直接数相加 ——
 * 不要求 members 覆盖所有部门（没人的部门本来就不在 map 里，缺省 0 是对的）。
 */
export function subtreeMemberCount(node: DeptNode, members: Map<number, number>): number {
  return (members.get(node.id) ?? 0) + node.children.reduce((s, c) => s + subtreeMemberCount(c, members), 0);
}

/**
 * 路径的全部祖先路径前缀（`a/b/c` → `["a", "a/b"]`）。
 * 用途：带 `?dept=` 直接打开深层部门时，要把祖先都展开，否则选中项在树里根本看不见。
 */
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * 部门搜索（左树的「搜索部门」）。
 * 规则：**命中就整棵留下**（便于继续往里走），没命中的节点只要有后代命中就保留为"路径"。
 * 返回 `autoOpen` = 所有"只因后代命中而保留"的节点路径 —— 搜索态下必须展开它们，
 * 否则结果是"搜到了却看不见"（折叠态下祖先不在 expanded 里）。
 */
export function filterDeptTree(nodes: DeptNode[], query: string): { tree: DeptNode[]; autoOpen: Set<string> } {
  const q = query.trim().toLowerCase();
  const autoOpen = new Set<string>();
  if (q === "") return { tree: nodes, autoOpen };
  const walk = (node: DeptNode): DeptNode | null => {
    const self = node.name.toLowerCase().includes(q);
    if (self) return node; // 命中：整棵子树原样留下
    const kids = node.children.map(walk).filter((n): n is DeptNode => n !== null);
    if (kids.length === 0) return null;
    autoOpen.add(node.path);
    return { ...node, children: kids };
  };
  // 根节点自身被 `walk` 命中时也是整棵留下；保留的是新对象，不改动原树
  return { tree: nodes.map(walk).filter((n): n is DeptNode => n !== null), autoOpen };
}

export interface DeptTreeProps {
  /** null = 还在加载（渲染骨架），而不是「没有部门」 */
  tree: DeptNode[] | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  /** 选中节点的 **id**：不用 path —— 重命名/移动后 path 会变，选中态会静默掉线 */
  selectedId: number | null;
  onSelect: (node: DeptNode) => void;
  /** 部门 id → 直接归属人数（含本地账号） */
  members: Map<number, number>;
  /** 根节点徽标口径，默认 direct（= 旧 Org 页行为，未接线即不变行为） */
  rootBadge?: "direct" | "subtree";
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  members,
  rootBadge,
}: {
  node: DeptNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (p: string) => void;
  selectedId: number | null;
  onSelect: (n: DeptNode) => void;
  members: Map<number, number>;
  rootBadge: "direct" | "subtree";
}) {
  const isOpen = expanded.has(node.path);
  const hasKids = node.children.length > 0;
  // depth === 0 就是「根节点那一行」；口径见文件头注释
  const subtreeMode = rootBadge === "subtree" && depth === 0;
  const m = subtreeMode ? subtreeMemberCount(node, members) : members.get(node.id) ?? 0;
  return (
    <div className="treenode">
      <div className={`treerow ${selectedId === node.id ? "sel" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(node)}>
        <span
          className={`twist ${isOpen ? "open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasKids) onToggle(node.path);
          }}
          style={{ visibility: hasKids ? "visible" : "hidden" }}
        >
          <CaretRight size={12} />
        </span>
        <span>{node.name}</span>
        {m > 0 && <span className="cnt" title={subtreeMode ? "含下级成员总数（本节点及所有下级）" : "直接归属本部门的成员数"}>{m}</span>}
      </div>
      {hasKids && isOpen && (
        <div className="tree-children">
          {node.children.map((c) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} expanded={expanded} onToggle={onToggle} selectedId={selectedId} onSelect={onSelect} members={members} rootBadge={rootBadge} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 部门树行集合。**不含** `.tree-panel` 外框 —— 合并页要在同一块面板里把「搜索部门」放在树上方，
 * 外框和搜索框归调用方，组件只管行（骨架态也在这里，免得调用方各写一遍加载判断）。
 */
export function DeptTree({ tree, expanded, onToggle, selectedId, onSelect, members, rootBadge = "direct" }: DeptTreeProps) {
  if (tree === null) return <SkeletonRows n={8} />;
  return (
    <>
      {tree.map((n) => (
        <TreeRow key={n.id} node={n} depth={0} expanded={expanded} onToggle={onToggle} selectedId={selectedId} onSelect={onSelect} members={members} rootBadge={rootBadge} />
      ))}
    </>
  );
}
