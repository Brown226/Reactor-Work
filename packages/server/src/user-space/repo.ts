import { lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { UserSpaceConfig } from "./config.js";
import { SpaceError } from "./errors.js";
import { findFreeName, assertNoSymlinkPath, lstatOrNull, toFsError, withCopySuffix } from "./fs-utils.js";
import {
  categoryForName,
  isInsideDirectory,
  resolveSpacePath,
  resolveUserSpaceRoot,
  TRASH_DIR_NAME,
  validateSegment,
  type SpaceCategory,
} from "./paths.js";
import { moveEntryToTrash, type TrashEntryMeta } from "./trash.js";

/**
 * 我的空间文件系统操作（方案 §2 磁盘布局）。
 *
 * 所有函数先按 uid 解析空间根，再把相对路径交给 paths.ts 做边界校验；
 * 这里不直接相信任何调用方传入的路径字符串。
 */

export type SpaceEntryKind = "file" | "directory" | "other";

export interface SpaceEntry {
  name: string;
  kind: SpaceEntryKind;
  size: number;
  mtime: string;
}

export interface SpaceUsage {
  usedBytes: number;
  quotaBytes: number;
  trashBytes: number;
  byCategory: Record<SpaceCategory, number>;
}

export interface EntryStat {
  abs: string;
  name: string;
  kind: SpaceEntryKind;
  size: number;
  mtime: string;
}

/** 同名冲突时最多尝试的副本序号由 fs-utils.findFreeName 统一处理。 */
/** 上传的 wx 重试上限：与 findFreeName 的尝试上限保持一致。 */
const UPLOAD_NAME_ATTEMPTS = 1000;

function kindOf(info: { isFile(): boolean; isDirectory(): boolean }): SpaceEntryKind {
  if (info.isFile()) {
    return "file";
  }
  if (info.isDirectory()) {
    return "directory";
  }
  return "other";
}

function emptyUsage(quotaBytes: number): SpaceUsage {
  return {
    usedBytes: 0,
    quotaBytes,
    trashBytes: 0,
    byCategory: { document: 0, image: 0, drawing: 0, other: 0 },
  };
}

/** 读请求不建目录：空间不存在就按空空间返回，避免 GET 触发写盘。 */
export async function createSpaceRoot(config: UserSpaceConfig, uid: string): Promise<string> {
  const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
  const info = await lstatOrNull(root);
  if (info) {
    // 用户根被替换成符号链接时，后续所有读写都会落到链接目标（可能是别人目录/系统路径）。
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SpaceError("空间根目录异常（不是普通目录）", 409);
    }
    return root;
  }
  await mkdir(root, { recursive: true });
  return root;
}

export async function listEntries(
  config: UserSpaceConfig,
  uid: string,
  rel: string,
): Promise<SpaceEntry[]> {
  const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
  const dirAbs = resolveSpacePath(root, rel);
  // 中间段是符号链接时，lstat 最终条目仍会看到链接目标，必须先逐段拒绝。
  await assertNoSymlinkPath(root, rel, { allowMissing: true });
  const dirInfo = await lstatOrNull(dirAbs);
  if (!dirInfo) {
    if (!rel) {
      return [];
    }
    throw new SpaceError("目录不存在", 404);
  }
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new SpaceError("目标不是目录", 409);
  }
  const entries: SpaceEntry[] = [];
  for (const dirent of await readdir(dirAbs, { withFileTypes: true })) {
    // 内部目录一律不暴露：.trash 只走回收站视图；.uploads 是分片暂存；
    // .versions 是历史版本仓库。出现在文件树里只会让人误删或困惑。
    if (
      dirent.name === TRASH_DIR_NAME ||
      dirent.name === ".uploads" ||
      dirent.name === ".versions"
    ) {
      continue;
    }
    const info = await lstatOrNull(join(dirAbs, dirent.name));
    if (!info) {
      continue;
    }
    entries.push({
      name: dirent.name,
      kind: kindOf(info),
      size: info.isFile() ? info.size : 0,
      mtime: info.mtime.toISOString(),
    });
  }
  entries.sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") {
      return -1;
    }
    if (right.kind === "directory" && left.kind !== "directory") {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });
  return entries;
}

