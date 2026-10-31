/**
 * DWG/DXF 在线预览：把服务端 sidecar 的 graph 输出画成 SVG。
 *
 * 为什么不用图片：sidecar 给的是矢量数据（线段坐标 + 块插入点），直接画 SVG 可以
 * 无损缩放、按图层分色，也不需要服务端做栅格化。
 *
 * 局限（已知，非 bug）：sidecar 的 graph 只收 LINE/多段线与 INSERT 插入点，
 * 圆、圆弧、椭圆、块属性不在其输出里——预览图会比真实图纸少这些图元。
 * 因此界面上必须同时给出「图元明细 + 下载原件」，不能假装是完整渲染。
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { spaceClient, type DwgGraph, type DwgSegment } from "./spaceClient.js";

/** 单屏最多画的线段数：2 万条 polyline 会把主线程卡住，超出部分提示已截断。 */
const MAX_RENDER_SEGMENTS = 8000;
const VIEW = 1000;
const PAD = 20;

/** 图层配色：按图层名哈希取固定色，保证同一图层每次打开颜色一致。 */
const LAYER_COLORS = ["#2f7fd1", "#d1495b", "#2a9d8f", "#e9a13b", "#7b6d8d", "#4a6fa5", "#8a9a5b"];

function colorForLayer(layer: string): string {
  let hash = 0;
  for (let index = 0; index < layer.length; index += 1) {
    hash = (hash * 31 + layer.charCodeAt(index)) % 997;
  }
  return LAYER_COLORS[hash % LAYER_COLORS.length] ?? LAYER_COLORS[0]!;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBounds(graph: DwgGraph): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const segment of graph.segments) {
    for (const point of segment.points) visit(point.x, point.y);
  }
  for (const symbol of graph.symbols) visit(symbol.insert.x, symbol.insert.y);
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

/** 同一个 SVG 组件被详情栏与放大视图复用，避免两份投影逻辑漂移。 */
function DrawingSvg({
  segments,
  symbols,
  project,
  ariaLabel,
}: {
  segments: DwgSegment[];
  symbols: DwgGraph["symbols"];
  project: (point: { x: number; y: number }) => string;
  ariaLabel: string;
}) {
  return (
    <svg viewBox={`0 0 ${VIEW} ${VIEW}`} className="h-full w-full" role="img" aria-label={ariaLabel}>
      {segments.map((segment, index) =>
        segment.points.length >= 2 ? (
          <polyline
            key={segment.handle ?? `seg-${index}`}
            points={segment.points.map(project).join(" ")}
            fill="none"
            stroke={colorForLayer(segment.layer)}
            strokeWidth={0.8}
            vectorEffect="non-scaling-stroke"
          />
        ) : null,
      )}
      {symbols.map((symbol, index) => {
        const [cx, cy] = project(symbol.insert).split(",");
        return <circle key={`sym-${index}`} cx={cx} cy={cy} r={1.6} fill="#444" opacity={0.7} />;
      })}
    </svg>
  );
}

export function MySpaceDwgPreview({ relPath }: { relPath: string }) {
  const [graph, setGraph] = useState<DwgGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 详情栏只有 288px 宽，图纸在里面基本看不清；放大视图是同一个 SVG，只是给足空间。
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGraph(null);
    void spaceClient
      .dwg(relPath)
      .then((result) => {
        if (!cancelled) setGraph(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  const bounds = useMemo(() => (graph ? computeBounds(graph) : null), [graph]);
  const layers = useMemo(() => {
    if (!graph) return [];
    const counter = new Map<string, number>();
    for (const segment of graph.segments) {
      counter.set(segment.layer, (counter.get(segment.layer) ?? 0) + 1);
    }
    return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [graph]);

  const download = (
    <Button size="sm" variant="outline" onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}>
      <Download className="mr-2 size-4" /> 下载原件
    </Button>
  );

  if (loading) {
    return <p className="p-4 text-ui-sm text-foreground-subtle">正在解析图纸…（首次打开需要几秒）</p>;
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-ui-sm text-foreground-subtle">{error}</p>
        {download}
      </div>
    );
  }

  if (!graph || !bounds) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-ui-sm text-foreground-subtle">
          这张图纸里没有可预览的线段或块引用（可能全部由圆/圆弧/文字构成）。
        </p>
        {download}
      </div>
    );
  }

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const scale = (VIEW - PAD * 2) / Math.max(width, height);
  // 两个方向都要居中：宽扁的图纸只做等比缩放会贴在画布底部，看着像渲染失败。
  const offsetX = (VIEW - width * scale) / 2;
  const offsetY = (VIEW - height * scale) / 2;
  // CAD 的 Y 轴向上、SVG 向下：投影时翻转 Y，否则图纸上下颠倒
  const project = (point: { x: number; y: number }): string => {
    const x = (point.x - bounds.minX) * scale + offsetX;
    const y = VIEW - ((point.y - bounds.minY) * scale + offsetY);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const segments = graph.segments.slice(0, MAX_RENDER_SEGMENTS);
  const hiddenSegments = graph.segments.length - segments.length;

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden bg-white">
        <DrawingSvg segments={segments} symbols={graph.symbols} project={project} ariaLabel={relPath} />
        <Button
          size="sm"
          variant="outline"
          className="absolute right-1.5 top-1.5 h-7 gap-1 px-2 text-ui-xs"
          data-testid="dwg-expand"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 className="size-3" /> 放大
        </Button>
      </div>
      <div className="space-y-1 border-t border-border px-2 py-1.5 text-ui-xs text-foreground-subtle">
        <div className="flex flex-wrap items-center gap-x-3">
          <span>版本 {graph.version ?? "—"}</span>
          <span>线段 {graph.segments.length}</span>
          <span>块引用 {graph.symbols.length}</span>
          {graph.ms !== undefined ? <span>解析 {graph.ms} ms</span> : null}
        </div>
        {layers.length > 0 ? (
          <div className="flex flex-wrap gap-x-2">
            {layers.map(([layer, count]) => (
              <span key={layer} className="inline-flex items-center gap-1">
                <i className="inline-block size-2 rounded-sm" style={{ background: colorForLayer(layer) }} />
                {layer} {count}
              </span>
            ))}
          </div>
        ) : null}
        {hiddenSegments > 0 ? (
          <div>图元过多，仅渲染前 {MAX_RENDER_SEGMENTS} 条（其余 {hiddenSegments} 条请下载原件查看）</div>
        ) : null}
        {graph.truncated ? <div>服务端解析已截断（超过上限），预览不完整。</div> : null}
        <div>预览只含线段与块引用，圆/圆弧/文字请下载原件查看。</div>
      </div>

      {expanded ? (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/70 p-6">
          <div className="mb-2 flex items-center justify-between gap-4 text-white">
            <span className="truncate text-ui-sm">{relPath} · 放大视图</span>
            <Button
              size="sm"
              variant="ghost"
              className="text-white"
              data-testid="dwg-expand-close"
              onClick={() => setExpanded(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-white">
            <DrawingSvg segments={segments} symbols={graph.symbols} project={project} ariaLabel={relPath} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
