/**
 * dwg_graph 工具：DWG → 符号/连接拓扑图（只读，确定性，离线）。
 *
 * sidecar graph 命令出原始行（INSERT/LINE/POLYLINE + 文本坐标），本插件内融合
 * （见 dwg-graph-fusion.ts）。与 dwg_modify 的分界：dwg_modify 管图纸的文本/尺寸/
 * 标准引用与结构化修改；本管「谁连着谁」。符号为散落图元绘制时如实出 note，
 * 不静默返回空结论（审查板块「无文本层必须明说」的同款纪律）。
 */
import { z } from "zod";
import { assertReadableFile, wrapFileContent } from "../guard.js";
import { runSidecar } from "../dwg-sidecar.js";
import { buildDrawingGraph, type DrawingGraph } from "../dwg-graph-fusion.js";
import type { SidecarSegment, SidecarSymbol, SidecarTextEntity } from "../dwg-graph-fusion.js";

export const DWG_GRAPH_DESCRIPTION = [
  "Extract the symbol/connection topology graph from a local DWG drawing (read-only, offline, deterministic).",
  "Use it for connectivity questions on vector drawings: which equipment a symbol (e.g. pump P-101) connects to,",
  "whether two symbols are linked, or which symbols are isolated or missing tags.",
  "Nodes are block-reference (INSERT) symbols annotated with their nearest text tag; edges are line/polyline",
  "connections (direct single segment, or chained runs). Every node and edge carries its CAD entity handle.",
  "For drawing text, dimensions and standard references use dwg_modify read mode; for scans and images use ocr_scan.",
  "Symbols drawn as raw geometry instead of block references are out of scope: the tool says so in its note",
  "rather than returning an empty graph silently.",
].join(" ");

export const dwgGraphInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path to the .dwg file."),
  snap_tol: z
    .number()
    .min(0.1)
    .max(1000)
    .optional()
    .describe("Snap tolerance in drawing units (default 5.0) for text-tag and endpoint association; raise it (e.g. 500-1000) for sparse or large-scale drawings."),
  max_symbols: z
    .number()
    .int()
    .min(1)
    .max(50000)
    .optional()
    .describe("Max INSERT symbols extracted (default 20000; truncated drawings get a note)."),
  max_segments: z
    .number()
    .int()
    .min(1)
    .max(50000)
    .optional()
    .describe("Max line/polyline segments extracted (default 20000; truncated drawings get a note)."),
});

interface SidecarGraphResponse {
  ok: boolean;
  error?: string;
  truncated?: boolean;
  symbols?: SidecarSymbol[];
  segments?: SidecarSegment[];
  textEntities?: SidecarTextEntity[];
}

interface DwgGraphOutput {
  status: "success" | "failed";
  nodes: DrawingGraph["nodes"];
  edges: DrawingGraph["edges"];
  stats: DrawingGraph["stats"];
  truncated: boolean;
  note?: string;
  /** 可读摘要（<file_content> 包裹）：符号清单 + 连接清单。 */
  text: string;
}

function failedOutput(note: string): DwgGraphOutput {
  return {
    status: "failed",
    nodes: [],
    edges: [],
    stats: {
      nodeCount: 0,
      edgeCount: 0,
      runCount: 0,
      isolatedNodeCount: 0,
      taggedNodeCount: 0,
      textCount: 0,
    },
    truncated: false,
    note,
    text: "",
  };
}

function renderGraphText(graph: DrawingGraph): string {
  const lines: string[] = [
    `符号 ${graph.stats.nodeCount} 个（带位号 ${graph.stats.taggedNodeCount} 个，孤立 ${graph.stats.isolatedNodeCount} 个），连接 ${graph.stats.edgeCount} 条（链合 ${graph.stats.runCount} 处）`,
  ];
  for (const node of graph.nodes) {
    const tag = node.tag ? ` tag=${node.tag}` : "";
    lines.push(
      `[符号] ${node.id} block=${node.block || "(匿名)"}${tag} layer=${node.layer} @(${node.position.x.toFixed(2)},${node.position.y.toFixed(2)})`,
    );
  }
  for (const edge of graph.edges) {
    lines.push(`[连接] ${edge.from} --${edge.via}(${edge.length})--> ${edge.to}`);
  }
  return lines.join("\n");
}

export async function dwgGraph(input: z.infer<typeof dwgGraphInputSchema>): Promise<DwgGraphOutput> {
  if (!input.file_path.toLowerCase().endsWith(".dwg")) {
    return failedOutput(`不是 .dwg 文件：${input.file_path}`);
  }
  assertReadableFile(input.file_path);

  const response = await runSidecar<SidecarGraphResponse>({
    command: "graph",
    path: input.file_path,
    ...(input.max_symbols !== undefined ? { maxSymbols: input.max_symbols } : {}),
    ...(input.max_segments !== undefined ? { maxSegments: input.max_segments } : {}),
  });
  if (!response.ok) {
    return failedOutput(response.error ?? "DWG sidecar 返回未知错误");
  }

  const graph = buildDrawingGraph(
    {
      symbols: response.symbols ?? [],
      segments: response.segments ?? [],
      textEntities: response.textEntities ?? [],
    },
    { snapTol: input.snap_tol ?? 5 },
  );

  const notes: string[] = [];
  if (response.truncated) {
    notes.push("符号或线段实体超过上限，结果可能不完整");
  }
  if (graph.nodes.length === 0) {
    notes.push("未发现块引用符号：该图纸符号可能为散落图元绘制，拓扑图不可用；可改用 dwg_modify 读模式查看图层/文本");
  }
  return {
    status: "success",
    nodes: graph.nodes,
    edges: graph.edges,
    stats: graph.stats,
    truncated: response.truncated ?? false,
    note: notes.join("；") || undefined,
    text: wrapFileContent(renderGraphText(graph)),
  };
}
