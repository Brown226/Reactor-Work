/**
 * 用量上报子系统（P4.1）：outbox + 上报桥 + 只读状态的唯一所有者。
 *
 * 为什么从 `reactorServerService.ts` 抽出来：那个文件同时承载登录、企业 provider 物化、
 * 技能/Agent 同步与 P4 策略，已经顶到 `max-lines` 上限；上报子系统本身是自洽的一层
 * （outbox 落盘、事件源订阅、flush 触发时机），抽出来后接线方只需要 `start/stop/flushNow`。
 *
 * 硬约束（P4 文档 §4.2，全部在这里闭环）：
 * - 未登录 / 无 baseUrl → `postBatch` 直接抛错（**不发网络**），flush 因此不 ack、outbox 保留；
 * - ack 只在 POST 成功后发生（由 `flushAuditOutbox` 保证，本层不自行删条目）；
 * - 单批 ≤500、一次 flush ≤10 批（`flushAuditOutbox` 默认值）；
 * - outbox 的写入权不对外暴露：外部只能读 `getStatus()` 与触发 `flushNow()`。
 */
import { resolveAuditOutboxPath } from "./auditContract.js";
import { createAuditOutbox, type AuditOutbox } from "./auditOutbox.js";
import { createReactorAuditBridge, type ReactorAuditBridge } from "./auditBridge.js";
import type { AuditBatchPoster, AuditFlushResult } from "./auditFlush.js";
import type { BehaviorAuditFact, ModelCallUsageDelta } from "./auditEventMapping.js";
import type { ReactorServerAuditStatus } from "./reactorServer.js";

export interface ReactorUsageReportingDeps {
  /** outbox 落盘路径（缺省 `{用户数据根}/audit-outbox.jsonl`；测试注入临时目录）。 */
  outboxPath?: string;
  /** 上报出口：调用方负责登录态判定与 access 令牌解析（未登录必须抛错）。 */
  postBatch: AuditBatchPoster;
  isEnterpriseLoggedIn: () => boolean | Promise<boolean>;
  isEnterpriseProvider: (providerId: string) => boolean | Promise<boolean>;
  /** 会话流用量事件源；缺省 = 只装 outbox/flush（探针用例）。 */
  subscribeUsageDelta?: (listener: (delta: ModelCallUsageDelta) => void) => () => void;
  /** 行为审计事实源（洞②）；与用量源并列，两者皆缺省时 start() 不订阅任何流。 */
  subscribeAuditFacts?: (listener: (fact: BehaviorAuditFact) => void) => () => void;
  debounceMs?: number;
  intervalMs?: number;
  logger?: {
    debug?: (message: string, meta?: unknown) => void;
    warn: (message: string, meta?: unknown) => void;
  };
}

export interface ReactorUsageReporting {
  /** 挂事件源 + 起定时兜底（幂等）；返回是否有事件源被挂上。 */
  start(): boolean;
  /** 退订 + 停计时器（幂等）。 */
  stop(): void;
  /** 立即 flush 一次（登录成功 / 退出前 / 探针 / 设置页手动刷新）。 */
  flushNow(): Promise<ReactorServerAuditStatus>;
  /** 只读状态（积压条数 + 最近一次 flush 结果）。 */
  getStatus(): Promise<ReactorServerAuditStatus>;
}

export function createReactorUsageReporting(
  deps: ReactorUsageReportingDeps,
): ReactorUsageReporting {
  const outbox: AuditOutbox = createAuditOutbox({
    filePath: deps.outboxPath ?? resolveAuditOutboxPath(),
  });
  const bridge: ReactorAuditBridge = createReactorAuditBridge({
    outbox,
    postBatch: deps.postBatch,
    isEnterpriseLoggedIn: deps.isEnterpriseLoggedIn,
    isEnterpriseProvider: deps.isEnterpriseProvider,
    ...(deps.subscribeUsageDelta ? { subscribeUsageDelta: deps.subscribeUsageDelta } : {}),
    ...(deps.subscribeAuditFacts ? { subscribeAuditFacts: deps.subscribeAuditFacts } : {}),
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  let subscribed = false;
  let lastFlushAt: string | null = null;
  let lastError: string | null = null;

  const toStatus = async (): Promise<ReactorServerAuditStatus> => ({
    active: subscribed,
    pendingEvents: await outbox.size(),
    lastFlushAt,
    lastError,
  });

  return {
    start() {
      // 任一事件源在场即算接线成功（用量 / 行为审计可各自单独存在）。
      if (!deps.subscribeUsageDelta && !deps.subscribeAuditFacts) return false;
      bridge.start();
      subscribed = true;
      return true;
    },
    stop() {
      bridge.stop();
      subscribed = false;
    },
    async flushNow() {
      const result: AuditFlushResult = await bridge.flushNow();
      lastFlushAt = new Date().toISOString();
      lastError = result.error ?? null;
      return toStatus();
    },
    getStatus: toStatus,
  };
}
