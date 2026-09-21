// Reactor 管理台 · 网关管理服务（T2-4）：模板化密钥 / 供应商 / 模型（双层）
// 契约对齐 packages/server/src/gateway/admin-routes.ts（platform_admin 专用）。

import type { ModelType } from "../lib/model-types";
import { http } from "../http/client";
import { refreshAccess } from "./identity";
import { localStorageTokenStore } from "../http/client";

const AUTH = {
  onUnauthorized: refreshAccess,
  onAuthLost: () => localStorageTokenStore.clearTokens(),
} as const;

export interface AdminProvider {
  id: number;
  code: string;
  name: string;
  baseUrl: string;
  /**
   * 板块归属（对话/向量/重排/生图/语音）：**每个板块有专属供应商**，左列表按它分栏（2026-09-19）。
   *
   * ⚠ 声明为**可选**是刻意的：迁移在服务端**启动时**执行，所以「新界面 + 旧服务」时
   * 该字段为 undefined。声明成必填会让调用方忘记回退，把所有供应商筛掉、列表空白
   * （真实事故 2026-09-19：用户以为「配好的供应商丢了」）。
   * 消费方一律用 `normalizeModelType(p.modelType)` 兜底。
   */
  modelType?: ModelType;
  /** 板块内排序（小在前）；旧服务同样不返回，故可选 */
  sort?: number;
  /**
   * 是否已配置 API Key（服务端只给布尔值，**永不回传明文或密文**）。
   * 界面据此把输入框显示成「已配置 · 留空不改」。
   */
  hasApiKey?: boolean;
  /** P2：上游协议类型（auto=入站什么形态就发什么形态，与历史一致） */
  api: ProviderApi;
  /** P2：自定义出站请求头（已校验；不加密，不放密钥） */
  headers: Record<string, string>;
  bindSecretId: number | null;
  enabled: boolean;
  createdAt: string;
}

/** P2：上游协议类型 */
export type ProviderApi = "auto" | "openai-chat" | "anthropic-messages" | "openai-responses" | "google-generative-ai";

/** 资源可见范围（与 skills/agents 同口径：命中任一即可见） */
export interface ResourceScope {
  kind: "all" | "role" | "dept" | "user";
  roles: string[];
  deptIds: number[];
  uids: string[];
}

export interface ModelPricing {
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
}

export interface AdminModel {
  id: number;
  providerId: number;
  model: string;
  displayName: string;
  modelType: string;
  features: string[];
  maxContext: number | null;
  maxOutput: number | null;
  /** 四段价（¥/百万 tokens）：输入/输出/缓存读/缓存写 */
  pricing: ModelPricing;
  /** 计费币种（上游目录带则透传，如 CNY） */
  currency: string | null;
  /** P2：可见范围（all/role/dept/user） */
  scope: ResourceScope;
  enabled: boolean;
  sort: number;
  /** 建库时钉死的参数（如 rerank 的向量维度）；界面只读展示 */
  params?: Record<string, unknown>;
}

/** 「模型发现」候选：上游 /models 的一项 + 是否已入库 */
export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsAnthropic?: boolean;
  supportsVision?: boolean;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  cacheReadPricePer1M?: number;
  cacheWritePricePer1M?: number;
  currency?: string;
  /** 库里已有同名模型 */
  imported: boolean;
  /** 已入库时的行 id / 启用态 */
  rowId: number | null;
  enabled: boolean | null;
  /** 上游给出的能力标记（服务端已与内置快照合并） */
  features?: string[];
  /** 元数据来源：upstream=全来自上游 · mixed=上游缺的用内置快照补 · preset=上游什么都没给，全靠快照 · none=都没有 */
  metadataSource?: "upstream" | "mixed" | "preset" | "none";
  /**
   * 按模型名推测的板块（**建议值**）：上游不会告诉你模型用途，所以这只是「默认帮你勾选」。
   * 落库时服务端按**供应商的板块**强制对齐，推测值不决定归属。
   */
  suggestedType?: ModelType;
  /** 被内置快照补齐的字段（窗口/价目/能力/币种…） */
  presetFilledFields?: string[];
}

