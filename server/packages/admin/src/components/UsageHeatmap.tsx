/**
 * 用量日历热力图：GitHub 风格的「近 12 个月 × 每天一格」，**纯 CSS Grid**（零依赖）。
 *
 * 与 `UsageTrend` 的分工：
 *   · 本组件看**长期**（一年里哪段时间密集、有没有断档），一格 = 一天；
 *   · `UsageTrend` 看**近期细节**（近 30 天逐日读数，可悬停查看）。
 *
 * 数据与趋势图同一份 `groupBy=day` 的 rows —— 页面只为热力图额外拉一次 365 天区间
 * （时间筛选只覆盖趋势图与表格，热力图固定看一年），不新增后端接口。
 */

import { useMemo, useState } from "react";
import type { UsageSummaryRow } from "../services/audit";
import { nf } from "../lib/usage-format";
import { buildHeatCalendar, type HeatDay } from "../lib/usage-heatmap";

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", "日"];

export function UsageHeatmap({ rows, days = 365 }: { rows: UsageSummaryRow[]; days?: number }) {
  const [hover, setHover] = useState<HeatDay | null>(null);
  const cal = useMemo(() => buildHeatCalendar(rows, days), [rows, days]);

  if (cal.weeks.length === 0) return null;

  return (
    <div className="uh-wrap">
      <div className="uh-readout mono" aria-live="polite">
        {hover
          ? `${hover.date} · ${nf(hover.tokens)} tokens · ${hover.calls} 次调用`
          : cal.peak
            ? `近 ${days} 天活跃 ${cal.activeDays} 天 · 峰值 ${cal.peak.date}（${nf(cal.peak.tokens)} tokens）`
            : `近 ${days} 天暂无用量`}
      </div>

      <div className="uh-scroll">
        {/* 月份标注：按周索引对齐到网格列（每周一列） */}
        <div className="uh-months" style={{ gridTemplateColumns: `repeat(${cal.weeks.length}, var(--uh-cell))` }}>
          {cal.monthLabels.map((m) => (
            <span key={`${m.weekIndex}-${m.label}`} className="uh-month" style={{ gridColumnStart: m.weekIndex + 1 }}>
              {m.label}
            </span>
          ))}
        </div>

        <div className="uh-body">
          {/* 星期行标（只标一/三/五/日，与 GitHub 一致） */}
          <div className="uh-days" aria-hidden="true">
            {WEEKDAY_LABELS.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </div>

          <div
            className="uh-grid"
            style={{ gridTemplateColumns: `repeat(${cal.weeks.length}, var(--uh-cell))` }}
            role="img"
            aria-label={`近 ${days} 天 token 用量热力图，活跃 ${cal.activeDays} 天`}
            onPointerLeave={() => setHover(null)}
          >
            {/* 按「列=周、行=星期」铺：CSS Grid 用 grid-auto-flow: column 竖着填，天然对齐 */}
            {cal.weeks.flatMap((w) =>
              w.days.map((d, di) => {
                if (!d) return <span key={`${w.days[0]?.date ?? "x"}-${di}-empty`} className="uh-cell is-empty" />;
                return (
                  <span
                    key={d.date}
                    className={`uh-cell lv-${d.level}${hover?.date === d.date ? " is-on" : ""}`}
                    title={`${d.date} · ${nf(d.tokens)} tokens · ${d.calls} 次调用`}
                    aria-label={`${d.date}，${nf(d.tokens)} tokens`}
                    onPointerEnter={() => setHover(d)}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>

      <div className="uh-legend">
        <span className="cell-sub">{cal.peak ? `峰值 ${nf(cal.peak.tokens)}` : "暂无数据"}</span>
        <span className="uh-scale" aria-hidden="true">
          少
          <i className="uh-cell lv-0" />
          <i className="uh-cell lv-1" />
          <i className="uh-cell lv-2" />
          <i className="uh-cell lv-3" />
          <i className="uh-cell lv-4" />
          多
        </span>
      </div>
    </div>
  );
}