export async function createDirectory(
  config: UserSpaceConfig,
  uid: string,
  rel: string,
): Promise<void> {
  if (!rel) {
    await createSpaceRoot(config, uid);
    return;
  }
  const root = await createSpaceRoot(config, uid);
  const abs = resolveSpacePath(root, rel);
  await assertNoSymlinkPath(root, rel, { allowMissing: true });
  const existing = await lstatOrNull(abs);
  if (existing) {
    if (existing.isDirectory() && !existing.isSymbolicLink()) {
      return;
    }
    throw new SpaceError("同名文件已存在", 409);
  }
  try {
    await mkdir(abs, { recursive: true });
  } catch (error) {
    throw toFsError(error, "创建目录失败");
  }
}

async function requireDirectory(dirAbs: string): Promise<void> {
  const info = await lstatOrNull(dirAbs);
  if (!info) {
    throw new SpaceError("目标目录不存在", 404);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new SpaceError("目标不是目录", 409);
  }
}

/**
 * 上传落盘（方案 §5.4：同名不覆盖）。
 * 用 `wx` 打开而不是「先查存在再写」：并发上传同名文件时由内核保证只有一个成功，
 * 失败方换下一个序号，不留覆盖窗口。
 */
export async function uploadFile(
  config: UserSpaceConfig,
  uid: string,
  dirRel: string,
  name: string,
  data: Buffer,
): Promise<SpaceEntry> {
  const root = await createSpaceRoot(config, uid);
  const dirAbs = resolveSpacePath(root, dirRel);
  await assertNoSymlinkPath(root, dirRel, { allowMissing: false });
  await requireDirectory(dirAbs);
  for (let index = 0; index < UPLOAD_NAME_ATTEMPTS; index += 1) {
    const candidate = index === 0 ? name : withCopySuffix(name, index, true);
    const targetAbs = join(dirAbs, candidate);
    try {
      await writeFile(targetAbs, data, { flag: "wx" });
      const info = await lstat(targetAbs);
      return {
        name: candidate,
        kind: "file",
        size: info.size,
        mtime: info.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw toFsError(error, "写入文件失败");
    }
  }
  throw new SpaceError("同名文件过多，请先清理", 409);
}

/** 下载/预览前取条目：返回 null 表示不存在，kind 让调用方区分「不是普通文件」与「符号链接」。 */
export async function statEntry(
  config: UserSpaceConfig,
  uid: string,
  rel: string,
): Promise<EntryStat | null> {
  if (!rel) {
    return null;
  }
  const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
  const abs = resolveSpacePath(root, rel);
  await assertNoSymlinkPath(root, rel, { allowMissing: true });
  const info = await lstatOrNull(abs);
  if (!info) {
    return null;
  }
  return {
    abs,
    name: basename(abs),
    kind: kindOf(info),
    size: info.isFile() ? info.size : 0,
    mtime: info.mtime.toISOString(),
  };
}

export async function renameEntry(
  config: UserSpaceConfig,
  uid: string,
  rel: string,
  newName: string,
): Promise<void> {
  if (!rel) {
    throw new SpaceError("不能重命名空间根目录");
  }
  const name = validateSegment(newName, "名称");
  const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
  const abs = resolveSpacePath(root, rel);
  await assertNoSymlinkPath(root, rel, { allowMissing: false });
  const info = await lstatOrNull(abs);
  if (!info) {
    throw new SpaceError("条目不存在", 404);
  }
  const targetAbs = join(dirname(abs), name);
  if (targetAbs === abs) {
    return;
  }
  if (await lstatOrNull(targetAbs)) {
    throw new SpaceError("同名条目已存在", 409);
  }
  try {
    await rename(abs, targetAbs);
  } catch (error) {
    throw toFsError(error, "重命名失败");
  }
}

/**
 * 批量移动。目标目录内同名时自动加 ` (n)` 后缀，与上传「不覆盖」口径一致；
 * 目录移动到自身子树会触发 EINVAL，这里提前用 400 拒绝。
 */
export async function moveEntries(
  config: UserSpaceConfig,
  uid: string,
  paths: string[],
  toDirRel: string,
): Promise<number> {
  const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
  const toAbs = resolveSpacePath(root, toDirRel);
  await assertNoSymlinkPath(root, toDirRel, { allowMissing: false });
  await requireDirectory(toAbs);
  let moved = 0;
  for (const rel of paths) {
    if (!rel) {
      throw new SpaceError("不能移动空间根目录");
    }
    const srcAbs = resolveSpacePath(root, rel);
    await assertNoSymlinkPath(root, rel, { allowMissing: false });
    const info = await lstatOrNull(srcAbs);
    if (!info) {
      throw new SpaceError(`条目不存在: ${rel}`, 404);
    }
    if (info.isDirectory() && !info.isSymbolicLink() && isInsideDirectory(srcAbs, toAbs)) {
      throw new SpaceError("不能把目录移动到自身或其子目录");
    }
    const name = await findFreeName(toAbs, basename(srcAbs), info.isFile() && !info.isSymbolicLink());
    try {
      await rename(srcAbs, join(toAbs, name));
    } catch (error) {
      throw toFsError(error, "移动失败");
    }
    moved += 1;
  }
  return moved;
}

/** 删除 = 移入回收站；不释放容量（方案 §3），purge 才释放。 */
export async function deleteEntries(
  config: UserSpaceConfig,
  uid: string,
  paths: string[],
): Promise<TrashEntryMeta[]> {
  const root = await createSpaceRoot(config, uid);
  const deleted: TrashEntryMeta[] = [];
  for (const rel of paths) {
    if (!rel) {
      throw new SpaceError("不能删除空间根目录");
    }
    deleted.push(await moveEntryToTrash(root, rel));
  }
  return deleted;
}

/**
 * 用量统计（方案 §3）：
 * - usedBytes 含 .trash；trashBytes 单列；
 * - byCategory 也包含回收站里的文件，保证 sum(byCategory) === usedBytes，前端进度条能对齐；
 * - 符号链接不跟随、不计入（与 user-workspace 口径一致）。
 */
export async function computeUsage(
  config: UserSpaceConfig,
  uid: string,
): Promise<SpaceUsage> {
  const usage = emptyUsage(config.quotaBytes);
  const root = resolveUserSpaceRoot(config.workspaceRoot, uid);
  const rootInfo = await lstatOrNull(root);
  if (!rootInfo) {
    return usage;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    // 不静默返回 0：根被替换成符号链接/文件是异常状态，展示 0 会让用户误以为数据没了。
    throw new SpaceError("空间根目录异常（不是普通目录）", 409);
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const info = await lstatOrNull(abs);
      if (!info || info.isSymbolicLink()) {
        continue;
      }
      if (info.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!info.isFile()) {
        continue;
      }
      const rel = relative(root, abs);
      const segments = rel.split(sep);
      // .uploads 是分片上传的暂存区：半成品不该占用用户配额，
      // 否则传到一半失败会留下「看不见但吃掉空间」的垃圾。
      if (segments[0] === ".uploads") {
        continue;
      }
      // .trash/<id>/meta.json 是回收站实现开销（记录 id→原路径），不是用户数据：
      // 计入 usedBytes 会让「删除文件」反而涨容量。按目录项开销忽略处理（方案 §3），
      // payload 本体仍然照常统计，删除不释放容量的语义才成立。
      if (segments.length === 3 && segments[0] === TRASH_DIR_NAME && segments[2] === "meta.json") {
        continue;
      }
      usage.usedBytes += info.size;
      usage.byCategory[categoryForName(entry.name)] += info.size;
      if (rel === TRASH_DIR_NAME || rel.startsWith(`${TRASH_DIR_NAME}${sep}`)) {
        usage.trashBytes += info.size;
      }
    }
  }
  return usage;
}
