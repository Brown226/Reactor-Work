// 双平台看板的展示格式化与平台档位元数据（纯函数/常量，不引页面与组件）。
//
// 为什么单独抽出来：主页面、对比面板与会话面板都要用同一套时间/百分比口径与平台配色，
// 就地各写一份必然漂移（表格显示 1.2%，图例显示 1%）—— 与 lib/usage-format.ts 同一理由。

import type { PlatformKey } from "../services/platform-ops";

/** 平台三分档的展示元数据（颜色与 UsageTrend / UsageHeatmap 的语义色一致）。 */
export const PLATFORM_META: Record<PlatformKey, { label: string; color: string }> = {
  desktop: { label: "桌面端", color: "var(--accent)" },
  web: { label: "Web 端", color: "var(--info)" },
  untagged: { label: "未打标", color: "var(--ink-3)" },
};

export const fmtDateTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 占比展示：`0.123 → 12.3%`；total 为 0 时给 0%，不产生 NaN。 */
export const pct = (value: number, total: number): string =>
  total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0%";

/** 服务端未给统计起点时的统一说法（避免各区块各写一句）。 */
export const sinceLabel = (since: string | null): string =>
  since ? `自 ${fmtDate(since)} 起统计` : "统计起点未返回";
