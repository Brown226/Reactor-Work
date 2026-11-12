/**
 * 用量趋势图：逐日 token 的折线，**手写 SVG**。
 *
 * 复刻自 scaffold-vue `charts/TrendChart.vue` 的折线形态（原版本身也是手写 SVG + GSAP，
 * 零图表库）。入参只吃 `UsageSummaryRow[]`，与 `groupBy="day"` 的服务端返回同形 ——
 * 按日聚好后 rows 就是一条有序时间序列，正好是一条趋势线。
 *
 * ## 为什么手写而不引入 recharts
 *
 * `pages/Usage.tsx` 头注与既有实现明确「图表用纯 CSS 条形，**不引入额外运行时依赖**」，
 * 且 scaffold 原版同样不依赖图表库。保持一致，不新增依赖。
 *
 * ## 只用日期分组
 *
 * 部门/模型/用户分组没有时间维，画折线无意义 —— 那些只看下方表格的「占比」列。
 */

import { useMemo, useState, type MouseEvent } from "react";
import type { UsageSummaryRow } from "../services/audit";
import { nf } from "../lib/usage-format";

const W = 760;
const H = 220;
const PAD = { top: 18, right: 18, bottom: 28, left: 52 };

export function UsageTrend({ rows }: { rows: UsageSummaryRow[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const g = useMemo(() => {
    // 按日期升序绘制：ISO 日期字符串的字典序即时间序；不依赖服务端返回顺序。
    const sorted = [...rows].sort((a, b) => a.key.localeCompare(b.key));
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const max = Math.max(1, ...sorted.map((r) => r.totalTokens));
    const n = sorted.length;
    const xAt = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const yAt = (v: number) => PAD.top + innerH - (v / max) * innerH;
    const pts = sorted.map((r, i) => ({ x: xAt(i), y: yAt(r.totalTokens), row: r }));
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const first = pts[0];
    const last = pts[pts.length - 1];
    const area =
      first && last
        ? `${line} L${last.x.toFixed(1)},${PAD.top + innerH} L${first.x.toFixed(1)},${PAD.top + innerH} Z`
        : "";
    // 只画 0 / 一半 / 峰值三条水平参考线，避免网格过密。
    const gridY = [0, 0.5, 1].map((f) => ({ y: PAD.top + innerH * (1 - f), v: Math.round(max * f) }));
    // x 轴标签抽稀：点多了隔步显示，避免文字重叠。
    const step = Math.max(1, Math.ceil(n / 8));
    const xLabels = pts
      .map((p, i) => ({ i, x: p.x, label: p.row.key.length >= 10 ? p.row.key.slice(5) : p.row.key }))
      .filter((l) => l.i % step === 0 || l.i === n - 1);
    return { pts, line, area, gridY, xLabels, innerH };
  }, [rows]);

  if (rows.length === 0) return null;
  const active = hover !== null ? g.pts[hover] : null;
  const peak = Math.max(...rows.map((r) => r.totalTokens));

  /** 按鼠标 x 反查最近的数据点（比每个点铺一个热区更省 DOM，命中区域也更友好）。 */
  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < g.pts.length; i += 1) {
      const pt = g.pts[i];
      if (!pt) continue;
      const d = Math.abs(pt.x - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <div className="ut-wrap">
      <div className="ut-readout mono">
        {active
          ? `${active.row.key} · ${nf(active.row.totalTokens)} tokens · ${active.row.calls} 次调用`
          : `区间峰值 ${nf(peak)} tokens`}
      </div>
      <svg
        className="ut-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`逐日 token 趋势，峰值 ${nf(peak)}`}
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
        {active ? <line className="ut-cursor" x1={active.x} x2={active.x} y1={PAD.top} y2={PAD.top + g.innerH} /> : null}
        <path className="ut-area" d={g.area} />
        <path className="ut-line" d={g.line} />
        {g.pts.map((p, i) => (
          <circle key={p.row.key} className={`ut-dot${i === hover ? " is-on" : ""}`} cx={p.x} cy={p.y} r={i === hover ? 5 : 3} />
        ))}
        {g.xLabels.map((l) => (
          <text key={`xl${l.i}`} className="ut-axis" x={l.x} y={H - 8} textAnchor="middle">
            {l.label}
          </text>
        ))}
      </svg>
    </div>
  );
}
