/**
 * 知识库 HTTP 网关 —— 文件夹 / Wiki / 图谱 / 同步 / 活动 / 设置 部分。
 *
 * ## 为什么拆成两个文件
 *
 * `routes.ts` 负责「库 + 文档 + 检索」这条主链（也是 P0 最先跑通的部分），
 * 本文件负责其余全部能力。合在一个文件会超过 800 行上限（见根 .oxlintrc.json），
 * 且两块的生命周期不同：主链在 P0 就稳定了，这部分是整包移植 EvoFlow 后
 * 才补上的（spec §18）。
 *
 * ## 契约来源
 *
 * 前端 `packages/ui/src/knowledge/kb-api.ts` 的 23 个桩方法，逐个对应
 * sidecar 的 `owned.owned_api.REGISTRY`。方法名与 EvoFlow 前端原有约定一致，
 * 所以前端调用点一行都不用改。
 */
import type { Context } from "hono";
import type { Hono } from "hono";

import { formatLogPrefix } from "@zcode/shared";
import { type KnowledgeClient, KnowledgeRpcCallError, KnowledgeUnavailableError } from "@zcode/services";

const logError = (...args: unknown[]) =>
  console.error(formatLogPrefix("zcode-server:knowledge-extra", process.pid), ...args);

function statusForCode(code: string): 400 | 404 | 409 | 501 {
  switch (code) {
    case "KB_NOT_FOUND":
    case "FILE_NOT_FOUND":
    case "DOC_NOT_FOUND":
    case "JOB_NOT_FOUND":
    case "PAGE_NOT_FOUND":
      return 404;
    case "INVALID_MODE":
    case "INVALID_PARAM":
    case "INVALID_PATH":
    case "MISSING_PARAM":
    case "MISSING_KB_ID":
      return 400;
    case "UNKNOWN_METHOD":
    case "NOT_IMPLEMENTED":
      return 501;
    default:
      return 400;
  }
}

function gatewayError(c: Context, error: unknown): Response {
  if (error instanceof KnowledgeRpcCallError) {
    return c.json({ error: error.message, code: error.code }, statusForCode(error.code));
  }
  if (error instanceof KnowledgeUnavailableError) {
    return c.json({ error: error.message, code: "KNOWLEDGE_UNAVAILABLE" }, 503);
  }
  logError("知识库网关未预期错误", error);
  return c.json({ error: "知识库服务内部错误", code: "INTERNAL" }, 500);
}

