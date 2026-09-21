/**
 * 软件更新 HTTP 路由（UPD）：管理面 `/admin/updates/*` + 客户端下发面 `/api/v1/releases/electron/*`。
 *
 * 为什么分两个工厂、挂在两处（改错一处不是 401 就是用不上鉴权）：
 *  - `createUpdatesRoutes` 由 identity/server.ts 挂在 authed 组**之后**，复用 Bearer 中间件，
 *    这里只再校验 platform_admin；
 *  - `createUpdatesPublicRoutes` 必须挂在 authed 组**之前**（identity/routes.ts 的「公开」段）——
 *    桌面端取 manifest 时**不带 Authorization**（见 manifestUpdateProvider 的 httpRequest），
 *    挂在 authed 之后会被 401 拦掉。
 *
 * 产物上传为什么不用 multipart：安装包几百 MB，multipart 会把整包读进内存再落盘。
 * 这里走「先建草稿拿 id → PUT 原始字节流」，边写盘边算 sha512，内存占用与包体无关；
 * .part 中转文件保证"传一半断线"不会留下看起来可用的产物。
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";

import { recordAdminAction, resolveActorForClaims } from "../audit/repo.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  ELECTRON_FILE_PATH_PREFIX,
  ELECTRON_MANIFEST_PATH,
  buildElectronManifest,
  isDeviceInRollout,
  normalizeReleasePlatform,
  parseReleaseChannel,
} from "./manifest.js";
import {
  attachReleaseArtifact,
  createRelease,
  deleteRelease,
  findPublishedRelease,
  findReleaseByStoredName,
  getRelease,
  listReleases,
  patchRelease,
  type AppReleaseRow,
} from "./repo.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

/** 产物落盘目录：与知识库文件同思路，走 env + 容器数据卷；不进 PG。 */
const UPDATE_FILE_DIR =
  process.env["REACTOR_UPDATE_FILE_DIR"]?.trim() || join(process.cwd(), "data", "updates");

const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
function readMaxArtifactBytes(): number {
  const raw = process.env["REACTOR_UPDATE_MAX_BYTES"]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ARTIFACT_BYTES;
}

/**
 * 允许的产物后缀白名单。不是洁癖：electron-updater 按安装格式挑文件
 * （Windows 认 .exe、Linux 认 .appimage/.deb/.rpm/.pkg.tar.zst），
 * 收进来的类型若对不上，客户端会报"manifest 里没有当前安装格式的文件"，
 * 与其让管理员传到线上再发现，不如上传时就拒掉。
 */
const ARTIFACT_SUFFIXES = [
  ".exe",
  ".msi",
  ".zip",
  ".dmg",
  ".pkg",
  ".appimage",
  ".deb",
  ".rpm",
  ".pacman",
  ".pkg.tar.zst",
] as const;

function resolveArtifactSuffix(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  // .pkg.tar.zst 是 pacman 的复合后缀，extname 只会给出 .zst，必须整体匹配。
  const matched = ARTIFACT_SUFFIXES.find((suffix) => lower.endsWith(suffix));
  if (matched) return matched;
  const ext = extname(lower);
  return ARTIFACT_SUFFIXES.includes(ext as (typeof ARTIFACT_SUFFIXES)[number]) ? ext : null;
}

function ensureUpdateDir(): void {
  if (!existsSync(UPDATE_FILE_DIR)) mkdirSync(UPDATE_FILE_DIR, { recursive: true });
}

