/**
 * 上报 flush（P4.1b）：peek → POST → ack 的批量循环，外加触发时机。
 *
 * 语义与边界见 docs/服务端接线-P4-用量上报与策略.md §4.2：
 * - **peek 不删 → 全批 ack**：POST 成功但 ack 前崩溃，重发由服务端 `eventId` 判重；
 * - 单批 ≤ `MAX_AUDIT_BATCH`(500)；一次 flush 最多 `maxBatches`(10) 批，避免长时间占住；
 * - POST 失败**不动 outbox**（已 ack 的批次不会重发，未 ack 的下次再试）；
 * - 未登录/无 baseUrl 时不发起（由调用方决定是否调用本函数，这里只负责"发得出去"的循环）。
 *
 * 网络出口由调用方注入（生产走 `reactorServerClient` / ApiClient），本文件不直接 fetch。
 */
import {
  MAX_AUDIT_BATCH,
  type AuditBatchRequest,
  type AuditBatchResponse,
} from "./auditContract.js";
import type { AuditOutbox } from "./auditOutbox.js";

export type AuditBatchPoster = (request: AuditBatchRequest) => Promise<AuditBatchResponse>;

export interface AuditFlushResult {
  /** 实际发出的批次数。 */
  batches: number;
  /** 发出的条数。 */
  posted: number;
  /** 已 ack（从 outbox 移除）的条数。 */
  acked: number;
  /** flush 结束时 outbox 剩余条数。 */
  remaining: number;
  /** 中途失败时为错误信息（此时 posted/acked 是已完成的部分）。 */
  error?: string;
}

export interface AuditFlushOptions {
  outbox: AuditOutbox;
  postBatch: AuditBatchPoster;
  /** 单批条数上限。 */
  batchSize?: number;
  /** 一次 flush 最多几批。 */
  maxBatches?: number;
  /** 排序发号用（可选，只影响日志可读性）。 */
  batchIdPrefix?: string;
  logger?: { warn: (message: string, meta?: unknown) => void };
}

function countEventIds(response: AuditBatchResponse, fallback: number): number {
  const rejected = Array.isArray(response.rejected) ? response.rejected.length : 0;
  // accepted + duplicates + rejected 是服务端对整批的回执；缺字段时按整批已处理算。
  const sum = Number(response.accepted ?? 0) + Number(response.duplicates ?? 0) + rejected;
  return sum > 0 ? sum : fallback;
}

export async function flushAuditOutbox(options: AuditFlushOptions): Promise<AuditFlushResult> {
  const batchSize = options.batchSize ?? MAX_AUDIT_BATCH;
  const maxBatches = options.maxBatches ?? 10;
  let batches = 0;
  let posted = 0;
  let acked = 0;

  for (let index = 0; index < maxBatches; index += 1) {
    const batch = await options.outbox.peek(batchSize);
    if (batch.length === 0) break;

    const request: AuditBatchRequest = {
      batchId: options.batchIdPrefix ? `${options.batchIdPrefix}-${index + 1}` : undefined,
      events: batch,
    };

    let response: AuditBatchResponse;
    try {
      response = await options.postBatch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn("[audit] 上报失败，事件留在 outbox 等下次重试", {
        batchSize: batch.length,
        error: message,
      });
      return { batches, posted, acked, remaining: await options.outbox.size(), error: message };
    }

    batches += 1;
    posted += batch.length;
    const handled = countEventIds(response, batch.length);
    if (handled < batch.length) {
      // 回执与批次对不上：只 ack 服务端明确回执过的条数（按批内顺序），其余留待重发。
      options.logger?.warn("[audit] 回执条数与批次不一致，按最小集 ack", {
        batchSize: batch.length,
        handled,
      });
    }
    const ackedIds = batch.slice(0, Math.max(0, Math.min(handled, batch.length))).map(
      (event) => event.eventId,
    );
    await options.outbox.ack(ackedIds);
    acked += ackedIds.length;
  }

  return { batches, posted, acked, remaining: await options.outbox.size() };
}

export interface AuditFlushScheduler {
  /** 合并窗口内的多次触发只发一次（默认 30s）。 */
  schedule(): void;
  /** 立即发一次（登录成功 / 退出前）。 */
  flushNow(): Promise<AuditFlushResult>;
  /** 定时兜底（默认 5min）。 */
  start(): void;
  dispose(): void;
}

/**
 * 触发时机的收口：登录成功、回合结束（合并窗口）、退出前、定时兜底。
 * 计时器由调用方注入以便测试；不注入则用全局 `setTimeout`/`setInterval`。
 */
export function createAuditFlushScheduler(options: {
  flush: () => Promise<AuditFlushResult>;
  debounceMs?: number;
  intervalMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  logger?: { debug?: (message: string, meta?: unknown) => void };
}): AuditFlushScheduler {
  const debounceMs = options.debounceMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 300_000;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<AuditFlushResult> | null = null;

  const runOnce = (): Promise<AuditFlushResult> => {
    // 并发调用合并成同一次 flush：多窗口/多触发点同时到达时不重复发包。
    if (inFlight) return inFlight;
    inFlight = options.flush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    schedule() {
      if (debounceTimer !== null) return;
      debounceTimer = setTimeoutImpl(() => {
        debounceTimer = null;
        void runOnce();
      }, debounceMs);
    },
    flushNow: runOnce,
    start() {
      if (intervalTimer !== null) return;
      intervalTimer = setIntervalImpl(() => {
        void runOnce();
      }, intervalMs);
    },
    dispose() {
      if (debounceTimer !== null) {
        clearTimeoutImpl(debounceTimer);
        debounceTimer = null;
      }
      if (intervalTimer !== null) {
        clearIntervalImpl(intervalTimer);
        intervalTimer = null;
      }
    },
  };
}
