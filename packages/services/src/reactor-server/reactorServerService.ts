import { isReactorServerManagedApiKey, type ApiClient } from "@zcode/shared";
import type { ModelId, ProviderConfigObject, ProviderId } from "@zcode/provider";
import type { ICredentialService } from "../credential/credential.js";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { writeZCodeDataScopeMarker } from "../userDataScope.js";
import type { BehaviorAuditFact, ModelCallUsageDelta } from "./auditEventMapping.js";
import { createReactorServerP4Wiring } from "./reactorServerP4Wiring.js";
import {
  createReactorServerClient,
  deriveGatewayBaseUrl,
  normalizeReactorServerUrl,
  ReactorServerHttpError,
  type ReactorServerModelInfo,
} from "./reactorServerClient.js";
import { buildGatewayModelConfig } from "./gatewayModelConfig.js";
import {
  REACTOR_SERVER_API_KEY_PLACEHOLDER,
  REACTOR_SERVER_CREDENTIAL_KEYS,
  REACTOR_SERVER_PROVIDER_NAME,
  type IReactorServerService,
  type ReactorServerLoginInput,
  type ReactorServerRequestAuth,
  type ReactorServerStatus,
  type ReactorServerUserInfo,
} from "./reactorServer.js";

const logger = createServiceLogger("reactorServerService");

/** access 剩余不足该时长就先刷新；服务端也会在 <5min 时回 `x-new-token`，两边留有余量。 */
const ACCESS_REFRESH_MARGIN_MS = 5 * 60_000;
/** 网关令牌剩余不足该时长就先换新的（它 TTL 短，且每次模型请求都要用）。 */
const GATEWAY_REFRESH_MARGIN_MS = 60_000;

interface CachedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

interface CachedGatewayToken {
  token: string;
  expiresAt: number;
}

export interface CreateReactorServerServiceOptions {
  readonly apiClient: ApiClient;
  readonly credentials: ICredentialService;
  readonly providerSettings: IProviderSettingsService;
  /** 注入时钟便于测试（缺省 `Date.now`）。 */
  readonly now?: () => number;
  /**
   * 登录成功且模型目录已写入企业 provider 之后触发——此时 `reactor:providerId` 必然存在，
   * 是服务端技能/Agent 后台同步的正确时机（P3 计划 U-P3-2 的时序保证）。
   * **fire-and-forget**：钩子失败只记日志，绝不阻断登录。
   */
  readonly onLoginSuccess?: () => unknown;
  /** 登出本地清理完成后触发（P3：清空 `server-agents/`）。失败不阻断登出。 */
  readonly onLogout?: () => unknown;
  /**
   * 会话流用量事件源（P4.1b）：Host 装配注入（订阅 CLI 的 `usage.delta` 事实）。
   * 缺省 = 不上报（只保留 outbox/flush 语义，供探针与测试）。
   */
  readonly subscribeUsageDelta?: (listener: (delta: ModelCallUsageDelta) => void) => () => void;
  /**
   * 行为审计事实源（洞②）：Host 装配注入（订阅 CLI 的 `tool.lifecycle` / `permission.lifecycle` 事实）。
   * 缺省 = 不上报行为事件（与 subscribeUsageDelta 同口径，供探针与测试）。
   */
  readonly subscribeAuditFacts?: (listener: (fact: BehaviorAuditFact) => void) => () => void;
  /** outbox 落盘路径（缺省 `{用户数据根}/audit-outbox.jsonl`；测试注入临时目录）。 */
  readonly auditOutboxPath?: string;
  /** 策略缓存路径（缺省 `{用户数据根}/desktop-policy.json`；测试注入临时目录）。 */
  readonly policyFilePath?: string;
  /** 上报合并窗口（缺省 30s）与定时兜底（缺省 5min）；测试注入短窗口以便确定性断言。 */
  readonly auditFlushDebounceMs?: number;
  readonly auditFlushIntervalMs?: number;
  /**
   * 构造后是否自动补一次启动态：已登录则拉策略 + 挂用量事件源，未登录则清空策略缓存。
   * 缺省 true；测试可关掉以避免后台网络。
   */
  readonly bootstrapOnStart?: boolean;
}

