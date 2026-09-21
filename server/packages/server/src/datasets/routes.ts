/**
 * 公共知识库 HTTP 路由（KB-⑥ 服务端）—— `/v1/kb/*`。
 *
 * 依据：`docs/实施计划/个人知识库-实施方案-v1.md` §KB-⑥「3) 路由」。
 *
 * ## 鉴权口径（与 skills / agents 完全一致）
 *
 * 复用 identity 的 authed 中间件注入的 `claims`；**不另立一套**。
 *  - 读（列表 / 文档 / 成员 / 检索）：任意已登录用户 —— 可见性由 `visibilitySql` 裁决，
 *    读到什么取决于 scope，不取决于角色。
 *  - 写（建库 / 改库 / 删库 / 加文档 / 管成员）：平台管理员 **或** 该库 owner。
 *
 * ## 为什么读接口不要求管理员
 *
 * 公共库的语义是「组织资料，按 scope 对员工可见」—— 一个普通员工本就该能检索到自己部门的库。
 * 把读收紧到管理员会让这个功能失去意义（也会把权限判断从 scope 挪到角色，口径就分叉了）。
 *
 * ## 审计口径（一处刻意偏离，必须知道）
 *
 * 规格写「subject 进审计」。本仓的审计域（`audit/repo.ts`）是**端侧工具/用量事件**的通道，
 * 形状是 `{eventId, kind, usage…}`，不适合承载管理面 CRUD；而设计文档里的
 * `admin_audit_events`（管理操作日志）**尚未实现**（全仓零命中）。
 * 因此本层**不写审计表**，改为把主体打进服务端日志（`[kb] … uid=`）。
 * 等 `admin_audit_events` 落地后，这里的写操作应一并接入 —— 已在实施方案里记为待办。
 */

import { Hono } from "hono";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Context } from "hono";
import { kb } from "@reactor/shared";
import { parseScope, type ResourceScope } from "../common/scope.js";
import type { TokenClaims } from "../identity/auth.js";
import type { IdentityDb } from "../identity/db.js";
import {
  addDocument,
  canWriteDataset,
  createDataset,
  datasetStats,
  deleteDataset,
  deleteDocument,
  deleteDocumentsBatch,
  ensureDatasetsSchema,
  findDataset,
  getDocumentStoredPath,
  leaveDataset,
  listApplications,
  listDatasetTags,
  listDocumentsPaged,
  listMembers,
  listSquareDatasetsPaged,
  listDatasetsPaged,
  listVisibleDatasets,
  markDocumentParseFailed,
  removeMember,
  replaceDocumentSegments,
  reviewApplication,
  setSquareStatus,
  updateDatasetScope,
  updateDocumentTags,
  batchAddDocumentTags,
  createFileRecord,
  getFileRecord,
  upsertMember,
  userStorageUsage,
  appendMessage,
  createConversation,
  ensureConversationTables,
  getConversationFor,
  listConversations,
  listMessages,
  copyDocumentsBatch,
  moveDocumentsBatch,
  createApplication,
  type KbViewer,
} from "./repo.js";
import { DocumentParseError, fetchUrlText, parseUploadedFile, MAX_UPLOAD_BYTES } from "./parse.js";
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveDatasetScope, searchKb, sourceOfDataset, type KbSearchMode } from "./retrieval.js";

type AppEnv = { Variables: { claims: TokenClaims } };
type Ctx = Context<AppEnv>;

const err = (c: Ctx, status: 400 | 403 | 404 | 409 | 500, message: string): Response =>
  c.json({ error: { code: String(status), message } }, status);

/** 请求者视角（role/deptId/uid 三件套，与 skills/agents 同形） */
const viewerOf = (c: Ctx): KbViewer => {
  const claims = c.get("claims");
  return { uid: claims.sub, role: claims.role, deptId: claims.deptId ?? null };
};

const MAX_NAME_CHARS = 120;
const MAX_DESC_CHARS = 500;
const MAX_DOC_CONTENT_CHARS = 500_000;
const MAX_DOC_NAME_CHARS = 200;
const MAX_SEGMENTS_PER_DOC = 2_000;

/** 上传文件的落盘目录（容器里建议挂数据卷，否则重启即丢 —— compose 已加） */
const KB_FILE_DIR = process.env["REACTOR_KB_FILE_DIR"]?.trim() || path.join(process.cwd(), "data", "kb-files");

/** 库行 → 接口载荷（用户侧清单与可见列表共用同一形状） */
function toDatasetPayload(r: {
  id: number;
  name: string;
  description: string | null;
  scopeKind: string;
  scopeRoles: string[];
  scopeDeptIds: number[];
  scopeUids: string[];
  createdBy: string | null;
  createdAt: string;
  documentCount: number;
  segmentCount: number;
}) {
  return {
    id: String(r.id),
    name: r.name,
    description: r.description,
    source: sourceOfDataset(r.scopeKind),
    scopeKind: r.scopeKind,
    scopeRoles: r.scopeRoles,
    scopeDeptIds: r.scopeDeptIds,
    scopeUids: r.scopeUids,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    documentCount: r.documentCount,
    segmentCount: r.segmentCount,
    // 上游详情页读 creator.avatar/nickname —— 本仓没有头像，nickname 给创建人 uid
    creator: { nickname: r.createdBy ?? "" },
  };
}

