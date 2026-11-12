// 组织画布布局算法（复刻 scaffold-master OrgCanvas.vue 的「整齐树」tidy tree 布局）
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/OrgCanvas.vue
//   （Vue 版把布局写在 <script setup> 的 computed 里；这里抽成纯函数模块，
//    与 OrgUsers.tsx「口径纯函数化、探针直接钉」的风格一致）
//
// 算法要点（与 Vue 版逐行对应，不重新发明）：
//   叶子节点按 cursor 水平步进占位；父节点 x = 首尾子节点 x 的均值 ——
//   即「父居中于子树」，这是整齐树视觉整齐的根本。
//   连线用「直角 + 圆角过渡」贝塞尔（先垂直下 GAP_Y/2，横移，再垂直入子），
//   比直线更像组织图，比纯曲线更稳。
//
// 为什么砍掉 Vue 版的 status / leader：Reactor 的 DeptNode 只有
// {id,name,path,children}，没有这两个字段；leader 由调用方用 dept_head
// 反查后单独传（见 components/OrgCanvas.tsx），布局层不关心。

import type { DeptNode } from "../types";

export const NODE_W = 196;
export const NODE_H = 72;
export const GAP_X = 26;
export const GAP_Y = 64;

export interface LaidNode {
  dept: DeptNode;
  /** 节点左上角在布局坐标系里的位置（像素） */
  x: number;
  y: number;
  depth: number;
  /** 一级分支序号（决定 cat-N 配色，只用于区分一级分支） */
  branch: number;
  parentId: number | null;
  hasChildren: boolean;
}

export interface LaidLink {
  /** 子节点 id（连线唯一键） */
  id: number;
  /** SVG path 的 d 属性 */
  d: string;
  depth: number;
  branch: number;
}

export interface OrgLayout {
  nodes: LaidNode[];
  links: LaidLink[];
  width: number;
  height: number;
}

/**
 * 整齐树布局。`collapsed` 里的节点按叶子处理（不展开后代）——
 * 折叠只改布局，不改传入的 tree。
 */
export function layoutOrgTree(tree: DeptNode[], collapsed: ReadonlySet<number> = new Set()): OrgLayout {
  const nodes: LaidNode[] = [];
  let cursor = 0;

  const place = (dept: DeptNode, depth: number, branch: number, parentId: number | null): number => {
    const kids = collapsed.has(dept.id) ? [] : (dept.children ?? []);
    let x: number;
    if (!kids.length) {
      x = cursor;
      cursor += NODE_W + GAP_X;
    } else {
      const xs = kids.map((child, i) => place(child, depth + 1, depth === 0 ? i : branch, dept.id));
      // kids.length > 0 时 xs 必然非空（上面已分支），非空断言是给 tsc 的说明
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    nodes.push({ dept, x, y: depth * (NODE_H + GAP_Y), depth, branch, parentId, hasChildren: Boolean(dept.children?.length) });
    return x;
  };

  tree.forEach((root, i) => place(root, 0, i, null));

  // 按层再按 x 排序：同层节点从左到右，方向键「左右 = 同级相邻」才成立
  nodes.sort((a, b) => a.depth - b.depth || a.x - b.x);

  const byId = new Map(nodes.map((n) => [n.dept.id, n]));
  const links: LaidLink[] = nodes
    .filter((n) => n.parentId !== null && byId.has(n.parentId))
    .map((n) => {
      const p = byId.get(n.parentId as number) as LaidNode;
      const px = p.x + NODE_W / 2;
      const py = p.y + NODE_H;
      const cx = n.x + NODE_W / 2;
      const midY = py + GAP_Y / 2;
      // 圆角半径随横向距离收缩，横向很近时退化为直线段（r=0 时 Q 会画出尖角）
      const r = Math.min(10, Math.abs(cx - px) / 2);
      const dir = cx > px ? 1 : -1;
      const d =
        Math.abs(cx - px) < 1
          ? `M${px},${py} V${n.y}`
          : `M${px},${py} V${midY - r} Q${px},${midY} ${px + dir * r},${midY} H${cx - dir * r} Q${cx},${midY} ${cx},${midY + r} V${n.y}`;
      return { id: n.dept.id, d, depth: n.depth, branch: n.branch };
    });

  const width = nodes.length ? Math.max(...nodes.map((n) => n.x)) + NODE_W : 0;
  const height = nodes.length ? Math.max(...nodes.map((n) => n.y)) + NODE_H : 0;
  return { nodes, links, width, height };
}

/**
 * 部门 id → 负责人姓名列表（从全量用户里反查 role=dept_head 的成员）。
 *
 * 为什么不新增接口：OrgUsers.tsx 的 load() 本就已拉全量可见用户（成员数徽标
 * 同一个数据源），dept_head 角色和 dept 归属都在 AdminUser 上，零额外请求。
 * 注意口径：dept_head 登录时 usersApi.list() 只返回其部门子树，所以负责人
 * 映射对当前用户可见范围是完备的；不可见的部门显示「未设负责人」而不是造假。
 *
 * 返回数组而不是单个名字：一个部门理论上可以有多个负责人，节点上显示第一个，
 * title 里列全部（不静默丢弃）。
 */
export function buildLeaderMap(users: ReadonlyArray<{ id: number; name: string; role: string; dept: { id: number } | null }>): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const u of users) {
    if (u.role !== "dept_head" || !u.dept) continue;
    const list = map.get(u.dept.id) ?? [];
    list.push(u.name);
    map.set(u.dept.id, list);
  }
  return map;
}
