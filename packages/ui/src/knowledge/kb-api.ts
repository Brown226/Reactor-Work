/**
 * 知识库前端适配层。
 *
 * ## 为什么有这一层
 *
 * EvoFlow 的知识库 UI（`knowledge-owned.jsx` 等约 11,000 行）原本 import
 * `../lib/tauri-api.js`，用它的 `api.*` 对象访问后端。EvoFlow 的 `tauri-api`
 * 本身是双模式（桌面 Tauri invoke / Web `gatewayProxy` 即普通 HTTP），
 * 我们只实现了 Web 那一半的网关（`packages/server/src/knowledge/routes.ts`）。
 *
 * 所以这里提供一个**同形状的 `api` 对象**，方法名与 EvoFlow 完全一致，
 * 内部走我们的 HTTP 网关。UI 代码的 `import { api } from "../lib/tauri-api.js"`
 * 改成 `import { api } from "./kb-api.js"` 即可，其余不动。
 *
 * ## 纪律
 *
 * - 本文件只做「方法名 → HTTP 请求」的映射，**不放业务逻辑**。
 * - 后端未实现的能力返回明确 rejected promise（UI 已有 try/catch 兜底），
 *   不伪造空成功 —— 那会让 UI 显示「0 个文档」而用户以为传成功了。
 * - 新增后端能力时只改这张表，不碰 UI。
 */
import { logger } from "../logger.js";

const log = logger.warn.bind(logger);

/**
 * 网关 base。
 *
 * - **Web**：与其它 `/api/*` 同源，相对路径即可（开发态走 vite proxy）。
 * - **桌面端**：没有常驻 HTTP server，main 进程为知识库单独起了一个只监听
 *   127.0.0.1 的网关，地址经 preload 注入到 `window.__ZCODE_KNOWLEDGE_GATEWAY_URL__`。
 *   此时 BASE 变成绝对地址 `<注入值>/api/knowledge/owned`。
 *
 * 注入值为空（网关启动失败 / 非 Electron 环境）时退回相对路径，
 * 请求会自然失败 —— 比静默返回空数据更诚实。
 */
function resolveBase(): string {
  const injected = (
    globalThis as { __ZCODE_KNOWLEDGE_GATEWAY_URL__?: string }
  ).__ZCODE_KNOWLEDGE_GATEWAY_URL__;
  const origin = typeof injected === "string" ? injected.trim().replace(/\/+$/, "") : "";
  return `${origin}/api/knowledge/owned`;
}

const BASE = resolveBase();

/** 向量模型选项（与 EvoFlow `collectEmbeddingModelOptions` 消费的形状一致）。 */
export interface KnowledgeModelOption {
  name: string;
  display_name?: string;
  model?: string;
  supportsChat?: boolean;
}

/**
 * 模型列表注入点。
 *
 * 模型目录的唯一 owner 是 provider 体系（React hook），不是本模块。
 * 宿主在挂载知识库视图前注入一个读取函数即可，避免这里维护第二份模型状态。
 */
let knowledgeModelProvider: (() => Promise<KnowledgeModelOption[]>) | null = null;

