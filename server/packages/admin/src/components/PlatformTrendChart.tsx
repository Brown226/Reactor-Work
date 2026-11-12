/**
 * 双平台趋势图：请求数 / Token / 活跃用户三条线（桌面端、Web 端、未打标），手写 SVG。
 *
 * 为什么手写而不上 recharts：本包虽然有 recharts（KB 移植件在用），但管理台的用量图表
 *（`UsageTrend` / `UsageHeatmap`）一直是手写 SVG + 纯 CSS，头注也写明「不引入额外运行时依赖」。
 * 这里沿用同一套 `.ut-*` 样式与坐标算法，保持两页图表观感一致，也不给首屏再加一个图表库。
 *
 * 数据点按时间并集铺 x 轴：某平台在某个小时没有记录时画**断点**而不是补 0 ——
 * 补 0 会把「没数据」画成「用量归零」，这是最容易被误读的假象。
 */

import { useMemo, useState, type MouseEvent } from "react";
import type { PlatformInterval, PlatformSeriesPoint } from "../services/platform-ops";
import { nf } from "../lib/usage-format";

const W = 760;
const H = 220;
const PAD = { top: 18, right: 18, bottom: 28, left: 56 };

export interface PlatformTrendLine {
  key: string;
  label: string;
  color: string;
  points: PlatformSeriesPoint[];
}

/** x 轴与读数里的时间标签：ISO 时间串 → 本地「MM-DD HH:00」/「MM-DD」。 */
function bucketLabel(iso: string, interval: PlatformInterval): string {
  // 纯日期串按原样取月日，避免 new Date("2026-10-30") 被当成 UTC 零点后落到前一天
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.slice(5);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (v: number): string => String(v).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return interval === "hour" ? `${md} ${p(d.getHours())}:00` : md;
}

const fmtValue = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : nf(v));

export function PlatformTrendChart({
  lines,
  interval,
  metricLabel,
}: {
  lines: PlatformTrendLine[];
  interval: PlatformInterval;
  metricLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const g = useMemo(() => {
    const times = new Set<string>();
    for (const line of lines) for (const p of line.points) times.add(p.t);
    const labels = [...times].sort(); // ISO 时间串字典序 = 时间序
    const n = labels.length;
    const maps = lines.map((line) => new Map(line.points.map((p) => [p.t, p.value])));
    const series = lines.map((line, li) => ({
      ...line,
      values: labels.map((t) => maps[li]?.get(t) ?? null),
    }));
    const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const max = Math.max(1, ...values);
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const xAt = (i: number): number =>
      PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const yAt = (v: number): number => PAD.top + innerH - (v / max) * innerH;
    const paths = series.map((s) => {
      let d = "";
      let started = false;
      s.values.forEach((v, i) => {
        if (v === null) {
          started = false; // 断点：缺桶不画线
          return;
        }
        d += `${started ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
        started = true;
      });
      return d;
    });
    const gridY = [0, 0.5, 1].map((f) => ({ y: PAD.top + innerH * (1 - f), v: Math.round(max * f) }));
    // 标签抽稀：点多了隔步显示，避免文字重叠
    const step = Math.max(1, Math.ceil(n / 6));
    const xLabels = labels
      .map((t, i) => ({ t, i }))
      .filter((x) => x.i % step === 0 || x.i === n - 1)
      .map((x) => ({ i: x.i, t: x.t, x: xAt(x.i) }));
    return { labels, series, paths, max, innerH, gridY, xLabels };
  }, [lines]);

  const n = g.labels.length;
  if (n === 0) return null;

  const innerW = W - PAD.left - PAD.right;
  const xAt = (i: number): number => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number): number => PAD.top + g.innerH - (v / g.max) * g.innerH;

  const hoverIndex = hover !== null && hover >= 0 && hover < n ? hover : null;
  const activeTime = hoverIndex !== null ? g.labels[hoverIndex] : undefined;

  /** 按鼠标 x 反查最近的桶（与 UsageTrend 同一命中方式）。 */
  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const raw = n <= 1 ? 0 : ((px - PAD.left) / innerW) * (n - 1);
    setHover(Math.min(n - 1, Math.max(0, Math.round(raw))));
  };

  return (
    <div className="ut-wrap">
      <div className="ut-readout mono">
        {activeTime !== undefined && hoverIndex !== null
          ? `${bucketLabel(activeTime, interval)} · ${g.series
              .map((s) => `${s.label} ${fmtValue(s.values[hoverIndex])}`)
              .join(" · ")}`
          : `${metricLabel}峰值 ${nf(g.max)}`}
      </div>
      <svg
        className="ut-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`双平台${metricLabel}趋势`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {g.gridY.map((t) => (
          <line key={`gl${t.y}`} className="ut-grid-line" x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} />
        ))}
        {g.gridY.map((t) => (
          <text key={`gt${t.y}`} className="ut-axis" x={PAD.left - 10} y={t.y + 3.5} textAnchor="end">
            {nf(t.v)}
          </text>
        ))}
        {hoverIndex !== null ? (
          <line
            className="ut-cursor"
            x1={xAt(hoverIndex)}
            x2={xAt(hoverIndex)}
            y1={PAD.top}
            y2={PAD.top + g.innerH}
          />
        ) : null}
        {g.series.map((s, li) => (
          <path key={`p-${s.key}`} d={g.paths[li] ?? ""} className="ut-line" style={{ stroke: s.color }} />
        ))}
        {g.series.map((s) =>
          s.values.map((v, i) => {
            if (v === null) return null;
            return (
              <circle
                key={`d-${s.key}-${i}`}
                className={`ut-dot${i === hoverIndex ? " is-on" : ""}`}
                cx={xAt(i)}
                cy={yAt(v)}
                r={i === hoverIndex ? 5 : 3}
                style={{ stroke: s.color, fill: i === hoverIndex ? s.color : "var(--surface)" }}
              />
            );
          }),
        )}
        {g.xLabels.map((l) => (
          <text key={`xl${l.i}`} className="ut-axis" x={l.x} y={H - 8} textAnchor="middle">
            {bucketLabel(l.t, interval)}
          </text>
        ))}
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
        {g.series.map((s) => (
          <span key={`lg-${s.key}`} className="cell-sub" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <i style={{ width: 10, height: 2.5, borderRadius: 2, background: s.color, display: "inline-block" }} />
            {s.label}
          </span>
        ))}
        <span className="cell-sub" style={{ marginLeft: "auto" }}>
          缺数据的时段画断点，不补 0
        </span>
      </div>
    </div>
  );
}
