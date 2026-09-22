import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type AuditBatchRequest,
  type AuditBatchResponse,
  type AuditEventInput,
} from "../src/reactor-server/auditContract.js";
import { createAuditOutbox } from "../src/reactor-server/auditOutbox.js";
import { flushAuditOutbox, createAuditFlushScheduler } from "../src/reactor-server/auditFlush.js";
import { createReactorAuditBridge } from "../src/reactor-server/auditBridge.js";
import type { ModelCallUsageDelta } from "../src/reactor-server/auditEventMapping.js";

async function withTempOutbox(
  run: (outbox: ReturnType<typeof createAuditOutbox>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "audit-flush-"));
  try {
    await run(createAuditOutbox({ filePath: join(dir, "audit-outbox.jsonl") }));
  } finally {
    // outbox 是"临时文件 + rename"写入：清理时可能撞上刚落盘的 .tmp，重试即可。
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function seedEvents(count: number): AuditEventInput[] {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `e${index}`,
    ts: "2026-09-22T10:00:00.000Z",
    action: "model_call" as const,
  }));
}

function okResponse(request: AuditBatchRequest): AuditBatchResponse {
  return { accepted: request.events.length, duplicates: 0, rejected: [] };
}

test("flush：peek→post→ack，全部上报后 outbox 清空", async () => {
  await withTempOutbox(async (outbox) => {
    await outbox.append(seedEvents(3));
    const seenSizes: number[] = [];
    const result = await flushAuditOutbox({
      outbox,
      postBatch: async (request) => {
        seenSizes.push(request.events.length);
        return okResponse(request);
      },
    });
    assert.deepEqual(seenSizes, [3]);
    assert.equal(result.posted, 3);
    assert.equal(result.acked, 3);
    assert.equal(result.remaining, 0);
    assert.equal(result.batches, 1);
  });
});

test("flush：按 batchSize 分批，一次 flush 最多 maxBatches 批", async () => {
  await withTempOutbox(async (outbox) => {
    await outbox.append(seedEvents(5));
    const batches: number[] = [];
    const result = await flushAuditOutbox({
      outbox,
      batchSize: 2,
      maxBatches: 2,
      postBatch: async (request) => {
        batches.push(request.events.length);
        return okResponse(request);
      },
    });
    assert.deepEqual(batches, [2, 2]);
    assert.equal(result.acked, 4);
    // 第 5 条留下，下轮再发
    assert.equal(result.remaining, 1);
  });
});

test("flush：POST 失败不动 outbox，事件留待重试", async () => {
  await withTempOutbox(async (outbox) => {
    await outbox.append(seedEvents(2));
    const result = await flushAuditOutbox({
      outbox,
      postBatch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(result.posted, 0);
    assert.equal(result.acked, 0);
    assert.equal(result.remaining, 2);
    assert.match(result.error ?? "", /ECONNREFUSED/);
  });
});

test("flush：回执条数少于批次时按最小集 ack，未回执的下一轮重发（最终收敛）", async () => {
  await withTempOutbox(async (outbox) => {
    await outbox.append(seedEvents(3));
    // 服务端每轮只回执 1 条：每轮 ack 1 条、余下重发，直到清空——重发重复由服务端按 eventId 判重。
    const result = await flushAuditOutbox({
      outbox,
      postBatch: async () => ({ accepted: 1, duplicates: 0, rejected: [] }),
    });
    assert.equal(result.batches, 3);
    assert.equal(result.acked, 3);
    assert.equal(result.remaining, 0);
  });
});

test("scheduler：debounce 窗口内多次触发只发一次", async () => {
  await withTempOutbox(async (outbox) => {
    let flushes = 0;
    const pending: Array<() => void> = [];
    const scheduler = createAuditFlushScheduler({
      flush: async () => {
        flushes += 1;
        return { batches: 0, posted: 0, acked: 0, remaining: 0 };
      },
      debounceMs: 30_000,
      setTimeoutImpl: ((callback: () => void) => {
        pending.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(pending.length, 1, "多次 schedule 只挂一个计时器");

    pending[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(flushes, 1);
    scheduler.dispose();
    assert.equal(await outbox.size(), 0);
  });
});

test("bridge：只记录企业 provider 且已登录的调用，并触发 flush", async () => {
  await withTempOutbox(async (outbox) => {
    const posted: AuditEventInput[][] = [];
    let listener: ((delta: ModelCallUsageDelta) => void) | null = null;
    const bridge = createReactorAuditBridge({
      outbox,
      postBatch: async (request) => {
        posted.push([...request.events]);
        return okResponse(request);
      },
      isEnterpriseLoggedIn: () => true,
      isEnterpriseProvider: (providerId) => providerId === "reactor:new-provider",
      subscribeUsageDelta: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      // 让 schedule() 立即 flush，省掉 30s 等待
      debounceMs: 0,
    });

    bridge.start();
    const enterpriseDelta: ModelCallUsageDelta = {
      eventId: "evt-enterprise",
      providerId: "reactor:new-provider",
      modelId: "deepseek/deepseek-v4.1-flash",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
    const localDelta: ModelCallUsageDelta = {
      eventId: "evt-local",
      providerId: "custom:local",
      modelId: "local-model",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };

    listener?.(enterpriseDelta);
    listener?.(localDelta);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const postedIds = posted.flat().map((event) => event.eventId);
    assert.deepEqual(postedIds, ["evt-enterprise"]);
    assert.equal(await outbox.size(), 0);

    bridge.stop();
  });
});
