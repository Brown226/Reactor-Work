/**
 * 知识库 HTTP 网关（`/api/knowledge/owned/*`）。
 *
 * ## 为什么有这一层
 *
 * EvoFlow 的知识库前端（`pages/knowledge-owned.jsx` 等，约 460KB）原生走
 * Tauri `invoke` / `gatewayProxy`，其中 Web 模式就是普通 HTTP ——
 * 见 EvoFlow `evopanel/src/lib/tauri-api.js` 的 `gatewayProxyOnce`
 * （非 Tauri 分支直接用 `fetch`）。所以**不需要为 59 个前端方法写 shim**，
 * 只要按它已约定的 REST 契约提供网关，前端就能原样接上。
 *
 * 本文件实现该契约，落到 `packages/services` 的 KnowledgeClient（Python sidecar）。
 * 前端方法 → 本路由的对应关系见 `docs/未完成-知识库-sidecar-与检索链路-spec-v1.md` §13。
 *
 * ## 分工
 *
 * - 本层：HTTP 契约、参数校验、错误码翻译。**不懂知识库语义**。
 * - KnowledgeClient：sidecar 进程生命周期 + RPC。
 * - sidecar：文档 / 分块 / 索引 / 检索的唯一 owner。
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import type { Context } from "hono";
import type { Hono } from "hono";

import { formatLogPrefix } from "@zcode/shared";
import { KnowledgeClient, KnowledgeRpcCallError, KnowledgeUnavailableError } from "@zcode/services";

import { registerKnowledgeExtraRoutes } from "./routesExtra.js";

// server 侧日志统一用 formatLogPrefix（与 user-space 一致），不走 services 的
// createServiceLogger —— 后者是 services 包内部设施，未从 index 导出。
const logError = (...args: unknown[]) =>
  console.error(formatLogPrefix("zcode-server:knowledge", process.pid), ...args);

/** 上传体积上限：与 user-space 上传配额同一量级，知识库资料通常更大，放宽到 256MB。 */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** 上传白名单（与 EvoFlow `owned/formats.py` 对齐，P0 支持这些扩展名）。 */
const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".csv",
  ".json",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
  ".py",
]);

interface KnowledgeGatewayDeps {
  /** 知识库数据根目录（sidecar 的 --data-root）。 */
  dataRoot: string;
}

function gatewayError(c: Context, error: unknown): Response {
  if (error instanceof KnowledgeRpcCallError) {
    // sidecar 业务错误：原样透传 code，前端按 code 分支
    const status = statusForCode(error.code);
    return c.json({ error: error.message, code: error.code }, status);
  }
  if (error instanceof KnowledgeUnavailableError) {
    // 引擎不可用：503，前端提示「知识库引擎不可用」但不阻塞对话
    return c.json({ error: error.message, code: "KNOWLEDGE_UNAVAILABLE" }, 503);
  }
  logError("knowledge 网关未预期错误", error);
  return c.json({ error: "知识库服务内部错误", code: "INTERNAL" }, 500);
}

function statusForCode(code: string): 400 | 404 | 409 | 501 {
  switch (code) {
    case "KB_NOT_FOUND":
    case "FILE_NOT_FOUND":
    case "DOC_NOT_FOUND":
      return 404;
    case "INVALID_NAME":
    case "INVALID_MODE":
    case "INVALID_DIM":
    case "INVALID_PATH":
    case "MISSING_KB_ID":
    case "UNSUPPORTED_FORMAT":
    case "FILE_TOO_LARGE":
      return 400;
    case "NOT_IMPLEMENTED":
      return 501;
    default:
      return 400;
  }
}

/** 把 sidecar 返回的下划线/驼峰混用字段统一成前端期望的 camelCase。 */
function normalizeBase(base: Record<string, unknown>): Record<string, unknown> {
  return {
    id: base.id,
    name: base.name,
    description: base.description ?? "",
    embeddingModel: base.embeddingModel ?? "",
    embeddingDim: base.embeddingDim ?? 0,
    contentMode: base.contentMode ?? "hybrid",
    createdAt: base.createdAt ?? "",
    updatedAt: base.updatedAt ?? "",
  };
}

