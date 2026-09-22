/**
 * 部门树仓储：任意深度，path 列(root→leaf 用 "/" 连接)作为唯一键。
 * 数据量小(单企业)，全量载入内存处理即可；同步/登录时按路径逐级 upsert。
 */

import type { IdentityDb } from "./db.js";

export interface Dept {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  depth: number;
}

export async function loadAllDepts(db: IdentityDb): Promise<Dept[]> {
  const { rows } = await db.pool.query<{
    id: number;
    parent_id: number | null;
    name: string;
    path: string;
    depth: number;
  }>("SELECT id, parent_id, name, path, depth FROM departments ORDER BY path");
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    path: r.path,
    depth: r.depth,
  }));
}

/** 按 root→leaf 路径确保部门存在，返回叶节点 id（并发安全：冲突时取回已有行）。 */
export async function ensureDeptPath(db: IdentityDb, parts: string[]): Promise<number> {
  let parentId: number | null = null;
  let path = "";
  let leafId = 0;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    path = path ? `${path}/${name}` : name;
    const existing = await db.pool.query<{ id: number }>(
      "SELECT id FROM departments WHERE parent_id IS NOT DISTINCT FROM $1 AND name = $2",
      [parentId, name],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      leafId = existing.rows[0]!.id;
    } else {
      const inserted = await db.pool.query<{ id: number }>(
        `INSERT INTO departments (parent_id, name, path, depth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (parent_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [parentId, name, path, i + 1],
      );
      leafId = inserted.rows[0]!.id;
    }
    parentId = leafId;
  }
  return leafId;
}

/** 返回节点自身 + 全部后代 id（含 rootId）。 */
export function subtreeIds(depts: Dept[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  const byParent = new Map<number | null, Dept[]>();
  for (const d of depts) {
    const arr = byParent.get(d.parentId) ?? [];
    arr.push(d);
    byParent.set(d.parentId, arr);
  }
  const walk = (id: number): void => {
    const children = byParent.get(id) ?? [];
    for (const c of children) {
      ids.add(c.id);
      walk(c.id);
    }
  };
  walk(rootId);
  return ids;
}

export interface DeptTreeNode {
  id: number;
  name: string;
  path: string;
  children: DeptTreeNode[];
}

/** 建树（rootId 缺省 = 顶层；给定 rootId 则只含该子树）。 */
export function buildDeptTree(depts: Dept[], rootId?: number): DeptTreeNode[] {
  const roots = rootId === undefined ? depts.filter((d) => d.parentId === null) : depts.filter((d) => d.id === rootId);
  const byParent = new Map<number | null, Dept[]>();
  for (const d of depts) {
    const arr = byParent.get(d.parentId) ?? [];
    arr.push(d);
    byParent.set(d.parentId, arr);
  }
  const toNode = (d: Dept): DeptTreeNode => ({
    id: d.id,
    name: d.name,
    path: d.path,
    children: (byParent.get(d.id) ?? []).map(toNode),
  });
  return roots.map(toNode);
}

// ---------------------------------------------------------------------------
// 部门 CRUD（U-1）：后台微调只写平台库，不写回 AD。
// path 是唯一键（root→leaf 用 "/" 连接），改名/移动需同步重写整棵子树。
// ---------------------------------------------------------------------------

export const DEPT_NAME_MAX = 64;

function normalizeDeptName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function assertDeptName(name: string): void {
  if (!name) throw new Error("部门名称不能为空");
  if (name.length > DEPT_NAME_MAX) throw new Error(`部门名称不超过 ${DEPT_NAME_MAX} 字`);
  if (name.includes("/")) throw new Error("部门名称不能包含斜杠");
}

/** 新建部门（parentId=null 为顶层） */
export async function createDept(
  db: IdentityDb,
  input: { parentId: number | null; name: string },
): Promise<Dept> {
  const name = normalizeDeptName(input.name);
  assertDeptName(name);
  const all = await loadAllDepts(db);
  const parent = input.parentId === null ? null : all.find((d) => d.id === input.parentId) ?? null;
  if (input.parentId !== null && !parent) throw new Error("上级部门不存在");
  const path = parent ? `${parent.path}/${name}` : name;
  const depth = parent ? parent.depth + 1 : 1;
  try {
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO departments (parent_id, name, path, depth) VALUES ($1,$2,$3,$4) RETURNING id`,
      [parent?.id ?? null, name, path, depth],
    );
    return (await loadAllDepts(db)).find((d) => d.id === rows[0]!.id)!;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new Error("同级下已存在同名部门");
    throw e;
  }
}

