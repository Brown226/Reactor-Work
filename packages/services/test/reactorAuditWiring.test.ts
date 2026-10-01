/**
 * P4.1b 用量上报**装配层**回归（不只是库层语义）。
 *
 * 库层（outbox / flush / 映射）已有 17 个用例；这里验证本任务真正缺的那一环：
 * `reactorServerService` 把 outbox + bridge + 会话流事件源接起来之后的端到端语义，
 * 以及任务书列的硬约束在装配后仍然成立：
 *  - 未登录 / 无 baseUrl → 不发网络、outbox 保留；
 *  - POST 失败 → 不 ack（条目留下次重试），恢复后重传成功才 ack；
 *  - ack 只在 POST 成功之后（duplicates 也算已处理）；
 *  - 单批 ≤500、一次 flush ≤10 批；
 *  - eventId 幂等（重复事件只入队一次）；
 *  - 只报企业 provider（本地 provider / 被换掉哨兵密钥的条目都不入队）；
 *  - 登录成功 → 挂订阅 + 补传；登出 → 补传 + 退订；
 *  - 事件体不含 uid/deptId、不含正文。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import { REACTOR_SERVER_API_KEY_SENTINEL } from "@zcode/shared";
import type { IProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";
import type { ModelCallUsageDelta } from "../src/reactor-server/auditEventMapping.js";
import { createReactorServerService } from "../src/reactor-server/reactorServerService.js";

const ENTERPRISE_PROVIDER_ID = "ent-1";
const LOCAL_PROVIDER_ID = "local-9";
const SERVER_URL = "http://server.test:8791";
const GATEWAY_URL = "http://server.test:8790/v1";

/** 造一个 exp 在未来的假 JWT（服务只读 payload.exp 判断"该不该刷新"）。 */
function fakeJwt(expiresInSeconds = 3600): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

interface HarnessOptions {
  loggedIn?: boolean;
  /** 企业 provider 条目的 apiKey（默认哨兵值；传别的值模拟"用户把密钥改掉了"）。 */
  enterpriseApiKey?: string;
  /** `/desktop/audit/batch` 的行为：返回回执或抛错。 */
  onAuditBatch?: (events: number) => { accepted: number; duplicates: number } | Error;
}