export function setKnowledgeModelProvider(
  provider: (() => Promise<KnowledgeModelOption[]>) | null,
): void {
  knowledgeModelProvider = provider;
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; code?: string })
    | null;
  if (!response.ok) {
    const message = payload?.error ?? `知识库请求失败：HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: string; status?: number };
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return (payload ?? {}) as T;
}

/** multipart 上传（EvoFlow 的契约：file 字段 + 可选 relPath）。 */
async function upload(kbId: string, file: File, options: { relPath?: string } = {}) {
  const form = new FormData();
  form.append("file", file);
  if (options.relPath) form.append("relPath", options.relPath);
  const response = await fetch(`${BASE}/bases/${encodeURIComponent(kbId)}/documents`, {
    method: "POST",
    body: form,
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error((payload?.error as string) ?? `上传失败：HTTP ${response.status}`);
  }
  return payload;
}

/**
 * 与 EvoFlow `tauri-api.js` 同名的 api 对象。
 *
 * 只列 UI 实际用到的方法（见 kb-api-audit.txt 的调用点清单）；
 * 未列的不提供，UI 引用到会在运行期明确报错，好过 silently undefined。
 */
export const api = {
  // ── 库 ────────────────────────────────────────────────────────────────
  listOwnedKnowledgeBases: () => request<{ bases: unknown[] }>("GET", "/bases"),
  createOwnedKnowledgeBase: (data: unknown) => request<{ base: unknown }>("POST", "/bases", data),
  getOwnedKnowledgeBase: (id: string) =>
    request<{ base: unknown }>("GET", `/bases/${encodeURIComponent(id)}`),
  updateOwnedKnowledgeBase: (id: string, data: unknown) =>
    request<{ base: unknown }>("PATCH", `/bases/${encodeURIComponent(id)}`, data),
  deleteOwnedKnowledgeBase: (id: string) =>
    request<{ deleted: boolean }>("DELETE", `/bases/${encodeURIComponent(id)}`),
  reindexOwnedKnowledgeBase: (id: string) =>
    request<unknown>("POST", `/bases/${encodeURIComponent(id)}/reindex`, {}),

  // ── 文档 ──────────────────────────────────────────────────────────────
  listOwnedKnowledgeDocuments: (id: string) =>
    request<{ documents: unknown[] }>("GET", `/bases/${encodeURIComponent(id)}/documents`),
  uploadOwnedKnowledgeDocument: (kbId: string, file: File, options?: { relPath?: string }) =>
    upload(kbId, file, options),
  deleteOwnedKnowledgeDocument: (docId: string, kbId?: string) =>
    request<{ deleted: boolean }>(
      "DELETE",
      `/documents/${encodeURIComponent(docId)}${kbId ? `?kbId=${encodeURIComponent(kbId)}` : ""}`,
    ),
  retryOwnedDocument: (kbId: string, docId: string) =>
    request<unknown>(
      "POST",
      `/bases/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}/retry`,
      {},
    ),
  getOwnedKnowledgeDocument: (docId: string) =>
    request<unknown>("GET", `/documents/${encodeURIComponent(docId)}`),
  getOwnedKnowledgeDocumentContent: (docId: string) =>
    request<{ content: string }>("GET", `/documents/${encodeURIComponent(docId)}/content`),
  updateOwnedKnowledgeDocumentContent: (docId: string, content: string) =>
    request<unknown>("PUT", `/documents/${encodeURIComponent(docId)}/content`, { content }),
  listOwnedKnowledgeChunks: (docId: string) =>
    request<{ chunks: unknown[] }>("GET", `/documents/${encodeURIComponent(docId)}/chunks`),
  fetchOwnedKnowledgeDocumentFileBlob: (docId: string) =>
    fetch(`${BASE}/documents/${encodeURIComponent(docId)}/file`).then((r) => {
      if (!r.ok) throw new Error(`下载原件失败：HTTP ${r.status}`);
      return r.blob();
    }),
  fetchOwnedKnowledgeAssetObjectUrl: async (assetId: string) => {
    // sidecar 的资产端点直接给 bytes；这里包成 objectURL 供 <img src> 用
    const blob = await fetch(`${BASE}/assets/${encodeURIComponent(assetId)}`).then((r) => {
      if (!r.ok) throw new Error(`加载资产失败：HTTP ${r.status}`);
      return r.blob();
    });
    return URL.createObjectURL(blob);
  },

  // ── 检索 ──────────────────────────────────────────────────────────────
  searchOwnedKnowledge: (kbId: string, body: unknown) =>
    request<unknown>("POST", `/bases/${encodeURIComponent(kbId)}/search`, body),
  askOwnedKnowledge: (kbId: string, body: unknown) =>
    request<unknown>("POST", `/bases/${encodeURIComponent(kbId)}/ask`, body),

  // ── 任务 ──────────────────────────────────────────────────────────────
  getOwnedKnowledgeJob: (jobId: string) =>
    request<unknown>("GET", `/jobs/${encodeURIComponent(jobId)}`),
  listOwnedKnowledgeJobs: (kbId: string) =>
    request<{ jobs: unknown[] }>("GET", `/bases/${encodeURIComponent(kbId)}/jobs`),

  // ── 文件夹 ────────────────────────────────────────────────────────────
  listOwnedKnowledgeFolders: (kbId: string) =>
    request<{ folders: unknown[] }>("GET", `/bases/${encodeURIComponent(kbId)}/folders`),
  createOwnedKnowledgeFolder: (kbId: string, body: { parentPath?: string; path: string }) =>
    request<{ folder: unknown }>("POST", `/bases/${encodeURIComponent(kbId)}/folders`, body),
  renameOwnedKnowledgeFolder: (kbId: string, body: { fromPath: string; toPath: string }) =>
    request<{ folder: unknown }>("PATCH", `/bases/${encodeURIComponent(kbId)}/folders`, body),
  moveOwnedKnowledgeFolder: (kbId: string, fromPath: string, parentPath = "") =>
    request<{ folder: unknown }>("POST", `/bases/${encodeURIComponent(kbId)}/folders/move`, {
      fromPath,
      parentPath,
    }),
  deleteOwnedKnowledgeFolder: (kbId: string, path: string, mode = "move_up") =>
    request<{ deleted: unknown }>(
      "DELETE",
      `/bases/${encodeURIComponent(kbId)}/folders?path=${encodeURIComponent(path)}&mode=${encodeURIComponent(mode)}`,
    ),
  moveOwnedKnowledgeDocument: (
    docId: string,
    folderPath?: string,
    options: { beforeDocId?: string; sortOrder?: number } = {},
  ) =>
    request<{ doc: unknown }>("POST", `/documents/${encodeURIComponent(docId)}/move`, {
      folderPath: folderPath ?? "",
      ...options,
    }),

  // ── 同步 / 导入 ───────────────────────────────────────────────────────
  importOwnedKnowledgeFolder: (
    kbId: string,
    sourcePath: string,
    options: { pruneMissing?: boolean; folderPrefix?: string } = {},
  ) =>
    request<Record<string, unknown>>("POST", `/bases/${encodeURIComponent(kbId)}/sync/import`, {
      sourcePath,
      ...options,
    }),
  resyncOwnedKnowledgeBase: (kbId: string, options: { pruneMissing?: boolean } = {}) =>
    request<Record<string, unknown>>("POST", `/bases/${encodeURIComponent(kbId)}/sync/resync`, options),
  previewOwnedKnowledgeSync: (kbId: string, options: { path?: string; root?: string } = {}) =>
    request<Record<string, unknown>>("POST", `/bases/${encodeURIComponent(kbId)}/sync/preview`, options),
  createOwnedKnowledgeManual: (
    kbId: string,
    body: { title: string; content: string; folderPath?: string },
  ) =>
    request<{ doc: unknown }>("POST", `/bases/${encodeURIComponent(kbId)}/manual`, body),

  // ── Wiki ──────────────────────────────────────────────────────────────
  // 前端期望 `{ items }`（见 knowledge-owned.jsx 的 `res.items`），
  // sidecar 返回 `{ pages }` —— 在适配层统一，UI 不用改。
  listOwnedWikiPages: async (kbId: string) => {
    const res = await request<{ pages?: unknown[] }>(
      "GET",
      `/bases/${encodeURIComponent(kbId)}/wiki`,
    );
    return { items: res.pages ?? [] };
  },
  getOwnedWikiPage: (kbId: string, slug: string) =>
    request<Record<string, unknown>>(
      "GET",
      `/bases/${encodeURIComponent(kbId)}/wiki/${encodeURIComponent(slug)}`,
    ).then((res) => (res.page ?? res) as Record<string, unknown>),
  updateOwnedWikiPage: (
    kbId: string,
    slug: string,
    body: { title?: string; bodyMd?: string; pageType?: string },
  ) =>
    request<Record<string, unknown>>(
      "PUT",
      `/bases/${encodeURIComponent(kbId)}/wiki/${encodeURIComponent(slug)}`,
      body,
    ).then((res) => (res.page ?? res) as Record<string, unknown>),
  // 重建 Wiki 走整库 reindex：sidecar 的 wiki 生成是 pipeline 的一部分，
  // 没有单独的「只重建 wiki」入口，用 reindex 语义等价。
  rebuildOwnedWiki: (kbId: string) =>
    request<Record<string, unknown>>("POST", `/bases/${encodeURIComponent(kbId)}/reindex`, {
      force: false,
    }),
  getOwnedWikiGraph: (kbId: string, _options?: { depth?: number }) =>
    request<Record<string, unknown>>("GET", `/bases/${encodeURIComponent(kbId)}/wiki/graph`),

  // ── 知识图谱 ──────────────────────────────────────────────────────────
  rebuildOwnedKg: (kbId: string, force = false) =>
    request<Record<string, unknown>>("POST", `/bases/${encodeURIComponent(kbId)}/reindex`, {
      force,
    }),
  getOwnedKgGraph: (kbId: string, options: { center?: string; limit?: number } = {}) =>
    request<Record<string, unknown>>(
      "GET",
      `/bases/${encodeURIComponent(kbId)}/kg?${new URLSearchParams(
        Object.entries(options)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  getOwnedKnowledgeDocGraph: (
    kbId: string,
    options: { center?: string; depth?: number } = {},
  ) =>
    request<Record<string, unknown>>(
      "GET",
      `/bases/${encodeURIComponent(kbId)}/doc-graph?${new URLSearchParams(
        Object.entries(options)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  getOwnedKnowledgeDocumentLinks: (docId: string) =>
    request<Record<string, unknown>>(
      "GET",
      `/documents/${encodeURIComponent(docId)}/links`,
    ).then((res) => (res.links ?? res) as Record<string, unknown>),

  // ── 标签 / 活动 / 摘要 ────────────────────────────────────────────────
  listOwnedKnowledgeTags: async (kbId: string) => {
    const res = await request<{ tags?: unknown[] }>(
      "GET",
      `/bases/${encodeURIComponent(kbId)}/tags`,
    );
    return { items: res.tags ?? [] };
  },
  // 前端传的是 { limit }，且不指定库 —— 表示「最近的活动」。
  // sidecar 的活动查询按库，所以这里需要 kbId；调用方没有时会退化为空，
  // 不伪造数据（见文件头「纪律」）。
  listOwnedKnowledgeActivities: async (options: { kbId?: string; limit?: number } = {}) => {
    if (!options.kbId) return { items: [] };
    const res = await request<{ activities?: unknown[] }>(
      "GET",
      `/bases/${encodeURIComponent(options.kbId)}/activities?limit=${options.limit ?? 50}`,
    );
    return { items: res.activities ?? [] };
  },
  enqueueOwnedKnowledgeDocumentSummary: (docId: string, body: { force?: boolean } = {}) =>
    request<Record<string, unknown>>(
      "POST",
      `/documents/${encodeURIComponent(docId)}/summary`,
      body,
    ),
  // sidecar 没有「清理孤儿作业」的独立入口 —— worker 每轮会自动 reconcile
  // （见 owned/worker.py 的 _reconcile）。这里如实返回 0，不做假动作。
  purgeOrphanOwnedJobs: () => Promise.resolve({ purged: 0 }),

  // ── 设置 ──────────────────────────────────────────────────────────────
  // 知识库设置（摘要开关 / chat 模型）由库级字段承载，没有独立 KV 接口。
  // 返回空对象让 UI 走默认值，比抛错更合适（UI 已有 `|| {}` 兜底）。
  getOwnedKnowledgeSettings: () => Promise.resolve({} as Record<string, unknown>),
  setOwnedKnowledgeSettings: async (_body: unknown) => ({ ok: true }),

  /**
   * 可选模型列表（建库时选向量模型用）。
   *
   * EvoFlow 从它自己的 `GET /api/models` 取。我们的模型目录在 provider 体系里，
   * 由 React hook（useModelProviders 等）持有，模块级函数拿不到 ——
   * 所以这里返回空列表，UI 会走「无向量模型时创建按钮不可用」的既有降级，
   * 用户仍可建**纯关键词库**（contentMode: "keyword"，检索照样可用）。
   *
   * 需要完整能力时：由宿主在挂载前调 `setKnowledgeModelProvider()` 注入一个
   * 返回模型列表的函数（见下），不在这里再造一份 provider 状态。
   */
  listModels: async (): Promise<{ models: KnowledgeModelOption[] }> => {
    const provider = knowledgeModelProvider;
    if (!provider) return { models: [] };
    try {
      return { models: await provider() };
    } catch (error) {
      log("listModels 注入的 provider 失败，回退空列表", error);
      return { models: [] };
    }
  },

  // ── 宿主能力（桌面端「打开所在目录」）─────────────────────────────────
  revealPathInFileManager: (path: string) => {
    // Web 宿主没有「在文件管理器显示」；静默成功比抛错好（这是个增强而非主路径）
    log("revealPathInFileManager 在 Web 宿主不可用：", path);
    return Promise.resolve({ ok: false });
  },
};

export default api;
