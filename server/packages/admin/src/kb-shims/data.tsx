/**
 * 知识库**取数层适配（真调用版）**——把移植页面对上游 `@buildingai/services/*` 的依赖
 * 收敛到本仓一处实现，接到服务端 `/v1/kb/*`（KB-⑥）。
 *
 * ## 为什么放在 kb-port 之外
 *
 * `packages/admin/scripts/port-kb-ui.mjs` 是**幂等全量重生成**的移植脚本，
 * 手写文件放进去会被下一次重跑删掉。所以取数层住在 `kb-shims/`，由脚本把页面里的
 * 外部 import **机械改指**到这里 —— 生成物与手写代码分离。
 *
 * ## ★ 字段映射（上游形状 → 本仓形状）——没对应的一律**留空**，不编造
 *
 * | 上游字段 | 本仓来源 | 说明 |
 * |---|---|---|
 * | `id` / `name` / `description` | 同名 | |
 * | `creatorName` | `createdBy` | |
 * | `documentCount` | 同名 | |
 * | `publishedToSquare` / `squarePublishStatus` | `scopeKind === "all"` | 本仓没有「广场」概念：**全员可见 = 已发布** |
 * | `updatedAt` | `createdAt` | 本仓没有单独的更新时间 |
 * | `sort` | `id` | 没有排序权重 |
 * | `coverUrl` / `modelName` / `modelProvider` / `storageSizeFormatted` / `tags` | **null / []** | 本仓模型里**没有**这些字段（封面、每库模型、体积统计、数据集标签）——留空比编造更安全 |
 *
 * ## ★ 没有对应功能的地方（明确不做假）
 *
 * - **审核/申请流**（`useConsoleDatasetApplicationsQuery` 与 approve/reject）：本仓没有
 *   「数据集申请加入 + 管理员审核」这套流程 ⇒ 返回空列表（于是相关入口自然不可达），
 *   而不是返回假数据让界面看起来有功能。
 * - **全局检索配置的写入**：模型由**部署侧** `REACTOR_KB_EMBED_MODEL` 决定（embedder 在服务启动时装配），
 *   管理台**只读展示**（`useDatasetsConfigQuery` 读 `/v1/kb/health`）；保存会明确报错说明原因，
 *   不静默成功。
 * - **成员**：本仓用 `kb_members`（owner/writer/reader），映射到上游的 owner/editor/viewer 语义。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { http, localStorageTokenStore } from "../http/client";
import { refreshAccess } from "../services/identity";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 服务端契约（镜像 packages/server/src/datasets/routes.ts；admin 是独立构建，故镜像一份）
// ─────────────────────────────────────────────────────────────────────────────

export interface KbDatasetDto {
  id: string;
  name: string;
  description: string | null;
  source: "department" | "org";
  scopeKind: "all" | "role" | "dept" | "user";
  scopeRoles: string[];
  scopeDeptIds: number[];
  scopeUids: string[];
  createdBy: string | null;
  createdAt: string;
  documentCount: number;
  segmentCount: number;
}

export interface KbHealthDto {
  vectorReady: boolean;
  dim: number;
  embedderConfigured: boolean;
  embeddingModel: string | null;
  modes: { lexical: boolean; vector: boolean; hybrid: boolean };
}

export interface KbDocumentDto {
  id: number;
  datasetId: number;
  name: string;
  source: string | null;
  addedBy: string | null;
  addedAt: string;
}

export interface KbMemberDto {
  uid: string;
  role: string;
  addedBy: string | null;
  addedAt: string;
}

export interface KbHitDto {
  chunk: string;
  score: number;
  source: "personal" | "department" | "org";
  datasetName: string;
  docName: string;
  position: number;
}

export interface KbSearchMetaDto {
  mode: string;
  effectiveMode: string;
  vectorUsed: boolean;
  degraded: boolean;
  degradeReason?: string;
  droppedDatasetIds: number[];
  scanned: number;
}

const api = {
  health: () => http.get<KbHealthDto>("/v1/kb/health", AUTH),
  list: () => http.get<{ items: KbDatasetDto[]; total: number }>("/v1/kb/datasets", AUTH),
  detail: (id: string) => http.get<KbDatasetDto>(`/v1/kb/datasets/${encodeURIComponent(id)}`, AUTH),
  create: (body: unknown) => http.post<{ id: string }>("/v1/kb/datasets", body, AUTH),
  patch: (id: string, body: unknown) => http.patch<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}`, body, AUTH),
  remove: (id: string) => http.delete<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}`, AUTH),
  documents: (id: string) =>
    http.get<{ items: KbDocumentDto[]; total: number; segmentCount: number }>(
      `/v1/kb/datasets/${encodeURIComponent(id)}/documents`,
      AUTH,
    ),
  addDocument: (id: string, body: unknown) =>
    http.post<{ documentId: string; segmentCount: number }>(`/v1/kb/datasets/${encodeURIComponent(id)}/documents`, body, AUTH),
  deleteDocument: (id: string, docId: string) =>
    http.delete<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}/documents/${encodeURIComponent(docId)}`, AUTH),
  members: (id: string) =>
    http.get<{ items: KbMemberDto[]; total: number }>(`/v1/kb/datasets/${encodeURIComponent(id)}/members`, AUTH),
  addMember: (id: string, body: unknown) =>
    http.post<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}/members`, body, AUTH),
  removeMember: (id: string, uid: string) =>
    http.delete<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}/members/${encodeURIComponent(uid)}`, AUTH),
  search: (body: unknown) =>
    http.post<{ hits: KbHitDto[]; meta: KbSearchMetaDto; total: number }>("/v1/kb/search", body, AUTH),
};

/** 供探针直接断言「接口路径 + 取数映射」（SSR 不跑 effect，渲染验不到这两件事） */
export const kbApi = api;

