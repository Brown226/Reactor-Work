/**
 * 上报桥（P4.1b）：把「会话流的用量增量」接到「outbox + flush」上。
 *
 * 为什么要这一层而不是塞进 `reactorServerService.ts`：那个文件同时承载登录、企业 provider
 * 物化与（P2）技能同步，是另一个会话的地盘；把订阅与触发逻辑收在这里，接线侧只需要
 * **实例化 + start/stop**，两边不必同时改同一个文件。
 *
 * 依赖全部注入（不 new 服务、不读全局）：
 * - `subscribeUsageDelta`：Host 侧订阅 `task_token_usage_delta`（生产由 Host 装配提供）；
 * - `isEnterpriseLoggedIn` / `isEnterpriseProvider`：每次调用时现读，避免缓存成过期判断；
 * - `postBatch`：`reactorServerClient` 的批量上报出口。
 */
import type { AuditOutbox } from "./auditOutbox.js";
import type { ModelCallUsageDelta } from "./auditEventMapping.js";
import { createAuditReporter } from "./auditReporter.js";
import {
  createAuditFlushScheduler,
  flushAuditOutbox,
  type AuditBatchPoster,
  type AuditFlushResult,
} from "./auditFlush.js";

export interface ReactorAuditBridgeDeps {
  outbox: AuditOutbox;
  postBatch: AuditBatchPoster;
  isEnterpriseLoggedIn: () => boolean;
  isEnterpriseProvider: (providerId: string) => boolean;
  subscribeUsageDelta: (listener: (delta: ModelCallUsageDelta) => void) => () => void;
  /** 合并窗口（默认 30s）与定时兜底（默认 5min）；测试可缩短或注入假计时器。 */
  debounceMs?: number;
  intervalMs?: number;
  now?: () => string;
  logger?: { debug?: (message: string, meta?: unknown) => void; warn: (message: string, meta?: unknown) => void };
}

export interface ReactorAuditBridge {
  /** 订阅用量流并启动定时兜底；可重复调用（幂等）。 */
  start(): void;
  /** 退订并停掉计时器（退出前可先 `flushNow`）。 */
  stop(): void;
  /** 立即 flush 一次（登录成功 / 退出前 / 探针）。 */
  flushNow(): Promise<AuditFlushResult>;
}

export function createReactorAuditBridge(deps: ReactorAuditBridgeDeps): ReactorAuditBridge {
  const reporter = createAuditReporter({ outbox: deps.outbox, now: deps.now });
  const scheduler = createAuditFlushScheduler({
    flush: () =>
      flushAuditOutbox({
        outbox: deps.outbox,
        postBatch: deps.postBatch,
        logger: deps.logger,
      }),
    debounceMs: deps.debounceMs,
    intervalMs: deps.intervalMs,
    logger: deps.logger,
  });

  let unsubscribe: (() => void) | null = null;

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.subscribeUsageDelta((delta) => {
        void reporter
          .recordModelCallUsage(delta, {
            enterpriseLoggedIn: deps.isEnterpriseLoggedIn(),
            enterpriseProvider: deps.isEnterpriseProvider(delta.providerId),
          })
          .then((enqueued) => {
            if (enqueued) scheduler.schedule();
          })
          .catch((error: unknown) => {
            // 记账失败不影响会话：outbox 是本地文件，这里只记录。
            deps.logger?.warn("[audit] 用量入队失败", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      });
      scheduler.start();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
      scheduler.dispose();
    },
    flushNow: () => scheduler.flushNow(),
  };
}