function createHarness(options: HarnessOptions = {}) {
  const requests: RecordedRequest[] = [];
  const credentialsStore = new Map<string, string>();
  if (options.loggedIn) {
    credentialsStore.set("reactor:serverUrl", SERVER_URL);
    credentialsStore.set("reactor:accessToken", fakeJwt());
    credentialsStore.set("reactor:refreshToken", "refresh-1");
    credentialsStore.set("reactor:providerId", ENTERPRISE_PROVIDER_ID);
    credentialsStore.set(
      "reactor:user",
      JSON.stringify({ uid: "u1", name: "测试用户", role: "user", deptId: null, deptPath: null }),
    );
  }

  const enterpriseApiKey = options.enterpriseApiKey ?? REACTOR_SERVER_API_KEY_SENTINEL;
  const providerView = {
    providers: [
      {
        providerId: ENTERPRISE_PROVIDER_ID,
        personalConfig: {
          access: { type: "api-key" as const, apiKey: enterpriseApiKey },
          api: { type: "openai-chat-completions" as const, baseUrl: GATEWAY_URL },
          personalModelIds: ["glm-test"],
        },
        effectiveConfig: { api: { baseUrl: GATEWAY_URL } },
      },
      {
        providerId: LOCAL_PROVIDER_ID,
        personalConfig: {
          access: { type: "api-key" as const, apiKey: "sk-local" },
          api: { type: "openai-chat-completions" as const, baseUrl: "https://api.local.test/v1" },
          personalModelIds: ["local-model"],
        },
        effectiveConfig: { api: { baseUrl: "https://api.local.test/v1" } },
      },
    ],
  };

  const providerSettings = {
    onDidChange: () => ({ dispose: () => undefined }),
    getView: async () => providerView,
    refresh: async () => providerView,
    createPersonalProvider: async () => ({ providerId: ENTERPRISE_PROVIDER_ID }),
    resolveModelConfig: async () => {
      throw new Error("unused");
    },
    savePersonalProviderOverlay: async () => providerView,
    deletePersonalProvider: async () => providerView,
    reorderPersonalProviders: async () => providerView,
    reorderPersonalModels: async () => providerView,
    addPersonalModel: async () => providerView,
    renamePersonalModel: async () => providerView,
    deletePersonalModel: async () => providerView,
    savePersonalModelDraft: async () => providerView,
    setPersonalModelEnabled: async () => providerView,
  } as unknown as IProviderSettingsService;

  const apiClient: ApiClient = {
    async request(input, init) {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ url, method, body });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.endsWith("/desktop/audit/batch")) {
        const events = Array.isArray((body as { events?: unknown[] })?.events)
          ? ((body as { events: unknown[] }).events as unknown[]).length
          : 0;
        const outcome = options.onAuditBatch?.(events) ?? { accepted: events, duplicates: 0 };
        if (outcome instanceof Error) throw outcome;
        return json({ ...outcome, rejected: [] });
      }
      if (url.endsWith("/desktop/policy")) {
        return json({
          policy: {
            defaultApprovalMode: "edit",
            commandBlacklist: ["rm -rf"],
            egressAllowlist: ["example.com"],
            quota: { monthlyTokenLimit: 1000, alertThresholds: [80, 100] },
          },
        });
      }
      if (url.includes("/desktop/usage/summary")) {
        return json({
          groupBy: "model",
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-30T00:00:00.000Z",
          rows: [],
          totals: {
            key: "TOTAL",
            calls: 3,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 150,
            cost: 0,
          },
        });
      }
      if (url.endsWith("/auth/login")) {
        return json({
          accessToken: fakeJwt(),
          refreshToken: "refresh-1",
          user: { uid: "u1", name: "测试用户", role: "user", dept: null },
        });
      }
      if (url.endsWith("/auth/gateway-token"))
        return json({ token: "gateway-token", expiresIn: 7200 });
      if (url.endsWith("/auth/logout")) return json({ ok: true });
      if (url.endsWith("/models")) {
        return json({ data: [{ id: "glm-test", model_type: "chat", display_name: "GLM Test" }] });
      }
      return json({ error: { code: "404", message: `no route: ${method} ${url}` } }, 404);
    },
  };

  let listener: ((delta: ModelCallUsageDelta) => void) | null = null;
  let unsubscribed = 0;
  const subscribeUsageDelta = (next: (delta: ModelCallUsageDelta) => void): (() => void) => {
    listener = next;
    return () => {
      listener = null;
      unsubscribed += 1;
    };
  };

  const credentials = {
    load: async (key: string) => credentialsStore.get(key) ?? null,
    save: async (key: string, value: string) => {
      credentialsStore.set(key, value);
    },
    delete: async (key: string) => {
      credentialsStore.delete(key);
    },
  };

  return {
    requests,
    apiClient,
    providerSettings,
    credentials,
    subscribeUsageDelta,
    get unsubscribed() {
      return unsubscribed;
    },
    /** 模拟 CLI 的 `usage.delta` 经 node.ts 映射后送到服务的用量增量。 */
    emit(delta: Partial<ModelCallUsageDelta> & { providerId: string }): void {
      assert.ok(listener, "用量事件源未订阅（start 未执行）");
      listener({
        eventId: "evt-1",
        ts: new Date().toISOString(),
        sessionId: "session-1",
        modelId: "glm-test",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        ...delta,
      });
    },
    hasListener: () => listener !== null,
    auditBatchRequests: () =>
      requests.filter((request) => request.url.includes("/desktop/audit/batch")),
  };
}

/** 等待若干轮宏任务，让 fire-and-forget 的入队/上报跑完。 */
async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 登录 + 吸收登录时那次 fire-and-forget 补传。
 *
 * 登录成功会立刻 best-effort flush 一次（补传上次退出留下的积压）。它是 fire-and-forget，
 * 可能在测试 emit 之后才 peek 到新事件 —— 那样断言会看到"刚发的事件已被上报"。
 * 这里显式再 flush 一次把在途 flush 收敛掉，让后续断言只观察自己发的那个事件。
 */
async function loginAndQuiesce(service: Awaited<ReturnType<typeof createService>>): Promise<void> {
  await service.login({ serverUrl: SERVER_URL, username: "u", password: "p" });
  await service.flushUsageReports();
  await settle(2);
}

function createService(
  harness: ReturnType<typeof createHarness>,
  outboxPath: string,
  policyPath: string,
  /** 合并窗口：默认拉到很长，让断言只在显式 `flushUsageReports()` 时发生（确定性）。 */
  debounceMs = 600_000,
) {
  return createReactorServerService({
    apiClient: harness.apiClient,
    credentials: harness.credentials as never,
    providerSettings: harness.providerSettings,
    subscribeUsageDelta: harness.subscribeUsageDelta,
    auditOutboxPath: outboxPath,
    policyFilePath: policyPath,
    bootstrapOnStart: false,
    auditFlushDebounceMs: debounceMs,
    auditFlushIntervalMs: 600_000,
  });
}