// ─────────────────────────────────────────────────────────────────────────────
// 页面侧形状（上游字段名；见头注的映射表）
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsoleDatasetItem {
  id: string;
  name: string;
  description?: string | null;
  coverUrl?: string | null;
  creatorName?: string | null;
  documentCount?: number;
  modelName?: string | null;
  modelProvider?: string | null;
  publishedToSquare?: boolean;
  sort?: number;
  squarePublishStatus?: string | null;
  squareRejectReason?: string | null;
  storageSizeFormatted?: string | null;
  tags?: Array<{ id: string; name: string }>;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface ConsoleDatasetsDocument {
  id: string;
  fileName: string;
  fileType: string;
  sizeFormatted?: string;
  status?: string;
  chunkCount?: number;
  createdAt?: string;
  [key: string]: unknown;
}

export interface ConsoleDatasetMember {
  id: string;
  userId: string;
  userName?: string;
  role?: string;
  [key: string]: unknown;
}

export interface ConsoleDatasetApplication {
  id: string;
  applicantName?: string;
  reason?: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface QueryConsoleDatasetsDto {
  page?: number;
  pageSize?: number;
  keyword?: string;
  tagId?: string;
  status?: string;
  [key: string]: unknown;
}

export interface UpdateDatasetsConfigDto {
  [key: string]: unknown;
}

export interface SetDatasetVectorConfigDto {
  [key: string]: unknown;
}

/** 上游状态码枚举（`BooleanNumber.YES === 1`） */
export const BooleanNumber = { NO: 0, YES: 1 } as const;

/** 服务端库行 → 页面行（映射规则见文件头注） */
export function toPageItem(d: KbDatasetDto): ConsoleDatasetItem {
  const published = d.scopeKind === "all";
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    creatorName: d.createdBy,
    documentCount: d.documentCount,
    publishedToSquare: published,
    sort: Number(d.id),
    squarePublishStatus: published ? "published" : "none",
    squareRejectReason: null,
    updatedAt: d.createdAt,
    // 本仓模型里没有的字段：留空而不是编造（封面 / 每库模型 / 体积 / 数据集标签）
    coverUrl: null,
    modelName: null,
    modelProvider: null,
    storageSizeFormatted: null,
    tags: [],
    // 保留原始 scope 供「可见范围」编辑使用
    scopeKind: d.scopeKind,
    scopeRoles: d.scopeRoles,
    scopeDeptIds: d.scopeDeptIds,
    scopeUids: d.scopeUids,
    source: d.source,
  };
}

/** 文档行 → 页面行（上游叫 fileName/fileType，我们用 name + 从扩展名推类型） */
export function toPageDocument(doc: KbDocumentDto): ConsoleDatasetsDocument {
  const ext = doc.name.includes(".") ? (doc.name.split(".").pop() ?? "") : "";
  return {
    id: String(doc.id),
    fileName: doc.name,
    fileType: ext.toLowerCase(),
    status: "completed",
    createdAt: doc.addedAt,
  };
}

/** 成员行 → 页面行（owner/writer/reader → owner/editor/viewer） */
export function toPageMember(m: KbMemberDto): ConsoleDatasetMember {
  const role = m.role === "owner" ? "owner" : m.role === "writer" ? "editor" : "viewer";
  return { id: m.uid, userId: m.uid, userName: m.uid, role };
}

const PAGE_SIZE_DEFAULT = 20;

/** 通用「拉取 + 状态」hook（admin 没有 react-query，这里按页面需要的形状自己实现） */
function useFetch<T>(load: () => Promise<T>, deps: unknown[], enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  // 竞态保护：快速切库/切页时只认最后一次请求
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    load()
      .then((d) => {
        if (mine === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, isLoading, error, refetch };
}

/** 通用「变更 + 状态」hook（页面读 `isPending` / 调 `mutate`） */
export function useSimpleMutation<TArgs, TResult>(run: (args: TArgs) => Promise<TResult>) {
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mutateAsync = useCallback(
    async (args: TArgs): Promise<TResult> => {
      setPending(true);
      setError(null);
      try {
        return await run(args);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setPending(false);
      }
    },
    [run],
  );
  return { isPending, error, mutate: mutateAsync, mutateAsync };
}

// ─────────────────────────────────────────────────────────────────────────────
// 取数 hook（命名与签名保持上游原样 ⇒ 页面一行不用改）
// ─────────────────────────────────────────────────────────────────────────────

export function useConsoleDatasetsListQuery(dto?: QueryConsoleDatasetsDto) {
  const keyword = (dto?.keyword ?? "").trim().toLowerCase();
  const page = Math.max(1, Number(dto?.page ?? 1));
  const pageSize = Math.max(1, Number(dto?.pageSize ?? PAGE_SIZE_DEFAULT));

  const { data, isLoading, error, refetch } = useFetch(api.list, []);
  const all = (data?.items ?? []).map(toPageItem);
  // 关键词过滤在客户端做（服务端列表接口没有 keyword 参数）；tagId 无对应能力，忽略
  const filtered = keyword === "" ? all : all.filter((d) => d.name.toLowerCase().includes(keyword));
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  const published = all.filter((d) => d.publishedToSquare === true).length;
  return {
    data: {
      items,
      total: filtered.length,
      extend: {
        total: all.length,
        pending: 0, // 本仓没有审核流
        published,
        private: all.length - published,
        unpublished: 0,
      },
    },
    isLoading,
    error,
    refetch,
  };
}

export function useConsoleDatasetDetailQuery(id?: string | null) {
  const { data, isLoading, error, refetch } = useFetch(
    () => (id ? api.detail(id) : Promise.resolve(null)),
    [id],
    Boolean(id),
  );
  return { data: data === null ? undefined : toPageItem(data), isLoading, error, refetch };
}

export function useConsoleDatasetDocumentsQuery(id?: string | null, _dto?: unknown) {
  const { data, isLoading, error, refetch } = useFetch(
    () => (id ? api.documents(id) : Promise.resolve(null)),
    [id],
    Boolean(id),
  );
  const items = (data?.items ?? []).map(toPageDocument);
  return { data: { items, total: data?.total ?? 0, segmentCount: data?.segmentCount ?? 0 }, isLoading, error, refetch };
}

export function useConsoleDatasetMembersInfiniteQuery(id?: string | null, _dto?: unknown) {
  const { data, isLoading, error } = useFetch(() => (id ? api.members(id) : Promise.resolve(null)), [id], Boolean(id));
  const items = (data?.items ?? []).map(toPageMember);
  return {
    data: { pages: [{ items, total: data?.total ?? 0 }] },
    isLoading,
    error,
    fetchNextPage: () => {},
    hasNextPage: false,
  };
}

/**
 * ⚠️ 本仓**没有**「申请加入数据集 + 审核」流程 ⇒ 恒返回空列表。
 *
 * 空列表让相关入口（待审列表 / 审核对话框）自然不可达，而不是给界面塞假数据
 * 让它看起来有这个功能。
 */
export function useConsoleDatasetApplicationsQuery(_id?: string | null, _dto?: unknown) {
  return { data: { items: [] as ConsoleDatasetApplication[], total: 0 }, isLoading: false, error: null };
}

/** 全局检索配置：**只读**展示服务端真实能力（见头注「没有对应功能的地方」） */
export function useDatasetsConfigQuery() {
  const { data, isLoading, error, refetch } = useFetch(api.health, []);
  return {
    data: {
      vectorReady: data?.vectorReady ?? false,
      dim: data?.dim ?? 0,
      embedderConfigured: data?.embedderConfigured ?? false,
      defaultEmbeddingModel: data?.embeddingModel ?? null,
      enableRerank: true, // rerank 由网关侧决定，管理台不单独开关
      rerankModel: null,
      modes: data?.modes ?? { lexical: true, vector: false, hybrid: true },
    },
    isLoading,
    error,
    refetch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 变更 hook
// ─────────────────────────────────────────────────────────────────────────────

export function useDeleteDatasetMutation(opts?: { onSuccess?: () => void }) {
  const onSuccess = opts?.onSuccess;
  return useSimpleMutation(async (id: string) => {
    const r = await api.remove(id);
    onSuccess?.();
    return r;
  });
}

/** 上游「发布到广场」= 本仓「设为全员可见」 */
export function usePublishDatasetSquareMutation(opts?: { onSuccess?: () => void }) {
  const onSuccess = opts?.onSuccess;
  return useSimpleMutation(async (id: string) => {
    const r = await api.patch(id, { scope: { kind: "all", roles: [], deptIds: [], uids: [] } });
    onSuccess?.();
    return r;
  });
}

/** 上游「取消发布」= 本仓「收回为仅自己可见」 */
export function useUnpublishDatasetSquareMutation(opts?: { onSuccess?: () => void }) {
  const onSuccess = opts?.onSuccess;
  return useSimpleMutation(async (id: string) => {
    const r = await api.patch(id, { scope: { kind: "user", roles: [], deptIds: [], uids: [] } });
    onSuccess?.();
    return r;
  });
}

/**
 * ⚠️ 全局检索配置**不可在管理台改**：embedding 模型由部署侧 env（`REACTOR_KB_EMBED_MODEL`）
 * 决定，向量化器在服务启动时装配。这里明确报错说明原因 —— 不静默成功，
 * 否则管理员会以为改了、实际没生效（这正是「静默失效」最典型的样子）。
 */
export function useSetDatasetsConfigMutation(_opts?: unknown) {
  return useSimpleMutation(async (_dto: UpdateDatasetsConfigDto) => {
    throw new Error(
      "全局检索配置由部署侧环境变量决定（REACTOR_KB_EMBED_MODEL / 网关模型），管理台暂不支持修改。",
    );
  });
}

/** 每库向量配置：本仓没有 per-dataset 向量配置（向量由全局 embedder 决定）⇒ 明确报错 */
export function useSetDatasetVectorConfigMutation(_opts?: unknown) {
  return useSimpleMutation(async (_dto: SetDatasetVectorConfigDto) => {
    throw new Error("本仓没有「每个数据集单独的向量配置」——向量由全局 embedding 模型决定。");
  });
}

/** 上游的广场审核：本仓没有审核流（见 useConsoleDatasetApplicationsQuery 说明） */
export function useApproveDatasetSquareMutation(_opts?: unknown) {
  return useSimpleMutation(async (_id: string) => {
    throw new Error("本仓没有数据集审核流（全员可见即已发布，无需审核）。");
  });
}
export function useRejectDatasetSquareMutation(_opts?: unknown) {
  return useSimpleMutation(async (_id: string) => {
    throw new Error("本仓没有数据集审核流。");
  });
}

/** 成员变更（上游签名是「先给 datasetId」） */
export function useConsoleUpdateDatasetMemberRoleMutation(datasetId?: string) {
  return useSimpleMutation(async (args: { uid: string; role: string }) => {
    if (!datasetId) throw new Error("缺少 datasetId");
    const role = args.role === "owner" ? "owner" : args.role === "editor" ? "writer" : "reader";
    return api.addMember(datasetId, { uid: args.uid, role });
  });
}
export function useConsoleRemoveDatasetMemberMutation(datasetId?: string) {
  return useSimpleMutation(async (uid: string) => {
    if (!datasetId) throw new Error("缺少 datasetId");
    return api.removeMember(datasetId, uid);
  });
}
export function useConsoleApproveDatasetApplicationMutation(_datasetId?: string) {
  return useSimpleMutation(async (_id: string) => {
    throw new Error("本仓没有「数据集加入申请」流程。");
  });
}
export function useConsoleRejectDatasetApplicationMutation(_datasetId?: string) {
  return useSimpleMutation(async (_id: string) => {
    throw new Error("本仓没有「数据集加入申请」流程。");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 上传（`@buildingai/services/shared`）—— 本仓没有独立上传通道：
// 文档入库走 `POST /v1/kb/datasets/:id/documents`（正文直接给 content）。
// ─────────────────────────────────────────────────────────────────────────────

export interface UploadFileParams {
  [key: string]: unknown;
}

export interface UploadFileResult {
  id: string;
  url: string;
  name: string;
  [key: string]: unknown;
}

/**
 * ⚠️ 本仓**没有**通用的「文件上传」接口（上传组件被移植进来但当前页面未使用）。
 *
 * 与其假装上传成功，这里直接抛出可诊断的错误。知识库入库走
 * `api.addDocument(datasetId, { name, content })` —— 正文以文本形式提交，服务端切片入库。
 */
export async function uploadFileAuto(
  file: File,
  _params?: UploadFileParams,
  _options?: { onUploadProgress?: (event: { loaded: number; total: number }) => void },
): Promise<UploadFileResult> {
  throw new Error(
    `本仓没有通用文件上传通道，无法上传「${file.name}」；知识库入库请用 POST /v1/kb/datasets/:id/documents（提交正文文本）。`,
  );
}


// ═════════════════════════════════════════════════════════════════════════════
// 用户侧适配（「都搬」批次）—— pages/datasets/** 需要的取数层
//
// 上游这套页面构建在 **@tanstack/react-query** 上（无限滚动 / 缓存失效全靠它），
// 所以这里的 hook 直接用 react-query 实现，**queryKey 沿用上游的失效约定**
// （如 ["datasets", datasetId, "documents"]），页面里那些 invalidateQueries 才能真的命中。
// ═════════════════════════════════════════════════════════════════════════════

import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/** 上游的库行（用户侧页面的字段口径） */
export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  source: "department" | "org";
  scopeKind: string;
  scopeRoles: string[];
  scopeDeptIds: number[];
  scopeUids: string[];
  createdBy: string | null;
  createdAt: string;
  documentCount: number;
  segmentCount: number;
  squareStatus?: string;
  tags?: string[];
  /** 上游详情页展示用；本仓模型没有封面 ⇒ 恒 null（不编造） */
  coverUrl?: string | null;
  /** 上游是对象（avatar/nickname）；本仓没有头像，nickname = 创建人 uid */
  creator?: { avatar?: string; nickname?: string } | null;
  /** 成员数：本仓接口暂未返回 ⇒ undefined（详情页显示为 "-"） */
  memberCount?: number;
}

export interface DatasetsDocument {
  id: string;
  name: string;
  parseStatus: "completed" | "failed";
  parseError: string | null;
  tags: string[];
  fileName: string | null;
  fileSize: number | null;
  fileType: string | null;
  segmentCount: number;
  addedBy: string | null;
  addedAt: string;
}

export interface DatasetMember {
  id: string;
  uid: string;
  role: string;
  addedAt: string;
}

export interface DatasetApplication {
  id: string;
  datasetId: string;
  datasetName?: string;
  uid: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export type SquarePublishStatus = "none" | "pending" | "approved" | "rejected";

export interface AiProvider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

export interface DatasetsMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  usage?: { model?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  createdAt?: string;
}

const qk = {
  created: (kw?: string) => ["datasets", "my-created", kw ?? ""] as const,
  team: (kw?: string) => ["datasets", "team", kw ?? ""] as const,
  square: (kw?: string) => ["datasets", "square", kw ?? ""] as const,
  detail: (id: string) => ["datasets", id] as const,
  documentsInfinite: (id: string) => ["datasets", "documents-infinite", id] as const,
  documents: (id: string) => ["datasets", id, "documents"] as const,
  members: (id: string) => ["datasets", id, "members"] as const,
  applications: (id?: string) => ["datasets", "applications", id ?? "all"] as const,
  tags: () => ["datasets", "tags"] as const,
  storage: () => ["user", "storage"] as const,
  conversations: (id: string) => ["datasets", id, "conversations"] as const,
  providers: () => ["ai", "providers"] as const,
};

/** 分页清单 → 无限滚动形状（上游用 useInfiniteQuery） */
function usePagedAsInfinite<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>,
  key: readonly unknown[],
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(Number(pageParam ?? 1)),
    initialPageParam: 1,
    getNextPageParam: (last, all) => {
      const fetched = all.reduce((n, p) => n + p.items.length, 0);
      return fetched < last.total ? all.length + 1 : undefined;
    },
    enabled,
  });
}

function kwParam(keyword?: string): string {
  const k = (keyword ?? "").trim();
  return k === "" ? "" : `&keyword=${encodeURIComponent(k)}`;
}

// ── 库清单 ─────────────────────────────────────────────────────────────────

export function useMyCreatedDatasetsInfiniteQuery(keyword?: string) {
  return usePagedAsInfinite<Dataset>(
    (page) => http.get<{ items: Dataset[]; total: number }>(`/v1/kb/my-created?page=${page}${kwParam(keyword)}`, AUTH),
    qk.created(keyword),
  );
}

export function useTeamDatasetsInfiniteQuery(keyword?: string) {
  return usePagedAsInfinite<Dataset>(
    (page) => http.get<{ items: Dataset[]; total: number }>(`/v1/kb/team?page=${page}${kwParam(keyword)}`, AUTH),
    qk.team(keyword),
  );
}

export function useSquareDatasetsInfiniteQuery(keyword?: string) {
  return usePagedAsInfinite<Dataset>(
    (page) => http.get<{ items: Dataset[]; total: number }>(`/v1/kb/square?page=${page}${kwParam(keyword)}`, AUTH),
    qk.square(keyword),
  );
}

export async function listMyCreatedDatasets(): Promise<Dataset[]> {
  return (await http.get<{ items: Dataset[] }>("/v1/kb/my-created", AUTH)).items;
}
export async function listTeamDatasets(): Promise<Dataset[]> {
  return (await http.get<{ items: Dataset[] }>("/v1/kb/team", AUTH)).items;
}

export function useDatasetDetail(id?: string) {
  return useQuery({
    queryKey: qk.detail(id ?? ""),
    queryFn: () => http.get<KbDatasetDto & { squareStatus?: string }>(`/v1/kb/datasets/${encodeURIComponent(id ?? "")}`, AUTH),
    enabled: Boolean(id),
  });
}

export function useDeleteDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.delete<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}`, AUTH),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useLeaveDatasets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ datasetId }: { datasetId: string }) =>
      http.post<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(datasetId)}/leave`, {}, AUTH),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

/** 建空库（上游「新建」流程第一步；缺省 scope = 仅自己可见） */
export async function createEmptyDataset(input: {
  name: string;
  description?: string | null;
  scope?: unknown;
}): Promise<{ id: string }> {
  return http.post<{ id: string }>(
    "/v1/kb/datasets",
    {
      name: input.name,
      description: input.description ?? null,
      scope: input.scope ?? { kind: "user", roles: [], deptIds: [], uids: [] },
    },
    AUTH,
  );
}

export function useUpdateDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; description?: string | null; scope?: unknown }) =>
      http.patch<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(id)}`, patch, AUTH),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["datasets"] });
      qc.invalidateQueries({ queryKey: qk.detail(vars.id) });
    },
  });
}

// ── 发布到广场（审核状态机） ───────────────────────────────────────────────

export function usePublishDatasetToSquare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ datasetId }: { datasetId: string }) =>
      http.post<{ status: string }>(`/v1/kb/datasets/${encodeURIComponent(datasetId)}/publish`, {}, AUTH),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useUnpublishDatasetFromSquare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ datasetId }: { datasetId: string }) =>
      http.post<{ ok: boolean }>(`/v1/kb/datasets/${encodeURIComponent(datasetId)}/unpublish`, {}, AUTH),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

/** 上游这个 query 返回发布相关的展示配置；本仓如实返回状态机语义说明 */
export function useDatasetsSquarePublishConfigQuery() {
  return useQuery({
    queryKey: ["datasets", "square-publish-config"],
    queryFn: async () => ({
      requireApproval: true, // owner 发布 → pending，等管理员批（见服务端 publish 路由）
      statuses: ["none", "pending", "approved", "rejected"] as SquarePublishStatus[],
    }),
    staleTime: Infinity,
  });
}

// ── 成员 ───────────────────────────────────────────────────────────────────

export function useDatasetsMembersInfiniteQuery(datasetId?: string) {
  return useQuery({
    queryKey: qk.members(datasetId ?? ""),
    queryFn: async () => {
      const r = await http.get<{ items: Array<{ uid: string; role: string; addedAt: string }>; total: number }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/members`,
        AUTH,
      );
      const items: DatasetMember[] = r.items.map((m) => ({ id: m.uid, uid: m.uid, role: m.role, addedAt: m.addedAt }));
      return { pages: [{ items, total: r.total }], total: r.total };
    },
    enabled: Boolean(datasetId),
  });
}

