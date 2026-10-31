/**
 * 我的空间——增量能力：分片上传（断点续传）、搜索、批量打包下载、版本历史。
 *
 * 与 routes-files.ts 的分工：那里是基础文件区，这里是后补的重型能力。
 * 所有入口沿用同一套路径校验（normalizeSpacePath / assertNoSymlinkPath），
 * 任何新增路由都不得绕过它们。
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import yazl from "yazl";
import { resolveUserSpaceConfig } from "./config.js";
import { SpaceError, spaceRoute } from "./errors.js";
import { assertNoSymlinkPath, lstatOrNull, withCopySuffix } from "./fs-utils.js";
import { contentDispositionHeader, normalizeSpacePath, sanitizeUploadName } from "./paths.js";
import { readJsonObject, requireRequestUid, requireStringArrayField, requireStringField } from "./request.js";
import { computeUsage, createSpaceRoot, uploadFile, type SpaceEntry } from "./repo.js";

/** 分片暂存目录：与 .trash 同级，列表里必须隐藏。 */
export const UPLOADS_DIR_NAME = ".uploads";
/** 历史版本目录：同上。 */
export const VERSIONS_DIR_NAME = ".versions";

const UPLOAD_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_SEARCH_RESULTS = 500;

interface ChunkMeta {
  uid: string;
  dirRel: string;
  name: string;
  size: number;
  totalChunks: number;
  createdAt: number;
}

function uploadsRoot(root: string): string {
  return join(root, UPLOADS_DIR_NAME);
}

function uploadDir(root: string, uploadId: string): string {
  return join(uploadsRoot(root), uploadId);
}

async function readChunkMeta(root: string, uploadId: string): Promise<ChunkMeta> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw new SpaceError("uploadId 非法");
  const raw = await readFile(join(uploadDir(root, uploadId), "meta.json"), "utf8").catch(() => null);
  if (!raw) throw new SpaceError("上传会话不存在或已过期", 404);
  return JSON.parse(raw) as ChunkMeta;
}

async function receivedChunks(dir: string): Promise<number[]> {
  const names = await readdir(join(dir, "chunks")).catch(() => [] as string[]);
  return names
    .map((name) => Number(name))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b);
}

/**
 * 递归搜索文件名。跳过 .trash/.uploads/.versions 三个内部目录：
 * 它们不该出现在用户搜索结果里，也不该让人顺着结果摸到内部结构。
 */
async function searchNames(
  root: string,
  current: string,
  query: string,
  out: Array<{ path: string; entry: SpaceEntry }>,
): Promise<void> {
  if (out.length >= MAX_SEARCH_RESULTS) return;
  let names: string[];
  try {
    names = await readdir(current);
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_SEARCH_RESULTS) return;
    if (name === UPLOADS_DIR_NAME || name === VERSIONS_DIR_NAME || name === ".trash") continue;
    const abs = join(current, name);
    const info = await lstatOrNull(abs);
    if (!info || info.isSymbolicLink()) continue;
    const rel = abs.slice(root.length + 1).split("\\").join("/");
    if (info.isDirectory()) {
      await searchNames(root, abs, query, out);
      continue;
    }
    if (info.isFile() && name.toLowerCase().includes(query)) {
      out.push({ path: rel, entry: { name, kind: "file", size: info.size, mtime: info.mtime.toISOString() } });
    }
  }
}

/** 版本目录布局：.versions/<相对目录>/<文件名>/<时间戳>__<原文件名> */
function versionDir(root: string, rel: string): string {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return join(root, VERSIONS_DIR_NAME, ...(dir ? dir.split("/") : []), name);
}

