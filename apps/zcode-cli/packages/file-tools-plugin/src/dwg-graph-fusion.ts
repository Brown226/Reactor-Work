/**
 * DWG 符号/连接拓扑融合（纯函数，无 IO）：sidecar graph 命令的原始行 → 拓扑图。
 *
 * 规则（与 docs/文件解析OCR-CAD-集成方案.md §3 dwg_graph 契约一致）：
 * - 节点 = INSERT 块引用符号；tag = 插入点 snapTol 内最近的文本（平局按 handle 数值序）；
 * - 线段仅首末端点参与：吸附 snapTol 内的符号，端点间 snapTol 内重合则并查集链合成 run；
 * - 每个 run 附着的去重符号 ≥2 → 两两成边（单段 run = direct，多段 = run）；
 * - 同一对符号的多条连接合并为一条边（via 取 direct 优先，length 求和）；
 * - 全量按 handle 数值序排序，输出可复现。
 *
 * v1 明确不做（集成方案 §1 非目标）：线段 interior 穿越符号不吸附；圆弧/圆不收；
 * 块属性（ATTRIB）位号不取；符号为散落图元时本模块无输入（工具层出 note）。
 */

export interface SidecarSymbol {
  block: string;
  layer: string;
  handle: string;
  insert: { x: number; y: number };
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface SidecarSegment {
  kind: string;
  layer: string;
  handle: string;
  points: Array<{ x: number; y: number }>;
}

export interface SidecarTextEntity {
  text: string;
  layer: string;
  entityType: string;
  handle: string;
  insert: { x: number; y: number; z: number };
}

export interface SidecarGraphInput {
  symbols: SidecarSymbol[];
  segments: SidecarSegment[];
  textEntities: SidecarTextEntity[];
}

export interface GraphNode {
  /** CAD entity handle（十六进制），兼作边端点引用与审查锚点。 */
  id: string;
  block: string;
  tag: string | null;
  layer: string;
  position: { x: number; y: number };
}

export interface GraphEdge {
  from: string;
  to: string;
  via: "direct" | "run";
  /** 连接总长（绘图单位，三位小数）；同对符号多条连接已求和。 */
  length: number;
}

export interface DrawingGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    /** 产生至少一条边的 run 数（多段链合连接的计数）。 */
    runCount: number;
    isolatedNodeCount: number;
    taggedNodeCount: number;
    textCount: number;
  };
}

/** handle 十六进制串 → 数值，用于确定性排序；异常值退 0。 */
function handleValue(handle: string): number {
  const value = Number.parseInt(handle, 16);
  return Number.isFinite(value) ? value : 0;
}

