/**
 * 企业会话静默续期回归 —— 钉住 2026-11-01 修的「access 过期即视为未登录」缺陷。
 *
 * ## 缺陷原貌
 *
 * `getStatus()` 曾用 `hasUsableSession()`（只看 accessExpiresAt）判定 loggedIn：
 * access JWT 过期后即使 refresh token 仍有效，UI 的专家·技能市场门控也会显示
 * 「请先登录企业服务端」，而整条链路上没有任何路径会触发轮换 —— refresh 明明
 * 有效，用户却被迫重新输密码（web 端实测复现）。
 *
 * ## 本文件钉住的口径
 *
 *  ① access 过期 + refresh 有效：getStatus 静默轮换，返回 loggedIn=true，
 *     且凭据里的 access/refresh 已滚动更新；后续 getStatus 不再打 refresh 接口；
 *  ② access 过期 + refresh 轮换失败（网络/服务端 5xx）：getStatus 返回
 *     loggedIn=false，但**不清会话** —— getStatus 是纯状态读，不能因为一次
 *     探测失败把用户还能用的 refresh token 删掉；真实 API 调用仍走
 *     ensureAccessToken 的破坏性语义（那边失败必须清，防静默降级）；
 *  ③ 并发 getStatus 只发一次 refresh（单飞）——滚动轮换下并发刷新会拿同一个
 *     refresh 换两次，第二次必然 401，反而把刚续上的会话清掉。
 *
 * 为什么值得单测：这条链路错了不报错，只是把已登录用户显示成未登录、
 * 逼其重输密码（历史缺陷正是如此）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import type { IProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";
import { createReactorServerService } from "../src/reactor-server/reactorServerService.js";
import { setDataBaseDir } from "../src/paths.js";

const SERVER_URL = "http://server.test:8791";

// 登录/登出会同步写数据作用域 marker。不把数据根导到临时目录，跑一次测试就把开发机上
// 真实的数据作用域覆盖掉（gatewayModelReconcile.test.ts 的同款防护）。
let isolatedDataBaseDir: string | undefined;
test.before(async () => {
  isolatedDataBaseDir = await mkdtemp(join(tmpdir(), "reactor-session-refresh-data-"));
  setDataBaseDir(isolatedDataBaseDir);
});
test.after(() => {
  setDataBaseDir(null);
  if (isolatedDataBaseDir) void rm(isolatedDataBaseDir, { recursive: true, force: true });
  isolatedDataBaseDir = undefined;
});

function fakeJwt(expiresInSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

interface SessionHarnessOptions {
  /** /auth/refresh 的返回码；非 200 模拟轮换失败（网络/服务端 5xx）。 */
  refreshStatus?: number;
}

function createSessionHarness(options: SessionHarnessOptions = {}) {
  const credentialsStore = new Map<string, string>([
    ["reactor:serverUrl", SERVER_URL],
    // 初始即过期的 access：任何"只看过期时间"的判定都必须走轮换
    ["reactor:accessToken", fakeJwt(-600)],
    ["reactor:refreshToken", "refresh-1"],
  ]);

  const refreshCalls: Array<{ refreshToken: string }> = [];

  const apiClient: ApiClient = {
    async request(input, init) {
      const url = String(input);
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/auth/refresh")) {
        // client 传给 ApiClient 的 body 是已 JSON.stringify 的字符串
        const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as {
          refreshToken?: string;
        };
        refreshCalls.push({ refreshToken: body.refreshToken ?? "" });
        if (options.refreshStatus !== undefined && options.refreshStatus !== 200) {
          return json({ error: { code: "500", message: "模拟轮换失败" } }, options.refreshStatus);
        }
        // 滚动轮换：access/refresh 都换新
        return json({ accessToken: fakeJwt(3600), refreshToken: "refresh-2" });
      }
      if (url.endsWith("/models")) return json({ data: [] });
      return json({ error: { code: "404", message: url } }, 404);
    },
  };

  const credentials = {
    load: async (key: string) => credentialsStore.get(key) ?? null,
    save: async (key: string, value: string) => {
      credentialsStore.set(key, value);
    },
    remove: async (key: string) => {
      credentialsStore.delete(key);
    },
  };

  const providerSettings = {
    getView: async () => ({ revision: 1, providers: [] }),
  } as unknown as IProviderSettingsService;

  return { credentials, apiClient, providerSettings, credentialsStore, refreshCalls };
}

function createService(
  harness: ReturnType<typeof createSessionHarness>,
  dir: string,
) {
  return createReactorServerService({
    apiClient: harness.apiClient,
    credentials: harness.credentials as never,
    providerSettings: harness.providerSettings,
    auditOutboxPath: join(dir, "audit-outbox.jsonl"),
    policyFilePath: join(dir, "desktop-policy.json"),
    bootstrapOnStart: false,
  });
}

test("① access 过期 + refresh 有效：getStatus 静默轮换并返回 loggedIn=true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-session-refresh-1-"));
  try {
    const harness = createSessionHarness();
    const service = createService(harness, dir);

    const status = await service.getStatus();
    assert.equal(status.loggedIn, true, "refresh 有效时必须续期而不是判未登录");
    assert.equal(harness.refreshCalls.length, 1, "应恰好轮换一次");
    assert.equal(harness.refreshCalls[0]?.refreshToken, "refresh-1");
    // 凭据里的 token 已滚动更新（旧 access 被替换、refresh 换成 refresh-2）
    assert.notEqual(harness.credentialsStore.get("reactor:accessToken"), fakeJwt(-600));
    assert.match(harness.credentialsStore.get("reactor:refreshToken") ?? "", /^refresh-/);

    // 续期后 access 有效：再次 getStatus 不应再打 refresh 接口
    await service.getStatus();
    assert.equal(harness.refreshCalls.length, 1, "access 有效期间不应重复轮换");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("② access 过期 + refresh 轮换失败：loggedIn=false 但不清会话", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-session-refresh-2-"));
  try {
    const harness = createSessionHarness({ refreshStatus: 500 });
    const service = createService(harness, dir);

    const status = await service.getStatus();
    assert.equal(status.loggedIn, false);
    // getStatus 是纯状态读：轮换探测失败不能把用户还能用的 refresh token 删掉，
    // 否则网络恢复后用户也必须重新输密码。
    assert.equal(harness.credentialsStore.get("reactor:refreshToken"), "refresh-1");
    assert.equal(harness.credentialsStore.get("reactor:accessToken"), fakeJwt(-600));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("③ 并发 getStatus 只发一次 refresh（单飞）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-session-refresh-3-"));
  try {
    const harness = createSessionHarness();
    const service = createService(harness, dir);

    // 两个 getStatus 同时进入轮换窗口：单飞收口成一次 refresh，
    // 否则第二次拿已轮换的旧 refresh 必然 401，把会话清掉。
    const [a, b] = await Promise.all([service.getStatus(), service.getStatus()]);
    assert.equal(a.loggedIn, true);
    assert.equal(b.loggedIn, true);
    assert.equal(harness.refreshCalls.length, 1, "并发必须只轮换一次");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
