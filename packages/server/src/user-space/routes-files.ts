import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Context } from "hono";
import type { Hono } from "hono";
import { resolveUserSpaceConfig } from "./config.js";
import { SpaceError, spaceRoute } from "./errors.js";
import {
  contentDispositionHeader,
  mimeTypeForName,
  normalizeSpacePath,
  sanitizeUploadName,
} from "./paths.js";
import {
  readJsonObject,
  requireRequestUid,
  requireStringArrayField,
  requireStringField,
} from "./request.js";
import {
  computeUsage,
  createDirectory,
  deleteEntries,
  listEntries,
  moveEntries,
  renameEntry,
  statEntry,
  uploadFile,
  type EntryStat,
  type SpaceUsage,
} from "./repo.js";

/**
 * 文件区路由（方案 §4）：列目录、建目录、上传、下载/预览、重命名、移动、删除、用量。
 * 全部挂载在 /api/space 下，路径参数统一经过 normalizeSpacePath。
 */

/** 上传配额响应：保留结构化字段，前端可直接显示「已用 / 配额」。 */
function quotaExceeded(
  c: Context,
  usage: SpaceUsage,
  quotaBytes: number,
  sizeBytes: number,
): Response {
  return c.json(
    {
      error: "空间不足，请清理后重试",
      usedBytes: usage.usedBytes,
      quotaBytes,
      sizeBytes,
    },
    413,
  );
}

/** 读取并消毒上传文件名：x-file-name 由客户端 encodeURIComponent 传入（HTTP 头是 latin1）。 */
function readUploadName(c: Context): string {
  const raw = c.req.header("x-file-name")?.trim();
  if (!raw) {
    throw new SpaceError("缺少 x-file-name 头（原始文件名）");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new SpaceError("x-file-name 不是合法的 percent-encoding");
  }
  return sanitizeUploadName(decoded);
}

/**
 * 文件流响应。下载用 attachment，预览用 inline；
 * 预览额外加 CSP sandbox：用户上传的 html/svg 即使被直接打开也不能执行脚本或读取同源数据。
 */
export function sendEntryFile(
  c: Context,
  entry: EntryStat,
  disposition: "inline" | "attachment",
): Response {
  const stream = createReadStream(entry.abs);
  const headers: Record<string, string> = {
    "Content-Type": mimeTypeForName(entry.name),
    "Content-Length": String(entry.size),
    "Content-Disposition": contentDispositionHeader(disposition, entry.name),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
  };
  if (disposition === "inline") {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
  }
  return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200, headers);
}

export function registerFileRoutes(app: Hono): void {
  app.get(
    "/entries",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const rel = normalizeSpacePath(c.req.query("path"));
      const entries = await listEntries(config, uid, rel);
      return c.json({ path: rel, entries, usage: await computeUsage(config, uid) });
    }),
  );

  app.post(
    "/mkdir",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const rel = normalizeSpacePath(requireStringField(body, "path"));
      if (!rel) {
        throw new SpaceError("path 不能为空");
      }
      await createDirectory(config, uid, rel);
      return c.json({ path: rel }, 201);
    }),
  );

  app.post(
    "/upload",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const dirRel = normalizeSpacePath(c.req.query("path"));
      const name = readUploadName(c);
      const usage = await computeUsage(config, uid);

      // 先按声明的 Content-Length 快速拒绝，避免把超大 body 读进内存后才报 413。
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > 0) {
        if (usage.usedBytes + declared > config.quotaBytes) {
          return quotaExceeded(c, usage, config.quotaBytes, declared);
        }
      }
      const data = Buffer.from(await c.req.arrayBuffer());
      // 最终以真实字节数校验（chunked 或 Content-Length 不实时，声明值不可信）。
      if (usage.usedBytes + data.length > config.quotaBytes) {
        return quotaExceeded(c, usage, config.quotaBytes, data.length);
      }
      const entry = await uploadFile(config, uid, dirRel, name, data);
      return c.json({
        entry,
        path: dirRel ? `${dirRel}/${entry.name}` : entry.name,
        usedBytes: usage.usedBytes + data.length,
        quotaBytes: config.quotaBytes,
      });
    }),
  );

  app.get(
    "/download",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const rel = normalizeSpacePath(c.req.query("path"));
      if (!rel) {
        throw new SpaceError("path 不能为空");
      }
      const entry = await statEntry(config, uid, rel);
      if (!entry) {
        throw new SpaceError("文件不存在", 404);
      }
      if (entry.kind !== "file") {
        throw new SpaceError("只能下载普通文件（符号链接不跟随）", 400);
      }
      return sendEntryFile(c, entry, "attachment");
    }),
  );

  app.get(
    "/preview",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const rel = normalizeSpacePath(c.req.query("path"));
      if (!rel) {
        throw new SpaceError("path 不能为空");
      }
      const entry = await statEntry(config, uid, rel);
      if (!entry) {
        throw new SpaceError("文件不存在", 404);
      }
      if (entry.kind !== "file") {
        throw new SpaceError("只能预览普通文件（符号链接不跟随）", 400);
      }
      return sendEntryFile(c, entry, "inline");
    }),
  );

  app.post(
    "/rename",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const rel = normalizeSpacePath(requireStringField(body, "path"));
      const name = requireStringField(body, "name");
      await renameEntry(config, uid, rel, name);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/move",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const paths = requireStringArrayField(body, "paths", 1);
      const toDir = normalizeSpacePath(requireStringField(body, "toDir"));
      const moved = await moveEntries(config, uid, paths, toDir);
      return c.json({ ok: true, moved });
    }),
  );

  app.post(
    "/delete",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const paths = requireStringArrayField(body, "paths", 1);
      const deleted = await deleteEntries(config, uid, paths);
      return c.json({ ok: true, deleted });
    }),
  );

  app.get(
    "/usage",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      return c.json(await computeUsage(config, uid));
    }),
  );
}