function serializeRelease(row: AppReleaseRow) {
  return {
    id: row.id,
    platform: row.platform,
    channel: row.channel,
    version: row.version,
    releaseName: row.releaseName,
    releaseNotesZh: row.releaseNotesZh,
    releaseNotesEn: row.releaseNotesEn,
    rolloutPercent: row.rolloutPercent,
    published: row.published,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedBy,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    hasArtifact: Boolean(row.storedName && row.sha512Base64),
    downloadPath: row.storedName
      ? `${ELECTRON_FILE_PATH_PREFIX}${encodeURIComponent(row.storedName)}`
      : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function readPositiveInt(raw: unknown, fallback: number, max: number): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

// ============================================================================
// 客户端下发面（公开，无 Authorization）
// ============================================================================

export function createUpdatesPublicRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * 客户端 manifest。响应体用 JSON 承载：
   * 客户端用 `yaml` 包的 parse 解析，而 JSON 是 YAML 1.2 的子集，
   * 因此不必给服务端引入 YAML 依赖，也不会踩手写转义的坑（release notes 是多行中文）。
   */
  app.get(ELECTRON_MANIFEST_PATH, async (c) => {
    const platform = normalizeReleasePlatform(c.req.query("platform"));
    // 通道优先取查询串，兼容 X-Release-Channel（客户端两个都带，数字口径 1=stable / 3=preview）。
    const channel =
      parseReleaseChannel(c.req.query("channel")) ??
      parseReleaseChannel(c.req.header("x-release-channel"));
    if (!platform || !channel) {
      return err(c, 400, "缺少或非法的 platform / channel 参数");
    }

    const release = await findPublishedRelease(db, platform, channel);
    if (!release) {
      // 没有发布过就让客户端如实失败：伪造一个"当前版本"的 manifest 会掩盖管理台没配好的事实。
      return err(c, 404, `该平台/通道暂无已发布的更新：${platform} / ${channel}`);
    }

    const deviceMid = c.req.query("device_mid") ?? c.req.header("x-device-mid");
    if (!isDeviceInRollout(deviceMid, release)) {
      console.log(`[updates] 灰度未命中：${platform}/${channel} v${release.version} mid=${deviceMid ?? "-"}`);
      return err(c, 404, `该设备当前不在灰度范围内：${release.version}`);
    }

    console.log(`[updates] manifest 下发：${platform}/${channel} v${release.version}`);
    return c.json(buildElectronManifest(release));
  });

  /** 产物下载：支持单段 Range（客户端断点续传靠它），大小与校验和已在登记表里。 */
  app.get(`${ELECTRON_FILE_PATH_PREFIX}:name`, async (c) => {
    const storedName = c.req.param("name");
    // 只接受库内登记过的 stored_name：路径穿越（../）在这里直接落空，不需要再手写净化。
    const release = await findReleaseByStoredName(db, storedName);
    if (!release) return err(c, 404, "产物不存在");

    const filePath = join(UPDATE_FILE_DIR, storedName);
    if (!existsSync(filePath)) {
      // 库里有、盘上没有：口子多半是数据卷没挂或换了卷，说清楚比 500 好排查。
      return err(c, 404, "产物文件缺失，请检查 REACTOR_UPDATE_FILE_DIR 数据卷");
    }

    const total = statSync(filePath).size;
    const range = c.req.header("range");
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      ...(release.fileName
        ? { "content-disposition": `attachment; filename="${release.fileName.replace(/"/g, "")}"` }
        : {}),
      ...(release.sha512Base64 ? { "x-checksum-sha512": release.sha512Base64 } : {}),
    };

    const match = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(Number.parseInt(match[2], 10), total - 1) : total - 1;
      if (!Number.isFinite(start) || start > end || start >= total) {
        return c.body(null, 416, { "content-range": `bytes */${total}` });
      }
      const stream = createReadStream(filePath, { start, end });
      return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${total}`,
        "content-length": String(end - start + 1),
      });
    }

    const stream = createReadStream(filePath);
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200, {
      ...headers,
      "content-length": String(total),
    });
  });

  return app;
}

// ============================================================================
// 管理面（authed 组内，仅 platform_admin）
// ============================================================================

export function createUpdatesRoutes(db: IdentityDb): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.get("claims")?.role !== "platform_admin") return err(c, 403, "仅平台管理员可操作");
    await next();
  };
  app.use("/admin/updates", requireAdmin);
  app.use("/admin/updates/*", requireAdmin);

  const audit = async (c: Ctx, entry: Parameters<typeof recordAdminAction>[2]): Promise<void> => {
    const claims = c.get("claims");
    if (!claims?.sub) return;
    await recordAdminAction(db, await resolveActorForClaims(db, claims), entry);
  };

  app.get("/admin/updates/releases", async (c) => {
    const platform = c.req.query("platform")?.trim() || undefined;
    const channel = parseReleaseChannel(c.req.query("channel")) ?? undefined;
    const limit = readPositiveInt(c.req.query("limit"), 50, 200);
    const offset = readPositiveInt(c.req.query("offset"), 1, 100_000) - 1;
    const { releases, total } = await listReleases(db, { platform, channel, limit, offset });
    return c.json({ releases: releases.map(serializeRelease), total, limit, offset });
  });

  /** 第一步：建草稿（只有元数据，还没产物）。 */
  app.post("/admin/updates/releases", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      platform?: string;
      channel?: string;
      version?: string;
      releaseName?: string;
      releaseNotesZh?: string;
      releaseNotesEn?: string;
      rolloutPercent?: number;
    } | null;
    if (!body) return err(c, 400, "请求体非法");

    const platform = normalizeReleasePlatform(body.platform);
    const channel = parseReleaseChannel(body.channel);
    const version = body.version?.trim();
    if (!platform) return err(c, 400, "platform 需为 windows-x64 / darwin-arm64 / linux-x64 这类取值");
    if (!channel) return err(c, 400, "channel 需为 stable 或 preview");
    if (!version) return err(c, 400, "请填写版本号");
    if (!/^\d+\.\d+\.\d+/.test(version)) return err(c, 400, "版本号请用语义化写法，如 1.2.3");

    try {
      const release = await createRelease(db, {
        platform,
        channel,
        version,
        releaseName: body.releaseName?.trim() || null,
        releaseNotesZh: body.releaseNotesZh ?? null,
        releaseNotesEn: body.releaseNotesEn ?? null,
        rolloutPercent: readPositiveInt(body.rolloutPercent, 100, 100),
        createdBy: c.get("claims")?.sub ?? null,
      });
      await audit(c, {
        op: "update.release.create",
        target: `${platform}/${channel}/${version}`,
        summary: `创建更新草稿 v${version}（${platform} / ${channel}）`,
      });
      return c.json({ release: serializeRelease(release) }, 201);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return err(c, 409, `该平台与通道下已存在版本 ${version}`);
      }
      throw error;
    }
  });

  /**
   * 第二步：上传产物（原始字节流）。文件名走自定义头 `x-file-name`（避免 multipart），
   * 落盘用 uuid + 白名单后缀，原始名只入库供 UI 与下载头使用。
   */
  app.put("/admin/updates/releases/:id/file", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return err(c, 400, "id 非法");
    const release = await getRelease(db, id);
    if (!release) return err(c, 404, "发布记录不存在");
    if (release.published) return err(c, 409, "已发布的记录不能替换产物，请先下线");

    const rawFileName = c.req.header("x-file-name")?.trim();
    if (!rawFileName) return err(c, 400, "缺少 x-file-name 头（原始文件名）");
    const suffix = resolveArtifactSuffix(rawFileName);
    if (!suffix) {
      return err(c, 400, `不支持的产物类型，需为 ${ARTIFACT_SUFFIXES.join(" / ")}`);
    }

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    const maxBytes = readMaxArtifactBytes();
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return err(c, 400, `产物超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    const body = c.req.raw.body;
    if (!body) return err(c, 400, "缺少产物内容");

    ensureUpdateDir();
    const storedName = `${randomUUID()}${suffix}`;
    const finalPath = join(UPDATE_FILE_DIR, storedName);
    const partPath = `${finalPath}.part`;

    const hash = createHash("sha512");
    let sizeBytes = 0;
    try {
      await pipeline(
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.length;
            // 声明的 content-length 可能是 0（chunked），所以真实大小在这里兜底拦截，
            // 超过上限立即中断，避免把磁盘写满才发现。
            if (sizeBytes > maxBytes) {
              callback(new Error(`产物超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(partPath),
      );
    } catch (error) {
      await rm(partPath, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      return err(c, message.startsWith("产物超过上限") ? 400 : 500, `产物上传失败：${message}`);
    }

    if (sizeBytes === 0) {
      await rm(partPath, { force: true });
      return err(c, 400, "产物为空文件");
    }
    // 写盘成功后才改名：.part 残片不会被 manifest 引用到。
    await import("node:fs/promises").then((fs) => fs.rename(partPath, finalPath));

    const updated = await attachReleaseArtifact(db, id, {
      fileName: rawFileName,
      storedName,
      sizeBytes,
      sha512Base64: hash.digest("base64"),
    });
    if (!updated) {
      await rm(finalPath, { force: true });
      return err(c, 409, "记录状态已变化，产物未登记（请重试）");
    }

    await audit(c, {
      op: "update.release.upload",
      target: `${updated.platform}/${updated.channel}/${updated.version}`,
      summary: `上传更新产物 ${rawFileName}（${Math.round(sizeBytes / 1024 / 1024)}MB）`,
    });
    console.log(`[updates] 产物入库 v${updated.version} ${storedName} ${sizeBytes}B`);
    return c.json({ release: serializeRelease(updated) });
  });

  /** 改元数据 / 上下线 / 调灰度。 */
  app.patch("/admin/updates/releases/:id", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return err(c, 400, "id 非法");
    const body = (await c.req.json().catch(() => null)) as {
      releaseName?: string | null;
      releaseNotesZh?: string | null;
      releaseNotesEn?: string | null;
      rolloutPercent?: number;
      published?: boolean;
    } | null;
    if (!body) return err(c, 400, "请求体非法");

    const current = await getRelease(db, id);
    if (!current) return err(c, 404, "发布记录不存在");
    if (body.published === true && !current.storedName) {
      return err(c, 409, "还没有产物，不能上线");
    }

    const updated = await patchRelease(db, id, {
      ...(body.releaseName !== undefined ? { releaseName: body.releaseName } : {}),
      ...(body.releaseNotesZh !== undefined ? { releaseNotesZh: body.releaseNotesZh } : {}),
      ...(body.releaseNotesEn !== undefined ? { releaseNotesEn: body.releaseNotesEn } : {}),
      ...(body.rolloutPercent !== undefined
        ? { rolloutPercent: readPositiveInt(body.rolloutPercent, current.rolloutPercent, 100) }
        : {}),
      ...(body.published !== undefined ? { published: body.published } : {}),
      actorUid: c.get("claims")?.sub ?? null,
    });
    if (!updated) return err(c, 404, "发布记录不存在");

    if (body.published !== undefined && body.published !== current.published) {
      await audit(c, {
        op: body.published ? "update.release.publish" : "update.release.unpublish",
        target: `${updated.platform}/${updated.channel}/${updated.version}`,
        summary: `${body.published ? "上线" : "下线"}更新 v${updated.version}（${updated.platform} / ${updated.channel}）`,
      });
    }
    return c.json({ release: serializeRelease(updated) });
  });

  app.delete("/admin/updates/releases/:id", async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return err(c, 400, "id 非法");
    const removed = await deleteRelease(db, id);
    if (!removed) return err(c, 404, "发布记录不存在");

    if (removed.storedName) {
      const filePath = join(UPDATE_FILE_DIR, removed.storedName);
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch (error) {
        // 删文件失败不回滚删除：记录留着反而会让 manifest 指向不存在的产物。
        console.warn(`[updates] 产物删除失败：${filePath} ${error instanceof Error ? error.message : error}`);
      }
    }
    await audit(c, {
      op: "update.release.delete",
      target: `${removed.platform}/${removed.channel}/${removed.version}`,
      summary: `删除更新 v${removed.version}（${removed.platform} / ${removed.channel}）`,
    });
    return c.json({ ok: true });
  });

  return app;
}