export function registerExtraRoutes(app: Hono): void {
  // ---------------- 分片上传 ----------------

  app.post(
    "/upload/begin",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const root = await createSpaceRoot(config, uid);
      const body = await readJsonObject(c);
      const dirRel = normalizeSpacePath(requireStringField(body, "path"));
      const name = sanitizeUploadName(requireStringField(body, "name"));
      const size = Number(body.size);
      const totalChunks = Number(body.totalChunks);
      if (!Number.isFinite(size) || size <= 0) throw new SpaceError("size 非法");
      if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 100000) {
        throw new SpaceError("totalChunks 非法");
      }
      // 配额在 begin 就拒绝，避免用户传完 500MB 才失败
      const usage = await computeUsage(config, uid);
      if (usage.usedBytes + size > config.quotaBytes) {
        return c.json({ error: "空间不足，请清理后重试", usedBytes: usage.usedBytes, quotaBytes: config.quotaBytes, sizeBytes: size }, 413);
      }
      const uploadId = crypto.randomUUID().replace(/-/g, "");
      const dir = uploadDir(root, uploadId);
      await mkdir(join(dir, "chunks"), { recursive: true });
      const meta: ChunkMeta = { uid, dirRel, name, size, totalChunks, createdAt: Date.now() };
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
      return c.json({ uploadId, received: [], totalChunks }, 201);
    }),
  );

  app.get(
    "/upload/status",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const uploadId = c.req.query("uploadId") ?? "";
      const meta = await readChunkMeta(root, uploadId);
      if (meta.uid !== uid) throw new SpaceError("无权访问该上传会话", 403);
      return c.json({ uploadId, received: await receivedChunks(uploadDir(root, uploadId)), totalChunks: meta.totalChunks });
    }),
  );

  app.post(
    "/upload/chunk",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const uploadId = c.req.query("uploadId") ?? "";
      const index = Number(c.req.query("index"));
      const meta = await readChunkMeta(root, uploadId);
      if (meta.uid !== uid) throw new SpaceError("无权访问该上传会话", 403);
      if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
        throw new SpaceError("index 超出范围");
      }
      const data = Buffer.from(await c.req.arrayBuffer());
      await writeFile(join(uploadDir(root, uploadId), "chunks", String(index)), data);
      return c.json({ uploadId, index, size: data.length });
    }),
  );

  app.post(
    "/upload/commit",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const root = await createSpaceRoot(config, uid);
      const body = await readJsonObject(c);
      const uploadId = requireStringField(body, "uploadId");
      const meta = await readChunkMeta(root, uploadId);
      if (meta.uid !== uid) throw new SpaceError("无权访问该上传会话", 403);

      const dir = uploadDir(root, uploadId);
      const received = await receivedChunks(dir);
      if (received.length !== meta.totalChunks) {
        throw new SpaceError(`分片不完整：已收 ${received.length}/${meta.totalChunks}`, 409);
      }
      const parts: Buffer[] = [];
      for (let index = 0; index < meta.totalChunks; index += 1) {
        parts.push(await readFile(join(dir, "chunks", String(index))));
      }
      const data = Buffer.concat(parts);
      // 声明大小与实际不符说明客户端算错了分片边界，宁可拒绝也不写坏文件
      if (meta.size > 0 && Math.abs(data.length - meta.size) > 0) {
        await rm(dir, { recursive: true, force: true });
        throw new SpaceError(`合并大小与声明不符：${data.length} != ${meta.size}`, 400);
      }
      const usage = await computeUsage(config, uid);
      if (usage.usedBytes + data.length > config.quotaBytes) {
        return c.json({ error: "空间不足，请清理后重试", usedBytes: usage.usedBytes, quotaBytes: config.quotaBytes, sizeBytes: data.length }, 413);
      }
      const entry = await uploadFile(config, uid, meta.dirRel, meta.name, data);
      await rm(dir, { recursive: true, force: true });
      return c.json({
        entry,
        path: meta.dirRel ? `${meta.dirRel}/${entry.name}` : entry.name,
        usedBytes: usage.usedBytes + data.length,
        quotaBytes: config.quotaBytes,
      });
    }),
  );

  // ---------------- 搜索 ----------------

  app.get(
    "/search",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const query = (c.req.query("q") ?? "").trim().toLowerCase();
      if (!query) return c.json({ query, results: [] });
      const out: Array<{ path: string; entry: SpaceEntry }> = [];
      await searchNames(root, root, query, out);
      return c.json({ query, results: out, truncated: out.length >= MAX_SEARCH_RESULTS });
    }),
  );

  // ---------------- 批量打包下载 ----------------

  app.post(
    "/archive",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const body = await readJsonObject(c);
      const paths = requireStringArrayField(body, "paths", 1).map((p) => normalizeSpacePath(p));
      if (paths.length === 0) throw new SpaceError("paths 不能为空");
      const files: Array<{ abs: string; rel: string }> = [];
      for (const rel of paths) {
        await assertNoSymlinkPath(root, rel, { allowMissing: false });
        const abs = join(root, ...rel.split("/"));
        const info = await stat(abs);
        if (info.isFile()) files.push({ abs, rel });
        else throw new SpaceError(`只支持打包文件：${rel} 是目录`, 400);
      }
      const zip = new yazl.ZipFile();
      for (const file of files) zip.addFile(file.abs, file.rel);
      zip.end();
      const name = `space-${new Date().toISOString().slice(0, 10)}.zip`;
      return c.body(Readable.toWeb(zip.outputStream) as unknown as ReadableStream, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": contentDispositionHeader("attachment", name),
        "X-Content-Type-Options": "nosniff",
      });
    }),
  );

  // ---------------- 版本历史 ----------------

  /**
   * 上传并保留旧版本：同名文件存在时先把旧的移到 .versions 再写入新的。
   * 与普通 /upload 分开的原因：默认行为是「同名加 (1) 后缀」，那是防覆盖的保守策略；
   * 版本覆盖是明确的用户意图，不能被默认策略悄悄改掉。
   */
  app.post(
    "/upload/versioned",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const root = await createSpaceRoot(config, uid);
      const dirRel = normalizeSpacePath(c.req.query("path"));
      const rawName = c.req.header("x-file-name")?.trim();
      if (!rawName) throw new SpaceError("缺少 x-file-name 头（原始文件名）");
      const name = sanitizeUploadName(decodeURIComponent(rawName));
      const rel = dirRel ? `${dirRel}/${name}` : name;
      const targetAbs = join(root, ...rel.split("/"));
      await assertNoSymlinkPath(root, rel, { allowMissing: true });

      const existing = await lstatOrNull(targetAbs);
      if (existing?.isFile()) {
        const dir = versionDir(root, rel);
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await rename(targetAbs, join(dir, `${stamp}__${name}`));
      }

      const usage = await computeUsage(config, uid);
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > 0 && usage.usedBytes + declared > config.quotaBytes) {
        return c.json({ error: "空间不足，请清理后重试", usedBytes: usage.usedBytes, quotaBytes: config.quotaBytes, sizeBytes: declared }, 413);
      }
      const data = Buffer.from(await c.req.arrayBuffer());
      if (usage.usedBytes + data.length > config.quotaBytes) {
        return c.json({ error: "空间不足，请清理后重试", usedBytes: usage.usedBytes, quotaBytes: config.quotaBytes, sizeBytes: data.length }, 413);
      }
      await writeFile(targetAbs, data);
      const info = await stat(targetAbs);
      const entry: SpaceEntry = { name, kind: "file", size: info.size, mtime: info.mtime.toISOString() };
      return c.json({ entry, path: rel, usedBytes: usage.usedBytes + data.length, quotaBytes: config.quotaBytes });
    }),
  );

  app.get(
    "/versions",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const rel = normalizeSpacePath(c.req.query("path"));
      if (!rel) throw new SpaceError("path 不能为空");
      const dir = versionDir(root, rel);
      const names = await readdir(dir).catch(() => [] as string[]);
      const items: Array<{ id: string; size: number; savedAt: string }> = [];
      for (const name of names) {
        const info = await lstatOrNull(join(dir, name));
        if (!info?.isFile()) continue;
        const [stamp] = name.split("__");
        items.push({ id: name, size: info.size, savedAt: stamp ?? "" });
      }
      items.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      return c.json({ path: rel, items });
    }),
  );

  app.post(
    "/versions/restore",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const body = await readJsonObject(c);
      const rel = normalizeSpacePath(requireStringField(body, "path"));
      const versionId = requireStringField(body, "versionId");
      if (!rel) throw new SpaceError("path 不能为空");
      if (versionId.includes("/") || versionId.includes("\\") || versionId.includes("..")) {
        throw new SpaceError("versionId 非法");
      }
      const dir = versionDir(root, rel);
      const source = join(dir, versionId);
      const info = await lstatOrNull(source);
      if (!info?.isFile()) throw new SpaceError("版本不存在", 404);

      const targetAbs = join(root, ...rel.split("/"));
      // 当前文件先留一份，避免「还原」把还没保存的改动直接吞掉
      const current = await lstatOrNull(targetAbs);
      if (current?.isFile()) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await mkdir(dir, { recursive: true });
        await rename(targetAbs, join(dir, `${stamp}__${rel.slice(rel.lastIndexOf("/") + 1)}`));
      } else {
        await mkdir(dirname(targetAbs), { recursive: true });
      }
      await writeFile(targetAbs, await readFile(source));
      return c.json({ ok: true, path: rel });
    }),
  );
}

/** 供 routes.ts 复用的导出（避免外部误用内部常量）。 */
export { withCopySuffix };
