import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SpaceError } from "./errors.js";
import { assertNoSymlinkPath, findFreeName, lstatOrNull, statTreeSize, toFsError } from "./fs-utils.js";
import {
  normalizeSpacePath,
  resolveSpacePath,
  TRASH_DIR_NAME,
  TRASH_ITEM_ID_PATTERN,
} from "./paths.js";

/**
 * 回收站（方案 §2 / §3）。
 *
 * 布局：<空间根>/.trash/<uuid>/{meta.json,payload}
 * - 删除 = rename 到 payload，不复制字节，因此不释放容量（usedBytes 仍统计 .trash）；
 * - 只有 purge 才真正删除并释放容量；
 * - meta.json 由服务端写入，读取时仍做严格校验：磁盘可能被外部改动，不能信任内容。
 */

export interface TrashItem {
  id: string;
  name: string;
  size: number;
  deletedAt: string;
  fromPath: string;
}

/** 删除操作的返回项：与回收站列表同形状，前端可直接把删除结果并入本地列表。 */
export type TrashEntryMeta = TrashItem;

interface TrashMetaFile {
  name: string;
  deletedAt: string;
  fromPath: string;
  size: number;
}

function isTrashMetaFile(value: unknown): value is TrashMetaFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.deletedAt === "string" &&
    !Number.isNaN(Date.parse(record.deletedAt)) &&
    typeof record.fromPath === "string" &&
    typeof record.size === "number" &&
    Number.isFinite(record.size) &&
    record.size >= 0
  );
}

function requireTrashItemId(id: string): string {
  if (!TRASH_ITEM_ID_PATTERN.test(id)) {
    throw new SpaceError("回收站条目 id 不合法");
  }
  return id;
}

