import { create } from "zustand";
import {
  countGenUiNodes,
  genUiTreeKey,
  type GenUiNode,
  type GenUiPatchOp,
  type GenUiTreeV1,
} from "@zcode/shared";

/**
 * GenUI 树槽位唯一所有者（docs/未完成-GenUI-消息体-最小内核-spec-v1.md §3）。
 * key = sessionId::messageId；patch 后整体替换 root 引用，订阅者按 key 切片。
 */

interface UiTreeStoreState {
  treesByKey: Record<string, GenUiTreeV1 | undefined>;
  setTree: (params: { sessionId: string; messageId: string; tree: GenUiTreeV1 }) => void;
  clearTree: (params: { sessionId: string; messageId: string }) => void;
  applyPatch: (params: {
    sessionId: string;
    messageId: string;
    ops: GenUiPatchOp[];
  }) => { ok: true; nodeCount: number } | { ok: false; error: string };
  getTree: (params: { sessionId: string; messageId: string }) => GenUiTreeV1 | undefined;
}

function findNode(root: GenUiNode, path: string): GenUiNode | null {
  // path 为 nodeId 链：root 或 root/childId/grandId
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] !== root.nodeId && parts[0] !== "root") return null;
  let current: GenUiNode = root;
  for (let i = 1; i < parts.length; i += 1) {
    const next = current.children?.find((child: GenUiNode) => child.nodeId === parts[i]);
    if (!next) return null;
    current = next;
  }
  return current;
}

function cloneNode(node: GenUiNode): GenUiNode {
  return {
    ...node,
    props: node.props ? { ...node.props } : undefined,
    children: node.children?.map((child: GenUiNode) => cloneNode(child)),
  };
}

function replaceAtPath(root: GenUiNode, path: string, node: GenUiNode): GenUiNode | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) {
    return parts[0] === root.nodeId || parts[0] === "root" ? cloneNode(node) : null;
  }
  const cloned = cloneNode(root);
  let current: GenUiNode = cloned;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const next = current.children?.find((child: GenUiNode) => child.nodeId === parts[i]);
    if (!next) return null;
    current = next;
  }
  const leafId = parts[parts.length - 1];
  const index = current.children?.findIndex((child: GenUiNode) => child.nodeId === leafId) ?? -1;
  if (!current.children || index < 0) return null;
  current.children[index] = cloneNode(node);
  return cloned;
}

function patchPropsAtPath(
  root: GenUiNode,
  path: string,
  props: Record<string, unknown>,
): GenUiNode | null {
  const target = findNode(root, path);
  if (!target) return null;
  const cloned = cloneNode(root);
  const clonedTarget = findNode(cloned, path);
  if (!clonedTarget) return null;
  clonedTarget.props = { ...clonedTarget.props, ...props };
  return cloned;
}

export const useUiTreeStore = create<UiTreeStoreState>((set, get) => ({
  treesByKey: {},
  setTree: ({ sessionId, messageId, tree }) => {
    const key = genUiTreeKey(sessionId, messageId);
    set((state) => ({ treesByKey: { ...state.treesByKey, [key]: tree } }));
  },
  clearTree: ({ sessionId, messageId }) => {
    const key = genUiTreeKey(sessionId, messageId);
    set((state) => {
      const next = { ...state.treesByKey };
      delete next[key];
      return { treesByKey: next };
    });
  },
  applyPatch: ({ sessionId, messageId, ops }) => {
    const key = genUiTreeKey(sessionId, messageId);
    const current = get().treesByKey[key];
    if (!current) return { ok: false, error: `未找到 UI 树：${key}` };
    let root = current.root;
    for (const op of ops) {
      if (op.op === "replace") {
        const next = replaceAtPath(root, op.path, op.node);
        if (!next) return { ok: false, error: `replace 路径不存在：${op.path}` };
        root = next;
      } else if (op.op === "props") {
        const next = patchPropsAtPath(root, op.path, op.props);
        if (!next) return { ok: false, error: `props 路径不存在：${op.path}` };
        root = next;
      } else {
        return { ok: false, error: `不支持的 patch 操作` };
      }
    }
    const tree: GenUiTreeV1 = { schemaVersion: "1", root };
    set((state) => ({ treesByKey: { ...state.treesByKey, [key]: tree } }));
    return { ok: true, nodeCount: countGenUiNodes(tree.root) };
  },
  getTree: ({ sessionId, messageId }) => get().treesByKey[genUiTreeKey(sessionId, messageId)],
}));
