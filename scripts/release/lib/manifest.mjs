/**
 * MANIFEST.sha256 读写：交付包的门禁。
 *
 * 格式：`<sha256> *./<相对路径>`（与 `sha256sum -c` 兼容，`*` 表示二进制模式）。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const MANIFEST_NAME = "MANIFEST.sha256";

export function manifestPath(root) {
  return join(root, MANIFEST_NAME);
}

/** 读取现有清单，返回 `Map<相对路径, sha256>`。文件不存在时返回空表。 */
export function readManifest(root) {
  const path = manifestPath(root);
  const entries = new Map();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    entries.set(match[2].replace(/^\.\//, ""), match[1]);
  }
  return entries;
}

export function writeManifest(root, entries) {
  const lines = [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, hash]) => `${hash} *./${path}`);
  writeFileSync(manifestPath(root), `${lines.join("\n")}\n`, "utf8");
}

/** 计算文件 sha256（流式，避免大镜像占内存）。 */
export async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * 把给定文件写进清单（相对交付目录根）。
 * 返回被更新的条目数；文件不存在直接抛错——交付包不能有指向空文件的清单行。
 */
export async function updateManifest(root, files) {
  const entries = readManifest(root);
  for (const file of files) {
    const absolute = resolve(file);
    if (!existsSync(absolute)) throw new Error(`清单文件不存在：${absolute}`);
    const relativePath = relative(resolve(root), absolute).replace(/\\/g, "/");
    entries.set(relativePath, await sha256File(absolute));
  }
  writeManifest(root, entries);
  return entries.size;
}

/** 校验清单里所有文件（等价于 `sha256sum -c`，但输出更清楚）。 */
export async function verifyManifest(root) {
  const entries = readManifest(root);
  const failures = [];
  let checked = 0;
  for (const [relativePath, expected] of entries) {
    const absolute = join(root, relativePath);
    if (!existsSync(absolute)) {
      failures.push(`${relativePath}：文件缺失`);
      continue;
    }
    const actual = await sha256File(absolute);
    checked += 1;
    if (actual !== expected) failures.push(`${relativePath}：校验和不一致`);
  }
  return { checked, failures };
}
