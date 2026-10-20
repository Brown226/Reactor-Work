// Reactor 管理台 · 组织画布的「分析栏」数据装配
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/InsightPanel.vue
//   （纯展示容器：分类 → 标题/状态 → 主读数 + 迷你柱 → 读数块 → 洞察卡 → 关联芯片）
//
// 为什么把装配抽成纯函数、而不是写在组件里：
//   1. 洞察卡是**有依据才生成**的（空部门 / 未设负责人 / 下级较多），
//      条件判断放在纯函数里能单测，也避免 JSX 里堆三元；
//   2. 画布组件只负责交互（缩放/选中），不该同时承担「业务结论」的计算；
//   3. 与 B1 的 lib/usage-format.ts、B2 的 lib/org-layout.ts 同一手法。
//
// 数据口径（不造假）：
//   - Reactor 的 DeptNode 只有 {id,name,path,children}，**没有 status**，
//     所以状态行只在能推出结论时写（如「末级部门」），否则不渲染；
//   - 负责人由调用方用 dept_head 反查（buildLeaderMap），无来源时显示「未设负责人」；
//   - 成员数一律来自「部门 id → 直接归属人数」，含下级用 subtreeMemberCount 现算。

import { parentIdOf, subtreeMemberCount } from "../components/DeptTree";
import type { DeptNode } from "../types";

/* ────────────────────────── 展示模型（与 InsightPanel 组件的 props 同形） ────────────────────────── */

export interface InsightTile {
  label: string;
  value: number | string | null;
  unit?: string;
}

export interface InsightCard {
  tone?: "info" | "warn" | "ok" | "danger";
  title: string;
  text: string;
}

export interface InsightChip {
  id: string;
  label: string;
  sub?: string;
  tone?: "danger" | "off";
}

export interface InsightGroup {
  title: string;
  chips: InsightChip[];
  /** 超出 chips 显示数量的剩余个数（不静默丢弃） */
  more?: number;
}

/** 组织画布专用：芯片要能点着下钻，所以额外带上部门 id */
export interface DeptInsightChip extends InsightChip {
  deptId?: number;
}

export interface DeptInsightGroup extends Omit<InsightGroup, "chips"> {
  chips: DeptInsightChip[];
}

export interface DeptInsight {
  kind: string;
  title: string;
  subtitle?: string;
  status?: string;
  metric?: { label: string; value: number | null; unit?: string; bars?: number[] };
  tiles: InsightTile[];
  insights: InsightCard[];
  groups: DeptInsightGroup[];
}

/** 一棵子树里的部门总数（含自身） */
export function deptCountOf(node: DeptNode): number {
  return 1 + node.children.reduce((sum, child) => sum + deptCountOf(child), 0);
}

/** 展示用的直属下级上限：画布浮层只有 360px，超过就折叠成 +N */
const MAX_CHIPS = 6;

function chipsOf(nodes: readonly DeptNode[], members: Map<number, number>): { chips: DeptInsightChip[]; more?: number } {
  const all = nodes.map((n) => ({
    id: String(n.id),
    label: n.name,
    sub: `${subtreeMemberCount(n, members)} 人`,
    deptId: n.id,
  }));
  return all.length > MAX_CHIPS ? { chips: all.slice(0, MAX_CHIPS), more: all.length - MAX_CHIPS } : { chips: all };
}

/**
 * 把选中的部门装配成分析栏内容。
 *
 * `roots` 只用于反查父部门（树接口不下发 parentId），`members` 是直接归属人数。
 */
export function buildDeptInsight(
  node: DeptNode,
  roots: readonly DeptNode[],
  members: Map<number, number>,
  leaders?: Map<number, string[]>,
): DeptInsight {
  const direct = members.get(node.id) ?? 0;
  const total = subtreeMemberCount(node, members);
  const childCount = node.children.length;
  const descendants = deptCountOf(node) - 1;
  const leaderList = leaders?.get(node.id) ?? [];
  const depth = node.path.split("/").length;

  /* 状态行：只写能从数据推出的结论（Reactor 无 status 字段） */
  let status: string | undefined;
  if (total === 0) status = "该部门及其下级暂无成员";
  else if (childCount === 0) status = "末级部门，没有下级";
  else status = `${childCount} 个直属下级 · 共 ${descendants} 个下级部门`;

  /* 洞察卡：每条都必须有数据依据，宁缺毋滥 */
  const insights: InsightCard[] = [];
  if (total === 0) {
    insights.push({ tone: "warn", title: "空部门", text: "本节点与全部下级都没有归属成员，可考虑在列表态把该部门合并或删除。" });
  }
  if (leaderList.length === 0) {
    insights.push({ tone: "warn", title: "未设负责人", text: "该部门没有 dept_head 角色的成员。可在列表态给成员调整角色后，画布节点会自动显示负责人。" });
  } else if (leaderList.length > 1) {
    insights.push({ tone: "info", title: "多名负责人", text: `${leaderList.join("、")} 都是该部门的部门负责人，节点只显示第一位。` });
  }
  if (childCount >= 5) {
    insights.push({ tone: "info", title: "下级较多", text: `${childCount} 个直属下级在画布中会占较宽的一行，可点节点右下角的 − 收起，或双击节点聚焦。` });
  }
  if (direct > 0 && childCount === 0) {
    insights.push({ tone: "ok", title: "成员全部直属", text: `${direct} 名成员直接挂在该部门下，没有下级分摊。` });
  }

  /* 关联芯片：下级 + 同级（同级用于在画布上横向跳转） */
  const groups: DeptInsightGroup[] = [];
  if (childCount > 0) {
    groups.push({ title: "下级部门", ...chipsOf(node.children, members) });
  }
  const parentId = parentIdOf(node, [...roots]);
  const parent = parentId == null ? null : findDeptNode([...roots], parentId);
  const siblings = parent ? parent.children.filter((c) => c.id !== node.id) : [];
  if (siblings.length > 0) {
    groups.push({ title: "同级部门", ...chipsOf(siblings, members) });
  }

  return {
    // 分类标签写层级而不是「下级部门」——后者读起来像「它的下级」，
    // 实际语义是「非顶层部门」，容易误解（B4 联调时发现）。
    kind: depth === 1 ? "顶层部门" : `${depth} 级部门`,
    title: node.name,
    subtitle: node.path,
    status,
    metric: {
      label: "含下级成员",
      value: total,
      unit: "人",
      // 迷你柱：各直属下级的含下级人数；末级部门退化为「直接成员」单柱
      bars: childCount > 0 ? node.children.map((c) => subtreeMemberCount(c, members)) : [direct],
    },
    tiles: [
      { label: "直接成员", value: direct, unit: "人" },
      { label: "含下级", value: total, unit: "人" },
      { label: "下级部门", value: descendants, unit: "个" },
      { label: "层级", value: depth, unit: "级" },
    ],
    insights,
    groups,
  };
}

/** 按 id 在部门树里找节点（分析栏芯片下钻用；与 OrgUsers 的 findDept 同义，此处供组件层复用） */
export function findDeptNode(nodes: DeptNode[], id: number): DeptNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findDeptNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}