/** 切片段 + （可选）向量化 —— 与端上个人库**同一实现**（`kb.chunkDocument`） */
async function buildSegments(
  content: string,
  embedder: kb.Embedder | undefined,
): Promise<Array<{ position: number; text: string; embedding?: readonly number[] }>> {
  // docId/docName 在切片时只用于 `Segment.id`；入库时以数据库主键为准，故传占位串
  const chunks = kb
    .chunkDocument("doc", "doc", content, kb.DEFAULT_CHUNK_OPTIONS)
    .slice(0, MAX_SEGMENTS_PER_DOC);
  const segments: Array<{ position: number; text: string; embedding?: readonly number[] }> = chunks.map((s) => ({
    position: s.position,
    text: s.text,
  }));
  if (embedder === undefined || segments.length === 0) return segments;

  // 向量化失败**不阻断入库**（词法照样能命中）——与「未配置即纯词法」同口径
  const vectors = await embedder(segments.map((s) => s.text)).catch(() => null);
  if (vectors === null) return segments;
  return segments.map((s, i) => {
    const v = vectors[i];
    return v !== undefined && v.length > 0 ? { ...s, embedding: v } : s;
  });
}

/**
 * 服务端向量化器：POST 到网关的 `/v1/embeddings`（KB-⑤ 已落地，OpenAI 兼容）。
 *
 * 为什么经网关而不是直连上游：模型调用在本仓**只有一个出口**（网关负责密钥解密与审计），
 * 绕过去就等于开了第二个出口。令牌用 `REACTOR_GATEWAY_TOKEN` 同一份口径。
 */
