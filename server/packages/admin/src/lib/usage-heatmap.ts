/**
 * 用量日历热力图：把「按日聚合」的 token 用量摊成 GitHub 风格的 365 天日历网格。
 *
 * 数据来源与 `UsageTrend` 完全一致（`groupBy=day` 的 rows），本模块只做**纯函数装换**，
 * 不发请求、不读 store —— 页面调一次接口，两次视图共用同一份 rows。
 *
 * ## 为什么按「分位」而不是「线性比例」分级
 *
 * token 用量是长尾分布：单日峰值可能是平常日的 10 倍以上。若按 `value / max` 线性分 4 档，
 * 绝大多数格子会落在最低档，整张图看起来几乎全空，失去"哪天用得多"的辨识度。
 * scaffold 的 `heatmap.ts` 同样用分位（25/50/75），这里沿用同一口径。
 *
 * 注意：分位在**非零值**上取（零值单独是 level 0）。否则某个区间里大半是零的日子会把
 * 分位整体压低，导致"用了一点点"和"用了很多"都被分到同一档。
 */

import type { UsageSummaryRow } from "../services/audit";

/** 一格 = 一天。`level` 0 表示无用量。 */
export interface HeatDay {
  /** `YYYY-MM-DD`（本地时区），用作 key 与 tooltip 文案 */
  date: string;
  tokens: number;
  calls: number;
  /** 0 = 无用量；1–4 = 由浅到深 */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatWeek {
  /** 本周 7 格，周一在前；`null` 表示该位置在区间外（首周开头 / 末周结尾） */
  days: Array<HeatDay | null>;
}

export interface HeatCalendar {
  weeks: HeatWeek[];
  /** 有数据的日子总数 */
  activeDays: number;
  /** 区间内的 token 总和 */
  totalTokens: number;
  /** 单日峰值（无数据时为 null） */
  peak: HeatDay | null;
  /** 月份标签：`{ weekIndex, label }`，供顶部月份标注定位 */
  monthLabels: Array<{ weekIndex: number; label: string }>;
}

/** 本地时区的 `YYYY-MM-DD`（不能用 toISOString：那是 UTC，跨时区会错一天）。 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 取分位切点。`p` 为 0–1，返回该分位上的值（最近邻法，与 scaffold 一致）。
 * 空数组返回 0 —— 调用方据此把全部格子判为 level 0。
 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

/**
 * 构建日历网格。
 *
 * @param rows 服务端 `groupBy=day` 的返回（`key` 为 `YYYY-MM-DD`）
 * @param days 回看天数，默认 365
 * @param today 参考"今天"（注入便于测试；缺省取系统时间）
 */
export function buildHeatCalendar(
  rows: UsageSummaryRow[],
  days = 365,
  today: Date = new Date(),
): HeatCalendar {
  const byDate = new Map<string, UsageSummaryRow>();
  for (const r of rows) byDate.set(r.key.slice(0, 10), r);

  // 起点：从 today 往前推 days-1 天，再对齐到**周一**，保证首周不满时留出空位而不是错位。
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - (days - 1));
  const startDow = (start.getDay() + 6) % 7; // 周一=0，周日=6
  start.setDate(start.getDate() - startDow);

  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endDow = (end.getDay() + 6) % 7;

  // 1) 摊平成连续日期序列，同时收集非零值供分位分级
  const flat: HeatDay[] = [];
  const nonzero: number[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const date = localDateKey(cursor);
    const r = byDate.get(date);
    const tokens = r?.totalTokens ?? 0;
    const calls = r?.calls ?? 0;
    flat.push({ date, tokens, calls, level: 0 });
    if (tokens > 0) nonzero.push(tokens);
    cursor.setDate(cursor.getDate() + 1);
  }

  // 末周补到周日，让矩形完整（补的是 null，不是零值格子）
  const trailing = 6 - endDow;

  // 2) 分位分级（只在非零值上取切点）
  nonzero.sort((a, b) => a - b);
  const cuts = [quantile(nonzero, 0.25), quantile(nonzero, 0.5), quantile(nonzero, 0.75)];
  for (const d of flat) {
    if (d.tokens <= 0) {
      d.level = 0;
    } else if (d.tokens <= (cuts[0] ?? 0)) {
      d.level = 1;
    } else if (d.tokens <= (cuts[1] ?? 0)) {
      d.level = 2;
    } else if (d.tokens <= (cuts[2] ?? 0)) {
      d.level = 3;
    } else {
      d.level = 4;
    }
  }

  // 3) 切成周（首周前导 null + 末周尾随 null）
  const weeks: HeatWeek[] = [];
  let idx = 0;
  let week: Array<HeatDay | null> = new Array<HeatDay | null>(startDow).fill(null);
  while (idx < flat.length) {
    const d = flat[idx];
    if (!d) break;
    week.push(d);
    idx += 1;
    if (week.length === 7) {
      weeks.push({ days: week });
      week = [];
    }
  }
  if (week.length > 0) {
    for (let i = 0; i < trailing + 1 && week.length < 7; i += 1) week.push(null);
    weeks.push({ days: week });
  }

  // 4) 月份标签：某周第一天落在新月份时打标（避免同一月份重复标注）
  const monthLabels: Array<{ weekIndex: number; label: string }> = [];
  let lastMonth = -1;
  weeks.forEach((w, wi) => {
    const firstReal = w.days.find((d): d is HeatDay => d !== null);
    if (!firstReal) return;
    const month = Number(firstReal.date.slice(5, 7));
    if (month !== lastMonth) {
      monthLabels.push({ weekIndex: wi, label: `${month}月` });
      lastMonth = month;
    }
  });

  const peakRow = flat.reduce<HeatDay | null>((best, d) => (!best || d.tokens > best.tokens ? d : best), null);

  return {
    weeks,
    activeDays: nonzero.length,
    totalTokens: flat.reduce((s, d) => s + d.tokens, 0),
    peak: peakRow && peakRow.tokens > 0 ? peakRow : null,
    monthLabels,
  };
}
