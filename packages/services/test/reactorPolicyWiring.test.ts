/**
 * P4.2b 策略下发**装配层**回归：Host 侧策略缓存的三条语义 + 与 CLI 强制点共用的纯函数。
 *
 * 覆盖 P4 文档 §4.3：
 *  - 未登录 → 不同步、不强制（缓存清空，CLI 读不到文件即不限制）；
 *  - 拉取失败 → 保留上一份（文件不动，视图标 stale），禁止把失败当"清空限制"；
 *  - 空数组 → 不限制（不是全禁）；缺字段 → 按默认合并；
 *  - 模式天花板 → 与用户档位取交集，只收紧不放宽；
 *  - 域名匹配规则（裸域含子域 / `*.` 不含裸域 / `*` 逃生阀 / 端口不参与）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import {
  isReactorEgressHostAllowed,
  matchReactorCommandBlacklist,
  intersectReactorDesktopPolicyMode,
  normalizeReactorDesktopPolicy,
  parseReactorDesktopPolicyFile,
  REACTOR_DESKTOP_POLICY_FILE_NAME,
} from "@zcode/shared";

/** 与 Host 侧 wiring 的落盘口径一致（`{数据根}/desktop-policy.json`）。 */
const resolveReactorDesktopPolicyPath = (dir: string): string =>
  join(dir, REACTOR_DESKTOP_POLICY_FILE_NAME);
import type { IProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";
import { createReactorServerService } from "../src/reactor-server/reactorServerService.js";

const SERVER_URL = "http://server.test:8791";
const GATEWAY_URL = "http://server.test:8790/v1";

function fakeJwt(expiresInSeconds = 3600): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

interface PolicyHarnessOptions {
  loggedIn?: boolean;
  /** `GET /desktop/policy` 的响应；返回 Error 表示网络/HTTP 失败。 */
  policyResponse?: unknown | Error;
  monthTokens?: number;
}

function createPolicyHarness(options: PolicyHarnessOptions = {}) {
  const requests: string[] = [];
  const credentialsStore = new Map<string, string>();
  if (options.loggedIn) {
    credentialsStore.set("reactor:serverUrl", SERVER_URL);
    credentialsStore.set("reactor:accessToken", fakeJwt());
    credentialsStore.set("reactor:refreshToken", "refresh-1");
    credentialsStore.set("reactor:providerId", "ent-1");
  }
  const providerView = {
    providers: [
      {
        providerId: "ent-1",
        personalConfig: {
          access: { type: "api-key", apiKey: "managed-by-reactor-server" },
          api: { baseUrl: GATEWAY_URL },
          personalModelIds: ["glm-test"],
        },
        effectiveConfig: { api: { baseUrl: GATEWAY_URL } },
      },
    ],
  };
  const providerSettings = {
    getView: async () => providerView,
    createPersonalProvider: async () => ({ providerId: "ent-1" }),
    savePersonalProviderOverlay: async () => providerView,
    addPersonalModel: async () => providerView,
    deletePersonalModel: async () => providerView,
  } as unknown as IProviderSettingsService;

  const apiClient: ApiClient = {
    async request(input, init) {
      const url = String(input);
      requests.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/desktop/policy")) {
        const response = options.policyResponse ?? { policy: defaultServerPolicy() };
        if (response instanceof Error) throw response;
        return json(response);
      }
      if (url.includes("/desktop/usage/summary")) {
        return json({
          groupBy: "model",
          from: "",
          to: "",
          rows: [],
          totals: {
            key: "TOTAL",
            calls: 2,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: options.monthTokens ?? 850,
            cost: 0,
          },
        });
      }
      if (url.endsWith("/auth/login")) {
        return json({
          accessToken: fakeJwt(),
          refreshToken: "refresh-1",
          user: { uid: "u1", name: "用户", role: "user", dept: null },
        });
      }
      if (url.endsWith("/auth/gateway-token")) return json({ token: "gw", expiresIn: 7200 });
      if (url.endsWith("/models")) {
        return json({ data: [{ id: "glm-test", model_type: "chat" }] });
      }
      if (url.endsWith("/auth/logout")) return json({ ok: true });
      return json({ error: { code: "404", message: url } }, 404);
    },
  };

  return {
    apiClient,
    providerSettings,
    credentials: {
      load: async (key: string) => credentialsStore.get(key) ?? null,
      save: async (key: string, value: string) => {
        credentialsStore.set(key, value);
      },
      delete: async (key: string) => {
        credentialsStore.delete(key);
      },
    },
    requests,
    policyRequests: () => requests.filter((entry) => entry.includes("/desktop/policy")),
  };
}