async function readTrashMeta(itemDir: string): Promise<TrashMetaFile | null> {
  const metaPath = join(itemDir, "meta.json");
  const info = await lstatOrNull(metaPath);
  // meta.json 被替换成符号链接时不读取（避免读空间外文件），按损坏条目处理。
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    return isTrashMetaFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * .trash 本身也可能是符号链接：工作区 agent 有完整磁盘权限，能删除/替换它。
 * 所有回收站读写前先确认它是真实目录，避免 readdir/rename 落到空间外。
 * create=false 且不存在时返回 null（列表按空回收站处理）。
 */
async function requireTrashRoot(root: string, create: true): Promise<string>;
async function requireTrashRoot(root: string, create: false): Promise<string | null>;
async function requireTrashRoot(root: string, create: boolean): Promise<string | null> {
  const trashRoot = join(root, TRASH_DIR_NAME);
  const info = await lstatOrNull(trashRoot);
  if (!info) {
    if (!create) {
      return null;
    }
    await mkdir(trashRoot, { recursive: true });
    return trashRoot;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SpaceError("回收站目录异常（不是普通目录）", 409);
  }
  return trashRoot;
}

/** 列出 .trash 下合法条目目录的 id（损坏/非目录条目跳过）。 */
async function listTrashIds(root: string): Promise<string[]> {
  const trashRoot = await requireTrashRoot(root, false);
  if (!trashRoot) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(trashRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && TRASH_ITEM_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

export async function listTrashItems(root: string): Promise<TrashItem[]> {
  const trashRoot = await requireTrashRoot(root, false);
  if (!trashRoot) {
    return [];
  }
  const items: TrashItem[] = [];
  for (const id of await listTrashIds(root)) {
    const itemDir = join(trashRoot, id);
    const meta = await readTrashMeta(itemDir);
    if (!meta) {
      // 半写入/被外部破坏的条目：跳过而不是让整个回收站 500，用户仍可 purge 清空。
      continue;
    }
    const payload = await lstatOrNull(join(itemDir, "payload"));
    if (!payload) {
      continue;
    }
    items.push({
      id,
      name: meta.name,
      size: meta.size,
      deletedAt: meta.deletedAt,
      fromPath: meta.fromPath,
    });
  }
  items.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  return items;
}

/**
 * 删除单项：先写 meta 再 rename payload。
 * 顺序保证任何时刻都不会出现「payload 已进回收站但 meta 丢失」的不可还原状态；
 * rename 失败时清掉刚建的条目目录，原文件不受影响。
 */
export async function moveEntryToTrash(root: string, rawRel: string): Promise<TrashEntryMeta> {
  const rel = normalizeSpacePath(rawRel);
  if (!rel) {
    throw new SpaceError("不能删除空间根目录");
  }
  const abs = resolveSpacePath(root, rel);
  await assertNoSymlinkPath(root, rel, { allowMissing: false });
  const info = await lstatOrNull(abs);
  if (!info) {
    throw new SpaceError("要删除的条目不存在", 404);
  }
  const trashRoot = await requireTrashRoot(root, true);
  const id = randomUUID();
  const itemDir = join(trashRoot, id);
  await mkdir(itemDir, { recursive: true });
  const itemInfo = await lstatOrNull(itemDir);
  if (!itemInfo || itemInfo.isSymbolicLink() || !itemInfo.isDirectory()) {
    throw new SpaceError("回收站条目目录异常", 409);
  }
  const meta: TrashMetaFile = {
    name: basename(abs),
    deletedAt: new Date().toISOString(),
    fromPath: rel,
    size: await statTreeSize(abs),
  };
  try {
    await writeFile(join(itemDir, "meta.json"), JSON.stringify(meta), "utf8");
    await rename(abs, join(itemDir, "payload"));
  } catch (error) {
    // rename 失败时原文件仍在原位，清掉刚建的条目目录；清理再失败也不掩盖原始 errno。
    await rm(itemDir, { recursive: true, force: true }).catch(() => undefined);
    throw toFsError(error, "移入回收站失败");
  }
  return { id, ...meta };
}

/**
 * 还原到 meta.fromPath；原路径被占用时加 ` (n)` 后缀（方案 §3 / 任务约定：不覆盖）。
 * 父目录可能已被删除，这里递归补建。
 */
export async function restoreTrashItems(root: string, ids: string[]): Promise<number> {
  const trashRoot = await requireTrashRoot(root, false);
  if (!trashRoot) {
    throw new SpaceError("回收站为空", 404);
  }
  let restored = 0;
  for (const rawId of ids) {
    const id = requireTrashItemId(rawId);
    const itemDir = join(trashRoot, id);
    const info = await lstatOrNull(itemDir);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw new SpaceError(`回收站条目不存在: ${id}`, 404);
    }
    const meta = await readTrashMeta(itemDir);
    if (!meta) {
      throw new SpaceError(`回收站条目记录损坏: ${id}`, 409);
    }
    const payloadAbs = join(itemDir, "payload");
    const payloadInfo = await lstatOrNull(payloadAbs);
    if (!payloadInfo) {
      throw new SpaceError(`回收站条目缺少文件内容: ${id}`, 409);
    }
    let targetRel: string;
    try {
      targetRel = normalizeSpacePath(meta.fromPath);
    } catch {
      throw new SpaceError(`回收站记录中的原路径不合法: ${id}`, 409);
    }
    if (!targetRel) {
      throw new SpaceError(`回收站记录缺少原路径: ${id}`, 409);
    }
    // 原路径的中间目录若被替换成符号链接，还原会写到空间外；逐段确认后再补建父目录。
    await assertNoSymlinkPath(root, targetRel, { allowMissing: true });
    const targetAbs = resolveSpacePath(root, targetRel);
    await mkdir(dirname(targetAbs), { recursive: true });
    let finalAbs = targetAbs;
    if (await lstatOrNull(targetAbs)) {
      const name = await findFreeName(
        dirname(targetAbs),
        basename(targetAbs),
        payloadInfo.isFile() && !payloadInfo.isSymbolicLink(),
      );
      finalAbs = join(dirname(targetAbs), name);
    }
    try {
      await rename(payloadAbs, finalAbs);
      // 文件已经还原成功；meta 目录清理失败不应把成功操作报成失败（重试反而会 404）。
      await rm(itemDir, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      throw toFsError(error, "还原失败");
    }
    restored += 1;
  }
  return restored;
}

/** 彻底删除：ids 为空数组时清空整个回收站（方案 §4）。返回释放的字节数。 */
export async function purgeTrashItems(
  root: string,
  ids: string[],
): Promise<{ purged: number; freedBytes: number }> {
  const trashRoot = await requireTrashRoot(root, false);
  if (!trashRoot) {
    return { purged: 0, freedBytes: 0 };
  }
  const targets = ids.length > 0 ? ids.map(requireTrashItemId) : await listTrashIds(root);
  let purged = 0;
  let freedBytes = 0;
  for (const id of targets) {
    const itemDir = join(trashRoot, id);
    const info = await lstatOrNull(itemDir);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw new SpaceError(`回收站条目不存在: ${id}`, 404);
    }
    // meta.json 是回收站元数据；用量口径不计它（见 repo.computeUsage），
    // 这里也从释放字节中扣除，保证 freedBytes 与 usedBytes 的下降量一致。
    const metaInfo = await lstatOrNull(join(itemDir, "meta.json"));
    const itemBytes = await statTreeSize(itemDir);
    freedBytes += Math.max(0, itemBytes - (metaInfo?.size ?? 0));
    try {
      await rm(itemDir, { recursive: true, force: true });
    } catch (error) {
      throw toFsError(error, "彻底删除失败");
    }
    purged += 1;
  }
  return { purged, freedBytes };
}
