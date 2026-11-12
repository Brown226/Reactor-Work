/**
 * 24×7 使用热度：桌面端 / Web 端并排热力图，纯 CSS Grid（零依赖）。
 *
 * 色阶直接复用 `UsageHeatmap` 的 `.uh-cell.lv-0…4`（同一套设计令牌），
 * 但**两平台共用同一个上限**：各自归一化会让「桌面端 10 次」和「Web 端 3 次」都染成最深色，
 * 并排比较就失去意义。上限取两平台峰值，颜色深浅可直接横向读。
 */

import { Fragment, useMemo, useState } from "react";
import { nf } from "../lib/usage-format";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export interface PlatformHeatmapPanel {
  key: string;
  label: string;
  /** [星期(0=周一)][小时(0–23)] */
  matrix: number[][];
}

/** 与 UsageHeatmap 同一分档思路：0 是空，其余线性映射到 1–4。 */
function level(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((v / max) * 4)));
}

export function PlatformHeatmap({ panels }: { panels: PlatformHeatmapPanel[] }) {
  const max = useMemo(
    () => Math.max(0, ...panels.flatMap((p) => p.matrix.flat())),
    [panels],
  );
  const [hover, setHover] = useState<{ label: string; weekday: number; hour: number; value: number } | null>(null);

  return (
    <div className="uh-wrap">
      <div className="uh-readout mono" aria-live="polite">
        {hover
          ? `${hover.label} · ${WEEKDAYS[hover.weekday] ?? ""} ${hover.hour}:00 · ${nf(hover.value)} 次请求`
          : max > 0
            ? `24×7 热度 · 两平台共用色阶上限 ${nf(max)}`
            : "24×7 热度 · 暂无请求"}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
        {panels.map((panel) => (
          <div key={panel.key}>
            <div className="cell-sub" style={{ marginBottom: 6, fontWeight: 500 }}>{panel.label}</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `30px repeat(24, 14px)`,
                gap: 3,
                alignItems: "center",
              }}
              onPointerLeave={() => setHover(null)}
            >
              {/* 表头：小时刻度每 3 小时标一次，避免 24 个数字挤在一起 */}
              <span />
              {HOURS.map((h) => (
                <span
                  key={`h-${h}`}
                  className="cell-sub mono"
                  style={{ fontSize: 10, textAlign: "center", whiteSpace: "nowrap", lineHeight: 1 }}
                >
                  {h % 3 === 0 ? h : ""}
                </span>
              ))}
              {WEEKDAYS.map((wd, d) => (
                <Fragment key={`${panel.key}-${wd}`}>
                  <span className="cell-sub" style={{ fontSize: 10, textAlign: "right", whiteSpace: "nowrap" }}>
                    {wd}
                  </span>
                  {HOURS.map((h) => {
                    const value = panel.matrix[d]?.[h] ?? 0;
                    return (
                      <span
                        key={`${panel.key}-${d}-${h}`}
                        className={`uh-cell lv-${level(value, max)}`}
                        style={{ width: 14, height: 14 }}
                        title={`${panel.label} · ${wd} ${h}:00 · ${nf(value)} 次请求`}
                        onPointerEnter={() => setHover({ label: panel.label, weekday: d, hour: h, value })}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="uh-legend">
        <span className="cell-sub">颜色越深请求越密集；两平台同一色阶与上限，可横向比较</span>
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
