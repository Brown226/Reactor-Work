// 双平台运营（管理台「运营」组）：桌面端 / Web 端 / 未打标 的活跃构成、趋势、24×7 热度与会话明细。
// 方案：docs/未完成-管理端双平台运营看板-方案-v1.md §5（接口）与 §6（页面）。
//
// 本页只消费 /admin/metrics/platform/*。后端分阶段上线，缺失的接口一律由 service 层降级为
// null，这里渲染「数据尚未上线」空态 —— 这是本页最重要的产品约束：历史数据不可回溯，
// 空看板必须解释「为什么空」，而不是白屏或弹一串报错。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import {
  platformOpsApi,
  type PlatformHeatmap as PlatformHeatmapData,
  type PlatformInterval,
  type PlatformKey,
  type PlatformMetric,
  type PlatformOverview,
  type PlatformPresence,
  type PlatformRange,
  type PlatformSeries,
  type PlatformSessionsPage,
} from "../services/platform-ops";
import { PageHead } from "../ui";
import { Button } from "../components/ui/button";
import { PlatformTrendChart, type PlatformTrendLine } from "../components/PlatformTrendChart";
import { PlatformHeatmap, type PlatformHeatmapPanel } from "../components/PlatformHeatmap";
import { PlatformOverviewPanel } from "../components/PlatformOverviewPanel";
import { PlatformSessionsPanel } from "../components/PlatformSessionsPanel";
import { SectionEmpty, Unavailable } from "../components/PlatformSectionState";
import { PLATFORM_META, fmtDate, fmtDateTime, pct, sinceLabel } from "../lib/platform-format";
import { useAuthStore } from "../stores/auth";