export function createServerEmbedder(cfg: {
  baseUrl: string;
  token: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): kb.Embedder {
  const doFetch = cfg.fetchImpl ?? fetch;
  return async (texts: readonly string[], opts?: { model?: string }): Promise<number[][]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 8000);
    try {
      const res = await doFetch(`${cfg.baseUrl.replace(/\/+$/, "")}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ model: opts?.model ?? cfg.model ?? "bge-m3", input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      return (body.data ?? []).map((d) => (Array.isArray(d.embedding) ? d.embedding : []));
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface KbRoutesDeps {
  /** 向量化器（缺省 ⇒ 向量路降级为词法，接口 meta 里如实标注） */
  readonly embedder?: kb.Embedder;
  /** 建表探测结果；缺省时路由内自行探测一次（幂等，代价小） */
  readonly schema?: { vectorReady: boolean; dim: number };
  /** 当前 embedding 模型名（仅用于 `/v1/kb/health` 如实展示，便于排查"配了没用上"） */
  readonly embeddingModel?: string;
  /**
   * 该模型名**从哪来**（`admin` = 管理台库配置 / `env` = 部署环境变量）。
   *
   * 为什么要单独回报来源：历史上出现过「管理台配了向量模型但检索仍走词法」，
   * 排查时只能靠翻日志猜。把来源说出来，用户一眼就能判断「我改的那处生效了没有」。
   */
  readonly embeddingModelSource?: "admin" | "env";
}

export function createDatasetsRoutes(db: IdentityDb, deps: KbRoutesDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  /** 惰性探测一次并缓存（探针可显式注入覆盖） */
  let schemaPromise: Promise<{ vectorReady: boolean; dim: number }> | null =
    deps.schema === undefined ? null : Promise.resolve(deps.schema);
  const schema = async (): Promise<{ vectorReady: boolean; dim: number }> => {
    if (schemaPromise === null) schemaPromise = ensureDatasetsSchema(db);
    return schemaPromise;
  };

  const writeAllowed = async (c: Ctx, datasetId: number): Promise<boolean> =>
    canWriteDataset(db, viewerOf(c), datasetId);

  // ── 健康：向量能力如实标注（不假装已启用） ────────────────────────────────
  app.get("/v1/kb/health", async (c) => {
    const info = await schema();
    return c.json({
      vectorReady: info.vectorReady,
      dim: info.dim,
      embedderConfigured: deps.embedder !== undefined,
      embeddingModel: deps.embeddingModel ?? null,
      /** 模型名来源：改完管理台配置后，这里应变成 admin（否则说明库配置没生效/没选模型） */
      embeddingModelSource: deps.embeddingModel === undefined ? null : deps.embeddingModelSource ?? "env",
      /** 三模式里哪些**真的**可用（前端据此禁用/提示，而不是让用户选了才发现降级） */
      modes: {
        lexical: true,
        vector: info.vectorReady && deps.embedder !== undefined,
        hybrid: true,
      },
    });
  });

  // ── 单个库（详情；管理台编辑表单用） ──────────────────────────────────────
  app.get("/v1/kb/datasets/:id", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const { ids } = await resolveDatasetScope(db, viewerOf(c), [id]);
    if (!ids.includes(id)) return err(c, 404, "数据集不存在");
    const row = await findDataset(db, id);
    if (row === null) return err(c, 404, "数据集不存在");
    const stats = await datasetStats(db, id);
    return c.json({
      id: String(row.id),
      name: row.name,
      description: row.description,
      source: sourceOfDataset(row.scopeKind),
      scopeKind: row.scopeKind,
      scopeRoles: row.scopeRoles,
      scopeDeptIds: row.scopeDeptIds,
      scopeUids: row.scopeUids,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      documentCount: stats.documents,
      segmentCount: stats.segments,
    });
  });

  // ── 库列表：只回裁剪后的（可见性由 SQL 层裁决） ──────────────────────────
  app.get("/v1/kb/datasets", async (c) => {
    await schema();
    const rows = await listVisibleDatasets(db, viewerOf(c));
    return c.json({
      items: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        description: r.description,
        source: sourceOfDataset(r.scopeKind),
        scopeKind: r.scopeKind,
        scopeRoles: r.scopeRoles,
        scopeDeptIds: r.scopeDeptIds,
        scopeUids: r.scopeUids,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        documentCount: r.documentCount,
        segmentCount: r.segmentCount,
      })),
      total: rows.length,
    });
  });

  // ── 建库（平台管理员） ────────────────────────────────────────────────────
  app.post("/v1/kb/datasets", async (c) => {
    await schema();
    if (c.get("claims").role !== "platform_admin") return err(c, 403, "仅平台管理员可新建数据集");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim().slice(0, MAX_NAME_CHARS) : "";
    if (name.length === 0) return err(c, 400, "name 不能为空");
    const description =
      typeof body["description"] === "string" ? body["description"].trim().slice(0, MAX_DESC_CHARS) : null;
    const parsed = parseScope(body["scope"]);
    if ("error" in parsed) return err(c, 400, parsed.error);

    const id = await createDataset(db, { name, description, scope: parsed.scope, createdBy: c.get("claims").sub });
    console.log(`[kb] 新建数据集 id=${id} by uid=${c.get("claims").sub}`);
    return c.json({ id: String(id) }, 201);
  });

  // ── 改库（管理员或 owner） ────────────────────────────────────────────────
  app.patch("/v1/kb/datasets/:id", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const existing = await findDataset(db, id);
    if (existing === null) return err(c, 404, "数据集不存在");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可修改");

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: { name?: string; description?: string | null; scope?: ResourceScope } = {};
    if (body["name"] !== undefined) {
      const name = typeof body["name"] === "string" ? body["name"].trim().slice(0, MAX_NAME_CHARS) : "";
      if (name.length === 0) return err(c, 400, "name 不能为空");
      patch.name = name;
    }
    if (body["description"] !== undefined) {
      patch.description = typeof body["description"] === "string" ? body["description"].trim().slice(0, MAX_DESC_CHARS) : null;
    }
    if (body["scope"] !== undefined) {
      const parsed = parseScope(body["scope"]);
      if ("error" in parsed) return err(c, 400, parsed.error);
      patch.scope = parsed.scope;
    }
    await updateDatasetScope(db, id, patch);
    console.log(`[kb] 修改数据集 id=${id} by uid=${c.get("claims").sub}`);
    return c.json({ ok: true });
  });

  // ── 删库（管理员或 owner） ────────────────────────────────────────────────
  app.delete("/v1/kb/datasets/:id", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if ((await findDataset(db, id)) === null) return err(c, 404, "数据集不存在");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可删除");
    await deleteDataset(db, id);
    console.log(`[kb] 删除数据集 id=${id} by uid=${c.get("claims").sub}`);
    return c.json({ ok: true });
  });

  // ── 文档清单（分页 + 关键词/标签/解析状态过滤 —— 用户侧无限滚动按页拉） ──

  // ── 两步式上传 · 第 1 步：传文件拿 fileId（解析就位，正文暂存 kb_files） ──
  app.post("/v1/kb/files", async (c) => {
    await schema();
    const body = await c.req.parseBody().catch(() => null);
    const file = body?.["file"];
    if (!(file instanceof File)) return err(c, 400, "缺少 file 字段（multipart/form-data）");
    if (file.size === 0) return err(c, 400, "上传文件为空");
    if (file.size > MAX_UPLOAD_BYTES) return err(c, 400, `文件超过上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
    if (!existsSync(KB_FILE_DIR)) mkdirSync(KB_FILE_DIR, { recursive: true });

    const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
    const stored = path.join(KB_FILE_DIR, `${randomUUID()}${ext}`);
    writeFileSync(stored, Buffer.from(await file.arrayBuffer()));

    try {
      const parsed = await parseUploadedFile(stored, file.name);
      const fileId = await createFileRecord(db, {
        fileName: file.name,
        fileSize: file.size,
        fileType: ext.replace(/^\./, ""),
        storedPath: stored,
        uploadedBy: c.get("claims").sub,
        parseStatus: "completed",
        extractedText: parsed.text,
      });
      return c.json({ id: String(fileId), fileName: file.name, parseStatus: "completed" as const }, 201);
    } catch (perr) {
      const msg = perr instanceof Error ? perr.message : String(perr);
      // 与单步上传同语义：文件记录照建（正文为空），失败原因如实返回 —— 建文档时会被拒
      const fileId = await createFileRecord(db, {
        fileName: file.name,
        fileSize: file.size,
        fileType: ext.replace(/^\./, ""),
        storedPath: stored,
        uploadedBy: c.get("claims").sub,
        parseStatus: "failed",
        parseError: msg,
        extractedText: "",
      });
      return c.json({ id: String(fileId), fileName: file.name, parseStatus: "failed" as const, parseError: msg }, 201);
    }
  });

  app.post("/v1/kb/datasets/:id/documents", async (c) => {
    const info = await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if ((await findDataset(db, id)) === null) return err(c, 404, "数据集不存在");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员、库 owner 或 writer 可写入");

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const source = typeof body["source"] === "string" ? body["source"].trim().slice(0, MAX_DOC_NAME_CHARS) : null;

    /**
     * 三种来源（对齐上游 use-document-upload 的两条路径 + 我们已有的贴文本）：
     *  ① `{fileId}`  —— 两步式上传的第 2 步：用第 1 步暂存的解析正文建文档；
     *  ② `{url}`     —— 「添加在线文档」：拉取网页/PDF 并提取正文；
     *  ③ `{name,content}` —— 直接贴文本。
     */
    let docName = typeof body["name"] === "string" ? body["name"].trim().slice(0, MAX_DOC_NAME_CHARS) : "";
    let text = typeof body["content"] === "string" ? body["content"] : "";
    let fileName: string | null = null;
    let fileSize: number | null = null;
    let fileType: string | null = null;
    let storedPath: string | null = null;

    const fileId = Number(body["fileId"]);
    const url = typeof body["url"] === "string" ? body["url"].trim() : "";

    if (Number.isInteger(fileId) && fileId > 0) {
      const rec = await getFileRecord(db, fileId);
      if (rec === null) return err(c, 404, "fileId 不存在");
      if (rec.parseStatus !== "completed" || rec.extractedText.trim().length === 0) {
        return err(c, 400, `该文件解析未成功（${rec.parseError ?? "正文为空"}），无法入库`);
      }
      text = rec.extractedText;
      fileName = rec.fileName;
      fileSize = rec.fileSize;
      fileType = rec.fileType;
      storedPath = rec.storedPath;
      if (docName.length === 0) docName = rec.fileName.slice(0, MAX_DOC_NAME_CHARS);
    } else if (url !== "") {
      const fetched = await fetchUrlText(url).catch((perr: unknown) =>
        perr instanceof DocumentParseError ? perr : new DocumentParseError(String(perr)),
      );
      if (fetched instanceof DocumentParseError) return err(c, 400, fetched.message);
      text = fetched.text;
      if (docName.length === 0) docName = (fetched.title ?? url).slice(0, MAX_DOC_NAME_CHARS);
      if (text.trim().length === 0) return err(c, 400, "在线内容提取结果为空");
    }

    if (docName.length === 0) return err(c, 400, "name 不能为空");
    if (text.trim().length === 0) return err(c, 400, "正文不能为空（fileId/url/content 至少给一种）");
    if (text.length > MAX_DOC_CONTENT_CHARS) {
      return err(c, 400, `正文超过上限 ${MAX_DOC_CONTENT_CHARS} 字符（请拆分后再入库）`);
    }

    const segments = await buildSegments(text, deps.embedder);
    if (segments.length === 0) return err(c, 400, "切片结果为空");
    const result = await addDocument(db, {
      datasetId: id,
      name: docName,
      source,
      addedBy: c.get("claims").sub,
      segments,
      vectorReady: info.vectorReady,
      fileName,
      fileSize,
      fileType,
      storedPath,
    });
    console.log(
      `[kb] 入库文档 dataset=${id} doc=${result.documentId} 片段=${result.segmentCount} by uid=${c.get("claims").sub}`,
    );
    return c.json({ documentId: String(result.documentId), segmentCount: result.segmentCount }, 201);
  });

  app.delete("/v1/kb/datasets/:id/documents/:docId", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    const docId = Number(c.req.param("docId"));
    if (!Number.isInteger(id) || !Number.isInteger(docId)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可删除");
    const ok = await deleteDocument(db, id, docId);
    if (!ok) return err(c, 404, "文档不存在");
    console.log(`[kb] 删除文档 dataset=${id} doc=${docId} by uid=${c.get("claims").sub}`);
    return c.json({ ok: true });
  });

  // ── 成员（库 owner 级授权） ──────────────────────────────────────────────
  app.get("/v1/kb/datasets/:id/members", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const { ids } = await resolveDatasetScope(db, viewerOf(c), [id]);
    if (!ids.includes(id)) return err(c, 404, "数据集不存在");
    const items = await listMembers(db, id);
    return c.json({ items, total: items.length });
  });

  app.post("/v1/kb/datasets/:id/members", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可管理成员");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const uid = typeof body["uid"] === "string" ? body["uid"].trim() : "";
    const role = body["role"] === "owner" || body["role"] === "writer" ? (body["role"] as "owner" | "writer") : "reader";
    if (uid.length === 0) return err(c, 400, "uid 不能为空");
    await upsertMember(db, id, uid, role, c.get("claims").sub);
    console.log(`[kb] 成员变更 dataset=${id} uid=${uid} role=${role} by=${c.get("claims").sub}`);
    return c.json({ ok: true });
  });

  app.delete("/v1/kb/datasets/:id/members/:uid", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可管理成员");
    const ok = await removeMember(db, id, c.req.param("uid"));
    if (!ok) return err(c, 404, "成员不存在");
    return c.json({ ok: true });
  });

  // ── 文档清单（分页 + 关键词/标签/解析状态过滤 —— 用户侧无限滚动按页拉） ──
  app.get("/v1/kb/datasets/:id/documents", async (c) => {
    await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    // 读也走可见性：不可见的库直接 404（不泄露「存在但你看不到」）
    const { ids } = await resolveDatasetScope(db, viewerOf(c), [id]);
    if (!ids.includes(id)) return err(c, 404, "数据集不存在");
    const stats = await datasetStats(db, id);
    const paged = await listDocumentsPaged(db, viewerOf(c), id, {
      page: Number(c.req.query("page") ?? 1) || 1,
      pageSize: Number(c.req.query("pageSize") ?? 20) || 20,
      keyword: c.req.query("keyword") ?? undefined,
      tag: c.req.query("tag") ?? undefined,
      parseStatus: c.req.query("parseStatus") ?? undefined,
    });
    return c.json({
      items: paged.items,
      total: paged.total,
      segmentCount: stats.segments,
      page: Number(c.req.query("page") ?? 1) || 1,
      pageSize: Number(c.req.query("pageSize") ?? 20) || 20,
    });
  });

  // ── 上传文件入库（存原始文件 → anydoc 解析 → 切片 → 向量化） ─────────────
  /**
   * 解析失败**不返回错误**：文档照建、`parseStatus=failed` 并带原因 —— 用户侧界面上
   * 是「解析失败 + 重试」按钮（`useRetryDocumentVectorization`），这正是它的用途。
   * 返回体里用 `parseStatus`/`parseError` 如实告知。
   */
  app.post("/v1/kb/datasets/:id/files", async (c) => {
    const info = await schema();
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if ((await findDataset(db, id)) === null) return err(c, 404, "数据集不存在");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员、库 owner 或 writer 可上传");

    const body = await c.req.parseBody().catch(() => null);
    const file = body?.["file"];
    if (!(file instanceof File)) return err(c, 400, "缺少 file 字段（multipart/form-data）");
    if (file.size === 0) return err(c, 400, "上传文件为空");
    if (file.size > MAX_UPLOAD_BYTES) return err(c, 400, `文件超过上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）`);
    if (!existsSync(KB_FILE_DIR)) mkdirSync(KB_FILE_DIR, { recursive: true });

    // 落盘：uuid 名 + 原扩展名（解析按原文件名判断格式）
    mkdirSync(KB_FILE_DIR, { recursive: true });
    const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
    const stored = path.join(KB_FILE_DIR, `${randomUUID()}${ext}`);
    writeFileSync(stored, Buffer.from(await file.arrayBuffer()));

    const base = {
      datasetId: id,
      name: file.name,
      addedBy: c.get("claims").sub,
      fileName: file.name,
      fileSize: file.size,
      fileType: ext.replace(/^\./, ""),
      storedPath: stored,
      vectorReady: info.vectorReady,
    };
    try {
      const parsed = await parseUploadedFile(stored, file.name);
      const segments = await buildSegments(parsed.text, deps.embedder);
      const result = await addDocument(db, {
        ...base,
        segments,
        parseStatus: segments.length > 0 ? "completed" : "failed",
        parseError: segments.length > 0 ? null : "解析结果为空",
      });
      console.log(`[kb] 上传入库 dataset=${id} doc=${result.documentId} 片段=${result.segmentCount} by uid=${c.get("claims").sub}`);
      return c.json({ documentId: String(result.documentId), segmentCount: result.segmentCount, parseStatus: "completed" as const }, 201);
    } catch (perr) {
      const msg = perr instanceof Error ? perr.message : String(perr);
      const result = await addDocument(db, { ...base, segments: [], parseStatus: "failed", parseError: msg });
      console.warn(`[kb] 上传解析失败 dataset=${id} doc=${result.documentId}：${msg}`);
      return c.json(
        { documentId: String(result.documentId), segmentCount: 0, parseStatus: "failed" as const, parseError: msg },
        201,
      );
    }
  });

  // ── 重试解析/向量化（文件还在磁盘上才能重试） ────────────────────────────
  app.post("/v1/kb/datasets/:id/documents/:docId/retry-vectorization", async (c) => {
    const info = await schema();
    const id = Number(c.req.param("id"));
    const docId = Number(c.req.param("docId"));
    if (!Number.isInteger(id) || !Number.isInteger(docId)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员、库 owner 或 writer 可重试");
    const stored = await getDocumentStoredPath(db, id, docId);
    if (stored === null) return err(c, 400, "该文档没有原始文件（贴文本入库的文档不适用重试）");
    if (!existsSync(stored)) return err(c, 400, "原始文件已丢失（容器数据卷被清理），请重新上传");

    try {
      const parsed = await parseUploadedFile(stored, stored);
      const segments = await buildSegments(parsed.text, deps.embedder);
      const n = await replaceDocumentSegments(db, id, docId, segments, info.vectorReady);
      return c.json({ segmentCount: n, parseStatus: n > 0 ? ("completed" as const) : ("failed" as const) });
    } catch (perr) {
      const msg = perr instanceof Error ? perr.message : String(perr);
      await markDocumentParseFailed(db, docId, msg);
      return c.json({ segmentCount: 0, parseStatus: "failed" as const, parseError: msg });
    }
  });

  // ── 文档批量操作（删除 / 复制到另一库 / 移动到另一库） ───────────────────
  const readDocIds = (body: Record<string, unknown>): number[] =>
    Array.isArray(body["documentIds"]) ? body["documentIds"].map((v) => Number(v)).filter((n) => Number.isInteger(n)) : [];

  app.post("/v1/kb/datasets/:id/documents/batch-delete", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员、库 owner 或 writer 可删除");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const deleted = await deleteDocumentsBatch(db, id, readDocIds(body));
    return c.json({ deleted });
  });

  const batchTransfer = (move: boolean) =>
    async (c: Context) => {
      const from = Number(c.req.param("id"));
      if (!Number.isInteger(from)) return err(c, 400, "id 非法");
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const to = Number(body["targetDatasetId"]);
      if (!Number.isInteger(to)) return err(c, 400, "targetDatasetId 非法");
      // 两个库都要有写权限：从哪搬、搬到哪，缺一不可
      if (!(await writeAllowed(c, from))) return err(c, 403, "对源数据集无写权限");
      if (!(await writeAllowed(c, to))) return err(c, 403, "对目标数据集无写权限");
      const ids = readDocIds(body);
      const moved = move ? await moveDocumentsBatch(db, from, to, ids) : await copyDocumentsBatch(db, from, to, ids);
      console.log(`[kb] 批量${move ? "移动" : "复制"} ${moved} 篇 ${from} → ${to} by uid=${c.get("claims").sub}`);
      return c.json({ moved });
    };
  app.post("/v1/kb/datasets/:id/documents/batch-copy", batchTransfer(false));
  app.post("/v1/kb/datasets/:id/documents/batch-move", batchTransfer(true));

  // ── 文档标签 ─────────────────────────────────────────────────────────────
  app.patch("/v1/kb/datasets/:id/documents/:docId/tags", async (c) => {
    const id = Number(c.req.param("id"));
    const docId = Number(c.req.param("docId"));
    if (!Number.isInteger(id) || !Number.isInteger(docId)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员、库 owner 或 writer 可打标签");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const tags = Array.isArray(body["tags"]) ? body["tags"].map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    await updateDocumentTags(db, id, docId, tags);
    return c.json({ ok: true, tags });
  });

  app.post("/v1/kb/datasets/:id/documents/batch-add-tags", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员、库 owner 或 writer 可打标签");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const tags = Array.isArray(body["tags"]) ? body["tags"].map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    const updated = await batchAddDocumentTags(db, id, readDocIds(body), tags);
    return c.json({ updated, tags });
  });

  app.get("/v1/kb/tags", async (c) => {
    await schema();
    const tags = await listDatasetTags(db, viewerOf(c));
    return c.json({ items: tags, total: tags.length });
  });

  // ── 用户侧清单（我创建的 / 团队的 / 广场） ───────────────────────────────
  const pagedQuery = (c: Context) => ({
    page: Number(c.req.query("page") ?? 1) || 1,
    pageSize: Number(c.req.query("pageSize") ?? 20) || 20,
    keyword: c.req.query("keyword") ?? undefined,
  });

  app.get("/v1/kb/my-created", async (c) => {
    await schema();
    const viewer = viewerOf(c);
    const r = await listDatasetsPaged(db, viewer, "created", pagedQuery(c));
    return c.json({ items: r.items.map(toDatasetPayload), total: r.total });
  });

  app.get("/v1/kb/team", async (c) => {
    await schema();
    const viewer = viewerOf(c);
    const r = await listDatasetsPaged(db, viewer, "team", pagedQuery(c));
    return c.json({ items: r.items.map(toDatasetPayload), total: r.total });
  });

  app.get("/v1/kb/square", async (c) => {
    await schema();
    const viewer = viewerOf(c);
    const r = await listSquareDatasetsPaged(db, viewer, pagedQuery(c));
    return c.json({ items: r.items.map(toDatasetPayload), total: r.total });
  });

  // ── 广场发布 / 审核（owner 提交 → 管理员批；管理员直接发即生效） ─────────
  app.post("/v1/kb/datasets/:id/publish", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if ((await findDataset(db, id)) === null) return err(c, 404, "数据集不存在");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可发布");
    const claims = c.get("claims");
    // 管理员发布即生效；owner 发布进入待审（广场上架是「全员可见」级别的动作，得有人把关）
    if (claims.role === "platform_admin") {
      await setSquareStatus(db, id, "approved");
    } else {
      await setSquareStatus(db, id, "pending");
    }
    return c.json({ status: claims.role === "platform_admin" ? "approved" : "pending" });
  });

  app.post("/v1/kb/datasets/:id/unpublish", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if (!(await writeAllowed(c, id))) return err(c, 403, "仅平台管理员或库 owner 可下架");
    await setSquareStatus(db, id, "none");
    return c.json({ ok: true });
  });

  app.post("/v1/kb/square/review", async (c) => {
    if (c.get("claims").role !== "platform_admin") return err(c, 403, "仅平台管理员可审核上架");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = Number(body["datasetId"]);
    if (!Number.isInteger(id)) return err(c, 400, "datasetId 非法");
    const approve = body["approve"] !== false;
    const reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 300) : null;
    await setSquareStatus(db, id, approve ? "approved" : "rejected", approve ? null : (reason ?? "未通过审核"));
    console.log(`[kb] 广场审核 dataset=${id} ${approve ? "通过" : "驳回"} by uid=${c.get("claims").sub}`);
    return c.json({ ok: true, status: approve ? "approved" : "rejected" });
  });

  // ── 加入申请 / 审核 / 退出 ───────────────────────────────────────────────
  app.post("/v1/kb/datasets/:id/apply", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    if ((await findDataset(db, id)) === null) return err(c, 404, "数据集不存在");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body["reason"] === "string" ? body["reason"].slice(0, 300) : null;
    await createApplication(db, id, c.get("claims").sub, reason);
    return c.json({ ok: true, status: "pending" }, 201);
  });

  app.get("/v1/kb/applications", async (c) => {
    await schema();
    const viewer = viewerOf(c);
    const statusRaw = c.req.query("status");
    const status = statusRaw === "pending" || statusRaw === "approved" || statusRaw === "rejected" ? statusRaw : undefined;
    const datasetIdRaw = Number(c.req.query("datasetId"));
    const items = await listApplications(db, viewer, {
      ...(Number.isInteger(datasetIdRaw) && datasetIdRaw > 0 ? { datasetId: datasetIdRaw } : {}),
      ...(status === undefined ? {} : { status }),
    });
    return c.json({ items, total: items.length });
  });

  const reviewApp = (approve: boolean) =>
    async (c: Context) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id)) return err(c, 400, "id 非法");
      const viewer = viewerOf(c);
      const reviewed = await reviewApplication(db, id, approve, viewer);
      if (reviewed === null) return err(c, 404, "申请不存在");
      return c.json({ ok: true, status: reviewed.status });
    };
  app.post("/v1/kb/applications/:id/approve", reviewApp(true));
  app.post("/v1/kb/applications/:id/reject", reviewApp(false));

  app.post("/v1/kb/datasets/:id/leave", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const r = await leaveDataset(db, id, c.get("claims").sub);
    if (!r.ok) return err(c, 400, r.reason ?? "无法退出");
    return c.json({ ok: true });
  });

  // ── 存储用量 ─────────────────────────────────────────────────────────────
  app.get("/v1/kb/storage", async (c) => {
    await schema();
    const usage = await userStorageUsage(db, c.get("claims").sub);
    return c.json({ ...usage, quotaBytes: null });
  });

  // ── 与库对话：会话 CRUD ─────────────────────────────────────────────────
  app.get("/v1/kb/datasets/:id/conversations", async (c) => {
    await ensureConversationTables(db);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return err(c, 400, "id 非法");
    const items = await listConversations(db, id, c.get("claims").sub);
    return c.json({ items: items.map((x) => ({ id: String(x.id), datasetId: String(x.datasetId), title: x.title, createdAt: x.createdAt })), total: items.length });
  });

  app.get("/v1/kb/datasets/:id/conversations/:cid/messages", async (c) => {
    const id = Number(c.req.param("id"));
    const cid = Number(c.req.param("cid"));
    if (!Number.isInteger(id) || !Number.isInteger(cid)) return err(c, 400, "id 非法");
    const conv = await getConversationFor(db, id, cid, c.get("claims").sub);
    if (conv === null) return err(c, 404, "会话不存在");
    const items = await listMessages(db, cid);
    return c.json({ items, total: items.length });
  });

  app.get("/v1/kb/datasets/:id/conversations/:cid", async (c) => {
    const id = Number(c.req.param("id"));
    const cid = Number(c.req.param("cid"));
    if (!Number.isInteger(id) || !Number.isInteger(cid)) return err(c, 400, "id 非法");
    const conv = await getConversationFor(db, id, cid, c.get("claims").sub);
    if (conv === null) return err(c, 404, "会话不存在");
    return c.json({ id: String(conv.id), datasetId: String(conv.datasetId), title: conv.title, createdAt: conv.createdAt });
  });

  /**
   * ★ 与库对话（RAG 流式）—— `POST /api/ai-datasets/:id/chat`
   *
   * 协议：AI SDK v6 的 UIMessage 流（useChat 的 DefaultChatTransport 直连）。
   * RAG 管道：取最后一条用户消息 → `searchKb`（该库范围，混合模式）→ 把带出处的片段
   * 写进 system prompt → 网关 chat 流式 → AI SDK 把 token 转成 UI 流。
   * 兼容两条路径：`/api/ai-datasets/...`（部署态同源直连）与
   * `/ai-datasets/...`（开发期 vite 代理会剥掉 /api 前缀）。
   */
  const chatHandler = (c: Context) =>
    (async () => {
      await ensureConversationTables(db);
      const datasetId = Number(c.req.param("id"));
      if (!Number.isInteger(datasetId)) return err(c, 400, "id 非法");
      const viewer = viewerOf(c);
      const { ids } = await resolveDatasetScope(db, viewer, [datasetId]);
      if (!ids.includes(datasetId)) return err(c, 404, "数据集不存在");

      const body = (await c.req.json().catch(() => ({}))) as { messages?: Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>; conversationId?: string; model?: string }

      const uiMessages = body.messages ?? [];
      const lastUser = [...uiMessages].reverse().find((m) => m.role === "user");
      const question =
        (lastUser?.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("\n") || "";
      if (question.trim().length === 0) return err(c, 400, "消息里没有文本内容");

      // 会话：body 带 conversationId 就续用，否则新建（标题 = 问题前 40 字）
      let convId = Number(body.conversationId);
      let conv = Number.isInteger(convId) && convId > 0 ? await getConversationFor(db, datasetId, convId, viewer.uid) : null;
      if (conv === null) {
        conv = await createConversation(db, datasetId, viewer.uid, question.slice(0, 40));
        convId = conv.id;
      }
      await appendMessage(db, convId, "user", question);

      // RAG：检索（该库范围；双重校验在 searchKb 内部）
      const ds = await findDataset(db, datasetId);
      const scopeKinds = new Map([[datasetId, ds?.scopeKind ?? "all"]]);
      const search = await searchKb(
        db,
        viewer,
        { queries: [question], datasetIds: [datasetId], topK: 6, mode: "hybrid" },
        { ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }), vectorReady: (await schema()).vectorReady },
        scopeKinds,
      );
      const contextText =
        search.hits.length > 0
          ? search.hits
              .map((h, i) => `[${i + 1}] (《${h.datasetName}》· ${h.docName}#${h.position})
${h.chunk}`)
              .join("\n\n")
          : "";
      const system = [
        `你是企业知识库助手。只依据下面给出的资料片段回答；资料没有的内容明说「资料中未提及」，不要编造。`,
        `回答末尾用一行「出处：」列出用到的片段编号对应的库与文档名。`,
        contextText === ""
          ? `（本次检索没有命中任何片段 —— 请直接说明资料中未提及。）`
          : `—— 资料片段 ——
${contextText}`,
      ].join("\n");

      // 模型：body.model 或网关目录第一个（模型目录在管理台维护）
      const modelId = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "deepseek-v4-flash-0731";
      const gwBase = process.env["REACTOR_GATEWAY_URL"]?.trim() || `http://${process.env["REACTOR_GATEWAY_HOST"]?.trim() || "gateway"}:8790/v1`;
      const gwToken = (process.env["REACTOR_GATEWAY_TOKEN"] ?? process.env["REACTOR_DEV_TOKEN"] ?? "").trim();
      if (gwToken === "") return err(c, 500, "网关令牌未配置（REACTOR_DEV_TOKEN），无法调用模型");
      const provider = createOpenAI({ baseURL: gwBase, apiKey: gwToken });

      // useChat 会把整段对话（含历史）随 body.messages 传上来 ⇒ 直接整体转模型消息；
      // system 提示词（含检索片段）单独给 streamText。历史落库仅用于 messages 列表回放。
      const modelMessages = await convertToModelMessages(
        uiMessages.map((m) => ({
          role: (m.role ?? "user") as "user" | "assistant",
          parts: (m.parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => ({ type: "text" as const, text: p.text ?? "" })),
        })),
      );

      const uiStream = createUIMessageStream({
        execute: ({ writer }) => {
          const result = streamText({
            model: provider(modelId),
            system,
            messages: modelMessages,
            onFinish: async (event) => {
              const text = await event.text;
              const usage = event.totalUsage ?? undefined;
              await appendMessage(db, convId, "assistant", text, {
                model: modelId,
                inputTokens: usage?.inputTokens,
                outputTokens: usage?.outputTokens,
                totalTokens: usage?.totalTokens,
              });
              // 会话标题：第一条问答后用问题命名（已初始化为问题前 40 字，这里无需再改）
              void 0;
            },
          });
          void result;
          // 把 streamText 的输出接到 UI 流
          writer.merge(result.toUIMessageStream());
        },
        onError: (err) => `[对话失败] ${err instanceof Error ? err.message : String(err)}`,
      });
      return createUIMessageStreamResponse({ stream: uiStream, headers: { "x-kb-conversation-id": String(convId) } });
    })().then((r) => r as Response).catch((e: unknown) => err(c, 500, e instanceof Error ? e.message : String(e)));

  app.post("/api/ai-datasets/:id/chat", chatHandler);
  app.post("/ai-datasets/:id/chat", chatHandler); // 开发期 vite 代理剥掉 /api 后的形态

  // ── 检索（三模式 + 双重校验） ────────────────────────────────────────────
  app.post("/v1/kb/search", async (c) => {
    const info = await schema();
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const rawQueries = Array.isArray(body["queries"]) ? body["queries"] : [];
    const queries = rawQueries.filter((q): q is string => typeof q === "string");
    if (queries.length === 0) return err(c, 400, "queries 不能为空");

    const requestedIds = Array.isArray(body["datasetIds"])
      ? body["datasetIds"].map((v) => Number(v)).filter((n) => Number.isInteger(n))
      : undefined;
    const mode: KbSearchMode =
      body["mode"] === "vector" || body["mode"] === "lexical" || body["mode"] === "hybrid"
        ? (body["mode"] as KbSearchMode)
        : "hybrid";
    const topK = typeof body["topK"] === "number" ? body["topK"] : 8;

    // 库 id → scope_kind（来源标注用）；只查可见集合，天然不会带出越权库
    const { ids } = await resolveDatasetScope(db, viewerOf(c), requestedIds);
    const scopeKinds = new Map<number, string>();
    for (const id of ids) {
      const row = await findDataset(db, id);
      if (row !== null) scopeKinds.set(id, row.scopeKind);
    }

    const outcome = await searchKb(
      db,
      viewerOf(c),
      { queries, ...(requestedIds === undefined ? {} : { datasetIds: requestedIds }), topK, mode },
      { ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }), vectorReady: info.vectorReady },
      scopeKinds,
    );
    return c.json({ hits: outcome.hits, meta: outcome.meta, total: outcome.hits.length });
  });

  return app;
}
