/**
 * DWG graph 的纯绘制层：投影 + SVG 图元。不依赖 @/ 别名与 UI 组件库。
 *
 * 独立成文件的原因：投影、文字锚点、图层配色这套纯逻辑要能被无 React 环境
 * 的验证脚本（renderToStaticMarkup）直接复用，避免验证代码与组件实现漂移。
 *
 * 与 sidecar graph 输出对齐的已知边界：块只画插入点，HATCH/DIMENSION 图形/
 * SPLINE/块内图元/SHX 特殊字体不画；曲线已在 sidecar 侧采样成折线点。
 * 文字按真实字高绘制，多行 MTEXT 以 1.5 倍行距近似（真实行距取自样式，v1 不做）。
 */
import type { DwgGraph, DwgSegment, DwgTextEntity } from "./spaceClient.js";

export const DWG_VIEW_SIZE = 1000;
/** 画布四周留白，避免贴边图元被 viewBox 裁掉。 */
const DRAW_PAD = 20;

/** 图层配色：按图层名哈希取固定色，保证同一图层每次打开颜色一致。 */
const LAYER_COLORS = ["#2f7fd1", "#d1495b", "#2a9d8f", "#e9a13b", "#7b6d8d", "#4a6fa5", "#8a9a5b"];

export function colorForLayer(layer: string): string {
  let hash = 0;
  for (let index = 0; index < layer.length; index += 1) {
    hash = (hash * 31 + layer.charCodeAt(index)) % 997;
  }
  return LAYER_COLORS[hash % LAYER_COLORS.length] ?? LAYER_COLORS[0]!;
}