/** 从 JWT payload 读取 exp（不验签：只用于本地"该不该刷新"的判断）。 */
function readJwtExpiryMs(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function createReactorServerService(
  options: CreateReactorServerServiceOptions,
): IReactorServerService {
  const { credentials, providerSettings } = options;
  const client = createReactorServerClient(options.apiClient);
  const now = options.now ?? (() => Date.now());

  let cachedTokens: CachedTokens | null = null;
  let cachedGateway: CachedGatewayToken | null = null;
  /** `undefined` = 尚未从凭据读取；`null` = 确实没有。 */
  let cachedProviderId: string | null | undefined;
  let cachedModels: readonly string[] = [];
  let lastError: string | null = null;

  // ── P4：用量上报（P4.1）与组织策略（P4.2b）都在服务内闭环 ──
  // 为什么由服务持有而不是让 node.ts 直接调 bridge：outbox 的入队/peek/ack 是 Host 内部语义，
  // 暴露成公开方法就等于给 Renderer 开了第二条写路径（P4 文档 §4.2）。
  // 装配细节收在 reactorServerP4Wiring.ts，这里只保留"何时喊一声"（登录/登出/启动）。
  const p4 = createReactorServerP4Wiring({
    client,
    credentials,
    hasUsableSession,
    ensureAccessToken,
    readManagedProviderEntry,
    isManagedProvider,
    resolveDirectBaseUrl,
    ...(options.subscribeUsageDelta ? { subscribeUsageDelta: options.subscribeUsageDelta } : {}),
    ...(options.subscribeAuditFacts ? { subscribeAuditFacts: options.subscribeAuditFacts } : {}),
    ...(options.auditOutboxPath !== undefined ? { auditOutboxPath: options.auditOutboxPath } : {}),
    ...(options.policyFilePath !== undefined ? { policyFilePath: options.policyFilePath } : {}),
    ...(options.auditFlushDebounceMs !== undefined
      ? { auditFlushDebounceMs: options.auditFlushDebounceMs }
      : {}),
    ...(options.auditFlushIntervalMs !== undefined
      ? { auditFlushIntervalMs: options.auditFlushIntervalMs }
      : {}),
    logger,
  });

  function toUserInfo(user: {
    uid: string;
    name: string;
    role: string;
    dept?: { id: number; path?: string } | null;
    mustChangePassword?: boolean;
  }): ReactorServerUserInfo {
    return {
      uid: user.uid,
      name: user.name,
      role: user.role,
      deptId: user.dept?.id ?? null,
      deptPath: user.dept?.path ?? null,
      // 旧版本服务端不下发该字段 → 兜底 false（不兜底会让 UI 收到 undefined，
      // 而 `undefined` 在条件判断里与 false 等价但类型上骗过了契约）。
      mustChangePassword: user.mustChangePassword ?? false,
    };
  }

  async function readUser(): Promise<ReactorServerUserInfo | null> {
    const raw = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.user);
    if (!raw) return null;
    try {
      // 兜底同上：本机可能存着升级前写入的旧 user JSON（没有该字段）。
      const parsed = JSON.parse(raw) as ReactorServerUserInfo;
      return { ...parsed, mustChangePassword: parsed.mustChangePassword ?? false };
    } catch {
      return null;
    }
  }

  async function persistTokens(
    accessToken: string,
    refreshToken: string,
    latestAccess?: string,
  ): Promise<void> {
    const access = latestAccess ?? accessToken;
    cachedTokens = {
      accessToken: access,
      refreshToken,
      accessExpiresAt: readJwtExpiryMs(access),
    };
    await credentials.save(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken, access);
    await credentials.save(REACTOR_SERVER_CREDENTIAL_KEYS.refreshToken, refreshToken);
  }

  async function loadTokens(): Promise<CachedTokens | null> {
    if (cachedTokens) return cachedTokens;
    const accessToken = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.accessToken);
    const refreshToken = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.refreshToken);
    if (!accessToken || !refreshToken) return null;
    cachedTokens = { accessToken, refreshToken, accessExpiresAt: readJwtExpiryMs(accessToken) };
    return cachedTokens;
  }

  async function clearSession(): Promise<void> {
    cachedTokens = null;
    cachedGateway = null;
    cachedProviderId = undefined;
    cachedModels = [];
    for (const key of [
      REACTOR_SERVER_CREDENTIAL_KEYS.accessToken,
      REACTOR_SERVER_CREDENTIAL_KEYS.refreshToken,
      REACTOR_SERVER_CREDENTIAL_KEYS.user,
    ]) {
      await credentials.delete(key);
    }
  }

  async function hasUsableSession(): Promise<boolean> {
    const tokens = await loadTokens();
    return Boolean(tokens && tokens.accessExpiresAt > now());
  }

  /**
   * 取得有效 access。过期就用 refresh 换（**滚动轮换**，必须存回新的 refresh）。
   * refresh 也失效时清空会话并把原因写进 lastError —— 绝不静默降级成直连上游。
   */
  async function ensureAccessToken(serverUrl: string): Promise<string> {
    const tokens = await loadTokens();
    if (!tokens) throw new Error("尚未登录企业服务端");
    if (tokens.accessExpiresAt - now() > ACCESS_REFRESH_MARGIN_MS) return tokens.accessToken;
    try {
      const refreshed = await client.refresh(serverUrl, tokens.refreshToken);
      await persistTokens(refreshed.accessToken, refreshed.refreshToken);
      lastError = null;
      return refreshed.accessToken;
    } catch (error) {
      lastError =
        error instanceof ReactorServerHttpError && error.isUnauthorized
          ? "企业登录已过期，请重新登录"
          : `刷新企业登录失败：${error instanceof Error ? error.message : String(error)}`;
      await clearSession();
      throw new Error(lastError, { cause: error });
    }
  }

  async function ensureGatewayToken(serverUrl: string): Promise<string> {
    if (cachedGateway && cachedGateway.expiresAt - now() > GATEWAY_REFRESH_MARGIN_MS) {
      return cachedGateway.token;
    }
    const accessToken = await ensureAccessToken(serverUrl);
    const result = await client.gatewayToken(serverUrl, accessToken);
    if (result.renewedAccessToken) {
      const current = await loadTokens();
      if (current) {
        await persistTokens(current.accessToken, current.refreshToken, result.renewedAccessToken);
      }
    }
    cachedGateway = { token: result.token, expiresAt: now() + result.expiresIn * 1000 };
    return cachedGateway.token;
  }

  async function readManagedProviderId(): Promise<string | null> {
    if (cachedProviderId !== undefined) return cachedProviderId;
    cachedProviderId = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.providerId);
    return cachedProviderId;
  }

  /**
   * 读回企业 provider 的当前条目。按记录在凭据里的 id 查，不按 baseUrl 猜：
   * 用户如果把地址改成别的值，我们仍应认得出"这是我们的条目"。
   * 返回 null 表示条目已被用户删除（此时不重建，等下次登录/同步再决定）。
   */
  async function readManagedProviderEntry(): Promise<{
    providerId: string;
    config: ProviderConfigObject;
  } | null> {
    const providerId = await readManagedProviderId();
    if (!providerId) return null;
    const view = await providerSettings.getView();
    const provider = view.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) return null;
    // personalConfig 才是我们写的那一层；纯个人 provider 上两者等价，但读前者更贴合语义。
    return { providerId, config: provider.personalConfig ?? provider.effectiveConfig };
  }

  /** 该 provider 下已配置的个人模型 id（只有 personalConfig 里的这批是我们可改的）。 */
  async function readPersonalModelIds(providerId: string): Promise<readonly string[]> {
    const view = await providerSettings.getView();
    const provider = view.providers.find((candidate) => candidate.providerId === providerId);
    return provider?.personalConfig?.personalModelIds ?? [];
  }

  /**
   * 把企业 provider 的模型清单对齐到服务端下发的目录。
   *
   * **为什么不能只把 `personalModelIds` 写进 overlay**：`savePersonalProviderOverlay` 会用
   * 「当前已存配置的模型成员关系」覆盖 config 里的 `personalModelIds`（见 `config-service.ts`
   * 的 `normalizePersonalProviderMembership` 与 `withModelMembershipFrom`），写下去会被丢掉。
   * 真机验证时正是这一条：provider 条目、名称、baseUrl、哨兵密钥全部正确落盘，模型清单却是空的，
   * 聊天里也选不到企业模型。模型必须走 `addPersonalModel` / `deletePersonalModel` 这组领域操作。
   */
  /**
   * 把单条网关模型的配置刷成本次下发的值。
   *
   * **为什么单独抽出来**：`addPersonalModel` 对已存在的模型会直接 throw（见 config-service.ts），
   * 所以历史实现只能在 reconcile 里 `continue` 跳过——结果是端侧永远停在**首次登录时**那份配置，
   * 管理员后来改的上下文窗口/最大输出/多模态/推理档位一律不生效（2026-10-14 修复）。
   * 走草稿保存而不是"删了再建"：后者会丢掉用户自己排的模型顺序，且中间态会被 UI 看到。
   *
   * 服务端是模型能力的唯一事实源，因此这里**覆盖**端侧可能存在的本地改动；
   * 这与新增路径传真实配置是同一条口径（见 buildGatewayModelConfig 注释）。
   */
  async function refreshGatewayModelConfig(
    providerId: string,
    model: ReactorServerModelInfo,
  ): Promise<void> {
    /*
     * revision 必须现取：savePersonalModelDraft 带乐观锁，同一轮 reconcile 里
     * 上一条模型的写入已经让快照 revision 前进，复用旧值会必然冲突。
     */
    const view = await providerSettings.getView();
    await providerSettings.savePersonalModelDraft({
      providerId: providerId as ProviderId,
      originalModelId: model.id as ModelId,
      // 模型 id 由服务端目录决定，端侧不允许改名
      nextModelId: model.id as ModelId,
      personalConfig: buildGatewayModelConfig(model),
      basedOnRevision: view.revision,
      /*
       * 不传 useRecommendedConfig：传 true 会把规则类型从 manual-provider-model 改写成
       * provider-model（推荐规则），让"恢复推荐配置"之类的操作有机会把它冲掉；
       * 传 false 则相反。缺省值保持模型原有类型，只更新配置内容本身。
       */
    });
  }

  async function reconcileProviderModels(
    providerId: string,
    desiredModels: readonly ReactorServerModelInfo[],
  ): Promise<void> {
    const desired = new Set(desiredModels.map((m) => m.id));
    const current = await readPersonalModelIds(providerId);
    const currentSet = new Set(current);
    let added = 0;
    let updated = 0;
    let removed = 0;
    for (const model of desiredModels) {
      if (currentSet.has(model.id)) {
        /*
         * 已存在也要刷新：2026-10-14 前这里是 `continue`（防御 addPersonalModel 抛
         * "Model 已存在"），但服务端改了模型能力后端侧永不更新，表现为
         * 「在服务端配好的上下文/多模态，桌面端还是默认初始状态」。
         * 单条失败不阻断整轮同步：其余模型的增删照常完成，失败只记日志。
         */
        try {
          await refreshGatewayModelConfig(providerId, model);
          updated += 1;
        } catch (error) {
          logger.warn(undefined, "刷新企业模型配置失败（不影响本轮其它模型）", {
            modelId: model.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      /*
       * 用网关下发的真实能力构造 ModelConfig（上下文窗口 / 最大输出 / 多模态 / 推理档位）。
       * 2026-10-13 前这里传的是空对象 `{}`，注释称"由 provider 侧推荐配置补齐"，
       * 但网关 provider 并没有这些元数据 —— 结果桌面端只能兜底推断，表现为
       * 上下文/最大输出与管理台不同步、管理台标了多模态端侧不认、打开思考就 400。
       * 见 docs/未完成-网关模型能力同步桌面端-方案-v1.md。
       */
      await providerSettings.addPersonalModel(
        providerId as ProviderId,
        model.id as ModelId,
        buildGatewayModelConfig(model),
        true,
      );
      added += 1;
    }
    for (const modelId of current) {
      if (desired.has(modelId)) continue;
      await providerSettings.deletePersonalModel(providerId as ProviderId, modelId as ModelId);
      removed += 1;
    }
    if (added > 0 || removed > 0 || updated > 0) {
      logger.info(undefined, "企业模型清单已对齐服务端目录", { added, updated, removed });
    }
  }

  /**
   * 找到或创建企业 provider，并把模型清单写进去。
   *
   * 识别方式是 **baseUrl 等于本服务端网关基址**，而非固定 provider id：
   * `createPersonalProvider` 的 id 由配置服务生成、客户端无权指定，写死 id 等于依赖一个不属于我们的约定。
   * 找到后把 id 记进凭据，模型请求的热路径据此做 O(1) 判断。
   */
  /**
   * 找到或创建**指定 baseUrl** 的托管 provider 并写入配置（不回填模型）。
   *
   * 为什么按 baseUrl 而不是固定 provider id 识别：`createPersonalProvider` 的 id 由配置服务生成，
   * 客户端无权指定，写死 id 等于依赖一个不属于我们的约定（原有网关 provider 同理）。
   */
  async function ensureManagedProvider(
    baseUrl: string,
    providerName: string,
    /**
     * 2026-10-29：网关 provider 在「没有任何经网关转发的模型」时置 hidden。
     * hidden 只影响模型选择列表（model-selection-config / resolver 均跳过 hidden），
     * 不影响凭据里的 providerId —— 授权层与网关令牌换发仍靠它定位。
     */
    visibility: "visible" | "hidden" = "visible",
  ): Promise<string> {
    const view = await providerSettings.getView();
    const mine = view.providers.filter((provider) => provider.personalConfig !== undefined);
    const existing = mine.find(
      (provider) => provider.effectiveConfig.api?.baseUrl === baseUrl,
    );
    const providerId = existing
      ? existing.providerId
      : (await providerSettings.createPersonalProvider({ providerName })).providerId;
    // 这里不写 personalModelIds：它会被成员关系覆盖（见 reconcileProviderModels 注释），
    // 写上只会让人误以为模型清单由这里决定。
    const config: ProviderConfigObject = {
      group: "standard-personal",
      access: { type: "api-key", apiKey: REACTOR_SERVER_API_KEY_PLACEHOLDER },
      api: { type: "openai-chat-completions", baseUrl },
      visibility,
    };
    await providerSettings.savePersonalProviderOverlay(providerId as ProviderId, config, {
      providerName,
    });
    return providerId;
  }

  async function writeEnterpriseProvider(
    gatewayBaseUrl: string,
    models: readonly ReactorServerModelInfo[],
  ): Promise<void> {
    /*
     * 2026-10-29：没有非直连模型时把网关 provider 置为 hidden。
     *
     * 反例（本次修复前）：所有供应商都配了 direct_base_url，网关 provider 仍以 visible 存在，
     * 模型数为 0，用户在模型下拉里看到一个空的「Reactor 企业服务端」，误以为是另一个服务端；
     * 叠加直连分组后就是"三个分组、模型名还一样、不知道该选哪个"。
     *
     * 不能直接删除：这条记录是登录凭据里 providerId 的锚点，授权层与网关令牌换发都依赖它。
     * 只调可见性，服务端恢复非直连模型后下一次 sync 会自动回到 visible，是可逆的。
     */
    const providerId = await ensureManagedProvider(
      gatewayBaseUrl,
      REACTOR_SERVER_PROVIDER_NAME,
      models.length > 0 ? "visible" : "hidden",
    );
    cachedProviderId = providerId;
    await credentials.save(REACTOR_SERVER_CREDENTIAL_KEYS.providerId, providerId);
    await reconcileProviderModels(providerId, models);
  }

  /** 直连 provider 的显示名基名：与网关分区分组，但不让人误以为是另一个服务端。 */
  const DIRECT_PROVIDER_NAME = `${REACTOR_SERVER_PROVIDER_NAME} · 直连`;

  /**
   * 为某个直连地址生成**唯一**的 provider 显示名（2026-10-29 修复）。
   *
   * 反例（修复前的真实缺陷）：所有直连地址共用 `DIRECT_PROVIDER_NAME`。
   * 当服务端配了 ≥2 个直连地址（例如 qwen 与 deepseek 各自直连）时，
   * 第二个地址新建 provider 后要改成同名 → 触发 ProviderConfigService 的
   * 名称唯一性校验 `Provider 名称已存在` → syncModels 抛错 → 登录界面报失败。
   * 实测：登录凭据其实早已落盘（token 在此之前就保存了），只是模型清单没写进去。
   *
   * 取名规则：取 baseUrl 路径里最后一个非 `v1`/`v2` 段（上游聚合服务习惯用
   * `/<模型组>/v1`），没有则退回 hostname。地址相同时本来就复用同一 provider，
   * 不会进到这里，所以无需再拼接完整 URL。
   */
  function directProviderName(baseUrl: string, providerName?: string | null): string {
    /*
     * 2026-10-29：优先用管理台里的供应商名。
     * 员工对「Qwen（本部）」有认知，对 URL 派生的「qwen_medium」没有 —— 后者只在
     * 老网关不下发 provider_name 时兜底，保证升级前后都能取到名字。
     */
    if (typeof providerName === "string" && providerName.trim()) {
      return `${DIRECT_PROVIDER_NAME} · ${providerName.trim()}`;
    }
    try {
      const parsed = new URL(baseUrl);
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .filter((segment) => !/^v\d+$/i.test(segment));
      // 路径无可用段时退回 host:port（不是退回基名）：否则 `http://a:1/v1` 与
      // `http://b:2/v1` 会双双退回基名而再次撞名，正是本次要看住的那类问题。
      const tail = segments[segments.length - 1] ?? parsed.host;
      return `${DIRECT_PROVIDER_NAME} · ${tail}`;
    } catch {
      // 非法 URL 不该阻断登录：退回基名，最坏情况仍是原来的行为
      return DIRECT_PROVIDER_NAME;
    }
  }

  /**
   * 为直连地址分配一个**绝不与现有 provider 冲突**的显示名（2026-10-29）。
   *
   * 为什么需要两层：`directProviderName` 只按路径末段取名，可读性最好，但
   * `a.example.com/qwen/v1` 与 `b.example.com/qwen/v1` 会取到同一个名字。
   * 而 `ProviderConfigService` 强制用户可见名称唯一（`assertProviderLabelMutationIsUnique`），
   * 撞名会抛错并把整次 syncModels（进而整次登录）带崩。
   *
   * 规则：短名 → 已被占则追加 host → 仍被占则追加序号 → 最后退回完整地址。
   * 比较口径用 `toLocaleLowerCase`，与 ProviderConfigService 的唯一性校验保持一致，
   * 否则会出现"我们以为不冲突、它判定冲突"的分歧。
   *
   * `reserved` 是本轮已分配的名字：同一次 sync 里多个地址先后创建，
   * provider 视图在第二次读之前可能还没反映第一个的结果。
   */
  async function claimDirectProviderName(
    baseUrl: string,
    reserved: ReadonlySet<string>,
    providerName?: string | null,
  ): Promise<string> {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").trim().toLocaleLowerCase();

    const view = await providerSettings.getView();
    // 该地址自己的 provider 不计入"占用"：复用场景要允许它继续用原来的名字
    const selfIds = new Set<string>(
      view.providers
        .filter(
          (provider) =>
            provider.personalConfig !== undefined &&
            provider.effectiveConfig.api?.baseUrl === baseUrl,
        )
        .map((provider) => String(provider.providerId)),
    );
    const taken = new Set<string>(reserved);
    for (const provider of view.providers) {
      if (selfIds.has(String(provider.providerId))) continue;
      const name = normalize(provider.providerName);
      if (name) taken.add(name);
    }

    const base = directProviderName(baseUrl, providerName);
    let host = "";
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = "";
    }

    const candidates: string[] = [base];
    if (host) {
      candidates.push(`${base} (${host})`);
      for (let index = 2; index <= 20; index += 1) candidates.push(`${base} (${host}) ${index}`);
    } else {
      for (let index = 2; index <= 20; index += 1) candidates.push(`${base} ${index}`);
    }
    // 最后一档用完整地址：同一地址永远复用同一个 provider，不会走到这里两次
    candidates.push(`${base} (${baseUrl})`);

    for (const candidate of candidates) {
      if (!taken.has(normalize(candidate))) return candidate;
    }
    return `${base} (${baseUrl})`;
  }

  /**
   * 回收不再需要的直连 provider 模型清单（服务端撤掉 `direct_base_url` 后调用）。
   *
   * 只清模型、**不删 provider**：删 provider 会级联丢配置，用户可能还在里面手工加过东西；
   * 清空模型后它在下拉里自然消失，下次需要时原地复用。
   */
  async function pruneStaleDirectProviders(activeBaseUrls: ReadonlySet<string>): Promise<void> {
    const view = await providerSettings.getView();
    const gatewayProviderId = await readManagedProviderId();
    for (const provider of view.providers) {
      if (provider.personalConfig === undefined) continue;
      if (provider.providerId === gatewayProviderId) continue;
      const access = provider.personalConfig.access as { apiKey?: unknown } | undefined;
      if (!isReactorServerManagedApiKey(access?.apiKey)) continue;
      const baseUrl = provider.effectiveConfig.api?.baseUrl;
      if (!baseUrl || activeBaseUrls.has(baseUrl)) continue;
      const staleModels = provider.personalConfig.personalModelIds ?? [];
      for (const modelId of staleModels) {
        await providerSettings.deletePersonalModel(
          provider.providerId as ProviderId,
          modelId as ModelId,
        );
      }
      if (staleModels.length > 0) {
        logger.info(undefined, "已回收不再直连的企业 provider 模型", {
          providerId: provider.providerId,
          baseUrl,
          removed: staleModels.length,
        });
      }
    }
  }

  /** 全部托管 provider（网关 + 各直连）的模型 id 合并，供重启后的状态兜底。 */
  async function readAllManagedModelIds(): Promise<readonly string[]> {
    const view = await providerSettings.getView();
    const ids: string[] = [];
    for (const provider of view.providers) {
      if (provider.personalConfig === undefined) continue;
      const access = provider.personalConfig.access as { apiKey?: unknown } | undefined;
      if (!isReactorServerManagedApiKey(access?.apiKey)) continue;
      ids.push(...(provider.personalConfig.personalModelIds ?? []));
    }
    return ids;
  }

  /**
   * 该 provider 是否由本服务托管（网关 provider 或任一集团直连 provider）。
   *
   * 判据是**哨兵 apiKey**，与 baseUrl 无关：这样新增直连 provider 时，
   * 用量上报的过滤条件不需要跟着维护一张地址表（漏一处就会漏统计）。
   */
  async function isManagedProvider(providerId: string): Promise<boolean> {
    const view = await providerSettings.getView();
    const provider = view.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) return false;
    const access = provider.personalConfig?.access as { apiKey?: unknown } | undefined;
    return isReactorServerManagedApiKey(access?.apiKey);
  }

  /**
   * 该 provider 若是「直连」条目，返回其上游地址（2026-10-22）。
   *
   * 判据：托管 provider 只有两类 —— 网关 provider（baseUrl = `deriveGatewayBaseUrl`）
   * 与各直连 provider（baseUrl = 上游地址）。所以「是托管的 且 地址不是网关」即直连。
   *
   * 为什么必须区分：直连请求不过网关，网关侧不会写计量账本；只有端侧在用量事件里
   * 带上这个地址，服务端才能补记，否则直连流量的报表与部门额度会整体漏计。
   * 经网关转发的调用返回 null —— 网关已经记过账，再补就是重复计费。
   */
  async function resolveDirectBaseUrl(providerId: string): Promise<string | null> {
    const view = await providerSettings.getView();
    const provider = view.providers.find((candidate) => candidate.providerId === providerId);
    if (!provider) return null;
    // 与 isManagedProvider 同判据：先确认是本服务托管的条目，用户自建 provider 不进企业账本
    const access = provider.personalConfig?.access as { apiKey?: unknown } | undefined;
    if (!isReactorServerManagedApiKey(access?.apiKey)) return null;
    // 地址在 `api.baseUrl`（与 ensureManagedProvider 写入、pruneStaleDirectProviders 读取同路径）
    const baseUrl = provider.personalConfig?.api?.baseUrl ?? provider.effectiveConfig?.api?.baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    if (!serverUrl) return null;
    return baseUrl === deriveGatewayBaseUrl(serverUrl) ? null : baseUrl;
  }

  async function syncModels(): Promise<readonly string[]> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    if (!serverUrl) return [];
    const gatewayToken = await ensureGatewayToken(serverUrl);
    const gatewayBaseUrl = deriveGatewayBaseUrl(serverUrl);
    const models = await client.models(gatewayBaseUrl, gatewayToken);
    // 只把 chat 板块写进可选清单：embedding/rerank 不是会话模型，混进下拉会让用户选到"一发就 400"的条目。
    const chatModels = models.filter(
      (model) => model.modelType === null || model.modelType === "chat",
    );
    /*
     * 2026-10-22：按 `direct_base_url` 分组。
     *
     * 空 → 照旧写进网关 provider（流量经服务器转发）；
     * 非空 → 为**该地址**单独建一个 provider，端侧直接连上游，出口 IP 变成用户自己的机器。
     *
     * 为什么按地址分组而不是每个模型一个 provider：provider 是 baseUrl 级语义，
     * 同地址的模型必须共用一个 provider，否则模型下拉会被拆成几十个分组。
     * 为什么不做"非直连也直连"：只有被限并发的上游才需要，其余的经网关能保留统一限流与审计。
     */
    const directGroups = new Map<string, ReactorServerModelInfo[]>();
    for (const model of chatModels) {
      if (model.directBaseUrl && model.directBaseUrl !== gatewayBaseUrl) {
        const list = directGroups.get(model.directBaseUrl);
        if (list) list.push(model);
        else directGroups.set(model.directBaseUrl, [model]);
      }
    }
    /*
     * 同名模型直连优先（2026-10-29）。
     *
     * 反例：聚合平台与官方供应商都有 `deepseek-v4-flash`，一个配了直连、一个走网关，
     * 下拉里出现两个同名条目，用户不知道该选哪个。
     * 规则：直连组已占用的模型 id，网关组不再重复下发。
     * 取舍：该模型此后只能走直连地址；若该地址在员工机器上不可达，这个模型就不可用，
     * 需要管理员在管理台撤掉该供应商的直连地址才会回落到网关。
     */
    const directModelIds = new Set<string>();
    for (const list of directGroups.values()) {
      for (const model of list) directModelIds.add(model.id);
    }
    const gatewayModels: ReactorServerModelInfo[] = [];
    let shadowedByDirect = 0;
    for (const model of chatModels) {
      if (model.directBaseUrl && model.directBaseUrl !== gatewayBaseUrl) continue;
      if (directModelIds.has(model.id)) {
        shadowedByDirect += 1;
        continue;
      }
      gatewayModels.push(model);
    }
    if (shadowedByDirect > 0) {
      logger.info(undefined, "同名模型直连优先，网关组已剔除重复条目", { count: shadowedByDirect });
    }

    await writeEnterpriseProvider(gatewayBaseUrl, gatewayModels);
    /*
     * 每个直连地址单独一个 provider，名字必须互不冲突（见 claimDirectProviderName）。
     * 单个地址失败只跳过它、不抛给调用方：直连是"绕开上游 IP 限流"的优化，
     * 不该因为一个地址配错就让整次登录失败——那些模型仍可经网关使用。
     */
    const reservedDirectNames = new Set<string>();
    for (const [baseUrl, list] of directGroups) {
      try {
        // 分组名优先取该组第一个模型的供应商名；同 baseUrl 被多个供应商共用时取第一个
        const providerName = list[0]?.providerName ?? null;
        const name = await claimDirectProviderName(baseUrl, reservedDirectNames, providerName);
        reservedDirectNames.add(name.trim().toLocaleLowerCase());
        const providerId = await ensureManagedProvider(baseUrl, name);
        await reconcileProviderModels(providerId, list);
      } catch (error) {
        logger.warn(undefined, "直连 provider 准备失败，该地址的模型本次不下发", {
          baseUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 服务端撤掉直连配置后，端侧必须跟着回收：否则下拉里会留下"能选但打不通"的旧条目。
    await pruneStaleDirectProviders(new Set(directGroups.keys()));

    cachedModels = chatModels.map((model) => model.id);
    return cachedModels;
  }

  async function getStatus(): Promise<ReactorServerStatus> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    // 进程刚启动时内存缓存是空的，但企业 provider 里早已写好模型清单。
    // 这里以本地 provider 配置兜底，避免"重启后打开设置显示 0 个模型"的假象（不需要联网）。
    // 兜底读**全部**托管 provider：只有网关 provider 的话，重启后直连那批模型会显示成 0 个。
    const models = cachedModels.length > 0 ? cachedModels : await readAllManagedModelIds();
    return {
      configured: Boolean(serverUrl),
      loggedIn: Boolean(serverUrl && (await hasUsableSession())),
      serverUrl,
      gatewayBaseUrl: serverUrl ? deriveGatewayBaseUrl(serverUrl) : null,
      user: await readUser(),
      models,
      lastError,
    };
  }

  async function login(input: ReactorServerLoginInput): Promise<ReactorServerStatus> {
    const serverUrl = normalizeReactorServerUrl(input.serverUrl);
    const result = await client.login(serverUrl, input.username, input.password);
    await credentials.save(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl, serverUrl);
    await persistTokens(
      result.accessToken,
      result.refreshToken,
      result.renewedAccessToken ?? result.accessToken,
    );
    await credentials.save(
      REACTOR_SERVER_CREDENTIAL_KEYS.user,
      JSON.stringify(toUserInfo(result.user)),
    );
    // 数据命名空间切到该企业用户：同步写 marker，Renderer 收到成功响应后会立刻重启应用，
    // marker 必须在此之前落盘，否则新进程按旧 scope 拉起数据（方案文档 §3）。
    writeZCodeDataScopeMarker(result.user.uid, result.user.uid);
    lastError = null;
    cachedGateway = null;
    cachedProviderId = undefined;
    // 登录即把模型目录拉下来写进企业 provider，UI 随后就能选模型。
    await syncModels();
    logger.info(undefined, "企业服务端登录成功", { serverUrl, uid: result.user.uid });
    // P4.1 / P4.2b：登录成功 = 用量上报的启动点 + 策略拉取点（都 fire-and-forget，不阻断登录）。
    p4.onLogin();
    if (options.onLoginSuccess) {
      void Promise.resolve(options.onLoginSuccess()).catch((error: unknown) => {
        logger.warn(undefined, "登录后钩子失败（不阻断登录）", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return getStatus();
  }

  /**
   * 自助修改密码（强制改密弹窗与「设置 → 账号」共用）。
   *
   * 为什么改完要立刻落盘 user：服务端在校验通过后会把 must_change_password 清掉，
   * 若不同步回本地缓存，强制改密弹窗会继续挡着界面，用户只能靠重新登录才消失
   * —— 那正好是最不该让用户做操作的时候。
   */
  async function changePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<ReactorServerStatus> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    const tokens = await loadTokens();
    if (!serverUrl || !tokens) throw new Error("尚未登录企业服务端");
    const updated = await client.changePassword(
      serverUrl,
      tokens.accessToken,
      oldPassword,
      newPassword,
    );
    const info = toUserInfo(updated);
    await credentials.save(REACTOR_SERVER_CREDENTIAL_KEYS.user, JSON.stringify(info));
    logger.info(undefined, "企业服务端密码已修改", { uid: info.uid });
    return getStatus();
  }

  async function logout(): Promise<void> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    const tokens = await loadTokens();
    // P4.1：退出前 best-effort 补传一次（令牌此时仍有效）再退订；顺序由 wiring 内部保证
    // （先 flush 再 stop：反了会让未上报事件只能等下次登录才补）。
    await p4.beforeLogout(Boolean(serverUrl && tokens));
    if (serverUrl && tokens) {
      // 尽力吊销服务端 refresh；失败不影响本地清理，否则用户会卡在"退不出去"。
      await client.logout(serverUrl, tokens.accessToken).catch((error: unknown) => {
        logger.warn(undefined, "企业服务端登出请求失败（本地仍会清理）", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await clearEnterpriseProviderModels();
    await clearSession();
    // 数据命名空间回本地态：不切的话，下一个企业用户会看到这个人的任务与会话历史
    // （本机数据原本按「机器 + 工作区」落盘，与登录身份无关，见方案文档 §1）。
    writeZCodeDataScopeMarker("local");
    // P4.2b：登出后策略不同步、不强制 → 清掉缓存（否则组织策略会在无登录态下继续限制用户）。
    await p4.clearPolicy();
    // 登出钩子（清空 server-agents 等）在本地会话清完之后执行；失败只记日志，不阻断登出。
    if (options.onLogout) {
      try {
        await options.onLogout();
      } catch (error) {
        logger.warn(undefined, "登出后钩子失败（本地会话已清理）", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info(undefined, "企业服务端已登出");
  }

  /**
   * 登出后把企业 provider 的模型清单清空：
   * 留着清单会让用户在模型下拉里看到一批"选中就报未授权"的条目，比直接看不到更糟。
   * provider 条目本身保留（含固定地址），下次登录重新拉模型时复用，不产生重复条目。
   *
   * 清空同样只能走 `deletePersonalModel`：改 overlay 里的 `personalModelIds` 会被成员关系覆盖。
   */
  async function clearEnterpriseProviderModels(): Promise<void> {
    /*
     * 2026-10-29 修复：原来只清「网关 provider」一个条目，直连 provider 的模型会留下来。
     * 后果与注释里写的一样糟甚至更糟：登出后下拉里还留着直连模型，用户选中后
     * 端侧仍会照配置里的地址直接向上游发请求 —— 这次连"未授权"都不会报，是真的绕过了登录态。
     *
     * 改为按哨兵 apiKey 扫描全部托管 provider（网关 + 各直连），逐个清空模型。
     * 只清模型不删 provider：条目留着，下次登录按 baseUrl 原地复用。
     */
    const view = await providerSettings.getView();
    for (const provider of view.providers) {
      if (provider.personalConfig === undefined) continue;
      const access = provider.personalConfig.access as { apiKey?: unknown } | undefined;
      if (!isReactorServerManagedApiKey(access?.apiKey)) continue;
      await reconcileProviderModels(String(provider.providerId), []);
    }
  }

  async function resolveGatewayAuth(
    providerId: string,
    modelId: string,
  ): Promise<ReactorServerRequestAuth | null> {
    /*
     * 2026-10-29 修复：这里原来只认「网关 provider 的 id」（readManagedProviderId 读的是
     * 登录时写入凭据的那一个）。直连 provider 是另一批 id，不在该记录里，于是：
     *
     *   用户选了直连模型 → resolveGatewayAuth 返回 null
     *   → zcodeAgentService 抛「企业服务端未授权：请在设置中登录企业账号」
     *   → 用户明明已登录，却被要求重新登录，且请求根本发不出去。
     *
     * 判定改为「哨兵 apiKey 扫描」，与 isEnterpriseProvider / resolveDirectBaseUrl 同口径：
     * 网关 provider 与各直连 provider 都属于企业托管，不能只认其中一个 id。
     */
    if (!(await isManagedProvider(providerId))) return null;
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    if (!serverUrl) return null;

    const directBaseUrl = await resolveDirectBaseUrl(providerId);
    if (directBaseUrl) {
      /*
       * 直连不经网关，网关令牌没有意义。给哨兵占位值而不是 null：
       * null 会被上层解读为"未登录"，正是本次故障的表现。
       * 上游（我方内网模型服务）不校验凭据；若将来接的是要求密钥的上游，
       * 这里应改为读取该 provider 自己配置里的 key。
       */
      logger.debug(undefined, "直连 provider 请求使用占位凭据", {
        providerId,
        modelId,
        directBaseUrl,
      });
      return { apiKey: REACTOR_SERVER_API_KEY_PLACEHOLDER };
    }

    logger.debug(undefined, "为企业模型请求注入网关令牌", { providerId, modelId });
    return { apiKey: await ensureGatewayToken(serverUrl) };
  }

  // 启动补一次：进程重启后（凭据仍在）恢复用量上报与策略缓存，不等用户再点一次登录。
  if (options.bootstrapOnStart !== false) {
    void p4.bootstrap().catch((error: unknown) => {
      logger.warn(undefined, "启动补一次（策略/用量）失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    /*
     * 启动时补一次模型目录同步（2026-10-14 新增）。
     *
     * 此前模型目录只在 login 时拉一次，而 reconcile 又跳过已存在的模型 —— 两条叠加的后果是：
     * 管理员在管理台改了上下文窗口/最大输出/多模态/推理档位，桌面端必须用户**重新登录**才可能拿到，
     * 而即使重新登录，已存在模型仍被跳过，实际表现就是"服务端配了，桌面端永远不生效"。
     * 现在启动即对齐服务端目录，管理员改完配置、用户重启桌面端即可生效。
     *
     * fire-and-forget：失败只记日志，绝不影响启动（未登录时本就无目录可同步）。
     */
    void (async () => {
      const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
      // 未登录：没有企业 provider，也没有目录可对齐。
      if (!serverUrl) return;
      try {
        await syncModels();
        logger.info(undefined, "启动时已对齐企业模型目录");
      } catch (error: unknown) {
        logger.warn(undefined, "启动时对齐企业模型目录失败（不影响启动）", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  return {
    getStatus,
    login,
    logout,
    changePassword,
    syncModels,
    resolveGatewayAuth,
    isEnterpriseProvider: p4.isEnterpriseProvider,
    flushUsageReports: p4.flushUsageReports,
    getUsageReportStatus: p4.getUsageReportStatus,
    refreshPolicy: p4.refreshPolicy,
    getPolicy: () => p4.policyCache.getView(),
    getUsageOverview: p4.getUsageOverview,
  };
}
