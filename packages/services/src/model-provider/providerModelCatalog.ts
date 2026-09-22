import type { ProviderApiType } from "@zcode/provider";

/** 拉取模型目录的请求超时：目录接口通常 <1s，上游慢时不应把设置页长期卡在 loading。 */
const CATALOG_TIMEOUT_MS = 15_000;

export interface ProviderModelCatalogRequest {
  /** 供应商 Base URL（与聊天请求同一份配置，含不含 /v1 都可能）。 */
  readonly baseUrl: string;
  /** 供应商密钥；留空表示匿名目录（部分网关的 /models 允许匿名读取）。 */
  readonly apiKey?: string;
  /** 决定鉴权头与首试路径：anthropic-messages 走 x-api-key，其余走 Bearer。 */
  readonly apiType?: ProviderApiType;
}

export interface ProviderModelCatalogEntry {
  readonly modelId: string;
  /** 上游给了展示名就带上；没有则 UI 回落 modelId。 */
  readonly displayName?: string;
}

export interface ProviderModelCatalogResult {
  readonly models: readonly ProviderModelCatalogEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 模型目录地址按 API 形态排序候选并逐个试：
 * 仓库里 openai 形态的 Base URL 惯例带 `/v1`（聊天路径拼 `/chat/completions`），
 * anthropic 形态的 Base URL 是站点根（聊天路径拼 `/v1/messages`），
 * 用户手填时两种都可能出现，所以 404 才降级到下一条，401/403 直接报鉴权失败。
 */
function resolveCatalogCandidateUrls(baseUrl: string, apiType?: ProviderApiType): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const withModels = `${base}/models`;
  const withVersionedModels = `${base}/v1/models`;
  const ordered =
    apiType === "anthropic-messages"
      ? [withVersionedModels, withModels]
      : [withModels, withVersionedModels];
  return ordered.filter((url, index) => ordered.indexOf(url) === index);
}

function buildCatalogHeaders(apiKey?: string, apiType?: ProviderApiType): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = apiKey?.trim();
  if (!key) return headers;

  if (apiType === "anthropic-messages") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  headers.Authorization = `Bearer ${key}`;
  return headers;
}

function parseCatalogPayload(payload: unknown): ProviderModelCatalogEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : null;
  if (!list) {
    throw new Error("模型目录响应格式无法识别（期望 data/models 数组）");
  }

  const seen = new Set<string>();
  const models: ProviderModelCatalogEntry[] = [];
  for (const item of list) {
    const modelId =
      typeof item === "string"
        ? item.trim()
        : isRecord(item) && typeof item.id === "string"
          ? item.id.trim()
          : isRecord(item) && typeof item.name === "string"
            ? item.name.trim()
            : "";
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);

    const rawDisplayName = isRecord(item)
      ? (item.display_name ?? item.displayName ?? item.human_name)
      : undefined;
    const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : "";
    models.push(displayName ? { modelId, displayName } : { modelId });
  }
  models.sort((left, right) => left.modelId.localeCompare(right.modelId));
  return models;
}

async function requestCatalog(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const snippet = detail.trim().slice(0, 200);
      throw Object.assign(new Error(`HTTP ${response.status}${snippet ? ` ${snippet}` : ""}`), {
        status: response.status,
      });
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一次性拉取供应商模型目录（只读，不写配置）。
 *
 * 在 host/Node 侧执行，刻意不在 renderer 直接 fetch：渲染层跨源会被 CORS 拦，
 * 而各供应商是否放行浏览器来源并不统一。
 */
export async function fetchProviderModelCatalog(
  request: ProviderModelCatalogRequest,
): Promise<ProviderModelCatalogResult> {
  const baseUrl = request.baseUrl.trim();
  if (!baseUrl) {
    throw new Error("未配置 Base URL，无法拉取模型目录");
  }

  const headers = buildCatalogHeaders(request.apiKey, request.apiType);
  const candidates = resolveCatalogCandidateUrls(baseUrl, request.apiType);
  let lastError: unknown;
  for (const url of candidates) {
    try {
      const payload = await requestCatalog(url, headers);
      return { models: parseCatalogPayload(payload) };
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      // 只有「这条路不存在」才换下一条候选；鉴权失败换地址也一样失败，直接冒泡。
      if (status !== 404) break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`拉取模型目录失败：${message}`);
}