export function useRemoveDatasetsMember(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uid: string) =>
      http.delete<{ ok: boolean }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/members/${encodeURIComponent(uid)}`,
        AUTH,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(datasetId ?? "") }),
  });
}

export function useUpdateDatasetsMemberRole(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { uid: string; role: string }) => {
      const role = args.role === "owner" ? "owner" : args.role === "editor" ? "writer" : "reader";
      return http.post<{ ok: boolean }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/members`,
        { uid: args.uid, role },
        AUTH,
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.members(datasetId ?? "") }),
  });
}

// ── 加入申请 / 审核 ────────────────────────────────────────────────────────

export function useApplyToDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { datasetId: string; reason?: string }) =>
      http.post<{ ok: boolean }>(
        `/v1/kb/datasets/${encodeURIComponent(args.datasetId)}/apply`,
        { reason: args.reason ?? null },
        AUTH,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets", "applications"] }),
  });
}

interface KbApplicationApi {
  id: number;
  datasetId: number;
  datasetName?: string;
  uid: string;
  reason: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export function useDatasetsApplicationsQuery(datasetId?: string, status?: "pending" | "approved" | "rejected") {
  return useQuery({
    queryKey: qk.applications(datasetId ?? (status ? `status:${status}` : "all")),
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (datasetId) qs.set("datasetId", datasetId);
      if (status) qs.set("status", status);
      const r = await http.get<{ items: KbApplicationApi[]; total: number }>(`/v1/kb/applications?${qs.toString()}`, AUTH);
      const items: DatasetApplication[] = r.items.map((a) => ({
        id: String(a.id),
        datasetId: String(a.datasetId),
        datasetName: a.datasetName,
        uid: a.uid,
        reason: a.reason,
        status: a.status,
        createdAt: a.createdAt,
      }));
      return { items, total: r.total };
    },
  });
}