function seedOutbox(path: string, count: number): Promise<void> {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(
      JSON.stringify({
        eventId: `evt-${index}`,
        ts: new Date().toISOString(),
        action: "model_call",
        sessionId: "s",
        usage: { totalTokens: 1 },
      }),
    );
  }
  return writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

test("未登录：事件源未挂、不发起网络、outbox 原样保留", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createHarness({ loggedIn: false });
  const outboxPath = join(dir, "audit-outbox.jsonl");
  await seedOutbox(outboxPath, 1);
  const service = createService(harness, outboxPath, join(dir, "desktop-policy.json"));

  assert.equal(harness.hasListener(), false, "未登录不得挂订阅");
  const status = await service.flushUsageReports();
  assert.equal(status.active, false);
  assert.equal(status.pendingEvents, 1, "未登录时不得丢事件");
  assert.equal(harness.auditBatchRequests().length, 0, "未登录不得发起网络请求");
  assert.match(status.lastError ?? "", /未登录/);
});

test("登录成功 → 挂订阅 + 补传积压；登出 → 补传一次 + 退订", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createHarness({ loggedIn: false });
  const service = createService(harness, join(dir, "audit-outbox.jsonl"), join(dir, "policy.json"));
  t.after(() => service.logout().catch(() => undefined));

  await loginAndQuiesce(service);
  assert.equal(harness.hasListener(), true, "登录成功后必须挂上用量事件源");

  const beforeEmit = harness.auditBatchRequests().length;
  harness.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-login-1" });
  await settle();
  assert.equal((await service.getUsageReportStatus()).pendingEvents, 1);

  // 立即 flush（等价探针 / 退出前补传）。
  const flushed = await service.flushUsageReports();
  assert.equal(flushed.pendingEvents, 0, "POST 成功后必须 ack");
  const batches = harness.auditBatchRequests();
  assert.equal(batches.length, beforeEmit + 1);
  const posted = batches[batches.length - 1]?.body as { events: Record<string, unknown>[] };
  assert.equal(posted.events.length, 1);
  assert.equal(posted.events[0]?.eventId, "evt-login-1");
  assert.equal(posted.events[0]?.action, "model_call");
  // 红线：不带归属字段与正文类字段。
  for (const forbidden of ["uid", "deptId", "content", "prompt"]) {
    assert.equal(forbidden in (posted.events[0] ?? {}), false, `事件体不得包含 ${forbidden}`);
  }
  assert.ok(
    String(posted.events[0]?.summary ?? "").length <= 200,
    "summary 必须在服务端 200 字上限内",
  );

  harness.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-logout-1" });
  await settle();
  const beforeLogout = harness.auditBatchRequests().length;
  await service.logout();
  assert.equal(
    harness.auditBatchRequests().length,
    beforeLogout + 1,
    "登出前必须 best-effort 补传一次（令牌此时仍有效）",
  );
  assert.equal(harness.unsubscribed, 1, "登出必须退订用量事件源");
  assert.equal((await service.getUsageReportStatus()).pendingEvents, 0);
  assert.equal(harness.hasListener(), false);
});

test("POST 失败 → outbox 保留不 ack；恢复后重传成功才清空", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let failing = true;
  const harness = createHarness({
    loggedIn: true,
    onAuditBatch: (events) =>
      failing ? new Error("network down") : { accepted: events, duplicates: 0 },
  });
  const outboxPath = join(dir, "audit-outbox.jsonl");
  await seedOutbox(outboxPath, 2);
  const service = createReactorServerService({
    apiClient: harness.apiClient,
    credentials: harness.credentials as never,
    providerSettings: harness.providerSettings,
    auditOutboxPath: outboxPath,
    policyFilePath: join(dir, "policy.json"),
    bootstrapOnStart: false,
  });

  const failed = await service.flushUsageReports();
  assert.match(failed.lastError ?? "", /network down/);
  assert.equal(failed.pendingEvents, 2, "上报失败时不得从 outbox 删除条目");

  failing = false;
  const recovered = await service.flushUsageReports();
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.pendingEvents, 0, "恢复后重传成功才 ack");
});