export function registerKnowledgeRoutes(app: Hono, deps: KnowledgeGatewayDeps): void {
  const client = new KnowledgeClient({ dataRoot: deps.dataRoot });
  // app 退出时释放常驻进程；幂等，重复调用安全。
  process.once("beforeExit", () => {
    void client.shutdown("dispose");
  });

  // ── 库 ────────────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/bases", async (c) => {
    try {
      const result = (await client.call("kb.list")) as { bases: Record<string, unknown>[] };
      return c.json({ bases: result.bases.map(normalizeBase) });
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.post("/api/knowledge/owned/bases", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const result = (await client.call("kb.create", {
        name: body.name,
        description: body.description,
        embeddingModel: body.embeddingModel,
        embeddingDim: body.embeddingDim,
        contentMode: body.contentMode,
      })) as { base: Record<string, unknown> };
      return c.json({ base: normalizeBase(result.base) }, 201);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.get("/api/knowledge/owned/bases/:kbId", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      // [坑] 早期只调 kb.stats 并把统计平铺到顶层、base 里只放 id ——
      // 前端读 base.name / base.embeddingModel 全是 undefined，
      // 界面上「库名空白、向量模型未配置」。这里必须单独取一次 base。
      const [baseResult, stats] = await Promise.all([
        client.call("kb.get", { kbId }) as Promise<{ base: Record<string, unknown> }>,
        client.call("kb.stats", { kbId }) as Promise<Record<string, unknown>>,
      ]);
      return c.json({ base: normalizeBase(baseResult.base), ...stats });
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.patch("/api/knowledge/owned/bases/:kbId", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      const body = await c.req.json<Record<string, unknown>>();
      const result = (await client.call("kb.update", {
        kbId,
        name: body.name,
        description: body.description,
        embeddingModel: body.embeddingModel,
        contentMode: body.contentMode,
      })) as { base: Record<string, unknown> };
      return c.json({ base: normalizeBase(result.base) });
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.delete("/api/knowledge/owned/bases/:kbId", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      await client.call("kb.delete", { kbId });
      return c.json({ deleted: true, kbId });
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  // ── 文档 ──────────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/bases/:kbId/documents", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      const result = (await client.call("kb.listDocs", { kbId })) as {
        docs: Record<string, unknown>[];
      };
      return c.json({ documents: result.docs });
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  /**
   * 上传文件。
   *
   * 走 multipart/form-data（EvoFlow 的 `test_real_kb_pipeline.py` 与前端一致），
   * 落到 sidecar 数据根的 incoming 目录后调 `kb.upload` 传路径 —— 不在 HTTP 层
   * 做 base64，大文件会炸内存。
   */
  app.post("/api/knowledge/owned/bases/:kbId/documents", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      const form = await c.req.parseBody();
      const file = form.file;
      if (!file || typeof file === "string") {
        return c.json({ error: "缺少文件字段", code: "INVALID_PATH" }, 400);
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json({ error: "文件超过 256MB 上限", code: "FILE_TOO_LARGE" }, 400);
      }
      const relPath = typeof form.relPath === "string" ? form.relPath : file.name;
      const extension = extname(relPath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        return c.json({ error: `不支持的格式：${extension}`, code: "UNSUPPORTED_FORMAT" }, 400);
      }

      // 落盘到 <dataRoot>/incoming/<kbId>/<safeRelPath>，再让 sidecar 读路径。
      const incomingRoot = resolvePath(deps.dataRoot, "incoming", kbId);
      const target = safeJoin(incomingRoot, relPath);
      if (!target) {
        return c.json({ error: "非法文件路径", code: "INVALID_PATH" }, 400);
      }
      await ensureParentDir(target);
      await writeStreamToFile(file, target);

      const result = (await client.call("kb.upload", {
        kbId,
        filePath: target,
        relPath,
      })) as Record<string, unknown>;
      return c.json(result, 201);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.delete("/api/knowledge/owned/documents/:docId", async (c) => {
    // sidecar 的删除接口按库维度；这里用 query 传 kbId 保持 EvoFlow 的 URL 形状
    try {
      const docId = c.req.param("docId");
      const kbId = c.req.query("kbId") ?? "";
      if (!kbId) {
        return c.json({ error: "缺少 kbId 查询参数", code: "MISSING_KB_ID" }, 400);
      }
      await client.call("kb.deleteDoc", { kbId, docId });
      return c.json({ deleted: true, docId });
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  // ── 检索 ──────────────────────────────────────────────────────────────
  // 跨库检索：前端在「全部知识库」视图下不传 kbId，走这条。
  app.post("/api/knowledge/owned/search", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const result = (await client.call("kb.searchAll", {
        query: body.query,
        topK: body.topK,
        mode: body.mode,
      })) as Record<string, unknown>;
      return c.json(result);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.post("/api/knowledge/owned/bases/:kbId/search", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      const body = await c.req.json<Record<string, unknown>>();
      const result = (await client.call("kb.search", {
        kbId,
        query: body.query,
        topK: body.topK,
        mode: body.mode,
      })) as Record<string, unknown>;
      return c.json(result);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.post("/api/knowledge/owned/bases/:kbId/ask", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      const body = await c.req.json<Record<string, unknown>>();
      const result = (await client.call("kb.ask", {
        kbId,
        query: body.query,
        topK: body.topK,
        mode: body.mode,
      })) as Record<string, unknown>;
      return c.json(result);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  // ── 任务与统计 ────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/jobs/:jobId", async (c) => {
    // P0-c 实现索引任务队列后接入；现在前端轮询会拿到 501，不会卡死
    try {
      const jobId = c.req.param("jobId");
      const result = (await client.call("kb.job", { jobId })) as Record<string, unknown>;
      return c.json(result);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  app.get("/api/knowledge/owned/bases/:kbId/jobs", async (c) => {
    try {
      const kbId = c.req.param("kbId");
      const result = (await client.call("kb.listJobs", { kbId })) as Record<string, unknown>;
      return c.json(result);
    } catch (error) {
      return gatewayError(c, error);
    }
  });

  // 文件夹 / Wiki / 图谱 / 同步 / 活动 / 设置 —— 拆到 routesExtra.ts（见该文件头说明）。
  registerKnowledgeExtraRoutes(app, client);
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

function extname(path: string): string {
  const index = path.lastIndexOf(".");
  return index > 0 ? path.slice(index) : "";
}

/** 防目录穿越：relPath 解析后必须仍在 root 内。 */
function safeJoin(root: string, relPath: string): string | null {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const target = resolvePath(root, normalized);
  const normalizedRoot = resolvePath(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + sep)) return null;
  return target;
}

async function ensureParentDir(filePath: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(resolvePath(filePath, ".."), { recursive: true });
}

async function writeStreamToFile(file: File, target: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(target, buffer);
}

/** 供 server 装配层取目录大小（诊断用）。 */
export async function knowledgeDataRootSize(dataRoot: string): Promise<number> {
  if (!existsSync(dataRoot)) return 0;
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // 用 stat 复核：Dirent 的 d_type 在 FUSE / proot 上不可靠
      const stats = await stat(full);
      if (stats.isDirectory()) await walk(full);
      else if (stats.isFile()) total += stats.size;
    }
  };
  await walk(dataRoot);
  return total;
}