function cellKey(x: number, y: number, cell: number): string {
  return `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
}

/** 3×3 邻域已覆盖半径 = cell 的全部范围（cell 即 snapTol）。 */
function neighborhood(key: string): string[] {
  const [cx, cy] = key.split(":").map(Number);
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      keys.push(`${cx + dx}:${cy + dy}`);
    }
  }
  return keys;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let walk = x;
    while (this.parent[walk] !== root) {
      const next = this.parent[walk];
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

function segmentLength(points: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** 插入点 snapTol 内最近的文本；无则 null。平局按 handle 数值序，保证可复现。 */
function nearestText(
  insert: { x: number; y: number },
  texts: SidecarTextEntity[],
  textGrid: Map<string, number[]>,
  snapTol: number,
): string | null {
  let best: { distance: number; handle: number; text: string } | null = null;
  for (const key of neighborhood(cellKey(insert.x, insert.y, snapTol))) {
    const bucket = textGrid.get(key);
    if (!bucket) continue;
    for (const index of bucket) {
      const text = texts[index];
      const distance = Math.hypot(text.insert.x - insert.x, text.insert.y - insert.y);
      if (distance > snapTol) continue;
      const handle = handleValue(text.handle);
      if (!best || distance < best.distance || (distance === best.distance && handle < best.handle)) {
        best = { distance, handle, text: text.text };
      }
    }
  }
  return best?.text ?? null;
}

/** snapTol 内与给定点重合的符号 id（确定性：按 handle 数值序）。 */
function symbolsNear(
  point: { x: number; y: number },
  symbolGrid: Map<string, string[]>,
  symbolPoints: Map<string, { x: number; y: number }>,
  snapTol: number,
): string[] {
  const found: Array<{ handle: number; id: string }> = [];
  for (const key of neighborhood(cellKey(point.x, point.y, snapTol))) {
    const bucket = symbolGrid.get(key);
    if (!bucket) continue;
    for (const id of bucket) {
      const symbolPoint = symbolPoints.get(id);
      if (!symbolPoint) continue;
      if (Math.hypot(symbolPoint.x - point.x, symbolPoint.y - point.y) <= snapTol) {
        found.push({ handle: handleValue(id), id });
      }
    }
  }
  found.sort((a, b) => a.handle - b.handle);
  return found.map((entry) => entry.id);
}

export function buildDrawingGraph(input: SidecarGraphInput, options: { snapTol: number }): DrawingGraph {
  const snapTol = options.snapTol;
  if (!(snapTol > 0)) {
    throw new Error(`snapTol 必须为正数，收到 ${snapTol}`);
  }
  const { symbols, segments, textEntities } = input;

  // 文本空间哈希（格宽 = snapTol）。
  const textGrid = new Map<string, number[]>();
  textEntities.forEach((text, index) => {
    const key = cellKey(text.insert.x, text.insert.y, snapTol);
    const bucket = textGrid.get(key);
    if (bucket) bucket.push(index);
    else textGrid.set(key, [index]);
  });

  // 1. 节点 + tag 关联。
  const nodes: GraphNode[] = symbols
    .map((symbol) => ({
      id: symbol.handle,
      block: symbol.block,
      tag: nearestText(symbol.insert, textEntities, textGrid, snapTol),
      layer: symbol.layer,
      position: { x: symbol.insert.x, y: symbol.insert.y },
    }))
    .sort((a, b) => handleValue(a.id) - handleValue(b.id) || a.position.x - b.position.x || a.position.y - b.position.y);

  const symbolPoints = new Map(nodes.map((node) => [node.id, node.position]));
  const symbolGrid = new Map<string, string[]>();
  for (const node of nodes) {
    const key = cellKey(node.position.x, node.position.y, snapTol);
    const bucket = symbolGrid.get(key);
    if (bucket) bucket.push(node.id);
    else symbolGrid.set(key, [node.id]);
  }

  // 2. 端点并查集：snapTol 内重合的线段端点合并（端点索引 = 段索引*2 + 首/末）。
  const endpointCount = segments.length * 2;
  const endpointUf = new UnionFind(endpointCount);
  const endpointGrid = new Map<string, number[]>();
  const endpointOf = (segmentIndex: number, end: 0 | 1) => segmentIndex * 2 + end;
  segments.forEach((segment, segmentIndex) => {
    const ends: Array<0 | 1> = [0, 1];
    for (const end of ends) {
      const point = end === 0 ? segment.points[0] : segment.points[segment.points.length - 1];
      const key = cellKey(point.x, point.y, snapTol);
      const bucket = endpointGrid.get(key);
      if (bucket) bucket.push(endpointOf(segmentIndex, end));
      else endpointGrid.set(key, [endpointOf(segmentIndex, end)]);
    }
  });
  const pointAt = (segmentIndex: number, end: 0 | 1) => {
    const points = segments[segmentIndex].points;
    return end === 0 ? points[0] : points[points.length - 1];
  };
  segments.forEach((_, segmentIndex) => {
    for (const end of [0, 1] as const) {
      const point = pointAt(segmentIndex, end);
      const self = endpointOf(segmentIndex, end);
      for (const key of neighborhood(cellKey(point.x, point.y, snapTol))) {
        const bucket = endpointGrid.get(key);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other === self) continue;
          const otherPoint = pointAt(other >> 1, (other & 1) as 0 | 1);
          if (Math.hypot(otherPoint.x - point.x, otherPoint.y - point.y) <= snapTol) {
            endpointUf.union(self, other);
          }
        }
      }
    }
  });

  // 3. 端点组 → 线段：共享端点组的线段并查集合成 run。
  const segmentUf = new UnionFind(segments.length);
  const rootToSegments = new Map<number, number[]>();
  for (let endpoint = 0; endpoint < endpointCount; endpoint += 1) {
    const root = endpointUf.find(endpoint);
    const segmentIndex = endpoint >> 1;
    const bucket = rootToSegments.get(root);
    if (bucket) bucket.push(segmentIndex);
    else rootToSegments.set(root, [segmentIndex]);
  }
  for (const group of rootToSegments.values()) {
    for (let i = 1; i < group.length; i += 1) {
      segmentUf.union(group[0], group[i]);
    }
  }

  // 4. run → 附着的符号 → 边。
  const runSegments = new Map<number, number[]>();
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const root = segmentUf.find(segmentIndex);
    const bucket = runSegments.get(root);
    if (bucket) bucket.push(segmentIndex);
    else runSegments.set(root, [segmentIndex]);
  }

  const edgeByPair = new Map<string, { from: string; to: string; via: "direct" | "run"; length: number }>();
  let runCount = 0;
  for (const group of runSegments.values()) {
    const attached = new Set<string>();
    let length = 0;
    for (const segmentIndex of group) {
      const segment = segments[segmentIndex];
      length += segmentLength(segment.points);
      for (const end of [0, 1] as const) {
        for (const id of symbolsNear(pointAt(segmentIndex, end), symbolGrid, symbolPoints, snapTol)) {
          attached.add(id);
        }
      }
    }
    if (attached.size < 2) continue;
    runCount += 1;
    const ids = [...attached].sort((a, b) => handleValue(a) - handleValue(b));
    const via: "direct" | "run" = group.length === 1 ? "direct" : "run";
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}->${ids[j]}`;
        const existing = edgeByPair.get(key);
        if (existing) {
          existing.length += length;
          if (via === "direct") existing.via = "direct";
        } else {
          edgeByPair.set(key, { from: ids[i], to: ids[j], via, length });
        }
      }
    }
  }

  const edges: GraphEdge[] = [...edgeByPair.values()]
    .map((edge) => ({ ...edge, length: Math.round(edge.length * 1000) / 1000 }))
    .sort((a, b) => handleValue(a.from) - handleValue(b.from) || handleValue(a.to) - handleValue(b.to));

  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      runCount,
      isolatedNodeCount: nodes.filter((node) => !connectedIds.has(node.id)).length,
      taggedNodeCount: nodes.filter((node) => node.tag !== null).length,
      textCount: textEntities.length,
    },
  };
}