function useReviewDatasetApplication(approve: boolean) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (applicationId: string) =>
      http.post<{ ok: boolean }>(
        `/v1/kb/applications/${encodeURIComponent(applicationId)}/${approve ? "approve" : "reject"}`,
        {},
        AUTH,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets", "applications"] }),
  });
}
export const useApproveDatasetApplication = useReviewDatasetApplication;
export const useRejectDatasetApplication = useReviewDatasetApplication;

// ── 文档 ───────────────────────────────────────────────────────────────────

export function useDatasetsDocumentsInfiniteQuery(
  datasetId?: string,
  opts?: { keyword?: string; tag?: string; parseStatus?: string },
) {
  return useInfiniteQuery({
    queryKey: [...qk.documentsInfinite(datasetId ?? ""), opts ?? {}],
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams({ page: String(pageParam ?? 1), pageSize: "20" });
      if (opts?.keyword) qs.set("keyword", opts.keyword);
      if (opts?.tag) qs.set("tag", opts.tag);
      if (opts?.parseStatus) qs.set("parseStatus", opts.parseStatus);
      const r = await http.get<{ items: Array<Record<string, unknown>>; total: number }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents?${qs.toString()}`,
        AUTH,
      );
      const items = (r.items ?? []).map((d) => ({ ...d, id: String(d["id"]) })) as DatasetsDocument[];
      return { items, total: r.total };
    },
    initialPageParam: 1,
    getNextPageParam: (last, all) => {
      const fetched = all.reduce((n, p) => n + p.items.length, 0);
      return fetched < last.total ? all.length + 1 : undefined;
    },
    enabled: Boolean(datasetId),
  });
}

export function useDeleteDatasetsDocument(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) =>
      http.delete<{ ok: boolean }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/${encodeURIComponent(docId)}`,
        AUTH,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.documents(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.documentsInfinite(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.storage() });
    },
  });
}