test("只报企业 provider：本地 provider 不入队，被换掉哨兵密钥的条目也不入队", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const healthy = createHarness({ loggedIn: true });
  const healthyService = createService(
    healthy,
    join(dir, "outbox-a.jsonl"),
    join(dir, "policy-a.json"),
  );
  t.after(() => healthyService.logout().catch(() => undefined));
  await loginAndQuiesce(healthyService);
  assert.equal(await healthyService.isEnterpriseProvider(ENTERPRISE_PROVIDER_ID), true);
  assert.equal(await healthyService.isEnterpriseProvider(LOCAL_PROVIDER_ID), false);
  healthy.emit({ providerId: LOCAL_PROVIDER_ID, eventId: "evt-local" });
  healthy.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-ent" });
  await settle();
  assert.equal(
    (await healthyService.getUsageReportStatus()).pendingEvents,
    1,
    "只有企业 provider 的那条应入队",
  );

  const tampered = createHarness({ loggedIn: true, enterpriseApiKey: "user-replaced-key" });
  const tamperedService = createService(
    tampered,
    join(dir, "outbox-b.jsonl"),
    join(dir, "policy-b.json"),
  );
  t.after(() => tamperedService.logout().catch(() => undefined));
  await loginAndQuiesce(tamperedService);
  assert.equal(await tamperedService.isEnterpriseProvider(ENTERPRISE_PROVIDER_ID), false);
  tampered.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-tampered" });
  await settle();
  assert.equal((await tamperedService.getUsageReportStatus()).pendingEvents, 0);
});

test("eventId 幂等：重复事件只入队一次；服务端 duplicates 也算已处理", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createHarness({
    loggedIn: true,
    onAuditBatch: (events) => ({ accepted: 0, duplicates: events }),
  });
  const service = createService(harness, join(dir, "outbox.jsonl"), join(dir, "policy.json"));
  t.after(() => service.logout().catch(() => undefined));
  await loginAndQuiesce(service);
  const beforeEmit = harness.auditBatchRequests().length;
  harness.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-dup" });
  harness.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-dup" });
  await settle();
  assert.equal((await service.getUsageReportStatus()).pendingEvents, 1, "同一 eventId 只入队一次");

  const flushed = await service.flushUsageReports();
  assert.equal(flushed.pendingEvents, 0, "duplicates 属已处理，必须 ack");
  const batches = harness.auditBatchRequests();
  assert.equal(batches.length, beforeEmit + 1);
  const lastBatch = batches[batches.length - 1];
  assert.ok(lastBatch, "必须至少发出一批");
  assert.equal(
    (lastBatch.body as { events: unknown[] }).events.length,
    1,
    "重复事件不得在同批里出现两次",
  );
});

test("合并窗口触发：入队后到点自动 flush（不依赖显式调用）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createHarness({ loggedIn: true });
  const service = createService(harness, join(dir, "outbox.jsonl"), join(dir, "policy.json"), 10);
  t.after(() => service.logout().catch(() => undefined));
  await loginAndQuiesce(service);
  const beforeEmit = harness.auditBatchRequests().length;

  harness.emit({ providerId: ENTERPRISE_PROVIDER_ID, eventId: "evt-window" });
  // 等合并窗口（10ms）到点；不显式 flush。窗口轮询放宽到 3s：CI/本机负载高时
  // 10ms 定时器可能被推迟，断言本身只关心"到点会自己发"，不该被调度抖动判红。
  for (
    let index = 0;
    index < 150 && harness.auditBatchRequests().length === beforeEmit;
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(harness.auditBatchRequests().length, beforeEmit + 1, "合并窗口到点必须自动上报");
  // 自动 flush 的 ack 在 POST 之后，这里显式收敛一次再断言（幂等：已排空时是空操作）。
  assert.equal((await service.flushUsageReports()).pendingEvents, 0);
});

test("上限：单批 ≤500 条、一次 flush ≤10 批", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createHarness({ loggedIn: true });
  const outboxPath = join(dir, "outbox.jsonl");
  await seedOutbox(outboxPath, 5200);
  const service = createService(harness, outboxPath, join(dir, "policy.json"));

  const result = await service.flushUsageReports();
  const batches = harness.auditBatchRequests();
  assert.equal(batches.length, 10, "一次 flush 最多 10 批");
  for (const request of batches) {
    const size = (request.body as { events: unknown[] }).events.length;
    assert.ok(size <= 500, `单批不得超过 500 条，实际 ${size}`);
  }
  assert.equal(result.pendingEvents, 200, "5200 - 10*500 = 200 条留下次");
});
