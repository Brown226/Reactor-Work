/**
 * 我的空间——DWG/DXF 在线预览的服务端解析。
 *
 * 为什么放在服务端：DWG 是二进制专有格式，浏览器无法直接渲染。产品里已有
 * ACadSharp 的 .NET sidecar（桌面端给 agent 用），这里复用它输出的 graph 数据
 * （INSERT 符号插入点 + LINE/多段线线段坐标）供前端画 SVG。
 *
 * 解析结果按「绝对路径 + mtime + size」缓存：一张图纸解析几百毫秒到数秒，
 * 反复点开同一文件不该重复付这个代价；文件被 agent 改写后 key 变化会自动失效。
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { resolveUserSpaceConfig } from "./config.js";
import { SpaceError, spaceRoute } from "./errors.js";
import { assertNoSymlinkPath } from "./fs-utils.js";
import { normalizeSpacePath } from "./paths.js";
import { requireRequestUid } from "./request.js";
import { createSpaceRoot } from "./repo.js";

export interface DwgPoint {
  x: number;
  y: number;
}

export interface DwgSegment {
  kind: string;
  layer: string;
  handle?: string;
  points: DwgPoint[];
}

export interface DwgSymbol {
  block: string;
  layer: string;
  insert: DwgPoint;
  rotation?: number;
}

export interface DwgGraph {
  ok: true;
  command: "graph";
  version?: string;
  ms?: number;
  truncated?: boolean;
  symbols: DwgSymbol[];
  segments: DwgSegment[];
}

const SIDECAR_TIMEOUT_MS = 30_000;
const CACHE_LIMIT = 8;
const cache = new Map<string, DwgGraph>();

/** 依次尝试：显式 env → 资产根（容器内布局）→ 常见安装位置。返回可执行文件路径或 null。 */
async function resolveSidecarPath(): Promise<string | null> {
  const explicit = process.env["ZCODE_DWG_SIDECAR_PATH"]?.trim();
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(
      explicit.endsWith("dwg-sidecar") || explicit.endsWith("dwg-sidecar.exe")
        ? explicit
        : join(explicit, "dwg-sidecar", "linux-x64", "dwg-sidecar"),
    );
  }
  const assetsRoot = process.env["ZCODE_DWG_TOOLS_ASSETS_ROOT"]?.trim();
  if (assetsRoot) {
    candidates.push(join(assetsRoot, "dwg-sidecar", "linux-x64", "dwg-sidecar"));
  }
  candidates.push("/app/agent/dwg-tools/dwg-sidecar/linux-x64/dwg-sidecar");
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) throw new SpaceError("图纸解析没有输出", 502);
  try {
    return JSON.parse(last);
  } catch {
    throw new SpaceError("图纸解析输出不是合法 JSON", 502);
  }
}

async function runGraph(absPath: string): Promise<DwgGraph> {
  const sidecar = await resolveSidecarPath();
  if (!sidecar) {
    throw new SpaceError("服务端未安装图纸解析组件（dwg-sidecar）", 501);
  }
  const payload = JSON.stringify({
    command: "graph",
    path: absPath,
    maxSymbols: 20000,
    maxSegments: 20000,
  });
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(sidecar, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SpaceError("图纸解析超时", 504));
    }, SIDECAR_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SpaceError(`无法启动图纸解析组件：${error.message}`, 502));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // sidecar 协议：退出码 2 且 stdout 有一行 JSON 错误
        try {
          const parsed = parseLastJsonLine(out) as { error?: unknown };
          if (typeof parsed?.error === "string") {
            reject(new SpaceError(`图纸解析失败：${parsed.error}`, 422));
            return;
          }
        } catch {
          // 落到下面的通用错误
        }
        reject(new SpaceError(`图纸解析失败（退出码 ${String(code)}）${err ? `：${err.slice(0, 200)}` : ""}`, 502));
        return;
      }
      resolve(out);
    });
    child.stdin.end(payload);
  });
  const parsed = parseLastJsonLine(stdout) as Partial<DwgGraph> & { ok?: boolean; error?: string };
  if (parsed.ok !== true) {
    throw new SpaceError(parsed.error ? `图纸解析失败：${parsed.error}` : "图纸解析失败", 422);
  }
  return {
    ok: true,
    command: "graph",
    version: parsed.version,
    ms: parsed.ms,
    truncated: parsed.truncated,
    symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
  };
}

export function registerDwgRoutes(app: Hono): void {
  app.get(
    "/dwg",
    spaceRoute(async (c) => {
      const uid = requireRequestUid(c);
      const root = await createSpaceRoot(resolveUserSpaceConfig(), uid);
      const rel = normalizeSpacePath(c.req.query("path"));
      if (!rel) throw new SpaceError("path 不能为空");
      if (!/\.(dwg|dxf)$/i.test(rel)) throw new SpaceError("只支持 dwg / dxf");
      await assertNoSymlinkPath(root, rel, { allowMissing: false });
      const abs = join(root, ...rel.split("/"));
      const info = await stat(abs);
      if (!info.isFile()) throw new SpaceError("目标不是文件", 409);

      const key = `${abs}:${info.mtimeMs}:${info.size}`;
      const cached = cache.get(key);
      if (cached) return c.json({ ...cached, cached: true });

      const graph = await runGraph(abs);
      // 简单 LRU：超限删最早插入的一条（Map 保持插入顺序）
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(key, graph);
      return c.json({ ...graph, cached: false });
    }),
  );
}