export function useRetryDocumentVectorization(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) =>
      http.post<{ segmentCount: number; parseStatus: string }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/${encodeURIComponent(docId)}/retry-vectorization`,
        {},
        AUTH,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.documents(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.documentsInfinite(datasetId ?? "") });
    },
  });
}

export function useBatchDeleteDatasetsDocuments(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentIds: string[]) =>
      http.post<{ deleted: number }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/batch-delete`,
        { documentIds },
        AUTH,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.documents(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.documentsInfinite(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.storage() });
    },
  });
}

export function useBatchCopyDatasetsDocuments(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { targetDatasetId: string; documentIds: string[] }) =>
      http.post<{ moved: number }>(`/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/batch-copy`, args, AUTH),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useBatchMoveDatasetsDocuments(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { targetDatasetId: string; documentIds: string[] }) =>
      http.post<{ moved: number }>(`/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/batch-move`, args, AUTH),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useBatchAddTagsDatasetsDocuments(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { documentIds: string[]; tags: string[] }) =>
      http.post<{ updated: number }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/batch-add-tags`,
        args,
        AUTH,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.documents(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.documentsInfinite(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.tags() });
    },
  });
}

export function useUpdateDocumentTags(datasetId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { documentId: string; tags: string[] }) =>
      http.patch<{ ok: boolean }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId ?? "")}/documents/${encodeURIComponent(args.documentId)}/tags`,
        { tags: args.tags },
        AUTH,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.documents(datasetId ?? "") });
      qc.invalidateQueries({ queryKey: qk.documentsInfinite(datasetId ?? "") });
    },
  });
}