const RANGES: Array<{ key: PlatformRange; label: string }> = [
  { key: "24h", label: "近 24 小时" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
];
const METRICS: Array<{ key: PlatformMetric; label: string }> = [
  { key: "requests", label: "请求数" },
  { key: "tokens", label: "Token 数" },
  { key: "active", label: "活跃用户" },
];
const INTERVALS: Array<{ key: PlatformInterval; label: string }> = [
  { key: "hour", label: "按小时" },
  { key: "day", label: "按天" },
];
const PLATFORM_KEYS: PlatformKey[] = ["desktop", "web", "untagged"];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function PlatformOps() {
  const scope = useAuthStore((s) => s.scope);

  const [range, setRange] = useState<PlatformRange>("7d");
  const [metric, setMetric] = useState<PlatformMetric>("requests");
  const [interval, setInterval] = useState<PlatformInterval>("day");

  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [series, setSeries] = useState<PlatformSeries | null>(null);
  const [heatmap, setHeatmap] = useState<PlatformHeatmapData | null>(null);
  const [presence, setPresence] = useState<PlatformPresence | null>(null);
  const [sessionPage, setSessionPage] = useState<PlatformSessionsPage | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingSeries, setLoadingSeries] = useState(true);
  const [loadingHeatmap, setLoadingHeatmap] = useState(true);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async (): Promise<void> => {
    setLoadingOverview(true);
    try {
      setOverview(await platformOpsApi.overview(range));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingOverview(false);
    }
  }, [range]);

  const loadSeries = useCallback(async (): Promise<void> => {
    setLoadingSeries(true);
    try {
      setSeries(await platformOpsApi.series(metric, interval));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingSeries(false);
    }
  }, [metric, interval]);

  const loadHeatmap = useCallback(async (): Promise<void> => {
    setLoadingHeatmap(true);
    try {
      setHeatmap(await platformOpsApi.heatmap(range));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoadingHeatmap(false);
    }
  }, [range]);

  const loadPresence = useCallback(async (): Promise<void> => {
    try {
      setPresence(await platformOpsApi.presence());
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadHeatmap();
  }, [loadOverview, loadHeatmap]);
  useEffect(() => {
    void loadSeries();
  }, [loadSeries]);
  useEffect(() => {
    void loadPresence();
  }, [loadPresence]);

  const reloadAll = (): void => {
    setError(null);
    void loadOverview();
    void loadSeries();
    void loadHeatmap();
    void loadPresence();
    setSessionRefreshKey((k) => k + 1);
  };

  /* ---------------- 派生数据 ---------------- */

  // 各区块的 coverage 是同一份服务端口径，取第一个非空即可（前端不自行拼装）
  const coverage =
    overview?.coverage ?? series?.coverage ?? heatmap?.coverage ?? sessionPage?.coverage ?? null;
  const generatedAt =
    overview?.generatedAt ?? series?.generatedAt ?? heatmap?.generatedAt ?? sessionPage?.generatedAt ?? null;
  const sinceText = sinceLabel(coverage?.since ?? null);
  const untaggedRatio = coverage?.untaggedRatio ?? 0;

  const trendLines: PlatformTrendLine[] = useMemo(
    () =>
      series
        ? PLATFORM_KEYS.map((key) => ({
            key,
            label: PLATFORM_META[key].label,
            color: PLATFORM_META[key].color,
            points: series[key],
          }))
        : [],
    [series],
  );
  const trendEmpty = trendLines.every((l) => l.points.length === 0);

  const heatPanels: PlatformHeatmapPanel[] = useMemo(
    () =>
      heatmap
        ? (["desktop", "web"] as PlatformKey[]).map((key) => ({
            key,
            label: PLATFORM_META[key].label,
            matrix: heatmap[key],
          }))
        : [],
    [heatmap],
  );
  const heatMax = heatmap ? Math.max(0, ...heatmap.desktop.flat(), ...heatmap.web.flat()) : 0;

  return (
    <div>
      <PageHead
        title="平台运营"
        desc="桌面端与 Web 端的活跃构成、趋势、时段热度与会话明细；历史数据不可回溯，空态即「尚未开始统计」。"
        scope={scope?.kind === "dept" ? "dept" : scope?.kind === "self" ? "self" : "all"}
      />

      <div className="toolbar" style={{ marginTop: 0, marginBottom: 12 }}>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <span className="cell-sub mono">生成于 {fmtDateTime(generatedAt)}</span>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={reloadAll}>
          <ArrowsClockwise size={14} /> 刷新
        </Button>
      </div>

      {/* 非 404 的失败要如实说明是「接口异常」，不能与空数据混为一谈 */}
      {error ? (
        <div className="panel" style={{ marginBottom: 16, background: "var(--danger-soft)", borderColor: "transparent" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--danger)", fontWeight: 500 }}>
            <WarningCircle size={15} /> 平台指标加载失败：{error}
          </div>
          <div className="cell-sub" style={{ marginTop: 4 }}>
            这是接口异常，不是「没有数据」；接口未提供（404）会按「数据尚未上线」降级，不计入此提示。
          </div>
        </div>
      ) : null}

      {/* 未打标提示：只要 >0 就提示；≥20% 按方案 §6 追加一句「仅作趋势参考」 */}
      {untaggedRatio > 0 ? (
        <div className="panel" style={{ marginBottom: 16, background: "var(--warn-soft)", borderColor: "transparent" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--warn)", fontWeight: 500 }}>
            <WarningCircle size={15} /> 有 {pct(untaggedRatio, 1)} 的记录未打标（历史数据没有平台字段）
          </div>
          <div className="cell-sub" style={{ marginTop: 4 }}>
            未打标数据不并入桌面端或 Web 端，平台对比会偏低。
            {untaggedRatio >= 0.2 ? "未打标占比高于 20%，平台拆分结果仅作趋势参考。" : ""}
          </div>
        </div>
      ) : null}

      {/* ① 平台对比条 */}
      <PlatformOverviewPanel
        overview={overview}
        presence={presence}
        loading={loadingOverview}
        rangeLabel={RANGES.find((r) => r.key === range)?.label ?? ""}
        sinceText={sinceText}
      />

      {/* ② 双平台趋势 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>双平台趋势</h3>
            <div className="sub">桌面端 / Web 端 / 未打标三条线；缺数据的时段画断点，不补 0。</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div className="seg">
              {METRICS.map((m) => (
                <button key={m.key} className={metric === m.key ? "on" : ""} onClick={() => setMetric(m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
            <div className="seg">
              {INTERVALS.map((i) => (
                <button key={i.key} className={interval === i.key ? "on" : ""} onClick={() => setInterval(i.key)}>
                  {i.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {loadingSeries && series === null ? (
          <div className="cell-sub" style={{ padding: "8px 0" }}>加载中…</div>
        ) : series === null ? (
          <Unavailable section="平台趋势" />
        ) : trendEmpty ? (
          <SectionEmpty
            title={`${sinceText}，暂无趋势数据`}
            desc="该指标与时间粒度下确实没有事件；切换指标不会改变统计起点。"
          />
        ) : (
          <PlatformTrendChart
            lines={trendLines}
            interval={series.interval}
            metricLabel={METRICS.find((m) => m.key === series.metric)?.label ?? "指标"}
          />
        )}
      </div>

      {/* ③ 24×7 使用热度 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>24×7 使用热度</h3>
            <div className="sub">按星期 × 小时统计请求数，两平台并排；未打标不进热力图（口径同方案 §6）。</div>
          </div>
        </div>
        {loadingHeatmap && heatmap === null ? (
          <div className="cell-sub" style={{ padding: "8px 0" }}>加载中…</div>
        ) : heatmap === null ? (
          <Unavailable section="24×7 热度" />
        ) : heatMax === 0 ? (
          <SectionEmpty
            title={`${sinceText}，暂无使用热度`}
            desc="热力图仅统计带平台标记的请求；若上方未打标占比很高，这里会偏空。"
          />
        ) : (
          <PlatformHeatmap panels={heatPanels} />
        )}
      </div>

      {/* ④ 会话明细（自带筛选与分页状态） */}
      <PlatformSessionsPanel
        refreshKey={sessionRefreshKey}
        onEnvelope={setSessionPage}
        onError={setError}
      />

      {/* ⑤ 口径说明：回答「数据从哪来、为什么空、在线到底是不是在线」 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <div>
            <h3>口径说明</h3>
            <div className="sub">数据来自 /admin/metrics/platform/*；历史数据不可回溯，先埋点后有数。</div>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <span><span className="cell-sub">统计起点 </span><b>{coverage?.since ? fmtDate(coverage.since) : "—"}</b></span>
          <span><span className="cell-sub">未打标占比 </span><b className="mono">{coverage ? pct(coverage.untaggedRatio, 1) : "—"}</b></span>
          <span><span className="cell-sub">数据生成于 </span><b className="mono">{fmtDateTime(generatedAt)}</b></span>
          <span>
            <span className="cell-sub">在线口径 </span>
            <b>{presence ? (presence.approx ? "活跃（近似，非在线连接）" : "在线连接") : "—"}</b>
          </span>
        </div>
        <div className="cell-sub" style={{ marginTop: 8 }}>
          「活跃」= 最近窗口内产生过登录 / 用量 / 审计事件的去重用户，是近似值；只有客户端心跳上线后，「在线」才名副其实。
          未打标（历史行 platform 为空）不并入桌面端或 Web 端，也不伪造归属。
        </div>
      </div>
    </div>
  );
}
