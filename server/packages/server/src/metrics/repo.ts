/**
 * 平台运营指标：写入与聚合查询。
 *
 * 平台归属的两条判定路径（顺序即优先级）：
 * 1. 请求头 `x-reactor-client: desktop|web` —— 未来客户端显式声明，最可靠；
 * 2. UA 特征 —— 浏览器必带 `Mozilla/... (Chrome|Edg|Firefox|Safari)/`，
 *    而桌面端走 Node HTTP 客户端（axios/undici），UA 是 `axios/x.y.z` 或为空。
 *    因此「不像浏览器」即判为 desktop，这比「不像 Electron 即判 web」更稳。
 *
 * ⚠ 用量（tokens/requests）的平台拆分是**近似**：`usage_ledger` 没有平台列，
 *   这里按「窗口内该 uid 最近一次登录的平台」归属。同一用户两端混用时，
 *   会把用量整体算到最近使用的那一端。精确拆分需要令牌携带平台（二期）。
 */
import type { IdentityDb } from "../identity/db.js";

export type ClientPlatform = "desktop" | "web";
/** 未打标：usage_ledger 里存在、但窗口内找不到该 uid 的登录记录。 */
export type PlatformBucket = ClientPlatform | "untagged";

export interface ClientLoginInput {
  uid: string;
  deptId: number | null;
  deptPath: string | null;
  platform: ClientPlatform;
  clientVersion: string | null;
  userAgent: string | null;
  ip: string | null;
}

/**
 * 浏览器 UA 判定。
 *
 * ⚠ 不能写成一条「Mozilla/… (…) … Chrome/版本」的连续正则：真实 UA 里
 * `(KHTML, like Gecko)` 自带括号，`[^)]*` 会在 `(KHTML` 前截断，导致 Chrome 109
 * 的 UA 被判成桌面端（实测踩过）。这里改成两个独立判据同时成立即可。
 */
function looksLikeBrowser(ua: string): boolean {
  return /Mozilla\/[\d.]+/i.test(ua) && /(?:Chrome|Chromium|Edg|Firefox|Safari)\/[\d.]/i.test(ua);
}

