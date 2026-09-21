/**
 * Provider 注册表（M0-E2 / T3-4）—— 参照 BuildingAI provider-registry（Apache-2.0）的注册形态。
 * T3-4 起：网关上游由管理台（ai_providers + secrets）驱动，env 仅作兜底。
 * T3-4b 起：**模型目录（ai_models）参与路由**——请求的 model 决定上游 provider。
 */

import type { IdentityDb } from "../identity/db.js";
import { openFields } from "../common/secrets-crypto.js";
import { normalizePricing, type ModelPricing } from "../common/pricing.js";
import { normalizeApi, parseHeaders, type ProviderApi } from "./provider-api.js";
import { normalizeModelType, type ModelType } from "@reactor/shared";

export interface ProviderEntry {
  id: string;
  name: string;
  /** 上游 baseURL（OpenAI 兼容，含 /v1） */
  baseUrl: string;
  apiKey: string;
  /** 上游协议类型（P2）：auto = 入站什么形态就发什么形态（与历史一致） */
  api: ProviderApi;
  /** 自定义出站请求头（P2）；鉴权/传输类头不允许覆盖 */
  headers: Record<string, string>;
  /**
   * 板块归属（2026-09-19 管理台重构）：每个板块有**专属供应商**，
   * 所以同一个上游要同时服务对话与向量时，是两条记录（各自密钥/启停），本字段区分它们。
   */
  modelType: ModelType;
}

/** 模型能力与价目（来自 ai_models，供路由决策、目录下发与后续计量使用）。 */
export interface ModelEntry {
  /** 上游模型 id（请求 model 字段原样透传，不做别名改写） */
  model: string;
  displayName: string | null;
  modelType: ModelType;
  /** 能力标记；识别 tools / reasoning / anthropic / vision，其余忽略 */
  features: string[];
  maxContext: number | null;
  maxOutput: number | null;
  /** 四段价（¥/百万 tokens）；见 common/pricing.ts */
  pricing: ModelPricing;
  /** 计费币种（上游目录带则透传；缺省 null → 下游不展示单位） */
  currency: string | null;
  /** 可见范围（P2）：与 skills/agents 同口径（all / role / dept / user，命中任一即可见） */
  scope: { kind: string; roles: string[]; deptIds: number[]; uids: string[] };
  /**
   * 建库时钉死、运行期不能改的模型参数 —— 随目录下发给端侧（`/v1/models` 的 `params`）。
   * 首个使用者是 rerank 的**向量维度**：Qwen3-Embedding-8B 的模型卡写 4096，
   * 实测端点返回 1024，与建表时的 `vector(1024)` 一致；这个值必须**实测后钉住**，
   * 换维度意味着整个库的向量作废（需重建列 + 重新向量化）。
   */
  params?: Record<string, unknown>;
}

export interface ModelBinding {
  providerId: string;
  entry: ModelEntry;
}

/** 已识别的能力标记（features 数组里其它值忽略）。 */
const KNOWN_FEATURES = ["tools", "reasoning", "anthropic", "vision"] as const;

