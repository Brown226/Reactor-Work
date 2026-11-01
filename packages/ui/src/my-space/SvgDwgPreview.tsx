/**
 * DWG/DXF 的 SVG 兜底预览：服务端 sidecar graph + 手绘矢量。
 *
 * 定位是降级方案：mlightcad 内核（MySpaceDwgPreview 的主路径）初始化或解析失败时
 * 用它保底——不含 HATCH、DIMENSION 图形、SPLINE、块内图元与 SHX 特殊字体，只画
 * 线段/采样曲线/文字/块插入点，但足以认图，且不依赖 /dwg-assets、/dwg/fonts 资产。
 * 绘制与投影逻辑在 MySpaceDwgDrawing（纯组件，可被验证脚本复用）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Maximize2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { spaceClient, type DwgGraph } from "./spaceClient.js";
import {
  colorForLayer,
  computeBounds,
  createProjection,
  DrawingSvg,
  DWG_VIEW_SIZE,
} from "./MySpaceDwgDrawing.js";

/** 单屏最多画的线段数：2 万条 polyline 会把主线程卡住，超出部分提示已截断。 */
const MAX_RENDER_SEGMENTS = 8000;
/** 文字节点比 polyline 贵得多（每条都是一个带排版的 DOM），同样封顶。 */
const MAX_RENDER_TEXTS = 2000;
const ZOOM_MIN = 1;
const ZOOM_MAX = 20;

interface ViewState {
  k: number;
  tx: number;
  ty: number;
}

const INITIAL_VIEW: ViewState = { k: 1, tx: 0, ty: 0 };

export function SvgDwgPreview({ relPath }: { relPath: string }) {
  const [graph, setGraph] = useState<DwgGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 详情栏只有 288px 宽，图纸在里面基本看不清；放大视图是同一个 SVG，只是给足空间。
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const zoomWrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

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

  // 每次打开放大视图都回到整图适配态，避免上次的缩放位置误导
  useEffect(() => {
    if (expanded) setView(INITIAL_VIEW);
  }, [expanded]);

  // React 的 onWheel 是 passive 监听，preventDefault 无效；滚轮缩放必须手动挂非 passive
  useEffect(() => {
    const element = zoomWrapRef.current;
    if (!element || !expanded) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((prev) => {
        const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
        const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.k * factor));
        const rect = element.getBoundingClientRect();
        // 指针位置（viewBox 坐标）在缩放前后必须落在同一图元上：以指针为不动点求新偏移
        const cx = ((event.clientX - rect.left) / Math.max(1, rect.width)) * DWG_VIEW_SIZE;
        const cy = ((event.clientY - rect.top) / Math.max(1, rect.height)) * DWG_VIEW_SIZE;
        const ratio = k / prev.k;
        return { k, tx: cx - (cx - prev.tx) * ratio, ty: cy - (cy - prev.ty) * ratio };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [expanded]);

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
    <Button
      size="sm"
      variant="outline"
      onClick={() => window.open(spaceClient.downloadUrl(relPath), "_blank")}
    >
      <Download className="mr-2 size-4" /> 下载原件
    </Button>
  );

  if (loading) {
    return (
      <p className="p-4 text-ui-sm text-foreground-subtle">正在解析图纸…（首次打开需要几秒）</p>
    );
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
          这张图纸里没有可预览的图元（可能全部由填充/块内图元构成）。
        </p>
        {download}
      </div>
    );
  }

  const projection = createProjection(bounds);
  const segments = graph.segments.slice(0, MAX_RENDER_SEGMENTS);
  const hiddenSegments = graph.segments.length - segments.length;
  const texts = graph.textEntities.slice(0, MAX_RENDER_TEXTS);
  const hiddenTexts = graph.textEntities.length - texts.length;
  const drawnGraph = { ...graph, segments, textEntities: texts };

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-hidden bg-white">
        <DrawingSvg
          graph={drawnGraph}
          project={projection.project}
          scale={projection.scale}
          ariaLabel={relPath}
        />
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
          <span>图元 {graph.segments.length}</span>
          <span>文字 {graph.textEntities.length}</span>
          <span>块引用 {graph.symbols.length}</span>
          {graph.ms !== undefined ? <span>解析 {graph.ms} ms</span> : null}
        </div>
        {layers.length > 0 ? (
          <div className="flex flex-wrap gap-x-2">
            {layers.map(([layer, count]) => (
              <span key={layer} className="inline-flex items-center gap-1">
                <i
                  className="inline-block size-2 rounded-sm"
                  style={{ background: colorForLayer(layer) }}
                />
                {layer} {count}
              </span>
            ))}
          </div>
        ) : null}
        {hiddenSegments > 0 || hiddenTexts > 0 ? (
          <div>
            图元过多，仅渲染前 {MAX_RENDER_SEGMENTS} 条线段 / {MAX_RENDER_TEXTS} 条文字 （其余{" "}
            {hiddenSegments + hiddenTexts} 条请下载原件查看）
          </div>
        ) : null}
        {graph.truncated ? <div>服务端解析已截断（超过上限），预览不完整。</div> : null}
        <div>预览含线段、圆弧/圆/椭圆、文字与块插入点；填充、标注、块内图元请下载原件查看。</div>
      </div>

      {expanded ? (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/70 p-6">
          <div className="mb-2 flex items-center justify-between gap-4 text-white">
            <span className="truncate text-ui-sm">{relPath} · 放大视图（SVG 兜底）</span>
            <div className="flex items-center gap-2">
              <span className="text-ui-xs opacity-80">滚轮缩放 · 拖拽平移</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-white"
                data-testid="dwg-zoom-reset"
                onClick={() => setView(INITIAL_VIEW)}
              >
                <RotateCcw className="mr-1 size-3" /> 重置
              </Button>
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
          </div>
          <div
            ref={zoomWrapRef}
            className="min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-lg bg-white active:cursor-grabbing"
            data-testid="dwg-zoom-surface"
            onPointerDown={(event) => {
              dragRef.current = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              const rect = event.currentTarget.getBoundingClientRect();
              // preserveAspectRatio=meet 时实际缩放比取短边；平移量按 viewBox 单位换算
              const ratio = DWG_VIEW_SIZE / Math.max(1, Math.min(rect.width, rect.height));
              setView((prev) => ({
                ...prev,
                tx: drag.tx + (event.clientX - drag.x) * ratio,
                ty: drag.ty + (event.clientY - drag.y) * ratio,
              }));
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
          >
            <DrawingSvg
              graph={drawnGraph}
              project={projection.project}
              scale={projection.scale}
              transform={`translate(${view.tx.toFixed(1)} ${view.ty.toFixed(1)}) scale(${view.k.toFixed(3)})`}
              ariaLabel={relPath}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
