// 平台对比面板：desktop / web / 未打标 的活跃构成条 + 三项核心指标对照。
// 拆成独立组件只为控制主页面体量；它不取数，完全由页面传入的 overview 驱动。

import { useMemo } from "react";
import type { PlatformBucket, PlatformOverview, PlatformKey, PlatformPresence } from "../services/platform-ops";
import { ToneBadge } from "./reactor";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { SectionEmpty, Unavailable } from "./PlatformSectionState";
import { nf } from "../lib/usage-format";
import { PLATFORM_META, pct } from "../lib/platform-format";

const KEYS: PlatformKey[] = ["desktop", "web", "untagged"];

/**
 * 术语纪律（方案 §2）：阶段一二只有近似活跃，绝不能写成「在线」。
 * 只有服务端 approx:false（阶段三心跳上线）时才使用「在线连接」。
 */
function presenceText(p: PlatformPresence): string {
  return p.approx
    ? `活跃（近似）· 桌面 ${p.desktop.active} · Web ${p.web.active}`
    : `在线连接 · 桌面 ${p.desktop.online} · Web ${p.web.online}`;
}

export function PlatformOverviewPanel({
  overview,
  presence,
  loading,
  rangeLabel,
  sinceText,
}: {
  overview: PlatformOverview | null;
  presence: PlatformPresence | null;
  loading: boolean;
  rangeLabel: string;
  sinceText: string;
}) {
  const buckets = useMemo(
    () => (overview ? KEYS.map((key) => ({ key, ...PLATFORM_META[key], bucket: overview[key] as PlatformBucket })) : []),
    [overview],
  );
  const total = buckets.reduce((sum, b) => sum + b.bucket.activeUsers, 0);

  const metricRows: Array<{ label: string; get: (b: PlatformBucket) => string }> = [
    { label: "活跃用户", get: (b) => String(b.activeUsers) },
    { label: "会话数", get: (b) => String(b.sessions) },
    { label: "请求数", get: (b) => nf(b.requests) },
    { label: "Token 数", get: (b) => nf(b.tokens) },
    // 人均时长 0 分钟通常意味着样本不足，显示「—」比「0.0 分」诚实
    { label: "人均时长", get: (b) => (b.avgSessionMinutes > 0 ? `${b.avgSessionMinutes.toFixed(1)} 分` : "—") },
  ];

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <div>
          <h3>平台对比</h3>
          <div className="sub">活跃用户构成（{rangeLabel}）；未打标不计入任一平台。</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {presence ? (
            <ToneBadge tone={presence.approx ? "neutral" : "success"}>{presenceText(presence)}</ToneBadge>
          ) : null}
        </div>
      </div>

      {loading && overview === null ? (
        <div className="cell-sub" style={{ padding: "8px 0" }}>加载中…</div>
      ) : overview === null ? (
        <Unavailable section="平台概览" />
      ) : total === 0 ? (
        <SectionEmpty
          title={`${sinceText}，暂无活跃用户`}
          desc="平台字段自埋点上线起才有；此前的登录与用量无法回溯归属，属预期空态。"
        />
      ) : (
        <>
          <div
            style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--surface-2)" }}
            role="img"
            aria-label={`平台活跃构成：${buckets.map((b) => `${b.label} ${b.bucket.activeUsers}`).join("，")}`}
          >
            {buckets.map((b) =>
              b.bucket.activeUsers > 0 ? (
                <div
                  key={b.key}
                  title={`${b.label} ${b.bucket.activeUsers} 人`}
                  style={{ width: `${(b.bucket.activeUsers / total) * 100}%`, background: b.color }}
                />
              ) : null,
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 10 }}>
            {buckets.map((b) => (
              <span key={b.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <i style={{ width: 9, height: 9, borderRadius: 2, background: b.color, display: "inline-block" }} />
                <span>{b.label}</span>
                <b className="mono">{b.bucket.activeUsers}</b>
                <span className="cell-sub">{pct(b.bucket.activeUsers, total)}</span>
              </span>
            ))}
          </div>
          <div className="tablewrap" style={{ marginTop: 12 }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>指标</TableHead>
                  {buckets.map((b) => (
                    <TableHead key={b.key} className="num-cell">{b.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {metricRows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell>{row.label}</TableCell>
                    {buckets.map((b) => (
                      <TableCell key={b.key} className="num-cell mono">{row.get(b.bucket)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
