import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { SpaceError, type SpaceErrorStatus } from "./errors.js";

/** lstat 且把「不存在」折叠成 null：调用的地方大多是「有就处理、没有就跳过」。 */
export async function lstatOrNull(abs: string): Promise<Stats | null> {
  try {
    return await lstat(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * 逐段 lstat，拒绝路径中任何一层符号链接（方案 §5.3）。
 *
 * 只对最终条目做 lstat 是不够的：内核会跟随**中间**段的符号链接，
 * 例如 `link/passwd` 中 link → /etc 时，最终 lstat 看到的是 /etc/passwd 的普通文件，
 * 词法上的「在空间根内」校验仍然通过，实际已经读到空间外的文件。
 *
 * allowMissing=true 用于「即将创建」的目标：遇到不存在的段就停止检查（更深层不可能存在）。
 */
export async function assertNoSymlinkPath(
  rootAbs: string,
  rel: string,
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const segments = rel ? rel.split("/") : [];
  let current = rootAbs;
  const rootInfo = await lstatOrNull(current);
  if (rootInfo?.isSymbolicLink()) {
    throw new SpaceError("路径中的符号链接不被支持");
  }
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstatOrNull(current);
    if (!info) {
      if (options.allowMissing) {
        return;
      }
      throw new SpaceError("条目不存在", 404);
    }
    if (info.isSymbolicLink()) {
      throw new SpaceError("路径中的符号链接不被支持");
    }
  }
}

/**
 * 递归统计字节数（异步 fs，方案 §5.3）。
 *
 * - 符号链接不跟随也不计入：否则能把空间外的文件算进配额，也防目录环；
 * - 子项读不动时跳过该子项：统计失败不应该让删除/还原整体 500（与 user-workspace 口径一致）。
 */
export async function statTreeSize(abs: string): Promise<number> {
  const rootInfo = await lstatOrNull(abs);
  if (!rootInfo || rootInfo.isSymbolicLink()) {
    return 0;
  }
  if (rootInfo.isFile()) {
    return rootInfo.size;
  }
  if (!rootInfo.isDirectory()) {
    return 0;
  }
  let total = 0;
  // 显式栈而不是递归：深度目录不会被调用栈限制截断。
  const stack: string[] = [abs];
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
      const entryPath = join(dir, entry.name);
      let info: Stats;
      try {
        info = await lstat(entryPath);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        continue;
      }
      if (info.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (info.isFile()) {
        total += info.size;
      }
    }
  }
  return total;
}

/** 同名副本命名：文件保留扩展名（a.txt → a (1).txt），目录直接追加（a → a (1)）。 */
export function withCopySuffix(name: string, index: number, keepExtension: boolean): string {
  if (!keepExtension) {
    return `${name} (${index})`;
  }
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  return `${stem} (${index})${ext}`;
}

const MAX_SUFFIX_ATTEMPTS = 1000;

/**
 * 在目标目录里找一个不冲突的名字；上传、移动、还原共用同一口径。
 * 只做「查空位」，真正落盘由调用方用 wx / rename 保证不再覆盖。
 */
export async function findFreeName(
  dirAbs: string,
  name: string,
  keepExtension: boolean,
): Promise<string> {
  for (let index = 0; index < MAX_SUFFIX_ATTEMPTS; index += 1) {
    const candidate = index === 0 ? name : withCopySuffix(name, index, keepExtension);
    if (!(await lstatOrNull(join(dirAbs, candidate)))) {
      return candidate;
    }
  }
  throw new SpaceError("同名条目过多，请先清理", 409);
}

/**
 * 文件系统错误 → HTTP 语义。只暴露 errno 不暴露绝对路径：
 * 绝对路径属于服务端内部信息，返回给客户端没有收益。
 */
export function toFsError(error: unknown, message: string): SpaceError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  let status: SpaceErrorStatus = 500;
  if (code === "EACCES" || code === "EPERM") {
    status = 403;
  } else if (code === "ENOENT") {
    status = 404;
  } else if (
    code === "ENOTEMPTY" ||
    code === "EEXIST" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "EBUSY"
  ) {
    status = 409;
  } else if (code === "ENAMETOOLONG" || code === "EINVAL") {
    // 名称/路径超出文件系统限制、目标非法：属于请求参数问题，不是服务端故障。
    status = 400;
  } else if (code === "ENOSPC" || code === "EDQUOT") {
    status = 413;
  }
  return new SpaceError(`${message}${code ? `（${code}）` : ""}`, status);
}