export function detectClientPlatform(input: {
  clientHeader?: string | undefined;
  userAgent?: string | undefined;
}): { platform: ClientPlatform; clientVersion: string | null } {
  const declared = input.clientHeader?.trim().toLowerCase();
  if (declared === "desktop" || declared === "web") {
    return {
      platform: declared,
      clientVersion: extractVersion(input.userAgent, declared),
    };
  }
  const ua = input.userAgent ?? "";
  // Electron UA 同时含 Mozilla 与 Chrome，必须先于浏览器判据排除，否则桌面端会被判成 web
  if (/Electron\//i.test(ua)) return { platform: "desktop", clientVersion: extractVersion(ua, "desktop") };
  // 浏览器特征明确 → web
  if (looksLikeBrowser(ua)) return { platform: "web", clientVersion: extractVersion(ua, "web") };
  // 其余（axios/undici/空）来自桌面端主进程
  return { platform: "desktop", clientVersion: extractVersion(ua, "desktop") };
}

function extractVersion(ua: string | undefined, platform: ClientPlatform): string | null {
  if (!ua) return null;
  const electron = /Electron\/([\d.]+)/i.exec(ua);
  if (electron?.[1]) return electron[1];
  const chrome = /(?:Chrome|Chromium|Edg)\/([\d.]+)/i.exec(ua);
  if (chrome?.[1]) return chrome[1];
  const firefox = /Firefox\/([\d.]+)/i.exec(ua);
  if (firefox?.[1]) return firefox[1];
  if (platform === "desktop") {
    const axios = /axios\/([\d.]+)/i.exec(ua);
    if (axios?.[1]) return null; // axios 版本不代表客户端版本，宁可不填
  }
  return null;
}

/** 登录成功后调用。失败不得影响登录本身，调用方负责吞掉异常。 */
export async function recordClientLogin(db: IdentityDb, input: ClientLoginInput): Promise<void> {
  await db.pool.query(
    `INSERT INTO client_login (uid, dept_id, dept_path, platform, client_version, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.uid, input.deptId, input.deptPath, input.platform, input.clientVersion, input.userAgent, input.ip],
  );
}

export interface MetricsWindow {
  from: Date;
  to: Date;
}

export interface PlatformOverviewRow {
  activeUsers: number;
  logins: number;
  requests: number;
  tokens: number;
  /** 去重会话数与人均时长：按 audit_event 的 session_id 归属（同样走最近登录平台的近似） */
  sessions: number;
  avgSessionMinutes: number;
}

const emptyOverview = (): PlatformOverviewRow => ({
  activeUsers: 0,
  logins: 0,
  requests: 0,
  tokens: 0,
  sessions: 0,
  avgSessionMinutes: 0,
});
const emptyBuckets = (): Record<PlatformBucket, PlatformOverviewRow> => ({
  desktop: emptyOverview(),
  web: emptyOverview(),
  untagged: emptyOverview(),
});

/** 窗口内「每个用户最近一次登录的平台」——用量归属的唯一近似依据。 */
const LATEST_PLATFORM_CTE = `
  WITH latest_platform AS (
    SELECT DISTINCT ON (uid) uid, platform
    FROM client_login
    WHERE logged_in_at >= $1 AND logged_in_at <= $2
    ORDER BY uid, logged_in_at DESC
  )`;

export async function overviewByPlatform(
  db: IdentityDb,
  window: MetricsWindow,
): Promise<Record<PlatformBucket, PlatformOverviewRow>> {
  const buckets = emptyBuckets();

  const logins = await db.pool.query<{ platform: ClientPlatform; active_users: string; logins: string }>(
    `SELECT platform, count(DISTINCT uid)::text AS active_users, count(*)::text AS logins
     FROM client_login
     WHERE logged_in_at >= $1 AND logged_in_at <= $2
     GROUP BY platform`,
    [window.from, window.to],
  );
  for (const row of logins.rows) {
    const bucket = buckets[row.platform] ?? buckets.untagged;
    bucket.activeUsers = Number(row.active_users);
    bucket.logins = Number(row.logins);
  }

  const usage = await db.pool.query<{ platform: PlatformBucket; requests: string; tokens: string }>(
    `${LATEST_PLATFORM_CTE}
     SELECT COALESCE(lp.platform, 'untagged') AS platform,
            count(*)::text AS requests,
            COALESCE(sum(COALESCE(ul.input_tokens, 0) + COALESCE(ul.output_tokens, 0)), 0)::text AS tokens
     FROM usage_ledger ul
     LEFT JOIN latest_platform lp ON lp.uid = ul.uid
     WHERE ul.ts >= $1 AND ul.ts <= $2
     GROUP BY 1`,
    [window.from, window.to],
  );
  for (const row of usage.rows) {
    const bucket = buckets[row.platform] ?? buckets.untagged;
    bucket.requests = Number(row.requests);
    bucket.tokens = Number(row.tokens);
  }

  // 会话数与人均时长：按 audit_event 的 session_id 聚合（session 归属同样走最近登录平台）。
  // session 内可能混多个 uid（极少见），取 MIN(uid) 保证分组确定。
  const sessions = await db.pool.query<{
    platform: PlatformBucket;
    sessions: string;
    avg_min: string;
  }>(
    `${LATEST_PLATFORM_CTE},
     session_span AS (
       SELECT MIN(ae.uid) AS uid,
              ae.session_id,
              MIN(ae.ts) AS first_ts,
              MAX(ae.ts) AS last_ts
       FROM audit_event ae
       WHERE ae.ts >= $1 AND ae.ts <= $2
         AND ae.session_id IS NOT NULL AND ae.session_id <> ''
       GROUP BY ae.session_id
     )
     SELECT COALESCE(lp.platform, 'untagged') AS platform,
            count(*)::text AS sessions,
            COALESCE(avg(EXTRACT(EPOCH FROM (session_span.last_ts - session_span.first_ts)) / 60.0), 0)::text AS avg_min
     FROM session_span
     LEFT JOIN latest_platform lp ON lp.uid = session_span.uid
     GROUP BY 1`,
    [window.from, window.to],
  );
  for (const row of sessions.rows) {
    const bucket = buckets[row.platform] ?? buckets.untagged;
    bucket.sessions = Number(row.sessions);
    bucket.avgSessionMinutes = Number(row.avg_min);
  }
  return buckets;
}

export interface SeriesPoint {
  bucket: string;
  value: number;
}

export type SeriesMetric = "active" | "requests" | "tokens";

export async function seriesByPlatform(
  db: IdentityDb,
  window: MetricsWindow,
  metric: SeriesMetric,
  interval: "hour" | "day",
  timeZone: string,
): Promise<Record<PlatformBucket, SeriesPoint[]>> {
  const result: Record<PlatformBucket, SeriesPoint[]> = { desktop: [], web: [], untagged: [] };

  const sql =
    metric === "active"
      ? `SELECT date_trunc($3, logged_in_at AT TIME ZONE $4)::text AS bucket,
                platform,
                count(DISTINCT uid)::text AS value
         FROM client_login
         WHERE logged_in_at >= $1 AND logged_in_at <= $2
         GROUP BY 1, 2 ORDER BY 1`
      : `${LATEST_PLATFORM_CTE}
         SELECT date_trunc($3, ul.ts AT TIME ZONE $4)::text AS bucket,
                COALESCE(lp.platform, 'untagged') AS platform,
                ${metric === "tokens" ? "COALESCE(sum(COALESCE(ul.input_tokens,0)+COALESCE(ul.output_tokens,0)),0)" : "count(*)"}::text AS value
         FROM usage_ledger ul
         LEFT JOIN latest_platform lp ON lp.uid = ul.uid
         WHERE ul.ts >= $1 AND ul.ts <= $2
         GROUP BY 1, 2 ORDER BY 1`;

  const rows = await db.pool.query<{ bucket: string; platform: PlatformBucket; value: string }>(sql, [
    window.from,
    window.to,
    interval,
    timeZone,
  ]);
  for (const row of rows.rows) {
    const bucket = result[row.platform] ?? result.untagged;
    bucket.push({ bucket: row.bucket, value: Number(row.value) });
  }
  return result;
}

export interface HeatmapCell {
  /** 周一=0 … 周日=6（已按看板矩阵下标换算） */
  weekday: number;
  hour: number;
  value: number;
}

export async function heatmapByPlatform(
  db: IdentityDb,
  window: MetricsWindow,
  timeZone: string,
): Promise<Record<PlatformBucket, HeatmapCell[]>> {
  const result: Record<PlatformBucket, HeatmapCell[]> = { desktop: [], web: [], untagged: [] };
  const rows = await db.pool.query<{ weekday: string; hour: string; platform: PlatformBucket; value: string }>(
    `${LATEST_PLATFORM_CTE}
     SELECT ((extract(dow FROM ul.ts AT TIME ZONE $3)::int + 6) % 7)::text AS weekday,
            extract(hour FROM ul.ts AT TIME ZONE $3)::text AS hour,
            COALESCE(lp.platform, 'untagged') AS platform,
            count(*)::text AS value
     FROM usage_ledger ul
     LEFT JOIN latest_platform lp ON lp.uid = ul.uid
     WHERE ul.ts >= $1 AND ul.ts <= $2
     GROUP BY 1, 2, 3`,
    [window.from, window.to, timeZone],
  );
  for (const row of rows.rows) {
    const bucket = result[row.platform] ?? result.untagged;
    // weekday 已换算成周一=0 … 周日=6，与看板矩阵下标直接对应
    bucket.push({ weekday: Number(row.weekday), hour: Number(row.hour), value: Number(row.value) });
  }
  return result;
}

/**
 * 在线快照（阶段一为近似）：没有心跳，只能取最近一次登录。
 * 返回 approx=true，前端必须如实展示口径，不得直接写「在线」。
 */
export async function presenceSnapshot(
  db: IdentityDb,
  windowMinutes: number,
): Promise<{ approx: true; windowMinutes: number; counts: Record<ClientPlatform, number> }> {
  const rows = await db.pool.query<{ platform: ClientPlatform; n: string }>(
    `SELECT platform, count(DISTINCT uid)::text AS n
     FROM client_login
     WHERE last_seen_at >= now() - ($1 || ' minutes')::interval
     GROUP BY platform`,
    [String(windowMinutes)],
  );
  const counts: Record<ClientPlatform, number> = { desktop: 0, web: 0 };
  for (const row of rows.rows) counts[row.platform] = Number(row.n);
  return { approx: true, windowMinutes, counts };
}

export interface ClientLoginRow {
  id: number;
  uid: string;
  platform: ClientPlatform;
  client_version: string | null;
  user_agent: string | null;
  ip: string | null;
  dept_path: string | null;
  logged_in_at: string;
  last_seen_at: string;
}

export interface ClientLoginQuery {
  limit: number;
  offset: number;
  platform: ClientPlatform | null;
  /** 按账号精确过滤；空串/undefined 视为不过滤 */
  uid?: string;
}

export async function listClientLogins(
  db: IdentityDb,
  window: MetricsWindow,
  query: ClientLoginQuery,
): Promise<{ total: number; items: ClientLoginRow[] }> {
  const params: unknown[] = [window.from, window.to];
  let where = `logged_in_at >= $1 AND logged_in_at <= $2`;
  if (query.platform) {
    params.push(query.platform);
    where += ` AND platform = $${params.length}`;
  }
  if (query.uid) {
    params.push(query.uid);
    where += ` AND uid = $${params.length}`;
  }
  const totalRow = await db.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM client_login WHERE ${where}`,
    params,
  );
  const rows = await db.pool.query<ClientLoginRow>(
    `SELECT id, uid, platform, client_version, user_agent, ip, dept_path,
            logged_in_at::text, last_seen_at::text
     FROM client_login WHERE ${where}
     ORDER BY logged_in_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.limit, query.offset],
  );
  return { total: Number(totalRow.rows[0]?.n ?? 0), items: rows.rows };
}

/** 数据覆盖信息：起始时间与「未打标」占比，前端据此如实提示口径。 */
export async function coverageInfo(
  db: IdentityDb,
  window: MetricsWindow,
): Promise<{ since: string | null; untaggedRatio: number }> {
  const sinceRow = await db.pool.query<{ since: string | null }>(
    `SELECT min(logged_in_at)::text AS since FROM client_login`,
  );
  const ratioRow = await db.pool.query<{ tagged: string; total: string }>(
    `${LATEST_PLATFORM_CTE}
     SELECT
       count(*) FILTER (WHERE lp.uid IS NOT NULL)::text AS tagged,
       count(*)::text AS total
     FROM usage_ledger ul LEFT JOIN latest_platform lp ON lp.uid = ul.uid
     WHERE ul.ts >= $1 AND ul.ts <= $2`,
    [window.from, window.to],
  );
  const total = Number(ratioRow.rows[0]?.total ?? 0);
  const tagged = Number(ratioRow.rows[0]?.tagged ?? 0);
  return {
    since: sinceRow.rows[0]?.since ?? null,
    untaggedRatio: total === 0 ? 0 : Number(((total - tagged) / total).toFixed(4)),
  };
}