/** 可见范围内的全部标签（筛选下拉用） */
export function useDatasetTags() {
  return useQuery({
    queryKey: qk.tags(),
    queryFn: async () => {
      const r = await http.get<{ items: string[] }>("/v1/kb/tags", AUTH);
      return r.items.map((t) => ({ id: t, name: t }));
    },
  });
}

// ── 上传（两步式）─────────────────────────────────────────────────────────
/**
 * 与上游同形的第 1 步：`uploadFilesAuto(files)` 逐个文件调 `POST /v1/kb/files`
 * （暂存解析正文，拿到 fileId）；第 2 步 `createDatasetsDocument(datasetId, {fileId})` 原样保留。
 */
export async function uploadFilesAuto(
  files: File[],
): Promise<Array<{ id: string; fileName: string; parseStatus: string; parseError?: string }>> {
  const out: Array<{ id: string; fileName: string; parseStatus: string; parseError?: string }> = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file);
    out.push(
      await http.post<{ id: string; fileName: string; parseStatus: string; parseError?: string }>("/v1/kb/files", fd, AUTH),
    );
  }
  return out;
}

/** 两步式上传 · 第 2 步：fileId → 建文档（也支持 {url} 在线文档 / {name,content} 贴文本） */
export async function createDatasetsDocument(
  datasetId: string,
  input: { fileId?: string; url?: string; name?: string; content?: string },
): Promise<{ documentId: string; segmentCount: number }> {
  const r = await http.post<{ documentId: string; segmentCount: number }>(
    `/v1/kb/datasets/${encodeURIComponent(datasetId)}/documents`,
    input,
    AUTH,
  );
  getKbQueryClient().invalidateQueries({ queryKey: qk.documents(datasetId) });
  getKbQueryClient().invalidateQueries({ queryKey: qk.documentsInfinite(datasetId) });
  getKbQueryClient().invalidateQueries({ queryKey: qk.detail(datasetId) });
  getKbQueryClient().invalidateQueries({ queryKey: qk.storage() });
  return r;
}

