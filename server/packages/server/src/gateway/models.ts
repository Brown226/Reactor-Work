/**
 * 模型目录（M0-E2 / M10-03）：从上游 /v1/models 拉取并缓存（价目表供 M9 计量前置）。
 */

export interface CatalogModel {
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
  /** 四段价的缓存段（上游若下发则透传；缺省由服务端计费时回落输入价） */
  cacheReadPricePer1M?: number;
  cacheWritePricePer1M?: number;
  currency?: string;
}

const CATALOG_TTL_MS = 60_000;

/** 目录所依赖的上游（T3-4：由 ProviderSource 动态提供，provider 变更即失效重取）。 */
export interface CatalogUpstream {
  id?: string;
  baseUrl: string;
  apiKey: string;
}

export class ModelCatalog {
  /** key = provider id + baseUrl：管理台改上游后缓存自然失效。 */
  private cache: { key: string; models: CatalogModel[]; ts: number } | null = null;

  constructor(private readonly getUpstream: () => Promise<CatalogUpstream | undefined>) {}

  async list(force = false): Promise<CatalogModel[]> {
    const upstream = await this.getUpstream();
    if (!upstream) throw new Error("no upstream provider configured");
    const key = `${upstream.id ?? ""}|${upstream.baseUrl}`;
    const now = Date.now();
    if (!force && this.cache && this.cache.key === key && now - this.cache.ts < CATALOG_TTL_MS) {
      return this.cache.models;
    }
    const res = await fetch(joinUrl(upstream.baseUrl, "models"), {
      headers: { authorization: `Bearer ${upstream.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`upstream /models failed: ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const models = (data.data ?? []).map(toCatalogModel);
    this.cache = { key, models, ts: now };
    return models;
  }
}

/** 上游 `/models` 单项 → 目录模型（运行时目录与「模型发现」导入共用，避免两处映射漂移）。 */
export function toCatalogModel(raw: Record<string, unknown>): CatalogModel {
  return {
    id: String(raw.id ?? ""),
    name: typeof raw.id === "string" ? raw.id : undefined,
    contextWindow: num(raw.context_length),
    maxTokens: num(raw.max_completion_tokens),
    supportsTools: Boolean(raw.supports_tools),
    supportsReasoning: Boolean(raw.supports_reasoning),
    supportsAnthropic: Boolean(raw.supports_anthropic),
    supportsVision: Boolean(raw.supports_vision),
    inputPricePer1M: num(raw.input_price_per_million),
    outputPricePer1M: num(raw.output_price_per_million),
    cacheReadPricePer1M: num(raw.cache_read_price_per_million),
    cacheWritePricePer1M: num(raw.cache_write_price_per_million),
    currency: typeof raw.currency === "string" ? raw.currency : undefined,
  };
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 保证 path 拼在 base 之后（base 可能带 /v1 路径） */
export function joinUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}
