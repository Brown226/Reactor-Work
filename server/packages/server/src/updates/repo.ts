/**
 * 软件更新数据域（UPD）SQL 层。
 *
 * 分层纪律同其余域：这里只有 SQL 与行映射，HTTP 语义（状态码/鉴权/审计）在 routes.ts。
 *
 * 两处容易踩的坑：
 *  - `size_bytes` 是 BIGINT，node-pg 默认回**字符串**；不转数字会让客户端 manifest 里的
 *    size 变成 "123456"，electron-updater 的进度计算会算错。
 *  - 版本号是 TEXT 不做语义排序：同一通道里"哪条是最新"只认 published_at，避免 1.10.0 被
 *    当成小于 1.9.0 而回退版本。
 */
import type { IdentityDb } from "../identity/db.js";
import type { ReleaseChannel } from "./manifest.js";

export interface AppReleaseRow {
  id: number;
  platform: string;
  channel: ReleaseChannel;
  version: string;
  releaseName: string | null;
  releaseNotesZh: string | null;
  releaseNotesEn: string | null;
  rolloutPercent: number;
  published: boolean;
  publishedAt: Date | null;
  publishedBy: string | null;
  fileName: string | null;
  storedName: string | null;
  sizeBytes: number | null;
  sha512Base64: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawReleaseRow {
  id: number;
  platform: string;
  channel: string;
  version: string;
  release_name: string | null;
  release_notes_zh: string | null;
  release_notes_en: string | null;
  rollout_percent: number;
  published: boolean;
  published_at: Date | null;
  published_by: string | null;
  file_name: string | null;
  stored_name: string | null;
  size_bytes: string | null | number;
  sha512_base64: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const RELEASE_COLUMNS = [
  "id",
  "platform",
  "channel",
  "version",
  "release_name",
  "release_notes_zh",
  "release_notes_en",
  "rollout_percent",
  "published",
  "published_at",
  "published_by",
  "file_name",
  "stored_name",
  "size_bytes",
  "sha512_base64",
  "created_by",
  "created_at",
  "updated_at",
].join(", ");

function mapRelease(raw: RawReleaseRow): AppReleaseRow {
  return {
    id: raw.id,
    platform: raw.platform,
    channel: raw.channel === "preview" ? "preview" : "stable",
    version: raw.version,
    releaseName: raw.release_name,
    releaseNotesZh: raw.release_notes_zh,
    releaseNotesEn: raw.release_notes_en,
    rolloutPercent: raw.rollout_percent,
    published: raw.published,
    publishedAt: raw.published_at,
    publishedBy: raw.published_by,
    fileName: raw.file_name,
    storedName: raw.stored_name,
    sizeBytes: raw.size_bytes === null ? null : Number(raw.size_bytes),
    sha512Base64: raw.sha512_base64,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface CreateReleaseInput {
  platform: string;
  channel: ReleaseChannel;
  version: string;
  releaseName?: string | null;
  releaseNotesZh?: string | null;
  releaseNotesEn?: string | null;
  rolloutPercent?: number;
  createdBy?: string | null;
}

export async function createRelease(db: IdentityDb, input: CreateReleaseInput): Promise<AppReleaseRow> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `INSERT INTO app_release
       (platform, channel, version, release_name, release_notes_zh, release_notes_en, rollout_percent, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${RELEASE_COLUMNS}`,
    [
      input.platform,
      input.channel,
      input.version,
      input.releaseName ?? null,
      input.releaseNotesZh ?? null,
      input.releaseNotesEn ?? null,
      input.rolloutPercent ?? 100,
      input.createdBy ?? null,
    ],
  );
  return mapRelease(rows[0]!);
}

export interface ReleaseArtifactInput {
  fileName: string;
  storedName: string;
  sizeBytes: number;
  sha512Base64: string;
}

/** 产物上传完成后回填寻址与校验和；只有草稿态可覆盖（已发布的产物换文件会让客户端校验失败）。 */
export async function attachReleaseArtifact(
  db: IdentityDb,
  id: number,
  artifact: ReleaseArtifactInput,
): Promise<AppReleaseRow | null> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `UPDATE app_release
        SET file_name = $2, stored_name = $3, size_bytes = $4, sha512_base64 = $5, updated_at = now()
      WHERE id = $1 AND published = false
      RETURNING ${RELEASE_COLUMNS}`,
    [id, artifact.fileName, artifact.storedName, artifact.sizeBytes, artifact.sha512Base64],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

export interface ListReleaseFilter {
  platform?: string;
  channel?: ReleaseChannel;
  limit: number;
  offset: number;
}

export async function listReleases(
  db: IdentityDb,
  filter: ListReleaseFilter,
): Promise<{ releases: AppReleaseRow[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.platform) {
    params.push(filter.platform);
    conditions.push(`platform = $${params.length}`);
  }
  if (filter.channel) {
    params.push(filter.channel);
    conditions.push(`channel = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalResult = await db.pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM app_release ${where}`,
    params,
  );
  const { rows } = await db.pool.query<RawReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM app_release ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  );
  return { releases: rows.map(mapRelease), total: Number(totalResult.rows[0]?.count ?? 0) };
}

export async function getRelease(db: IdentityDb, id: number): Promise<AppReleaseRow | null> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM app_release WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

export interface PatchReleaseInput {
  releaseName?: string | null;
  releaseNotesZh?: string | null;
  releaseNotesEn?: string | null;
  rolloutPercent?: number;
  published?: boolean;
  actorUid?: string | null;
}

export async function patchRelease(
  db: IdentityDb,
  id: number,
  patch: PatchReleaseInput,
): Promise<AppReleaseRow | null> {
  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    fields.push(sql.replace("?", `$${params.length}`));
  };

  if (patch.releaseName !== undefined) push("release_name = ?", patch.releaseName);
  if (patch.releaseNotesZh !== undefined) push("release_notes_zh = ?", patch.releaseNotesZh);
  if (patch.releaseNotesEn !== undefined) push("release_notes_en = ?", patch.releaseNotesEn);
  if (patch.rolloutPercent !== undefined) push("rollout_percent = ?", patch.rolloutPercent);
  if (patch.published !== undefined) {
    push("published = ?", patch.published);
    // published_at 只在首次上线时写：下线再上线不该把"最新"顺序刷新到最前，
    // 否则一条历史版本被误点上线会立刻顶掉当前版本。
    if (patch.published) {
      fields.push("published_at = COALESCE(published_at, now())");
      push("published_by = ?", patch.actorUid ?? null);
    }
  }
  if (fields.length === 0) {
    return getRelease(db, id);
  }

  params.push(id);
  const { rows } = await db.pool.query<RawReleaseRow>(
    `UPDATE app_release SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}
     RETURNING ${RELEASE_COLUMNS}`,
    params,
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/** 删除并回传被删行，让路由层能顺带清掉磁盘产物。 */
export async function deleteRelease(db: IdentityDb, id: number): Promise<AppReleaseRow | null> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `DELETE FROM app_release WHERE id = $1 RETURNING ${RELEASE_COLUMNS}`,
    [id],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/** 客户端下发查询：只认已发布 + 有产物，按 published_at 取最新一条。 */
export async function findPublishedRelease(
  db: IdentityDb,
  platform: string,
  channel: ReleaseChannel,
): Promise<AppReleaseRow | null> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM app_release
      WHERE platform = $1 AND channel = $2 AND published = true
        AND stored_name IS NOT NULL AND sha512_base64 IS NOT NULL
      ORDER BY published_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [platform, channel],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/**
 * 公开下载页用：**各平台 / 通道的最新已发布版本**（每个组合一条）。
 *
 * 与 `findPublishedRelease` 的区别是「多平台聚合」——客户端按自己所在的平台 / 通道取一条，
 * 而面向新用户的下载页要一次列全（Windows 安装包、macOS 安装包…），因此这里按组合去重。
 *
 * `DISTINCT ON (platform, channel)` 的 `ORDER BY` 必须以这两列开头（PG 的硬要求）；
 * 版本号是 TEXT 不参与排序，与全表口径一致：**谁最新只认 published_at**，
 * 避免 `1.10.0` 被字符串比较判成小于 `1.9.0` 而回退版本。
 * 只回**有产物**的条目：没有安装包的登记在下载页上没有意义。
 */
export async function listLatestPublished(db: IdentityDb): Promise<AppReleaseRow[]> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `SELECT DISTINCT ON (platform, channel) ${RELEASE_COLUMNS} FROM app_release
      WHERE published = true AND stored_name IS NOT NULL AND sha512_base64 IS NOT NULL
      ORDER BY platform, channel, published_at DESC NULLS LAST, id DESC`,
  );
  return rows.map(mapRelease);
}

export async function findReleaseByStoredName(
  db: IdentityDb,
  storedName: string,
): Promise<AppReleaseRow | null> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM app_release WHERE stored_name = $1 LIMIT 1`,
    [storedName],
  );
  return rows[0] ? mapRelease(rows[0]) : null;
}

/**
 * 已发布版本的历史（官网「更新日志」用）。
 *
 * 与 `listLatestPublished` 的区别：那个是"每平台/通道取最新一条"（下载页要按平台分列），
 * 这个是"每个**版本号**取一条"（更新日志按版本叙事，同一版本发到多个平台不该重复出现）。
 *
 * 排序用 published_at 而不是 version：版本号是 TEXT，`1.10.0` 会被当小于 `1.9.0`；
 * 且人工填写的版本号未必严格递增，"按上线时间倒序"才是用户预期的"新的在上面"。
 */
export async function listPublishedChangelog(
  db: IdentityDb,
  limit: number,
): Promise<AppReleaseRow[]> {
  const { rows } = await db.pool.query<RawReleaseRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (version) ${RELEASE_COLUMNS} FROM app_release
       WHERE published = true AND stored_name IS NOT NULL AND sha512_base64 IS NOT NULL
       ORDER BY version, published_at DESC NULLS LAST, id DESC
     ) AS per_version
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(mapRelease);
}
