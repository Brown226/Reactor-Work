import assert from "node:assert/strict";
import test from "node:test";
import { buildDrawingGraph } from "../src/dwg-graph-fusion.js";
import type {
  GraphEdge,
  GraphNode,
  SidecarGraphInput,
  SidecarSegment,
  SidecarSymbol,
  SidecarTextEntity,
} from "../src/dwg-graph-fusion.js";

function symbol(handle: string, x: number, y: number, block = "BLK"): SidecarSymbol {
  return { block, layer: "L", handle, insert: { x, y }, rotation: 0, scaleX: 1, scaleY: 1 };
}

function line(handle: string, x1: number, y1: number, x2: number, y2: number): SidecarSegment {
  return { kind: "LINE", layer: "L", handle, points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] };
}

function polyline(handle: string, points: Array<[number, number]>): SidecarSegment {
  return { kind: "POLYLINE2D", layer: "L", handle, points: points.map(([x, y]) => ({ x, y })) };
}

function text(handle: string, x: number, y: number, value: string): SidecarTextEntity {
  return { text: value, layer: "T", entityType: "TEXT", handle, insert: { x, y, z: 0 } };
}

const input = (
  symbols: SidecarSymbol[],
  segments: SidecarSegment[],
  texts: SidecarTextEntity[] = [],
): SidecarGraphInput => ({ symbols, segments, textEntities: texts });

test("dwg_graph 融合：单段直连——端点吸附符号成 direct 边", () => {
  const graph = buildDrawingGraph(
    input([symbol("A", 0, 0), symbol("B", 100, 0)], [line("C", 0, 0, 100, 0)]),
    { snapTol: 5 },
  );
  const nodes: GraphNode[] = graph.nodes;
  const edges: GraphEdge[] = graph.edges;
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
  assert.deepEqual(graph.edges[0], { from: "A", to: "B", via: "direct", length: 100 });
  assert.deepEqual(graph.stats, {
    nodeCount: 2,
    edgeCount: 1,
    runCount: 1,
    isolatedNodeCount: 0,
    taggedNodeCount: 0,
    textCount: 0,
  });
});

test("dwg_graph 融合：多段端点重合链合成 run 边，长度为各段之和", () => {
  const graph = buildDrawingGraph(
    input(
      [symbol("A", 0, 0), symbol("B", 100, 0)],
      [line("C1", 0, 0, 50, 0), line("C2", 50, 0, 100, 0)],
    ),
    { snapTol: 5 },
  );
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0], { from: "A", to: "B", via: "run", length: 100 });
  assert.equal(graph.stats.runCount, 1);
});

test("dwg_graph 融合：只附着单个符号的线段不成边，两端符号记孤立", () => {
  const graph = buildDrawingGraph(
    input([symbol("A", 0, 0), symbol("B", 500, 0)], [line("C", 0, 0, 100, 0)]),
    { snapTol: 5 },
  );
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.stats.isolatedNodeCount, 2);
});

test("dwg_graph 融合：多符号共链成完全子图（两两成边）", () => {
  const graph = buildDrawingGraph(
    input(
      [symbol("A", 0, 0), symbol("B", 50, 0), symbol("C", 100, 0)],
      [line("C1", 0, 0, 50, 0), line("C2", 50, 0, 100, 0)],
    ),
    { snapTol: 5 },
  );
  assert.equal(graph.edges.length, 3);
  const pairs = graph.edges.map((edge) => `${edge.from}-${edge.to}`);
  assert.deepEqual(pairs, ["A-B", "A-C", "B-C"]);
  assert.equal(graph.stats.isolatedNodeCount, 0);
});

test("dwg_graph 融合：同一对符号多条连接合并为一条边，length 求和、direct 优先", () => {
  const graph = buildDrawingGraph(
    input(
      [symbol("A", 0, 5), symbol("B", 100, 5)],
      [line("C1", 0, 0, 100, 0), line("C2", 0, 10, 100, 10)],
    ),
    { snapTol: 5 },
  );
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0], { from: "A", to: "B", via: "direct", length: 200 });
  assert.equal(graph.stats.runCount, 2);
});

test("dwg_graph 融合：tag 取 snapTol 内最近文本，越界不匹配", () => {
  const graph = buildDrawingGraph(
    input(
      [symbol("A", 0, 0), symbol("B", 1000, 0)],
      [line("C", 0, 0, 1000, 0)],
      [text("T1", 3, 0, "P-101"), text("T2", 100, 0, "远文本")],
    ),
    { snapTol: 5 },
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("A")!.tag, "P-101");
  assert.equal(byId.get("B")!.tag, null);
  assert.equal(graph.stats.taggedNodeCount, 1);
});

test("dwg_graph 融合：等距文本平局按 handle 数值序，输出确定", () => {
  const graph = buildDrawingGraph(
    input([symbol("A", 0, 0)], [], [text("20", 0, 3, "HANDLE-20"), text("10", 0, -3, "HANDLE-10")]),
    { snapTol: 5 },
  );
  assert.equal(graph.nodes[0].tag, "HANDLE-10");
});

test("dwg_graph 融合：节点与边按 handle 数值序（十六进制）排序", () => {
  const graph = buildDrawingGraph(
    input([symbol("A", 0, 0), symbol("9", 100, 0)], [line("C", 0, 0, 100, 0)]),
    { snapTol: 5 },
  );
  assert.deepEqual(graph.nodes.map((node) => node.id), ["9", "A"]);
  assert.deepEqual(graph.edges[0], { from: "9", to: "A", via: "direct", length: 100 });
});

test("dwg_graph 融合：多段线长度为顶点路径和，单段即 direct", () => {
  const graph = buildDrawingGraph(
    input(
      [symbol("A", 0, 0), symbol("B", 10, 10)],
      [polyline("C", [[0, 0], [10, 0], [10, 10]])],
    ),
    { snapTol: 5 },
  );
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0], { from: "A", to: "B", via: "direct", length: 20 });
});

test("dwg_graph 融合：空输入返回空图与全零统计", () => {
  const graph = buildDrawingGraph(input([], [], []), { snapTol: 5 });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.deepEqual(graph.stats, {
    nodeCount: 0,
    edgeCount: 0,
    runCount: 0,
    isolatedNodeCount: 0,
    taggedNodeCount: 0,
    textCount: 0,
  });
});

test("dwg_graph 融合：snapTol 非正数直接抛错（不静默产出错图）", () => {
  assert.throws(() => buildDrawingGraph(input([symbol("A", 0, 0)], [], []), { snapTol: 0 }), /snapTol/);
});

test("dwg_graph 融合：同一符号多 tag 取最近（determinism 回归）", () => {
  const texts = [text("T9", 2, 0, "近"), text("T1", -4, 0, "远")];
  const graph = buildDrawingGraph(input([symbol("A", 0, 0)], [], texts), { snapTol: 5 });
  assert.equal(graph.nodes[0].tag, "近");
});