/** 发现结果；失败时 ok=false + 已脱敏的 error（同样返回 200，与连通性测试同口径） */
export interface DiscoverResult {
  ok: boolean;
  code?: string;
  endpoint?: string;
  latencyMs?: number;
  total?: number;
  importedCount?: number;
  models?: DiscoveredModel[];
  error?: string;
  /** 内置快照来源说明（随 discover 下发） */
  presetSource?: string;
}

/** 内置模型目录条目（P1）：按模型名给窗口/最大输出/能力/四段价 */
export interface ModelPresetEntry {
  id: string;
  /** 归一化匹配键（服务端算好，UI 直接查表，避免前后端两套归一化逻辑） */
  matchKeys: string[];
  displayName: string;
  contextWindow: number | null;
  maxTokens: number | null;
  features: string[];
  pricing: ModelPricing;
  currency: string | null;
}

/** 单模型连通性测试结果（失败也返回 200 + ok:false） */
export interface ModelTestResult {
  ok: boolean;
  model: string;
  code?: string;
  endpoint?: string;
  shape?: string;
  httpStatus?: number;
  error?: string;
  latencyMs?: number;
  usage?: unknown;
  replied?: boolean;
  /** 向量模型实测维度（embedding 板块的测试才有）——用于「与库内维度是否一致」的判定 */
  embeddingDim?: number;
  /** 重排回执条数（rerank 板块的测试才有） */
  rerankCount?: number;
}

export interface ProviderTestResult {
  ok: boolean;
  code: string;
  /** ok=true 时返回 */
  endpoint?: string;
  modelCount?: number;
  sample?: string[];
  /** ok=false 时返回（已脱敏） */
  error?: string;
  latencyMs: number;
}

/*
 * 密钥（secrets）与密钥模板的客户端 API **已删除**（2026-09-19）。
 *
 * 原因（用户口径）：不需要针对密钥做单独的管理界面 —— 密钥在「供应商配置」里直接填，
 * 由 `providersApi.create/patch` 的 `apiKey` 字段一并提交，服务端加密落库。
 * 模板概念也一并下线（服务端的 /admin/secret-templates 端点已移除）。
 *
 * ⚠ 服务端仍保留 /admin/secrets（加密/掩码/审计的回归网在用），但**管理台不再有它的客户端** ——
 * 没有页面用它，留着这层封装只会让人误以为还有入口。要用就直接调接口。
 */

export const providersApi = {
  list: () => http.get<{ providers: AdminProvider[] }>("/admin/providers", AUTH),
  /** P2：协议选项由服务端下发（不前端硬编枚举） */
  apis: () => http.get<{ apis: Array<{ value: ProviderApi; label: string }> }>("/admin/provider-apis", AUTH),
  /** 新增供应商；`modelType` 决定它属于哪个板块（服务端会拒绝预留板块） */
  create: (body: {
    code: string;
    name: string;
    baseUrl: string;
    /** API Key 直填（推荐）：服务端加密落库，不回传。省略/空串 = 不设置 */
    apiKey?: string;
    bindSecretId?: number | null;
    api?: ProviderApi;
    headers?: Record<string, string>;
    modelType?: ModelType;
    sort?: number;
  }) => http.post<{ id: number }>("/admin/providers", body, AUTH),
  patch: (
    id: number,
    body: Partial<Pick<AdminProvider, "name" | "baseUrl" | "enabled" | "api" | "headers" | "modelType" | "sort">> & {
      /** API Key 直填：省略/空串 = 不改；非空 = 加密覆盖 */
      apiKey?: string;
    },
  ) => http.patch<{ ok: boolean }>(`/admin/providers/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/admin/providers/${id}`, AUTH),
  /** 连通性测试；可传未保存的 baseUrl/bindSecretId 覆盖库中值 */
  test: (id: number, body?: { baseUrl?: string; bindSecretId?: number | null }) =>
    http.post<ProviderTestResult>(`/admin/providers/${id}/test`, body ?? {}, AUTH),
  /** 模型发现（P0）：用该供应商的解密密钥拉上游 /models，返回带元数据的候选清单 */
  discover: (id: number) => http.post<DiscoverResult>(`/admin/providers/${id}/discover`, {}, AUTH),
};

