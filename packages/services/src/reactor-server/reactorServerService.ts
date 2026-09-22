import type { ApiClient } from "@zcode/shared";
import type { ModelId, ProviderConfigObject, ProviderId } from "@zcode/provider";
import type { ICredentialService } from "../credential/credential.js";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createReactorServerClient,
  deriveGatewayBaseUrl,
  normalizeReactorServerUrl,
  ReactorServerHttpError,
} from "./reactorServerClient.js";
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

  function toUserInfo(user: {
    uid: string;
    name: string;
    role: string;
    dept?: { id: number; path?: string } | null;
  }): ReactorServerUserInfo {
    return {
      uid: user.uid,
      name: user.name,
      role: user.role,
      deptId: user.dept?.id ?? null,
      deptPath: user.dept?.path ?? null,
    };
  }

  async function readUser(): Promise<ReactorServerUserInfo | null> {
    const raw = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.user);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReactorServerUserInfo;
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
  async function reconcileProviderModels(
    providerId: string,
    desiredModelIds: readonly string[],
  ): Promise<void> {
    const desired = new Set(desiredModelIds);
    const current = await readPersonalModelIds(providerId);
    const currentSet = new Set(current);
    let added = 0;
    let removed = 0;
    for (const modelId of desiredModelIds) {
      if (currentSet.has(modelId)) continue;
      // config 传空对象：上下文窗口、推理档位等真实参数由 provider 侧推荐配置补齐，
      // 这里只声明"这个 id 属于该 provider"。
      await providerSettings.addPersonalModel(
        providerId as ProviderId,
        modelId as ModelId,
        {},
        true,
      );
      added += 1;
    }
    for (const modelId of current) {
      if (desired.has(modelId)) continue;
      await providerSettings.deletePersonalModel(providerId as ProviderId, modelId as ModelId);
      removed += 1;
    }
    if (added > 0 || removed > 0) {
      logger.info(undefined, "企业模型清单已对齐服务端目录", { added, removed });
    }
  }

  /**
   * 找到或创建企业 provider，并把模型清单写进去。
   *
   * 识别方式是 **baseUrl 等于本服务端网关基址**，而非固定 provider id：
   * `createPersonalProvider` 的 id 由配置服务生成、客户端无权指定，写死 id 等于依赖一个不属于我们的约定。
   * 找到后把 id 记进凭据，模型请求的热路径据此做 O(1) 判断。
   */
  async function writeEnterpriseProvider(
    gatewayBaseUrl: string,
    modelIds: readonly string[],
  ): Promise<void> {
    const view = await providerSettings.getView();
    const mine = view.providers.filter((provider) => provider.personalConfig !== undefined);
    const existing = mine.find(
      (provider) => provider.effectiveConfig.api?.baseUrl === gatewayBaseUrl,
    );
    const providerId = existing
      ? existing.providerId
      : (
          await providerSettings.createPersonalProvider({
            providerName: REACTOR_SERVER_PROVIDER_NAME,
          })
        ).providerId;
    // 这里不写 personalModelIds：它会被成员关系覆盖（见 reconcileProviderModels 注释），
    // 写上只会让人误以为模型清单由这里决定。
    const config: ProviderConfigObject = {
      group: "standard-personal",
      access: { type: "api-key", apiKey: REACTOR_SERVER_API_KEY_PLACEHOLDER },
      api: { type: "openai-chat-completions", baseUrl: gatewayBaseUrl },
      visibility: "visible",
    };
    await providerSettings.savePersonalProviderOverlay(providerId as ProviderId, config, {
      providerName: REACTOR_SERVER_PROVIDER_NAME,
    });
    cachedProviderId = providerId;
    await credentials.save(REACTOR_SERVER_CREDENTIAL_KEYS.providerId, providerId);
    await reconcileProviderModels(providerId, modelIds);
  }

  async function syncModels(): Promise<readonly string[]> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    if (!serverUrl) return [];
    const gatewayToken = await ensureGatewayToken(serverUrl);
    const gatewayBaseUrl = deriveGatewayBaseUrl(serverUrl);
    const models = await client.models(gatewayBaseUrl, gatewayToken);
    // 只把 chat 板块写进可选清单：embedding/rerank 不是会话模型，混进下拉会让用户选到"一发就 400"的条目。
    const chatModelIds = models
      .filter((model) => model.modelType === null || model.modelType === "chat")
      .map((model) => model.id);
    await writeEnterpriseProvider(gatewayBaseUrl, chatModelIds);
    cachedModels = chatModelIds;
    return cachedModels;
  }

  async function getStatus(): Promise<ReactorServerStatus> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    // 进程刚启动时内存缓存是空的，但企业 provider 里早已写好模型清单。
    // 这里以本地 provider 配置兜底，避免"重启后打开设置显示 0 个模型"的假象（不需要联网）。
    const models =
      cachedModels.length > 0
        ? cachedModels
        : ((await readManagedProviderEntry())?.config.personalModelIds ?? []);
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
    lastError = null;
    cachedGateway = null;
    cachedProviderId = undefined;
    // 登录即把模型目录拉下来写进企业 provider，UI 随后就能选模型。
    await syncModels();
    logger.info(undefined, "企业服务端登录成功", { serverUrl, uid: result.user.uid });
    if (options.onLoginSuccess) {
      void Promise.resolve(options.onLoginSuccess()).catch((error: unknown) => {
        logger.warn(undefined, "登录后钩子失败（不阻断登录）", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return getStatus();
  }

  async function logout(): Promise<void> {
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    const tokens = await loadTokens();
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
    const entry = await readManagedProviderEntry();
    if (!entry) return;
    await reconcileProviderModels(entry.providerId, []);
  }

  async function resolveGatewayAuth(
    providerId: string,
    modelId: string,
  ): Promise<ReactorServerRequestAuth | null> {
    const managedId = await readManagedProviderId();
    if (!managedId || providerId !== managedId) return null;
    const serverUrl = await credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);
    if (!serverUrl) return null;
    logger.debug(undefined, "为企业模型请求注入网关令牌", { providerId, modelId });
    return { apiKey: await ensureGatewayToken(serverUrl) };
  }

  return { getStatus, login, logout, syncModels, resolveGatewayAuth };
}
