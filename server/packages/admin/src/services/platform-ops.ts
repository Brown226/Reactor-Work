// Reactor 管理台 · 双平台运营指标服务
// 契约真源：docs/未完成-管理端双平台运营看板-方案-v1.md §5（/admin/metrics/platform/*）。
//
// 为什么所有接口都返回 `T | null`：后端按阶段上线（阶段一登录记录、阶段二 ledger 平台列、
// 阶段三心跳），路由未注册时是 404。对本页来说 404 表示「该区块还没上线」，不是故障，
// 所以在这里统一降级为 null，由页面渲染「数据尚未上线」空态 —— 页面不需要判断 HTTP 状态，
// 也不会因为后端少一个接口就白屏或抛异常。

import { ApiError, http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "./identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export type PlatformRange = "24h" | "7d" | "30d";
export type PlatformMetric = "requests" | "tokens" | "active";
export type PlatformInterval = "hour" | "day";
/** 与 §3 的档位一致：declared 两档进主口径，*_legacy / *_guess 单独展示，不混算。 */
export type PlatformKey = "desktop" | "web" | "untagged";

export interface PlatformCoverage {
  /** 埋点上线时间（历史不可回溯）；页面据此显示「自 X 起统计」 */
  since: string | null;
  /** 未打标记录占全部记录的比例（0–1）；历史行 platform 为 NULL */
  untaggedRatio: number;
}

export interface PlatformEnvelope {
  /** 服务端生成时间；null = 响应没带，页面显示「—」而不拿本地时间冒充 */
  generatedAt: string | null;
  coverage: PlatformCoverage;
}

export interface PlatformBucket {
  activeUsers: number;
  sessions: number;
  requests: number;
  tokens: number;
  /** 人均会话时长（分钟）：首末事件时间差的均值 */
  avgSessionMinutes: number;
}

export interface PlatformOverview extends PlatformEnvelope {
  range: string | null;
  desktop: PlatformBucket;
  web: PlatformBucket;
  untagged: PlatformBucket;
}

export interface PlatformSeriesPoint {
  /** ISO 时间点（hour 粒度到小时，day 粒度到日） */
  t: string;
  value: number;
}

export interface PlatformSeries extends PlatformEnvelope {
  metric: PlatformMetric;
  interval: PlatformInterval;
  desktop: PlatformSeriesPoint[];
  web: PlatformSeriesPoint[];
  untagged: PlatformSeriesPoint[];
}

export interface PlatformHeatmap extends PlatformEnvelope {
  /** [星期(0=周一)][小时(0–23)]，服务端两种形态都会被归一到这里 */
  desktop: number[][];
  web: number[][];
  untagged: number[][];
}

export interface PlatformPresenceSide {
  online: number;
  active: number;
}

export interface PlatformPresence extends PlatformEnvelope {
  /** true = 阶段一二的近似活跃口径，**不能叫「在线」**（方案 §2 术语纪律） */
  approx: boolean;
  desktop: PlatformPresenceSide;
  web: PlatformPresenceSide;
}

export interface PlatformSessionRow {
  uid: string;
  deptPath: string | null;
  platform: string;
  clientVersion: string | null;
  userAgent: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sessionId: string | null;
}

export interface PlatformSessionsPage extends PlatformEnvelope {
  rows: PlatformSessionRow[];
  /** 下一页游标；null = 已到底 */
  nextCursor: string | null;
}

export interface PlatformSessionsQuery {
  uid?: string;
  platform?: string;
  cursor?: string | null;
  limit?: number;
}

/* ------------------------------ 响应归一 ------------------------------ */

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function readCoverage(raw: unknown): PlatformCoverage {
  const c = asRecord(raw);
  const ratio = num(c.untaggedRatio);
  return {
    since: str(c.since),
    // 服务端若按百分比给（>1）就换算成 0–1，避免页面出现 3000% 这种明显失真
    untaggedRatio: ratio > 1 ? ratio / 100 : ratio,
  };
}

function readEnvelope(raw: unknown): PlatformEnvelope {
  const r = asRecord(raw);
  return { generatedAt: str(r.generatedAt), coverage: readCoverage(r.coverage) };
}

function readBucket(raw: unknown): PlatformBucket {
  const b = asRecord(raw);
  return {
    activeUsers: num(b.activeUsers ?? b.active ?? b.activeApprox),
    sessions: num(b.sessions ?? b.sessionCount),
    requests: num(b.requests ?? b.calls),
    tokens: num(b.tokens ?? b.totalTokens),
    avgSessionMinutes: num(b.avgSessionMinutes ?? b.avgDurationMinutes ?? b.avgMinutes),
  };
}

function readOverview(raw: unknown): PlatformOverview {
  const r = asRecord(raw);
  return {
    ...readEnvelope(r),
    range: str(r.range),
    desktop: readBucket(r.desktop),
    web: readBucket(r.web),
    untagged: readBucket(r.untagged),
  };
}

/**
 * 时序点归一。契约写的是 `{desktop:[],web:[],untagged:[]}`，未写明元素字段；
 * 后端并行开发中，这里接受 `value` 或指标同名字段（requests/tokens/active）以及常见别名。
 * 只做形状归一，不做缺值推算 —— 缺失就是 0，不编造数据。
 */
function readPoints(raw: unknown, metric: PlatformMetric): PlatformSeriesPoint[] {
  return list(raw)
    .map(asRecord)
    .map((p) => ({
      t: str(p.t ?? p.ts ?? p.time ?? p.bucket ?? p.key) ?? "",
      value: num(p.value ?? p[metric] ?? p.count),
    }))
    .filter((p) => p.t !== "");
}

function readSeries(raw: unknown, metric: PlatformMetric, interval: PlatformInterval): PlatformSeries {
  const r = asRecord(raw);
  return {
    ...readEnvelope(r),
    metric: (str(r.metric) as PlatformMetric | null) ?? metric,
    interval: (str(r.interval) as PlatformInterval | null) ?? interval,
    desktop: readPoints(r.desktop, metric),
    web: readPoints(r.web, metric),
    untagged: readPoints(r.untagged, metric),
  };
}

const WEEKDAYS = 7;
const HOURS = 24;

function emptyMatrix(): number[][] {
  return Array.from({ length: WEEKDAYS }, () => Array.from({ length: HOURS }, () => 0));
}

/**
 * 热度矩阵归一成 [星期(0=周一)][小时(0–23)]。
 * 接受「二维数组」与「{weekday,hour,value} 列表」两种形态：方案只写了「24×7 矩阵」，
 * 后端并行实现时形状尚未冻结；这里两种都收，避免一个字段名差异就让整块热力图空白。
 * weekday 同时兼容 0 起（周一=0）与 1 起（ISO 周一=1）两种编号。
 */
function readMatrix(raw: unknown): number[][] {
  const matrix = emptyMatrix();
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    list(raw).slice(0, WEEKDAYS).forEach((row, d) => {
      const target = matrix[d];
      if (!target || !Array.isArray(row)) return;
      for (let h = 0; h < HOURS; h += 1) target[h] = num(row[h]);
    });
    return matrix;
  }
  const cells = list(raw).map(asRecord);
  const rawWeekdays = cells.map((c) => num(c.weekday ?? c.day));
  const oneBased =
    rawWeekdays.length > 0 && rawWeekdays.every((d) => d >= 1 && d <= 7) && !rawWeekdays.includes(0);
  for (const [i, c] of cells.entries()) {
    const weekday = rawWeekdays[i] ?? 0;
    const hour = num(c.hour);
    const d = oneBased ? weekday - 1 : weekday;
    if (d < 0 || d >= WEEKDAYS || hour < 0 || hour >= HOURS) continue;
    const row = matrix[d];
    if (row) row[hour] = num(c.value ?? c.requests ?? c.tokens ?? c.count);
  }
  return matrix;
}

