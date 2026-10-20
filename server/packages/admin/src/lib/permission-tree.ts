// 权限码 → 层级树（复刻 scaffold PermissionTree 的树形组织，降维为只读）
//
// 来源：server/scaffold-master/scaffold-vue/src/components/business/PermissionTree.vue
//   （Vue 版：菜单树 dir/menu/btn 三级 + 可勾选授权 + 级联 + 未保存浮条）
//
// 复刻取舍（为什么不是照搬）：
//   Reactor 的权限模型是**固定三角色 + 只读**（角色→权限映射硬编码在服务端
//   permissionAllowed()，没有在线授权写接口），所以：
//   - 保留：层级组织（目录 → 模块 → 动作）、折叠展开、三态覆盖展示
//   - 去掉：勾选/级联/保存（Reactor 没有授权写接口，做了也是假的——与 B0
//     PermissionMatrix 同一套降维逻辑）
//   - 行尾的「角色覆盖」替代勾选框：每行展示三个角色对该节点的覆盖情况
//
// 目录段名保持权限码原文（admin / skills / read），不建 area→中文 映射表——
// 前端另建映射会和后端口径漂移（B0 PermissionMatrix 的同一原则，中文区名
// 由服务端 description 提供，取不到就展示原文）。

import type { PermissionPoint } from "../services/permissions";

/** 动作段（权限码末段）→ 中文；未知动作原样展示。PermissionMatrix 也复用这一份 */
export const ACTION_LABEL: Record<string, string> = { read: "查看", create: "创建/执行", update: "修改", delete: "删除" };

export interface PermTreeNode {
  /** 目录=完整前缀（如 `admin:skills`）；叶子=完整权限码（如 `admin:skills:*:read`） */
  key: string;
  /** 显示名：目录=当前段名；叶子=动作段名（read/create/…） */
  label: string;
  depth: number;
  /** true=目录（可折叠）；false=叶子（权限点） */
  isDir: boolean;
  /** 目录的直接子节点（目录在前，其余按 key 排序） */
  children: PermTreeNode[];
  /** 叶子节点携带的权限点原始数据 */
  point?: PermissionPoint;
}

/**
 * 把权限点清单聚合成层级树。权限码按 `:` 分段：
 * `admin:skills:*:read` → 目录 `admin` → 目录 `admin:skills` → 目录 `admin:skills:*` → 叶子。
 *
 * 排序口径：入参已按 code 排序（调用方保证），因此同层节点天然有序；
 * 重复 code 的权限点不会重复建节点（code 是主键，正常不会重复，这里是防御）。
 */
export function buildPermissionTree(points: PermissionPoint[]): PermTreeNode[] {
  const roots: PermTreeNode[] = [];
  const index = new Map<string, PermTreeNode>();

  for (const point of points) {
    const segs = point.code.split(":");
    let siblings = roots;
    let prefix = "";
    segs.forEach((seg, i) => {
      prefix = i === 0 ? seg : `${prefix}:${seg}`;
      const isLeaf = i === segs.length - 1;
      let node = index.get(prefix);
      if (!node) {
        node = { key: prefix, label: seg, depth: i, isDir: !isLeaf, children: [], point: isLeaf ? point : undefined };
        index.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    });
  }
  return roots;
}

/** 节点子树下的全部叶子权限点（目录自身不是叶子） */
export function leavesOf(node: PermTreeNode, out: PermissionPoint[] = []): PermissionPoint[] {
  if (!node.isDir && node.point) out.push(node.point);
  for (const child of node.children) leavesOf(child, out);
  return out;
}

/**
 * 搜索过滤：命中（code/path/description 含关键词）的叶子整枝保留，
 * 未命中但有后代命中的目录保留为"路径"。返回 `autoOpen` = 所有因后代命中
 * 而保留的目录 key —— 搜索态必须展开它们，否则"搜到了却看不见"
 * （与 DeptTree.filterDeptTree 同一手法）。
 */
export function filterPermissionTree(
  nodes: PermTreeNode[],
  query: string,
  autoOpen: Set<string> = new Set(),
): { tree: PermTreeNode[]; autoOpen: Set<string> } {
  const q = query.trim().toLowerCase();
  if (q === "") return { tree: nodes, autoOpen };
  const hit = (point: PermissionPoint) =>
    point.code.toLowerCase().includes(q) ||
    point.path.toLowerCase().includes(q) ||
    (point.description ?? "").toLowerCase().includes(q);
  const walk = (node: PermTreeNode): PermTreeNode | null => {
    if (!node.isDir) return node.point && hit(node.point) ? node : null;
    const kids = node.children.map(walk).filter((n): n is PermTreeNode => n !== null);
    if (kids.length === 0) return null;
    autoOpen.add(node.key);
    return { ...node, children: kids };
  };
  return { tree: nodes.map(walk).filter((n): n is PermTreeNode => n !== null), autoOpen };
}