/** 适配层偶发的缓存失效（react-query 的 client 由应用根注入 setKbQueryClient） */
interface KbQueryClientLike {
  invalidateQueries: (filter: { queryKey: readonly unknown[] }) => void;
}
let kbQueryClient: KbQueryClientLike | null = null;
export function setKbQueryClient(client: KbQueryClientLike): void {
  kbQueryClient = client;
}
function getKbQueryClient(): KbQueryClientLike {
  // 没注入时退化成空实现 —— 只少一次缓存刷新，不影响正确性
  return kbQueryClient ?? { invalidateQueries: () => undefined };
}

// ── 存储配额 / 模型列表（对话侧用） ────────────────────────────────────────

export function useUserStorageQuery() {
  return useQuery({
    queryKey: qk.storage(),
    queryFn: async () => {
      const r = await http.get<{ usedBytes: number; documentCount: number; quotaBytes: number | null }>("/v1/kb/storage", AUTH);
      return { usedBytes: r.usedBytes, documentCount: r.documentCount, quotaBytes: r.quotaBytes };
    },
  });
}

/** 对话选模型用：把网关模型目录按 provider 分组（我们只有一个网关出口 ⇒ 单组） */
export function useAiProvidersQuery() {
  return useQuery({
    queryKey: qk.providers(),
    queryFn: async (): Promise<AiProvider[]> => {
      const r = await http.get<{ data: Array<{ id: string; display_name?: string }> }>("/v1/models", AUTH);
      return [
        {
          id: "gateway",
          name: "Reactor 网关",
          models: (r.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id })),
        },
      ];
    },
  });
}