export interface DwgBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 包含图元边界的计算：线段/曲线采样点、块插入点、文字（含字高与估宽）。 */
export function computeBounds(
  graph: Pick<DwgGraph, "segments" | "symbols" | "textEntities">,
): DwgBounds | null {
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
  for (const text of graph.textEntities) {
    visit(text.insert.x, text.insert.y);
    // 文字宽度没有真实度量（不做字体排版），按 CJK 全角 0.6 倍字高估一个上界，
    // 只用于定外框：宁可留白也不把长文字裁出画布。宽取最长行、高按行数计——
    // 多行说明块的整段长度若按单行估会把外框撑大好几倍（真实图纸实测 2.5 倍）。
    const lines = (text.plain ?? text.text).split(/\r?\n/);
    const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const estimatedWidth = (text.height ?? 0) * 0.6 * longestLine;
    // MTEXT 从 insert 向下排（TopLeft 附着），TEXT 基线在 insert、字形向上：
    // 两个方向都探一遍，多算的只是留白。
    const blockHeight = (text.height ?? 0) * (1 + 1.5 * (lines.length - 1));
    visit(text.insert.x + estimatedWidth, text.insert.y + (text.height ?? 0));
    visit(text.insert.x, text.insert.y - blockHeight);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

export interface DwgProjection {
  /** CAD 单位 → 画布像素 的比例，文字字号要用它换算。 */
  scale: number;
  /** CAD 坐标 → 画布坐标（Y 轴已翻转）。 */
  project: (point: { x: number; y: number }) => [number, number];
}

export function createProjection(bounds: DwgBounds, view = DWG_VIEW_SIZE): DwgProjection {
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const scale = (view - DRAW_PAD * 2) / Math.max(width, height);
  // 两个方向都要居中：宽扁的图纸只做等比缩放会贴在画布底部，看着像渲染失败。
  const offsetX = (view - width * scale) / 2;
  const offsetY = (view - height * scale) / 2;
  return {
    scale,
    project: (point) => [
      (point.x - bounds.minX) * scale + offsetX,
      view - ((point.y - bounds.minY) * scale + offsetY),
    ],
  };
}

interface TextAnchorSpec {
  anchor: "start" | "middle" | "end";
  /** 基线相对 insert 点的垂直偏移，单位是字号倍数（屏幕 Y 向下为正）。 */
  dyFactor: number;
}

/**
 * 文字锚点：CAD 的定位语义（TEXT 对齐 / MTEXT 附着九宫格）映射到 SVG 的
 * text-anchor + 基线偏移。多行只处理首行锚点，后续行走 tspan 行距。
 */
function anchorFor(text: DwgTextEntity): TextAnchorSpec {
  if (text.entityType === "MTEXT") {
    const horizontal = text.attachment?.includes("Right")
      ? "end"
      : text.attachment?.includes("Center")
        ? "middle"
        : "start";
    const dyFactor = text.attachment?.startsWith("Top")
      ? 1
      : text.attachment?.startsWith("Middle")
        ? 0.5
        : 0;
    return { anchor: horizontal, dyFactor };
  }
  const [horizontal = "Left", vertical = "Baseline"] = text.anchor ? text.anchor.split(":") : [];
  const anchor =
    horizontal === "Center" || horizontal === "Middle"
      ? "middle"
      : horizontal === "Right"
        ? "end"
        : "start";
  const dyFactor = vertical === "Top" ? 1 : vertical === "Middle" ? 0.5 : 0;
  return { anchor, dyFactor };
}

/**
 * 整张图纸的 SVG。详情栏与放大视图复用同一组件；zoom 场景通过 transform
 * 从外部套在内容组上，本组件不持有缩放状态。
 */
export function DrawingSvg({
  graph,
  project,
  scale,
  view = DWG_VIEW_SIZE,
  transform,
  ariaLabel,
}: {
  graph: Pick<DwgGraph, "segments" | "symbols" | "textEntities">;
  project: DwgProjection["project"];
  scale: number;
  view?: number;
  transform?: string;
  ariaLabel: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${view} ${view}`}
      className="h-full w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <g transform={transform}>
        {graph.segments.map((segment: DwgSegment, index) =>
          segment.points.length >= 2 ? (
            <polyline
              key={segment.handle ?? `seg-${index}`}
              points={segment.points
                .map((p) =>
                  project(p)
                    .map((v) => v.toFixed(1))
                    .join(","),
                )
                .join(" ")}
              fill="none"
              stroke={colorForLayer(segment.layer)}
              strokeWidth={0.8}
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
        {graph.symbols.map((symbol, index) => {
          const [cx, cy] = project(symbol.insert);
          return (
            <circle
              key={`sym-${index}`}
              cx={cx.toFixed(1)}
              cy={cy.toFixed(1)}
              r={1.6}
              fill="#444"
              opacity={0.7}
            />
          );
        })}
        {graph.textEntities.map((text: DwgTextEntity, index) => {
          const fontSize = (text.height ?? 0) * scale;
          // 小于半个像素的字肉眼不可见，跳过省 DOM 节点
          if (fontSize < 0.5) return null;
          const [x, y] = project(text.insert);
          const { anchor, dyFactor } = anchorFor(text);
          const rotation = text.rotation ?? 0;
          // CAD 逆时针为正，SVG 屏幕 Y 向下、rotate 正值是顺时针：取负号才是同一方向
          const rotate = rotation
            ? `rotate(${(-rotation).toFixed(2)} ${x.toFixed(1)} ${y.toFixed(1)})`
            : undefined;
          const lines = (text.plain ?? text.text).split(/\r?\n/);
          return (
            <text
              key={text.handle ?? `txt-${index}`}
              x={x.toFixed(1)}
              y={y.toFixed(1)}
              fontSize={fontSize.toFixed(2)}
              fill={colorForLayer(text.layer)}
              textAnchor={anchor}
              dy={(fontSize * dyFactor).toFixed(2)}
              transform={rotate}
              style={{ userSelect: "none" }}
            >
              {lines.map((line, lineIndex) =>
                lineIndex === 0 ? (
                  line
                ) : (
                  <tspan key={lineIndex} x={x.toFixed(1)} dy={(fontSize * 1.5).toFixed(2)}>
                    {line}
                  </tspan>
                ),
              )}
            </text>
          );
        })}
      </g>
    </svg>
  );
}