/** 统一的「解析 JSON body → 调 RPC → 返回结果」包装。 */
async function handle(
  c: Context,
  client: KnowledgeClient,
  method: string,
  buildParams: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<Response> {
  try {
    const params = await buildParams();
    const result = await client.call(method, params);
    return c.json(result as Record<string, unknown>);
  } catch (error) {
    return gatewayError(c, error);
  }
}

/** 从 query string 收集翻页 / 过滤参数。 */
function queryParams(c: Context, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = c.req.query(key);
    if (value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

export function registerKnowledgeExtraRoutes(app: Hono, client: KnowledgeClient): void {
  // ── 文件夹 ────────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/bases/:kbId/folders", async (c) =>
    handle(c, client, "kb.folder.list", () => ({ kbId: c.req.param("kbId") })),
  );

  app.post("/api/knowledge/owned/bases/:kbId/folders", async (c) =>
    handle(c, client, "kb.folder.create", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      // 前端的 createOwnedKnowledgeFolder(kbId, { parentPath, path }) 里
      // path 是「名字」，parentPath 是父目录 —— 要拼成完整路径再传给 sidecar。
      const parent = String(body.parentPath ?? "").trim().replace(/^\/+|\/+$/g, "");
      const leaf = String(body.path ?? body.name ?? "").trim();
      const fullPath = parent && leaf ? `${parent}/${leaf}` : leaf;
      return { kbId: c.req.param("kbId"), path: fullPath };
    }),
  );

  app.patch("/api/knowledge/owned/bases/:kbId/folders", async (c) =>
    handle(c, client, "kb.folder.rename", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        kbId: c.req.param("kbId"),
        path: body.fromPath,
        newPath: body.toPath,
      };
    }),
  );

  app.post("/api/knowledge/owned/bases/:kbId/folders/move", async (c) =>
    handle(c, client, "kb.folder.move", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        kbId: c.req.param("kbId"),
        fromPath: body.fromPath,
        parentPath: body.parentPath ?? "",
      };
    }),
  );

  app.delete("/api/knowledge/owned/bases/:kbId/folders", async (c) =>
    handle(c, client, "kb.folder.delete", () => ({
      kbId: c.req.param("kbId"),
      path: c.req.query("path") ?? "",
      mode: c.req.query("mode") ?? "move_up",
    })),
  );

  // ── 文档移动 ──────────────────────────────────────────────────────────
  app.post("/api/knowledge/owned/documents/:docId/move", async (c) =>
    handle(c, client, "kb.doc.move", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        docId: c.req.param("docId"),
        folderPath: body.folderPath ?? "",
        beforeDocId: body.beforeDocId,
        sortOrder: body.sortOrder,
      };
    }),
  );

  // ── 同步 / 导入 ───────────────────────────────────────────────────────
  app.post("/api/knowledge/owned/bases/:kbId/sync/preview", async (c) =>
    handle(c, client, "kb.sync.preview", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return { kbId: c.req.param("kbId"), root: body.path ?? body.root };
    }),
  );

  app.post("/api/knowledge/owned/bases/:kbId/sync/preview-resync", async (c) =>
    handle(c, client, "kb.sync.previewResync", () => ({ kbId: c.req.param("kbId") })),
  );

  app.post("/api/knowledge/owned/bases/:kbId/sync/import", async (c) =>
    handle(c, client, "kb.sync.import", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        kbId: c.req.param("kbId"),
        sourcePath: body.path ?? body.sourcePath,
        pruneMissing: body.pruneMissing,
        folderPrefix: body.folderPrefix,
      };
    }),
  );

  app.post("/api/knowledge/owned/bases/:kbId/sync/resync", async (c) =>
    handle(c, client, "kb.sync.resync", async () => {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      return { kbId: c.req.param("kbId"), pruneMissing: body.pruneMissing };
    }),
  );

  // ── 手动文档 ──────────────────────────────────────────────────────────
  app.post("/api/knowledge/owned/bases/:kbId/manual", async (c) =>
    handle(c, client, "kb.createManual", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        kbId: c.req.param("kbId"),
        title: body.title,
        content: body.content,
        folderPath: body.folderPath ?? "",
      };
    }),
  );

  // ── Wiki ──────────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/bases/:kbId/wiki", async (c) =>
    handle(c, client, "kb.wiki.list", () => ({
      kbId: c.req.param("kbId"),
      ...queryParams(c, ["pageType"]),
    })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/wiki/graph", async (c) =>
    handle(c, client, "kb.wiki.graph", () => ({ kbId: c.req.param("kbId") })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/wiki/:slug", async (c) =>
    handle(c, client, "kb.wiki.get", () => ({
      kbId: c.req.param("kbId"),
      slug: decodeURIComponent(c.req.param("slug")),
    })),
  );

  app.put("/api/knowledge/owned/bases/:kbId/wiki/:slug", async (c) =>
    handle(c, client, "kb.wiki.update", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        kbId: c.req.param("kbId"),
        slug: decodeURIComponent(c.req.param("slug")),
        title: body.title,
        bodyMd: body.bodyMd ?? "",
        pageType: body.pageType,
      };
    }),
  );

  // ── 知识图谱 ──────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/bases/:kbId/kg", async (c) =>
    handle(c, client, "kb.kg.graph", () => ({
      kbId: c.req.param("kbId"),
      center: c.req.query("center"),
      limit: c.req.query("limit"),
    })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/kg/stats", async (c) =>
    handle(c, client, "kb.kg.stats", () => ({ kbId: c.req.param("kbId") })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/kg/nodes", async (c) =>
    handle(c, client, "kb.kg.nodes", () => ({
      kbId: c.req.param("kbId"),
      limit: c.req.query("limit"),
    })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/doc-graph", async (c) =>
    handle(c, client, "kb.docGraph", () => ({
      kbId: c.req.param("kbId"),
      centerDocId: c.req.query("center"),
      depth: c.req.query("depth"),
    })),
  );

  app.get("/api/knowledge/owned/documents/:docId/links", async (c) =>
    handle(c, client, "kb.docLinks", () => ({ docId: c.req.param("docId") })),
  );

  // ── 标签 / 活动 / 统计 ────────────────────────────────────────────────
  app.get("/api/knowledge/owned/bases/:kbId/tags", async (c) =>
    handle(c, client, "kb.listTags", () => ({ kbId: c.req.param("kbId") })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/activities", async (c) =>
    handle(c, client, "kb.listActivities", () => ({
      kbId: c.req.param("kbId"),
      ...queryParams(c, ["limit", "before"]),
    })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/stats", async (c) =>
    handle(c, client, "kb.stats", () => ({ kbId: c.req.param("kbId") })),
  );

  app.get("/api/knowledge/owned/bases/:kbId/job-stats", async (c) =>
    handle(c, client, "kb.jobStats", () => ({ kbId: c.req.param("kbId") })),
  );

  // ── 摘要 ──────────────────────────────────────────────────────────────
  app.post("/api/knowledge/owned/documents/:docId/summary", async (c) =>
    handle(c, client, "kb.summary", async () => {
      const body = await c.req
        .json<Record<string, unknown>>()
        .catch(() => ({}) as Record<string, unknown>);
      return { docId: c.req.param("docId"), force: body.force };
    }),
  );

  // ── 模型 ──────────────────────────────────────────────────────────────
  // 知识库可用的向量模型。数据源是 sidecar（它读取 ZCODE_KNOWLEDGE_*），
  // 而不是本仓 provider 体系 —— 后者管的是对话模型，与嵌入模型是两套端点。
  app.get("/api/knowledge/owned/models", async (c) =>
    handle(c, client, "kb.models", () => ({})),
  );

  // ── 设置 ──────────────────────────────────────────────────────────────
  // 知识库设置是全局的（不挂在某个 kbId 下）：默认向量模型、对话模型、
  // 新建库是否默认开摘要、以及「自建库 / 内置库」的主次。
  app.get("/api/knowledge/owned/settings", async (c) =>
    handle(c, client, "kb.settings.get", () => ({})),
  );

  app.put("/api/knowledge/owned/settings", async (c) =>
    handle(c, client, "kb.settings.set", async () => {
      const body = await c.req.json<Record<string, unknown>>();
      return body;
    }),
  );

  // ── 分块 ──────────────────────────────────────────────────────────────
  app.get("/api/knowledge/owned/documents/:docId/chunks", async (c) =>
    handle(c, client, "kb.listChunks", () => ({ docId: c.req.param("docId") })),
  );
}
