/**
 * 会话内分支树（清单 #36）—— 移植 pi-web `lib/project-tree.ts` + BranchNavigator
 * 的**纯函数部分**（MIT）。
 *
 * 数据源是内核 `SessionManager.getTree()`（权威父子关系），这里只做：
 *  1. **链压缩**（compressChain）：单子链收缩为一个可见节点（其余记入
 *     compressedEntryIds）—— 线性会话压缩成 1-2 行，只有真正的分支才展开；
 *  2. **顶层分支选择**（selectTopLevelBranches）：首消息即分叉 → 根本身是分支；
 *     否则展示第一个分叉点的孩子们；
 *  3. **活动路径**（buildActivePath）：迭代 DFS 找 root→activeLeaf 的可见节点集
 *     （线性会话深度=条目数，递归会爆栈，pi-web 同样用显式栈）；
 *  4. **有无分支**（hasBranches）。
 *
 * 渲染（缩进导轨/分支符号）留在 client 组件。
 */

/** 投影后的树节点（供渲染层直接使用） */
export interface BranchTreeNode {
  entryId: string;
  /** 首条消息预览（≤40 字符；图片块 → [image]） */
  label: string;
  /** user / assistant / undefined（非消息条目） */
  role?: "user" | "assistant";
  /** 被收缩进该节点的下游条目数（提示「这一段有 N 条」） */
  skipped: number;
  children: BranchTreeNode[];
}

export const BRANCH_PREVIEW_MAX = 40;

export interface RawTreeNode {
  id: string;
  type: string;
  message?: { role?: unknown; content?: unknown };
  children?: RawTreeNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendPreviewText(current: string, value: unknown): string {
  if (typeof value !== "string" || current.length > BRANCH_PREVIEW_MAX) return current;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return current;
  const prefix = current + (current ? " " : "");
  if (prefix.length >= BRANCH_PREVIEW_MAX + 1) return prefix.slice(0, BRANCH_PREVIEW_MAX + 1);
  return prefix + normalized.slice(0, BRANCH_PREVIEW_MAX + 1 - prefix.length);
}

/** 首条消息 → 预览（对齐 pi-web `previewForEntry`：截 40 字符 / [image] / [assistant]） */
export function previewForEntry(entry: RawTreeNode): { label: string; role?: "user" | "assistant" } {
  if (entry.type !== "message" || !isRecord(entry.message) || typeof entry.message.role !== "string") {
    return { label: entry.type };
  }
  const content = entry.message.content;
  let text = "";
  let hasImage = false;
  if (typeof content === "string") {
    text = appendPreviewText(text, content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "image") hasImage = true;
      if (block.type === "text") text = appendPreviewText(text, block.text);
      if (text.length > BRANCH_PREVIEW_MAX) break;
    }
  }
  if (text.length > BRANCH_PREVIEW_MAX) {
    text = text.slice(0, BRANCH_PREVIEW_MAX) + "…";
  } else if (!text) {
    text = hasImage ? "[image]" : entry.message.role === "assistant" ? "[assistant]" : "message";
  }
  const role = entry.message.role === "user" || entry.message.role === "assistant"
    ? (entry.message.role as "user" | "assistant")
    : undefined;
  return { label: text, role };
}

/** 内核树 → 投影树（收缩单子链、携带预览）。迭代实现（防爆栈）。 */
export function projectBranchTree(roots: RawTreeNode[]): BranchTreeNode[] {
  const projectNode = (raw: RawTreeNode): BranchTreeNode => {
    // 压缩：沿唯一子链下探，直到分叉/叶子
    let current = raw;
    let skipped = 0;
    while (current.children?.length === 1) {
      current = current.children[0]!;
      skipped += 1;
    }
    const { label, role } = previewForEntry(current);
    return {
      entryId: current.id,
      label,
      ...(role ? { role } : {}),
      skipped,
      children: (current.children ?? []).map(projectNode),
    };
  };
  return roots.map(projectNode);
}

/** 顶层行：多根 = 根即分支；否则取第一个分叉点的孩子们；无分支 → 空数组 */
export function selectTopLevelBranches(tree: BranchTreeNode[]): BranchTreeNode[] {
  if (tree.length > 1) return tree;
  if (tree.length === 0) return [];
  const first = tree[0]!;
  return first.children.length > 1 ? first.children : [];
}

/** root→target 的可见节点集（迭代 DFS，对齐 pi-web `buildActivePath`） */
export function buildActivePath(nodes: BranchTreeNode[], targetId: string | null): Set<string> {
  const pathIds = new Set<string>();
  if (!targetId) return pathIds;
  const stack: Array<{ node: BranchTreeNode; path: string[] }> = nodes.map((n) => ({ node: n, path: [n.entryId] }));
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node.entryId === targetId) {
      for (const id of path) pathIds.add(id);
      return pathIds;
    }
    for (const child of node.children) stack.push({ node: child, path: [...path, child.entryId] });
  }
  return pathIds;
}

/** 会话是否存在分支（迭代；线性链无分支） */
export function hasBranches(nodes: BranchTreeNode[]): boolean {
  if (nodes.length > 1) return true;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.length > 1) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}
