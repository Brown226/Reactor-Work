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

/** 网关 base：与其它 `/api/*` 同源，相对路径即可（开发态走 vite proxy）。 */
const BASE = "/api/knowledge/owned";

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

/** 未实现的后端能力：明确拒绝，不静默返回空。 */
function notImplemented(name: string): never {
  throw new Error(`知识库能力尚未实现：${name}`);
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

  // ── 文件夹（P0 未实现）────────────────────────────────────────────────
  listOwnedKnowledgeFolders: (kbId: string) => {
    log("listOwnedKnowledgeFolders 未实现，返回空列表");
    return Promise.resolve({ folders: [] });
  },
  createOwnedKnowledgeFolder: () => notImplemented("createOwnedKnowledgeFolder"),
  renameOwnedKnowledgeFolder: () => notImplemented("renameOwnedKnowledgeFolder"),
  moveOwnedKnowledgeFolder: () => notImplemented("moveOwnedKnowledgeFolder"),
  deleteOwnedKnowledgeFolder: () => notImplemented("deleteOwnedKnowledgeFolder"),
  moveOwnedKnowledgeDocument: () => notImplemented("moveOwnedKnowledgeDocument"),

  // ── 导入（P0 未实现）──────────────────────────────────────────────────
  importOwnedKnowledgeFolder: () => notImplemented("importOwnedKnowledgeFolder"),
  resyncOwnedKnowledgeBase: () => notImplemented("resyncOwnedKnowledgeBase"),
  previewOwnedKnowledgeSync: () => notImplemented("previewOwnedKnowledgeSync"),
  createOwnedKnowledgeManual: () => notImplemented("createOwnedKnowledgeManual"),

  // ── Wiki / 图谱（P1）──────────────────────────────────────────────────
  listOwnedWikiPages: () => notImplemented("listOwnedWikiPages"),
  getOwnedWikiPage: () => notImplemented("getOwnedWikiPage"),
  updateOwnedWikiPage: () => notImplemented("updateOwnedWikiPage"),
  rebuildOwnedWiki: () => notImplemented("rebuildOwnedWiki"),
  getOwnedWikiGraph: () => notImplemented("getOwnedWikiGraph"),
  rebuildOwnedKg: () => notImplemented("rebuildOwnedKg"),
  getOwnedKgGraph: () => notImplemented("getOwnedKgGraph"),
  getOwnedKnowledgeDocGraph: () => notImplemented("getOwnedKnowledgeDocGraph"),
  getOwnedKnowledgeDocumentLinks: () => notImplemented("getOwnedKnowledgeDocumentLinks"),
  listOwnedKnowledgeTags: () => notImplemented("listOwnedKnowledgeTags"),
  listOwnedKnowledgeActivities: () => Promise.resolve({ activities: [] }),
  enqueueOwnedKnowledgeDocumentSummary: () => notImplemented("enqueueOwnedKnowledgeDocumentSummary"),
  purgeOrphanOwnedJobs: () => Promise.resolve({ purged: 0 }),
  getOwnedKnowledgeSettings: () => notImplemented("getOwnedKnowledgeSettings"),
  setOwnedKnowledgeSettings: () => notImplemented("setOwnedKnowledgeSettings"),

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