function readHeatmap(raw: unknown): PlatformHeatmap {
  const r = asRecord(raw);
  return {
    ...readEnvelope(r),
    desktop: readMatrix(r.desktop),
    web: readMatrix(r.web),
    untagged: readMatrix(r.untagged),
  };
}

function readPresenceSide(raw: unknown): PlatformPresenceSide {
  // 阶段一二只有一个活跃近似值（数字）；阶段三才有在线连接数
  if (typeof raw === "number") return { online: 0, active: num(raw) };
  const o = asRecord(raw);
  return {
    online: num(o.online ?? o.onlineConnections ?? o.connections),
    active: num(o.active ?? o.activeApprox ?? o.activeUsers),
  };
}

function readPresence(raw: unknown): PlatformPresence {
  const r = asRecord(raw);
  // 阶段一二的响应可能是 { approx:true, activeApprox:{desktop,web} }
  const approxMap = asRecord(r.activeApprox);
  return {
    ...readEnvelope(r),
    // 只有服务端明确给 approx:false 才按「真实在线」展示，默认保守当作近似
    approx: r.approx !== false,
    desktop: readPresenceSide(r.desktop ?? approxMap.desktop),
    web: readPresenceSide(r.web ?? approxMap.web),
  };
}

function readSessionRows(raw: unknown): PlatformSessionRow[] {
  return list(raw)
    .map(asRecord)
    .map((s) => ({
      uid: str(s.uid) ?? "",
      deptPath: str(s.deptPath ?? s.dept_path ?? s.dept),
      platform: str(s.platform) ?? "untagged",
      clientVersion: str(s.clientVersion ?? s.client_version ?? s.version),
      userAgent: str(s.userAgent ?? s.user_agent ?? s.ua),
      firstSeenAt: str(s.firstSeenAt ?? s.first_seen_at ?? s.loggedInAt ?? s.startedAt),
      lastSeenAt: str(s.lastSeenAt ?? s.last_seen_at),
      sessionId: str(s.sessionId ?? s.session_id),
    }))
    .filter((s) => s.uid !== "");
}

function readSessionsPage(raw: unknown): PlatformSessionsPage {
  const r = asRecord(raw);
  return {
    ...readEnvelope(r),
    rows: readSessionRows(r.rows ?? r.items ?? r.sessions),
    nextCursor: str(r.nextCursor ?? r.next_cursor ?? r.cursor),
  };
}

/** 404/501 = 该阶段的接口还没上线 ⇒ null；其它错误照常抛出，由页面如实显示。 */
async function getOrNull<T>(path: string, read: (raw: unknown) => T): Promise<T | null> {
  try {
    return read(await http.get<unknown>(path, AUTH));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return null;
    throw e;
  }
}

/* ------------------------------ 对外 API ------------------------------ */

export const platformOpsApi = {
  overview: (range: PlatformRange) =>
    getOrNull(`/admin/metrics/platform/overview${qs({ range })}`, readOverview),
  series: (metric: PlatformMetric, interval: PlatformInterval) =>
    getOrNull(`/admin/metrics/platform/series${qs({ metric, interval })}`, (raw) =>
      readSeries(raw, metric, interval),
    ),
  heatmap: (range: PlatformRange) =>
    getOrNull(`/admin/metrics/platform/heatmap${qs({ range })}`, readHeatmap),
  presence: () => getOrNull("/admin/metrics/platform/presence", readPresence),
  sessions: (query: PlatformSessionsQuery) =>
    getOrNull(`/admin/metrics/platform/sessions${qs(query)}`, readSessionsPage),
};