export const modelsApi = {
  list: () => http.get<{ models: AdminModel[] }>("/admin/models", AUTH),
  create: (body: {
    providerId: number;
    model: string;
    displayName?: string;
    modelType?: string;
    features?: string[];
    maxContext?: number | null;
    maxOutput?: number | null;
    pricing?: ModelPricing;
    currency?: string | null;
    scope?: ResourceScope;
    sort?: number;
  }) => http.post<{ id: number }>("/admin/models", body, AUTH),
  /** 支持改挂供应商（providerId）——网关按 model 路由，改动 TTL 内热生效 */
  patch: (
    id: number,
    body: Partial<
      Pick<
        AdminModel,
        "providerId" | "model" | "displayName" | "modelType" | "features" | "enabled" | "sort" | "maxContext" | "maxOutput" | "pricing" | "currency" | "scope"
      >
    >,
  ) => http.patch<{ ok: boolean }>(`/admin/models/${id}`, body, AUTH),
  remove: (id: number) => http.delete<{ ok: boolean }>(`/admin/models/${id}`, AUTH),
  /** 内置模型目录（P1）：只读，供「一键填充 / 撤销」 */
  presets: () => http.get<{ source: string; presets: ModelPresetEntry[] }>("/admin/model-presets", AUTH),
  /** 单模型连通性测试（P1）：会真实发起一次最小调用（约几个 token） */
  test: (id: number) => http.post<ModelTestResult>(`/admin/models/${id}/test`, {}, AUTH),
  /** 批量修改（P1）：启用/停用 + 改价；只允许安全字段，未传的字段不动 */
  bulkPatch: (
    ids: number[],
    patch: {
      enabled?: boolean;
      modelType?: string;
      features?: string[];
      maxContext?: number | null;
      maxOutput?: number | null;
      /** 批量改价：只传要改的键（服务端按 JSONB 合并，不会把未传的段置空） */
      pricing?: Partial<ModelPricing>;
      currency?: string;
    },
  ) => http.post<{ ok: boolean; updated: number; changed: string[] }>("/admin/models/bulk-patch", { ids, ...patch }, AUTH),
  /**
   * 批量导入（P0）：单事务按 (providerId, model) 幂等 upsert。
   * 服务端语义：只补空缺/刷新上游元数据，**不动** enabled 与 sort（人工停用的不会被重拉启用）。
   */
  import: (providerId: number, models: Array<{
    model: string;
    displayName?: string | null;
    /** @deprecated 服务端按供应商的板块强制对齐，传了也会被忽略 */
    modelType?: string;
    features?: string[];
    maxContext?: number | null;
    maxOutput?: number | null;
    pricing?: ModelPricing;
    currency?: string | null;
  }>) => http.post<{ ok: boolean; added: number; updated: number; moved: number; total: number }>("/admin/models/import", { providerId, models }, AUTH),
};

/** 知识库检索配置（向量化/重排模型）—— 2026-09-19 打通：管理台配置优先，env 兜底 */
export interface AdminKbRetrieval {
  config: { embeddingEnabled: boolean; embeddingModel: string | null; rerankEnabled: boolean; rerankModel: string | null };
  /** 环境变量兜底值（库里没配时实际用的就是它） */
  env: { embeddingModel: string | null; rerankModel: string | null; gatewayConfigured: boolean };
  /** 实际生效值 + 是否需要重启 */
  effective: { embeddingModel: string | null; rerankModel: string | null; requiresRestart: boolean };
  /** 库内向量列的实际维度（换模型时用于 fail-closed 校验） */
  dim: number | null;
}

export const kbRetrievalApi = {
  get: () => http.get<AdminKbRetrieval>("/admin/kb-retrieval", AUTH),
  /**
   * 保存配置。`embeddingDim` 是前端先调模型「测试」拿到的实测维度：
   * 服务端用它做「与库内维度是否一致」的校验（不一致直接 409，避免检索悄悄变差）。
   */
  patch: (body: Partial<{
    embeddingEnabled: boolean;
    embeddingModel: string | null;
    rerankEnabled: boolean;
    rerankModel: string | null;
    embeddingDim: number | null;
  }>) => http.patch<{ ok: boolean; requiresRestart: boolean }>("/admin/kb-retrieval", body, AUTH),
};