/** 改名/移动：事务内重写该节点及其全部后代的 path/depth */
export async function updateDept(
  db: IdentityDb,
  id: number,
  patch: { name?: string; parentId?: number | null },
): Promise<Dept> {
  const all = await loadAllDepts(db);
  const node = all.find((d) => d.id === id);
  if (!node) throw new Error("部门不存在");

  const name = patch.name === undefined ? node.name : normalizeDeptName(patch.name);
  assertDeptName(name);

  const nextParentId = patch.parentId === undefined ? node.parentId : patch.parentId;
  if (nextParentId === id) throw new Error("不能把部门移动到自身");
  const parent = nextParentId === null ? null : all.find((d) => d.id === nextParentId) ?? null;
  if (nextParentId !== null && !parent) throw new Error("上级部门不存在");
  // 环检测：新上级不能是本节点的后代
  for (let cursor = parent; cursor; ) {
    if (cursor.id === id) throw new Error("不能把部门移动到自己的下级");
    cursor = cursor.parentId === null ? null : all.find((d) => d.id === cursor!.parentId) ?? null;
  }

  const newPath = parent ? `${parent.path}/${name}` : name;
  const depthDelta = (parent ? parent.depth + 1 : 1) - node.depth;
  const subtree = all.filter((d) => d.path === node.path || d.path.startsWith(`${node.path}/`));

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const dept of subtree) {
      const suffix = dept.path === node.path ? "" : dept.path.slice(node.path.length);
      const path = dept === node ? newPath : `${newPath}${suffix}`;
      await client.query(
        `UPDATE departments SET path = $1, depth = $2, name = $3, parent_id = $4, updated_at = now() WHERE id = $5`,
        [
          path,
          dept.depth + depthDelta,
          dept === node ? name : dept.name,
          dept === node ? parent?.id ?? null : dept.parentId,
          dept.id,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    if ((e as { code?: string }).code === "23505") throw new Error("目标位置已存在同名部门");
    throw e;
  } finally {
    client.release();
  }
  return (await loadAllDepts(db)).find((d) => d.id === id)!;
}

/** 删除部门：有下级或仍有成员时拒绝（显式优先于级联） */
export async function deleteDept(db: IdentityDb, id: number): Promise<void> {
  const all = await loadAllDepts(db);
  const node = all.find((d) => d.id === id);
  if (!node) throw new Error("部门不存在");
  if (all.some((d) => d.parentId === id)) throw new Error("请先删除或移走下级部门");
  const { rows } = await db.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE department_id = $1",
    [id],
  );
  const count = rows[0]?.n ?? 0;
  if (count > 0) throw new Error(`该部门下还有 ${count} 名成员，请先调岗`);
  await db.pool.query("DELETE FROM departments WHERE id = $1", [id]);
}

/**
 * 按 id 取单个部门。
 *
 * 反馈提交这类一次性场景只为了拿一个部门名，不该为此把整棵部门树载进内存；
 * 这里只查自己要的两个列，且不参与树的内存模型。
 */
export async function findDeptById(
  db: IdentityDb,
  id: number,
): Promise<{ id: number; name: string; path: string } | null> {
  const { rows } = await db.pool.query<{ id: number; name: string; path: string }>(
    "SELECT id, name, path FROM departments WHERE id = $1",
    [id],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, path: row.path } : null;
}
