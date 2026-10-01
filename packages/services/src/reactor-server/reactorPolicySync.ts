/**
 * 组织策略同步 + 用量简报（P4.2b / P4.1 做-4）。
 *
 * 从 `reactorServerService.ts` 抽出：这里只依赖「取有效 access」「是否已登录」「读服务端地址」
 * 三个已注入的能力，不 new 客户端、不持有令牌 —— 登录态的所有权仍在 reactorServerService。
 *
 * 语义（P4 文档 §4.3）：
 * - 未登录 / 无地址：**不同步、不强制** → 清缓存（CLI 读不到文件即不限制）；
 * - 拉取失败：保留上一份 + `stale` 标记（禁止把失败当"清空限制"）；
 * - 单飞：登录 / 启动 / 设置页三个触发点并发到达时只发一次请求，避免并发写同一个缓存文件。
 */
import type { ReactorDesktopPolicy } from "@zcode/shared";
import type { ReactorServerClient } from "./reactorServerClient.js";
import type { ReactorPolicyCache } from "./reactorPolicyCache.js";
import type {
  ReactorServerAuditStatus,
  ReactorServerPolicyView,
  ReactorServerUsageOverview,
} from "./reactorServer.js";

export interface ReactorPolicySyncDeps {
  client: Pick<ReactorServerClient, "policy" | "usageSummary">;
  cache: ReactorPolicyCache;
  readServerUrl: () => Promise<string | null>;
  hasUsableSession: () => Promise<boolean>;
  ensureAccessToken: (serverUrl: string) => Promise<string>;
  readAuditStatus: () => Promise<ReactorServerAuditStatus>;
  logger: { warn: (message: string, meta?: unknown) => void };
  /** 注入时钟（本期口径：月度统计窗口按本地时区）。 */
  now?: () => Date;
}

export interface ReactorPolicySync {
  /** 拉取并落缓存（单飞）；未登录时清缓存。 */
  refresh(): Promise<ReactorServerPolicyView>;
  /** 只读视图（不发起网络）。 */
  getView(): Promise<ReactorServerPolicyView>;
  /** 设置页简报：服务端月度累计 + 策略额度 + 本地积压。 */
  getUsageOverview(): Promise<ReactorServerUsageOverview>;
}

export function createReactorPolicySync(deps: ReactorPolicySyncDeps): ReactorPolicySync {
  const now = deps.now ?? (() => new Date());
  let inFlight: Promise<ReactorServerPolicyView> | null = null;

  async function runRefresh(): Promise<ReactorServerPolicyView> {
    const serverUrl = await deps.readServerUrl();
    if (!serverUrl || !(await deps.hasUsableSession())) {
      await deps.cache.clear();
      return deps.cache.getView();
    }
    try {
      const accessToken = await deps.ensureAccessToken(serverUrl);
      await deps.cache.save(await deps.client.policy(serverUrl, accessToken));
      return await deps.cache.getView();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.warn("获取组织策略失败，保留上一份", { error: message });
      return await deps.cache.markStale(message);
    }
  }

  /** 本月起点（本地时区 00:00 → ISO8601）：月度简报的统计窗口。 */
  function startOfMonthIso(): string {
    const current = now();
    return new Date(current.getFullYear(), current.getMonth(), 1).toISOString();
  }

  return {
    refresh() {
      inFlight ??= runRefresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    getView: () => deps.cache.getView(),

    async getUsageOverview() {
      const [policyView, auditStatus] = await Promise.all([
        deps.cache.getView(),
        deps.readAuditStatus(),
      ]);
      const quota: ReactorDesktopPolicy["quota"] | undefined = policyView.policy?.quota;
      const quotaLimit = quota?.monthlyTokenLimit ?? null;
      let monthTokens: number | null = null;
      const serverUrl = await deps.readServerUrl();
      if (serverUrl && (await deps.hasUsableSession())) {
        try {
          const accessToken = await deps.ensureAccessToken(serverUrl);
          // 月度累计取服务端聚合（权威口径）。端上 outbox 只存"未确认"的事件，
          // 上报成功即 ack 删除，做不了月度累计，不能拿它冒充（P4 文档 §7-4）。
          const summary = await deps.client.usageSummary(serverUrl, accessToken, {
            groupBy: "model",
            from: startOfMonthIso(),
            to: now().toISOString(),
          });
          monthTokens = summary.totals.totalTokens;
        } catch (error) {
          deps.logger.warn("读取企业服务端月度用量失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const thresholds = quota?.alertThresholds ?? [];
      const percent =
        quotaLimit !== null && quotaLimit > 0 && monthTokens !== null
          ? monthTokens / quotaLimit
          : null;
      const maxThreshold = thresholds.length > 0 ? Math.max(...thresholds) : null;
      return {
        quotaLimit,
        alertThresholds: thresholds,
        policyMode: policyView.policy?.defaultApprovalMode ?? null,
        policySource: policyView.source,
        policyStale: policyView.stale,
        commandBlacklistCount: policyView.policy?.commandBlacklist.length ?? 0,
        egressAllowlistCount: policyView.policy?.egressAllowlist.length ?? 0,
        monthTokens,
        percent,
        quotaExceeded: percent !== null && maxThreshold !== null && percent * 100 >= maxThreshold,
        pendingEvents: auditStatus.pendingEvents,
        lastFlushAt: auditStatus.lastFlushAt,
        lastError: auditStatus.lastError ?? policyView.error,
      };
    },
  };
}