function defaultServerPolicy(): unknown {
  return {
    defaultApprovalMode: "edit",
    commandBlacklist: ["rm -rf"],
    egressAllowlist: ["example.com"],
    quota: { monthlyTokenLimit: 1000, alertThresholds: [80, 100] },
  };
}

function createService(harness: ReturnType<typeof createPolicyHarness>, dir: string) {
  return createReactorServerService({
    apiClient: harness.apiClient,
    credentials: harness.credentials as never,
    providerSettings: harness.providerSettings,
    auditOutboxPath: join(dir, "audit-outbox.jsonl"),
    policyFilePath: resolveReactorDesktopPolicyPath(dir),
    bootstrapOnStart: false,
  });
}

test("未登录：不拉策略、缓存清空、CLI 侧读到「无策略 = 不限制」", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({ loggedIn: false });
  const service = createService(harness, dir);

  const view = await service.refreshPolicy();
  assert.equal(view.source, "unknown");
  assert.equal(view.policy, null);
  assert.equal(harness.policyRequests().length, 0, "未登录不得发起策略拉取");
  // 缓存文件不存在：CLI 强制点据此判定"不限制"。
  await assert.rejects(readFile(resolveReactorDesktopPolicyPath(dir), "utf8"));
});

test("已登录：拉取成功 → 落盘 + 视图 source=server", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({ loggedIn: true });
  const service = createService(harness, dir);

  const view = await service.refreshPolicy();
  assert.equal(view.source, "server");
  assert.equal(view.stale, false);
  assert.equal(view.policy?.defaultApprovalMode, "edit");
  assert.deepEqual(view.policy?.commandBlacklist, ["rm -rf"]);
  // 落盘格式可被 CLI 侧解析器读回（同一契约）。
  const parsed = parseReactorDesktopPolicyFile(
    JSON.parse(await readFile(resolveReactorDesktopPolicyPath(dir), "utf8")) as unknown,
  );
  assert.equal(parsed?.policy.defaultApprovalMode, "edit");
  assert.ok(parsed?.fetchedAt);
});

test("拉取失败：保留上一份、标 stale，绝不清空限制", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({ loggedIn: true });
  const service = createService(harness, dir);
  await service.refreshPolicy();
  const before = await readFile(resolveReactorDesktopPolicyPath(dir), "utf8");

  // 换成失败的服务端：同目录新建实例，避免改动 harness 的可变状态。
  const failing = createPolicyHarness({ loggedIn: true, policyResponse: new Error("server down") });
  const failingService = createReactorServerService({
    apiClient: failing.apiClient,
    credentials: failing.credentials as never,
    providerSettings: failing.providerSettings,
    auditOutboxPath: join(dir, "audit-outbox.jsonl"),
    policyFilePath: resolveReactorDesktopPolicyPath(dir),
    bootstrapOnStart: false,
  });
  const view = await failingService.refreshPolicy();
  assert.equal(view.stale, true);
  assert.match(view.error ?? "", /server down/);
  assert.equal(view.policy?.defaultApprovalMode, "edit", "失败时必须仍用上一份策略");
  assert.equal(
    await readFile(resolveReactorDesktopPolicyPath(dir), "utf8"),
    before,
    "失败不得改写缓存文件",
  );
});

test("缺字段按默认合并：空数组 = 不限制，模式缺失不额外收紧", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({
    loggedIn: true,
    // 老服务端/形状残缺：只有旧词模式，数组与 quota 缺失，阈值非法。
    policyResponse: { policy: { defaultApprovalMode: "balanced", alertThresholds: [0, 250] } },
  });
  const service = createService(harness, dir);
  const view = await service.refreshPolicy();
  assert.equal(view.policy?.defaultApprovalMode, "build", "旧词 balanced 读时映射为 build");
  assert.deepEqual(view.policy?.commandBlacklist, []);
  assert.deepEqual(view.policy?.egressAllowlist, []);
  assert.equal(view.policy?.quota.monthlyTokenLimit, null);
  assert.deepEqual(view.policy?.quota.alertThresholds, [80, 100], "非法阈值回落默认");

  // 空名单 = 不限制（不是全禁）。
  assert.equal(
    isReactorEgressHostAllowed("anything.example.net", view.policy?.egressAllowlist),
    true,
  );
  assert.equal(matchReactorCommandBlacklist("ls -la", view.policy?.commandBlacklist), null);

  const missingMode = normalizeReactorDesktopPolicy({ commandBlacklist: ["x"] });
  assert.equal(missingMode.defaultApprovalMode, "yolo", "模式缺失不得变成额外限制");
});

