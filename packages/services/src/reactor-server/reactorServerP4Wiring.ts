/**
 * 企业服务端 P4 接线（用量上报 + 组织策略）在 Host 侧的装配件。
 *
 * 为什么单独一层：`reactorServerService.ts` 是登录态与企业 provider 的**唯一所有者**，
 * 已经顶到 `max-lines` 上限；P4 的两块（上报子系统、策略同步）都是"依赖登录态"的下游，
 * 把它们的装配与触发时机收在这里，服务侧只剩「登录/登出/启动时喊一声」。
 *
 * 依赖全部注入（不 new 凭据、不读全局），因此：
 * - 登录态判定 `isEnterpriseLoggedIn` 每次现读 Host 事实，不缓存第二份；
 * - `postBatch` 未登录时抛错 → flush 不 ack、outbox 保留、不发网络；
 * - `isEnterpriseProvider` 用哨兵 apiKey + `reactor:providerId` 判定（用户改坏密钥立即失效）。
 */
import { isReactorServerManagedApiKey, REACTOR_DESKTOP_POLICY_FILE_NAME } from "@zcode/shared";
import { join } from "node:path";
import type { ProviderConfigObject } from "@zcode/provider";
import type { ICredentialService } from "../credential/credential.js";
import { getZCodeDataRootDir } from "../paths.js";
import type { ModelCallUsageDelta } from "./auditEventMapping.js";
import type { ReactorServerClient } from "./reactorServerClient.js";
import { createReactorPolicyCache, type ReactorPolicyCache } from "./reactorPolicyCache.js";
import { createReactorPolicySync } from "./reactorPolicySync.js";
import {
  createReactorUsageReporting,
  type ReactorUsageReporting,
} from "./reactorUsageReporting.js";
import {
  REACTOR_SERVER_CREDENTIAL_KEYS,
  type ReactorServerAuditStatus,
  type ReactorServerPolicyView,
  type ReactorServerUsageOverview,
} from "./reactorServer.js";

export interface ReactorServerP4WiringDeps {
  client: ReactorServerClient;
  credentials: Pick<ICredentialService, "load">;
  /** 登录态（有效 access 未过期）现读。 */
  hasUsableSession: () => Promise<boolean>;
  /** 取有效 access（内部含刷新与失效清理）。 */
  ensureAccessToken: (serverUrl: string) => Promise<string>;
  /** 读企业 provider 条目（哨兵判定用）。 */
  readManagedProviderEntry: () => Promise<{
    providerId: string;
    config: ProviderConfigObject;
  } | null>;
  subscribeUsageDelta?: (listener: (delta: ModelCallUsageDelta) => void) => () => void;
  auditOutboxPath?: string;
  policyFilePath?: string;
  auditFlushDebounceMs?: number;
  auditFlushIntervalMs?: number;
  logger: {
    warn: (message: string, meta?: unknown) => void;
    debug?: (message: string, meta?: unknown) => void;
  };
}

export interface ReactorServerP4Wiring {
  policyCache: ReactorPolicyCache;
  usageReporting: ReactorUsageReporting;
  /** 该 provider 是否为企业服务端托管的哨兵条目（用量上报的唯一过滤依据）。 */
  isEnterpriseProvider: (providerId: string) => Promise<boolean>;
  flushUsageReports: () => Promise<ReactorServerAuditStatus>;
  getUsageReportStatus: () => Promise<ReactorServerAuditStatus>;
  refreshPolicy: () => Promise<ReactorServerPolicyView>;
  getUsageOverview: () => Promise<ReactorServerUsageOverview>;
  /** 登录成功后：挂事件源 + 补传积压 + 拉策略（都 fire-and-forget，失败不阻断登录）。 */
  onLogin: () => void;
  /** 退出前：尽力补传一次（令牌还在），随后退订；策略缓存由调用方在登出流程里清。 */
  beforeLogout: (loggedIn: boolean) => Promise<void>;
  /** 启动补一次：已登录则挂上报 + 拉策略 + 补传；未登录清空策略缓存。 */
  bootstrap: () => Promise<void>;
  /** 登出/未登录：清空策略缓存（未登录不同步、不强制）。 */
  clearPolicy: () => Promise<void>;
}