// ── 与库对话（会话 CRUD；发送走 AI SDK 的 transport，见 use-datasets-chat-stream） ──

export interface KbConversation {
  id: string;
  datasetId: string;
  title: string;
  createdAt: string;
}

export function useDatasetsConversationsQuery(datasetId?: string) {
  return useQuery({
    queryKey: qk.conversations(datasetId ?? ""),
    queryFn: async (): Promise<KbConversation[]> => {
      if (!datasetId) return [];
      const r = await http.get<{ items: KbConversation[] }>(
        `/v1/kb/datasets/${encodeURIComponent(datasetId)}/conversations`,
        AUTH,
      );
      return r.items;
    },
    enabled: Boolean(datasetId),
  });
}

export async function getDatasetsConversationInfo(datasetId: string, conversationId: string): Promise<KbConversation> {
  return http.get<KbConversation>(
    `/v1/kb/datasets/${encodeURIComponent(datasetId)}/conversations/${encodeURIComponent(conversationId)}`,
    AUTH,
  );
}

export async function getDatasetsConversationMessages(
  datasetId: string,
  conversationId: string,
  _opts?: { page?: number },
): Promise<{ items: DatasetsMessageRecord[]; total: number }> {
  return http.get<{ items: DatasetsMessageRecord[]; total: number }>(
    `/v1/kb/datasets/${encodeURIComponent(datasetId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    AUTH,
  );
}

/** 上传初始化（image-upload 组件用）；本仓没有独立文件服务 ⇒ 抛可诊断错误 */
export async function uploadInitFile(
  _file: File,
  _params?: UploadFileParams,
): Promise<UploadFileResult> {
  throw new Error("本仓没有通用文件上传通道（uploadInitFile）；知识库入库请走 POST /v1/kb/datasets/:id/files。");
}