test("登出：清空策略缓存（未登录不强制）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({ loggedIn: false });
  const service = createService(harness, dir);
  await service.login({ serverUrl: SERVER_URL, username: "u", password: "p" });
  // 登录内的策略拉取是 fire-and-forget；这里显式再取一次（单飞，会复用同一次在途刷新）。
  const afterLogin = await service.refreshPolicy();
  assert.equal(afterLogin.source, "server");

  await service.logout();
  const afterLogout = await service.getPolicy();
  assert.equal(afterLogout.source, "unknown");
  assert.equal(afterLogout.policy, null);
  await assert.rejects(readFile(resolveReactorDesktopPolicyPath(dir), "utf8"));
});

test("用量简报：服务端月度累计 + 额度进度 + 本地积压", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({ loggedIn: true, monthTokens: 850 });
  const service = createService(harness, dir);
  await service.refreshPolicy();

  const overview = await service.getUsageOverview();
  assert.equal(overview.monthTokens, 850);
  assert.equal(overview.quotaLimit, 1000);
  assert.equal(overview.percent, 0.85);
  assert.equal(overview.quotaExceeded, false, "85% 未跨 100% 线");
  assert.equal(overview.policyMode, "edit");
  assert.equal(overview.policySource, "server");
  assert.equal(overview.pendingEvents, 0);
});

test("用量简报：未登录时月度累计为 null（不拿本地缓存冒充）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = createPolicyHarness({ loggedIn: false });
  const service = createService(harness, dir);
  const overview = await service.getUsageOverview();
  assert.equal(overview.monthTokens, null);
  assert.equal(overview.percent, null);
  assert.equal(overview.policyMode, null);
  assert.equal(
    harness.requests.filter((entry) => entry.includes("/desktop/usage/summary")).length,
    0,
    "未登录不得请求用量聚合",
  );
});

test("模式天花板：与用户档位取交集，只收紧不放宽", () => {
  const cases: Array<[string, string, string]> = [
    ["yolo", "edit", "edit"],
    ["build", "edit", "edit"],
    ["plan", "edit", "plan"],
    ["edit", "yolo", "edit"],
    ["yolo", "yolo", "yolo"],
    ["build", "build", "build"],
    // 不可识别的档位（auto）按天花板处理：无法证明它不更宽。
    ["auto", "build", "build"],
  ];
  for (const [requested, ceiling, expected] of cases) {
    assert.equal(
      intersectReactorDesktopPolicyMode(requested, ceiling as never),
      expected,
      `${requested} ∩ ${ceiling} 应为 ${expected}`,
    );
  }
  assert.equal(intersectReactorDesktopPolicyMode("yolo", null), "yolo", "无天花板不收紧");
});

test("命令黑名单：子串匹配、大小写不敏感、空名单不限制", () => {
  const blacklist = ["rm -rf", "shutdown"];
  assert.equal(matchReactorCommandBlacklist("sudo RM -RF /tmp/x", blacklist), "rm -rf");
  assert.equal(matchReactorCommandBlacklist("echo hello", blacklist), null);
  assert.equal(matchReactorCommandBlacklist("rm -rf /", []), null);
  assert.equal(matchReactorCommandBlacklist("anything", null), null);
  assert.equal(matchReactorCommandBlacklist("   ", blacklist), null);
  // 空条目不得变成"匹配一切"。
  assert.equal(matchReactorCommandBlacklist("echo hi", ["", "  "]), null);
});

test("出网白名单：裸域含子域、*. 不含裸域、* 逃生阀、端口不参与", () => {
  const allowlist = ["example.com", "*.corp.test"];
  assert.equal(isReactorEgressHostAllowed("example.com", allowlist), true);
  assert.equal(isReactorEgressHostAllowed("a.example.com", allowlist), true);
  assert.equal(isReactorEgressHostAllowed("a.b.example.com", allowlist), true);
  assert.equal(isReactorEgressHostAllowed("evil-example.com", allowlist), false, "后缀必须整段");
  assert.equal(isReactorEgressHostAllowed("corp.test", allowlist), false, "*. 不含裸域");
  assert.equal(isReactorEgressHostAllowed("a.corp.test", allowlist), true);
  assert.equal(isReactorEgressHostAllowed("example.com:8443", allowlist), true, "端口不参与匹配");
  assert.equal(isReactorEgressHostAllowed("other.test", ["*"]), true);
  assert.equal(isReactorEgressHostAllowed("other.test", []), true, "空名单不限制");
  assert.equal(isReactorEgressHostAllowed("other.test", ["   "]), true, "无有效条目视为不限制");
  assert.equal(isReactorEgressHostAllowed("EXAMPLE.com.", allowlist), true, "大小写与尾点归一");
});