export function hasFeature(entry: ModelEntry, feature: (typeof KNOWN_FEATURES)[number]): boolean {
  return entry.features.includes(feature);
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderEntry>();
  /**
   * 模型目录：**按 `providerId::model` 双键**存放（2026-09-19 重构）。
   *
   * 为什么从「单键 model」改成双键：板块拆分后，**同一个模型名可能挂在不同供应商下**
   * （典型：gitee 有 Qwen3-Embedding-8B 的对话版与向量版；或两家上游各有一个 `bge-m3`）。
   * 旧的单键 Map 会让后注册的那条**静默覆盖**前一条，表现为「配了却打到别的上游」——
   * 这类 bug 只看代码极难发现，所以直接从数据结构上消除。
   */
  private readonly models = new Map<string, ModelBinding>();
  /** 供「不带 providerId 时按类型取第一条」用的顺序表（保持注册顺序 = SQL 的 sort, id） */
  private readonly modelOrder: ModelBinding[] = [];

  /**
   * 是否“带类型语义”的注册表。
   *
   * 为什么需要这个开关：板块（对话/向量/…）是**管理台库里的概念**。
   * env 兜底路径（无 REACTOR_DB_URL 时的 M0 形态）只有一条上游、没有板块，
   * 若照搬类型过滤，`/v1/embeddings` 会因为「没有 embedding 类型的供应商」直接 503 ——
   * 把本来能跑的旧部署打断。所以类型过滤**只在库驱动时生效**。
   */
  private typed = false;

  /** 标记本注册表来自管理台库（启用类型过滤）。由 createRegistryFromDb 调用。 */
  markTyped(): void {
    this.typed = true;
  }

  /** 本注册表是否启用类型过滤。 */
  get typedEnabled(): boolean {
    return this.typed;
  }

  register(entry: ProviderEntry): void {
    this.providers.set(entry.id, entry);
  }

  /** 注册模型；provider 未注册（被护栏跳过）时忽略，避免悬空绑定。 */
  registerModel(providerId: string, entry: ModelEntry): void {
    if (!this.providers.has(providerId)) return;
    const binding: ModelBinding = { providerId, entry };
    this.models.set(modelKey(providerId, entry.model), binding);
    // 同一 provider+model 重复注册（TTL 重载内不会发生，防御性处理）：替换顺序表里的旧项
    const dup = this.modelOrder.findIndex((b) => modelKey(b.providerId, b.entry.model) === modelKey(providerId, entry.model));
    if (dup >= 0) this.modelOrder[dup] = binding;
    else this.modelOrder.push(binding);
  }

  get(id: string): ProviderEntry | undefined {
    return this.providers.get(id);
  }

  list(): ProviderEntry[] {
    return [...this.providers.values()];
  }

  first(): ProviderEntry | undefined {
    return this.providers.values().next().value;
  }

  /** 第一个**属于指定板块**的供应商（无类型 / 未启用类型过滤时等价于 first）。 */
  firstOfType(type?: ModelType): ProviderEntry | undefined {
    if (type === undefined || !this.typed) return this.first();
    return this.list().find((p) => p.modelType === type);
  }

  /** 是否已配置模型目录（决定「白名单路由」是否生效）。 */
  hasModels(): boolean {
    return this.models.size > 0;
  }

  allModels(): Array<ModelEntry & { providerId: string }> {
    return this.modelOrder.map((b) => ({ ...b.entry, providerId: b.providerId }));
  }

  /** 按板块筛选模型（管理台/目录下发用）。 */
  modelsOfType(type: ModelType): Array<ModelEntry & { providerId: string }> {
    return this.allModels().filter((m) => m.modelType === type);
  }

  /**
   * 按 model 名（+ 板块）解析绑定。
   *
   * 解析顺序（**越具体越优先**）：
   *   ① providerId 明确给定 → 直接查 `providerId::model`（多类型并存时最可靠）
   *   ② 类型明确给定 → 在该板块的供应商里找第一个同名模型
   *   ③ 都不给 → 顺序表第一条（保持历史行为：同名以 sort,id 在前者胜）
   * 仍然**不做前缀/模糊匹配** —— 路由必须精确，避免把请求打到错误的上游。
   */
  resolveModel(raw: string, type?: ModelType, providerId?: string): { provider: ProviderEntry; entry: ModelEntry } | undefined {
    const name = raw.trim();
    if (!name) return undefined;
    const lc = name.toLocaleLowerCase();
    // 未启用类型过滤（env 兜底）时忽略 type —— 与 firstOfType 同一口径
    const want = this.typed ? type : undefined;

    // ① 显式给了 provider → 直查双键；同时兼容 `provider/model` 复合写法
    let wantProvider = providerId?.trim();
    let bare = name;
    if (wantProvider === undefined) {
      const slash = name.indexOf("/");
      if (slash > 0) {
        wantProvider = name.slice(0, slash).trim();
        bare = name.slice(slash + 1).trim();
      }
    }
    if (wantProvider !== undefined && wantProvider !== "") {
      const hit = this.models.get(modelKey(wantProvider, bare)) ?? this.models.get(modelKey(wantProvider, lc));
      if (hit) {
        const provider = this.providers.get(hit.providerId);
        if (provider) return { provider, entry: hit.entry };
      }
    }

    // ②/③ 在候选集合里按大小写不敏感找第一个命中
    const candidates = this.modelOrder.filter((b) => {
      if (want !== undefined && b.entry.modelType !== want) return false;
      const provider = this.providers.get(b.providerId);
      if (!provider) return false;
      if (want !== undefined && provider.modelType !== want) return false;
      return true;
    });
    const exact = candidates.find((b) => b.entry.model === name);
    const loose = candidates.find((b) => b.entry.model.toLocaleLowerCase() === lc);
    const picked = exact ?? loose;
    if (!picked) return undefined;
    const provider = this.providers.get(picked.providerId);
    return provider ? { provider, entry: picked.entry } : undefined;
  }
}