export function createReactorServerP4Wiring(
  deps: ReactorServerP4WiringDeps,
): ReactorServerP4Wiring {
  const readServerUrl = () => deps.credentials.load(REACTOR_SERVER_CREDENTIAL_KEYS.serverUrl);

  async function isEnterpriseProvider(providerId: string): Promise<boolean> {
    const entry = await deps.readManagedProviderEntry();
    if (!entry || entry.providerId !== providerId) return false;
    const access = entry.config.access as { apiKey?: unknown } | undefined;
    return isReactorServerManagedApiKey(access?.apiKey);
  }

  const usageReporting = createReactorUsageReporting({
    ...(deps.auditOutboxPath !== undefined ? { outboxPath: deps.auditOutboxPath } : {}),
    // 出网前先判定登录态与地址：未登录/没地址时**不发起网络**，抛错让 flush 保留 outbox
    // （P4 文档 §4.2；ack 只在 POST 成功后发生，见 auditFlush.ts）。
    postBatch: async (request) => {
      const serverUrl = await readServerUrl();
      if (!serverUrl || !(await deps.hasUsableSession())) {
        throw new Error("未登录企业服务端：用量事件留在本地队列，登录后再上报");
      }
      const accessToken = await deps.ensureAccessToken(serverUrl);
      return deps.client.postAuditBatch(serverUrl, accessToken, request);
    },
    isEnterpriseLoggedIn: () => deps.hasUsableSession(),
    isEnterpriseProvider: (providerId) => isEnterpriseProvider(providerId),
    ...(deps.subscribeUsageDelta ? { subscribeUsageDelta: deps.subscribeUsageDelta } : {}),
    ...(deps.auditFlushDebounceMs !== undefined ? { debounceMs: deps.auditFlushDebounceMs } : {}),
    ...(deps.auditFlushIntervalMs !== undefined ? { intervalMs: deps.auditFlushIntervalMs } : {}),
    logger: deps.logger,
  });

  const policyCache = createReactorPolicyCache({
    // 路径解析留在 Node 侧：shared 的 desktopPolicy 模块会被渲染层经 barrel 求值，不能 import node:path。
    filePath: deps.policyFilePath ?? join(getZCodeDataRootDir(), REACTOR_DESKTOP_POLICY_FILE_NAME),
    logger: deps.logger,
  });
  const policySync = createReactorPolicySync({
    client: deps.client,
    cache: policyCache,
    readServerUrl,
    hasUsableSession: deps.hasUsableSession,
    ensureAccessToken: deps.ensureAccessToken,
    readAuditStatus: () => usageReporting.getStatus(),
    logger: deps.logger,
  });

  return {
    policyCache,
    usageReporting,
    isEnterpriseProvider,
    flushUsageReports: () => usageReporting.flushNow(),
    getUsageReportStatus: () => usageReporting.getStatus(),
    refreshPolicy: () => policySync.refresh(),
    getUsageOverview: () => policySync.getUsageOverview(),

    onLogin() {
      // 顺序：先挂事件源再补传积压，避免补传期间新来的用量事件落空。
      usageReporting.start();
      void usageReporting.flushNow().catch((error: unknown) => {
        deps.logger.warn("登录后补传用量失败（事件仍在本地队列）", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      void policySync.refresh().catch((error: unknown) => {
        deps.logger.warn("登录后拉取组织策略失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },

    async beforeLogout(loggedIn) {
      // 先补传（此时令牌仍有效），再退订：顺序反了会让未上报事件只能等下次登录。
      if (loggedIn) {
        await usageReporting.flushNow().catch((error: unknown) => {
          deps.logger.warn("退出前补传用量失败（事件仍在本地队列）", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      usageReporting.stop();
    },

    async bootstrap() {
      const serverUrl = await readServerUrl();
      if (!serverUrl || !(await deps.hasUsableSession())) {
        await policyCache.clear();
        return;
      }
      usageReporting.start();
      await policySync.refresh();
      await usageReporting.flushNow().catch(() => undefined);
    },

    clearPolicy: () => policyCache.clear(),
  };
}
