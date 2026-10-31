import type { Hono } from "hono";
import { resolveUserSpaceConfig } from "./config.js";
import { SpaceError, spaceRoute } from "./errors.js";
import { normalizeSpacePath, SHARE_TOKEN_PATTERN } from "./paths.js";
import { readJsonObject, requireNumberField, requireRequestUid, requireStringField } from "./request.js";
import { statEntry } from "./repo.js";
import { sendEntryFile } from "./routes-files.js";
import {
  createShareRecord,
  findShareRecord,
  hashSharePassword,
  isShareExpired,
  readShareRecords,
  revokeShareRecord,
  sharePublicUrl,
  verifySharePassword,
} from "./shares.js";

/**
 * 分享路由（方案 §4 / §5.5 / §5.6）。
 * 除 `/shared/:token` 外都要求身份；公开路由只靠 token + 过期 + 口令，
 * 且只允许下载分享创建时锁定的那一个文件。
 */

/** 分享有效期上限 1 年：避免误填巨大 TTL 造成事实上的永久公开链接。 */
const MAX_SHARE_TTL_HOURS = 24 * 365;
const MAX_PASSWORD_LENGTH = 128;

function readSharePassword(body: Record<string, unknown>): string | null {
  const value = body.password;
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new SpaceError("字段 password 必须是字符串");
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new SpaceError(`口令最长 ${MAX_PASSWORD_LENGTH} 个字符`);
  }
  return value;
}

export function registerShareRoutes(app: Hono): void {
  app.post(
    "/share",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const rel = normalizeSpacePath(requireStringField(body, "path"));
      if (!rel) {
        throw new SpaceError("path 不能为空");
      }
      const ttlHours = requireNumberField(body, "ttlHours");
      if (ttlHours <= 0 || ttlHours > MAX_SHARE_TTL_HOURS) {
        throw new SpaceError(`ttlHours 需在 (0, ${MAX_SHARE_TTL_HOURS}] 之间`);
      }
      // §5.6：分享只允许文件；目录请先打包。同时用 lstat 拒绝符号链接。
      const entry = await statEntry(config, uid, rel);
      if (!entry) {
        throw new SpaceError("要分享的文件不存在", 404);
      }
      if (entry.kind !== "file") {
        throw new SpaceError("只能分享普通文件（不支持目录与符号链接）");
      }
      const password = readSharePassword(body);
      const record = await createShareRecord(config.sharesFile, {
        uid,
        path: rel,
        name: entry.name,
        size: entry.size,
        ttlHours,
        passwordHash: password ? hashSharePassword(password) : null,
      });
      return c.json(
        {
          token: record.token,
          expiresAt: record.expiresAt,
          url: sharePublicUrl(record.token),
        },
        201,
      );
    }),
  );

  app.get(
    "/shares",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const records = await readShareRecords(config.sharesFile);
      const items = records
        .filter((record) => record.uid === uid)
        .map((record) => ({
          token: record.token,
          path: record.path,
          name: record.name,
          size: record.size,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          hasPassword: record.passwordHash !== null,
          expired: isShareExpired(record),
          url: sharePublicUrl(record.token),
        }));
      return c.json({ items });
    }),
  );

  app.post(
    "/share/revoke",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const config = resolveUserSpaceConfig();
      const body = await readJsonObject(c);
      const token = requireStringField(body, "token");
      const revoked = await revokeShareRecord(config.sharesFile, uid, token);
      if (!revoked) {
        throw new SpaceError("分享不存在或不属于当前用户", 404);
      }
      return c.json({ ok: true });
    }),
  );

  // 公开下载：不解析 uid（分享记录里自带 uid），也不要求服务端 lite token（见 http.ts 放行说明）。
  app.get(
    "/shared/:token",
    spaceRoute(async (c) => {
      const token = c.req.param("token");
      if (!token || !SHARE_TOKEN_PATTERN.test(token)) {
        throw new SpaceError("分享不存在或已失效", 404);
      }
      const config = resolveUserSpaceConfig();
      const record = await findShareRecord(config.sharesFile, token);
      if (!record) {
        throw new SpaceError("分享不存在或已失效", 404);
      }
      if (isShareExpired(record)) {
        throw new SpaceError("分享已过期", 410);
      }
      if (record.passwordHash) {
        const password = c.req.query("pwd");
        if (!password) {
          throw new SpaceError("该分享需要口令", 401);
        }
        if (!verifySharePassword(record, password)) {
          throw new SpaceError("口令错误", 403);
        }
      }
      // 分享记录中的路径同样要过路径规则：损坏/被篡改的记录不能变成任意文件读取入口。
      let rel: string;
      try {
        rel = normalizeSpacePath(record.path);
      } catch {
        throw new SpaceError("分享的文件已不存在", 404);
      }
      const entry = await statEntry(config, record.uid, rel);
      if (!entry || entry.kind !== "file") {
        throw new SpaceError("分享的文件已不存在", 404);
      }
      return sendEntryFile(c, entry, "attachment");
    }),
  );
}