/** 模型目录的双键：providerId 与 model 都做大小写归一（上游大小写不敏感）。 */
function modelKey(providerId: string, model: string): string {
  return `${providerId.trim().toLocaleLowerCase()}::${model.trim().toLocaleLowerCase()}`;
}

export function createDefaultRegistry(config: {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
}): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({
    id: "tokenrhythm",
    name: "TokenRhythm",
    baseUrl: config.upstreamBaseUrl,
    apiKey: config.upstreamApiKey,
    // env 兜底路径与历史行为一致：入站什么形态就发什么形态，无自定义头
    api: "auto",
    headers: {},
    // env 兜底（无管理台数据域时的 M0 形态）：只有对话一条链路，归 chat
    modelType: "chat",
  });
  return registry;
}

/**
 * 从库构建（T3-4）：查询 enabled 的 ai_providers，apiKey 取 bind secret（解密后）的 apiKey。
 *
 * 护栏：baseUrl 或 apiKey 为空的 provider **不注册**——历史上 seed 曾在无 .env 的进程里跑过，
 * 落成「空密钥 + 错误域名」，若照单注册会让网关拿空密钥打上游。库为空/出错/全被护栏拒 → 返回 fallback。
 */
export async function createRegistryFromDb(
  db: IdentityDb,
  fallback: ProviderRegistry,
  opts: { secretKey?: Buffer | null } = {},
): Promise<ProviderRegistry> {
  try {
    const { rows } = await db.pool.query<{
      code: string;
      name: string | null;
      base_url: string | null;
      api: string | null;
      headers: unknown;
      model_type: string | null;
      field_values: Record<string, unknown> | null;
      template_fields: unknown;
    }>(
      `SELECT p.code, p.name, p.base_url, p.api, p.headers, p.model_type, s.field_values, t.fields AS template_fields
       FROM ai_providers p
       LEFT JOIN secrets s ON s.id = p.bind_secret_id
       LEFT JOIN secret_templates t ON t.key = s.template_key
       WHERE p.enabled AND (s.enabled IS DISTINCT FROM false)
       ORDER BY p.sort, p.id`,
    );
    const registry = new ProviderRegistry();
    for (const r of rows) {
      let fv: Record<string, unknown> = {};
      try {
        fv = openFields(r.field_values ?? {}, r.template_fields, opts.secretKey ?? null);
      } catch {
        // 解密失败（密钥轮换/主密钥缺失）→ 跳过该 provider，交给 fallback，不静默用错密钥
        console.warn(`[registry] provider ${r.code} 密钥解密失败，已跳过`);
        continue;
      }
      const baseUrl = r.base_url || (typeof fv.baseUrl === "string" ? fv.baseUrl : "");
      const apiKey = typeof fv.apiKey === "string" ? fv.apiKey : "";
      if (!baseUrl || !apiKey) {
        console.warn(`[registry] provider ${r.code} 配置不完整（baseUrl/apiKey 为空），已跳过`);
        continue;
      }
      const headersParsed = parseHeaders(r.headers);
      registry.register({
        id: r.code,
        name: r.name ?? r.code,
        baseUrl,
        apiKey,
        api: normalizeApi(r.api),
        headers: "headers" in headersParsed ? headersParsed.headers : {},
        // 历史行（该列默认 'chat'）自动落对话板块，不改变既有语义
        modelType: normalizeModelType(r.model_type),
      });
    }

    // 模型目录：只登记「provider 已通过护栏」的模型，避免悬空绑定
    const { rows: modelRows } = await db.pool.query<{
      code: string;
      model: string;
      display_name: string | null;
      model_type: string | null;
      features: unknown;
      max_context: number | null;
      max_output: number | null;
      pricing: unknown;
      currency: string | null;
      /** 建库时钉住的参数（JSONB）；当前用于 rerank 的向量维度等 */
      params: unknown;
      scope_kind: string | null;
      scope_roles: string[] | null;
      scope_dept_ids: number[] | null;
      scope_uids: string[] | null;
    }>(
      `SELECT p.code, m.model, m.display_name, m.model_type, m.features, m.max_context, m.max_output, m.pricing, m.currency,
              m.params, m.scope_kind, m.scope_roles, m.scope_dept_ids, m.scope_uids
       FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.enabled AND p.enabled
       ORDER BY m.sort, m.id`,
    );
    for (const m of modelRows) {
      if (typeof m.model !== "string" || !m.model.trim()) continue;
      registry.registerModel(m.code, {
        model: m.model,
        displayName: m.display_name,
        modelType: normalizeModelType(m.model_type),
        features: Array.isArray(m.features) ? m.features.filter((f): f is string => typeof f === "string") : [],
        maxContext: m.max_context,
        maxOutput: m.max_output,
        pricing: normalizePricing(m.pricing),
        currency: m.currency ?? null,
        ...(m.params !== null && typeof m.params === "object" ? { params: m.params as Record<string, unknown> } : {}),
        scope: {
          kind: m.scope_kind ?? "all",
          roles: Array.isArray(m.scope_roles) ? m.scope_roles.filter((r): r is string => typeof r === "string") : [],
          deptIds: Array.isArray(m.scope_dept_ids) ? m.scope_dept_ids.filter((n): n is number => Number.isInteger(n)) : [],
          uids: Array.isArray(m.scope_uids) ? m.scope_uids.filter((u): u is string => typeof u === "string") : [],
        },
      });
    }

    // 库驱动的注册表才启用类型过滤（见 ProviderRegistry.typed 头上的原因）
    registry.markTyped();
    return registry.list().length === 0 ? fallback : registry;
  } catch (err) {
    console.warn(`[registry] 从库加载 provider 失败，回退 env：${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/** 一次请求的上游解析结果。 */
export type ProviderResolution =
  | {
      ok: true;
      provider: ProviderEntry;
      /** 命中的模型（未配置模型目录时为 null） */
      model: ModelEntry | null;
      /** 模型目录是否已配置（true 时为白名单路由） */
      curated: boolean;
    }
  | { ok: false; reason: "no-provider" | "model-not-found"; available: string[] };

/**
 * 从注册表解析目标上游。语义（重要，勿悄悄改）：
 *   · 无可用 provider                          → no-provider（网关返回 503）
 *   · 未配置模型目录（ai_models 为空）         → 沿用 M0 行为，走第一个 provider（兼容期）
 *   · 已配置模型目录 + 请求带 model 且命中     → 打到该模型所属 provider
 *   · 已配置模型目录 + 请求带 model 但未命中   → model-not-found（网关返回 404，白名单语义）
 *   · 已配置模型目录 + 请求未带 model          → 兜底第一个 provider
 */
function resolveFromRegistry(
  registry: ProviderRegistry,
  model?: string,
  type?: ModelType,
  providerCode?: string,
): ProviderResolution {
  // 类型只在库驱动的注册表里有意义（env 兜底单上游没有板块概念）——口径集中在注册表内部
  const want = registry.typedEnabled ? type : undefined;
  const first = registry.firstOfType(want);
  if (!first) return { ok: false, reason: "no-provider", available: [] };
  if (!registry.hasModels()) return { ok: true, provider: first, model: null, curated: false };
  const wanted = model?.trim();
  if (!wanted) return { ok: true, provider: first, model: null, curated: true };
  const hit = registry.resolveModel(wanted, want, providerCode);
  if (hit) return { ok: true, provider: hit.provider, model: hit.entry, curated: true };
  // 白名单报错要给**本板块**的可选清单：跨板块列出一堆向量模型名只会让排查更糊涂
  const available =
    want === undefined ? registry.allModels().map((m) => m.model) : registry.modelsOfType(want).map((m) => m.model);
  return { ok: false, reason: "model-not-found", available };
}

/** 上游来源：网关按请求（含 model）向它解析当前生效的 provider。 */
export interface ProviderSource {
  /**
   * 解析目标上游。
   *
   * `type` 是**链路身份**，不是建议值：embeddings 链路只能落到向量板块的供应商、
   * rerank 链路只能落到重排板块 —— 否则会把请求发到一个不提供该能力的上游，
   * 得到一个看不懂的上游报错（而不是一句「未配置向量模型」）。
   */
  resolve(model?: string, type?: ModelType, providerCode?: string): Promise<ProviderResolution>;
  /** 目录：curated=true 表示来自管理台（ai_models），false 表示需回退上游拉取。 */
  models(type?: ModelType): Promise<{ curated: boolean; models: Array<ModelEntry & { providerId: string }> }>;
  /** 供日志/健康检查展示当前来源。 */
  describe(): string;
}

/** env 单上游（M0 形态 / 无 db 时兜底）。 */
export function createEnvProviderSource(registry: ProviderRegistry): ProviderSource {
  return {
    async resolve(model, type) {
      return resolveFromRegistry(registry, model, type);
    },
    async models() {
      return { curated: false, models: [] };
    },
    describe: () => "env",
  };
}

/**
 * T3-4：以库为准、带 TTL 热生效的 provider + 模型目录来源。
 * 改动管理台配置后，最多一个 TTL 周期内自动生效，无需重启网关。
 */
export function createDbProviderSource(
  db: IdentityDb,
  fallback: ProviderRegistry,
  opts: { secretKey?: Buffer | null; ttlMs?: number } = {},
): ProviderSource {
  const ttlMs = opts.ttlMs ?? 10_000;
  let current: ProviderRegistry | null = null;
  let loadedAt = 0;
  let inflight: Promise<void> | null = null;

  const load = async (): Promise<void> => {
    current = await createRegistryFromDb(db, fallback, { secretKey: opts.secretKey ?? null });
    loadedAt = Date.now();
  };

  const fresh = async (): Promise<ProviderRegistry> => {
    if (!current || Date.now() - loadedAt >= ttlMs) {
      inflight ??= load().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return current ?? fallback;
  };

  return {
    async resolve(model, type, providerCode) {
      return resolveFromRegistry(await fresh(), model, type, providerCode);
    },
    async models(type) {
      const registry = await fresh();
      if (type === undefined || !registry.typedEnabled) return { curated: registry.hasModels(), models: registry.allModels() };
      return { curated: registry.hasModels(), models: registry.modelsOfType(type) };
    },
    describe: () => `db(ttl=${ttlMs}ms)`,
  };
}
