/**
 * 企业模型目录同步（reconcile）回归 —— 钉住 2026-10-14 修的「配置永不更新」缺陷。
 *
 * ## 缺陷原貌
 *
 * `reconcileProviderModels` 曾对**已存在**的模型直接 `continue`：
 * 那个 continue 本是必要的防御（`addPersonalModel` 对已存在模型会 throw
 * "Model 已存在"），但后果是端侧永远停在**首次登录时**那份配置 ——
 * 管理员在管理台改了上下文窗口/最大输出/多模态/推理档位，桌面端一律不生效，
 * 用户反馈的现象是「服务端配好了，桌面端还是默认初始状态」。
 *
 * ## 本文件钉住的口径
 *
 *  ① 已存在的模型必须走 `savePersonalModelDraft` 刷新，而不是被跳过；
 *  ② 刷新必须带**本次下发的真实能力值**（改前/改后各 sync 一次，断言值确实变了）；
 *  ③ 新模型仍走 `addPersonalModel`、下线模型仍走 `deletePersonalModel`（不能回归）；
 *  ④ 单条模型刷新失败只记日志，不阻断整轮同步（否则一个坏模型让全部目录对不齐）；
 *  ⑤ 启动时（bootstrapOnStart 未显式关闭）会自动同步一次 —— 用户不必重新登录。
 *
 * 为什么值得单测：这条链路"算错了不报错，只会静默显示成错误的事实"，
 * 类型检查全绿也可能完全没同步（历史缺陷正是如此）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiClient } from "@zcode/shared";
import type { IProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";
import type { SavePersonalModelDraftInput } from "@zcode/provider";
import { createReactorServerService } from "../src/reactor-server/reactorServerService.js";
import { setDataBaseDir } from "../src/paths.js";

const SERVER_URL = "http://server.test:8791";
const GATEWAY_URL = "http://server.test:8790/v1";

// 登录/登出会同步写数据作用域 marker。不把数据根导到临时目录，跑一次测试就把开发机上
// 真实的数据作用域覆盖掉（reactorPolicyWiring.test.ts 的同款防护）。
let isolatedDataBaseDir: string | undefined;
test.before(async () => {
  isolatedDataBaseDir = await mkdtemp(join(tmpdir(), "reactor-model-reconcile-data-"));
  setDataBaseDir(isolatedDataBaseDir);
});
test.after(() => {
  setDataBaseDir(null);
  if (isolatedDataBaseDir) void rm(isolatedDataBaseDir, { recursive: true, force: true });
  isolatedDataBaseDir = undefined;
});

function fakeJwt(expiresInSeconds = 3600): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

/** 一条 `/v1/models` 返回的模型条目（形态见 reactorServerClient.models 的解析）。 */
interface WireModel {
  id: string;
  model_type?: string;
  display_name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
  reasoning_levels?: string[];
  reasoning_map?: string;
}

interface ReconcileHarnessOptions {
  /** 初始已存在的个人模型 id 列表（模拟"第一次登录后桌面端已存下这批模型"）。 */
  existingModelIds?: readonly string[];
  /** `/v1/models` 的返回；测试里可中途替换以模拟"服务端改了配置"。 */
  models?: readonly WireModel[];
  /** 让某条模型的刷新抛错，用于验证单条失败不阻断整轮。 */
  failRefreshFor?: string;
}

function createReconcileHarness(options: ReconcileHarnessOptions = {}) {
  const credentialsStore = new Map<string, string>();
  credentialsStore.set("reactor:serverUrl", SERVER_URL);
  credentialsStore.set("reactor:accessToken", fakeJwt());
  credentialsStore.set("reactor:refreshToken", "refresh-1");
  credentialsStore.set("reactor:providerId", "ent-1");

  // 已存在的模型清单：addPersonalModel 会把 id 追加进来，deletePersonalModel 会移除，
  // 这样连续两次 sync 时看到的是"上一轮写完之后"的真实状态。
  const personalModelIds: string[] = [...(options.existingModelIds ?? [])];
  let wireModels = options.models ?? [];

  const added: Array<{ modelId: string; config: unknown }> = [];
  const deleted: string[] = [];
  const drafted: Array<SavePersonalModelDraftInput> = [];

  const providerView = {
    revision: 7,
    providers: [
      {
        providerId: "ent-1",
        personalConfig: {
          access: { type: "api-key", apiKey: "managed-by-reactor-server" },
          api: { baseUrl: GATEWAY_URL },
          personalModelIds,
        },
        effectiveConfig: { api: { baseUrl: GATEWAY_URL } },
      },
    ],
  };

  const providerSettings = {
    getView: async () => providerView,
    createPersonalProvider: async () => ({ providerId: "ent-1" }),
    savePersonalProviderOverlay: async () => providerView,
    addPersonalModel: async (_providerId: string, modelId: string) => {
      added.push({ modelId, config: null });
      if (!personalModelIds.includes(modelId)) personalModelIds.push(modelId);
      return providerView;
    },
    deletePersonalModel: async (_providerId: string, modelId: string) => {
      deleted.push(modelId);
      const index = personalModelIds.indexOf(modelId);
      if (index >= 0) personalModelIds.splice(index, 1);
      return providerView;
    },
    savePersonalModelDraft: async (input: SavePersonalModelDraftInput) => {
      if (options.failRefreshFor === input.originalModelId) {
        throw new Error(`模拟刷新失败: ${input.originalModelId}`);
      }
      drafted.push(input);
      return providerView;
    },
  } as unknown as IProviderSettingsService;

  const apiClient: ApiClient = {
    async request(input) {
      const url = String(input);
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/auth/gateway-token")) return json({ token: "gw", expiresIn: 7200 });
      if (url.endsWith("/models")) {
        // 网关下发形态：data[] + 顶层能力字段（见 proxy.ts 的下发体）
        return json({ data: wireModels });
      }
      if (url.endsWith("/auth/logout")) return json({ ok: true });
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

  return {
    providerSettings,
    credentials,
    apiClient,
    added: () => added,
    deleted: () => deleted,
    drafted: () => drafted,
    existingIds: () => [...personalModelIds],
    /** 模拟"管理员在服务端改了配置"：换掉 /v1/models 的返回。 */
    setModels: (next: readonly WireModel[]) => {
      wireModels = next.map((m) => ({ ...m }));
    },
  };
}

function createService(
  harness: ReturnType<typeof createReconcileHarness>,
  dir: string,
  bootstrapOnStart = false,
) {
  return createReactorServerService({
    apiClient: harness.apiClient,
    credentials: harness.credentials as never,
    providerSettings: harness.providerSettings,
    auditOutboxPath: join(dir, "audit-outbox.jsonl"),
    policyFilePath: join(dir, "desktop-policy.json"),
    bootstrapOnStart,
  });
}

/** 从草稿入参里取出写进去的 ModelConfigObject。 */
function draftConfig(input: SavePersonalModelDraftInput): Record<string, unknown> {
  return input.personalConfig as unknown as Record<string, unknown>;
}

/**
 * 取 `properties` 子对象（contextWindow / inputFormat / supportsToolCall 都在这一层，
 * 见 gatewayModelConfig.ts 的组装方式 —— 写成顶层会静默拿到 undefined）。
 */
function draftProperties(input: SavePersonalModelDraftInput): Record<string, unknown> {
  const config = draftConfig(input);
  return (config.properties ?? {}) as Record<string, unknown>;
}

/** 取 `optionSpecs.maxOutputTokens.max`（最大输出是带上限的 spec，不是裸数字）。 */
function draftMaxOutput(input: SavePersonalModelDraftInput): unknown {
  const config = draftConfig(input);
  const specs = (config.optionSpecs ?? {}) as Record<string, unknown>;
  return (specs.maxOutputTokens as Record<string, unknown> | undefined)?.max;
}

test("已存在的模型必须被刷新，而不是被跳过（2026-10-14 缺陷回归）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const harness = createReconcileHarness({
    // 桌面端**已经**有这条模型（历史实现会在这里 continue 跳过）
    existingModelIds: ["deepseek/deepseek-v4.1-flash"],
    models: [
      {
        id: "deepseek/deepseek-v4.1-flash",
        model_type: "chat",
        context_length: 1_000_000,
        max_completion_tokens: 32_000,
        supports_vision: true,
        supports_tools: true,
      },
    ],
  });
  const service = createService(harness, dir);

  const synced = await service.syncModels();

  assert.deepEqual(synced, ["deepseek/deepseek-v4.1-flash"]);
  assert.equal(
    harness.added().length,
    0,
    '模型已存在时不得再走 addPersonalModel（那条路会 throw "Model 已存在"）',
  );
  assert.equal(harness.drafted().length, 1, "已存在的模型必须走草稿保存刷新配置");
  const draft = harness.drafted()[0];
  assert.equal(draft.originalModelId, "deepseek/deepseek-v4.1-flash");
  assert.equal(draft.nextModelId, "deepseek/deepseek-v4.1-flash", "同步不允许改模型 id");

  const config = draftConfig(draft);
  assert.equal(draftProperties(draft).contextWindow, 1_000_000, "上下文窗口必须随服务端配置刷新");
  assert.equal(draftMaxOutput(draft), 32_000, "最大输出必须随服务端配置刷新");
  const inputFormat = draftProperties(draft).inputFormat as Record<string, unknown>;
  assert.equal(inputFormat.supportsImage, true, "管理台标了多模态，端侧必须认");
  assert.equal(config.enabled, true, "同步写进去的模型默认启用");
});

test("服务端改了能力后，再次同步必须把新值写下去（不是只加不更新）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const harness = createReconcileHarness({
    existingModelIds: ["m-1"],
    models: [{ id: "m-1", model_type: "chat", context_length: 128_000, supports_vision: false }],
  });
  const service = createService(harness, dir);

  await service.syncModels();
  assert.equal(harness.drafted().length, 1);
  assert.equal(draftProperties(harness.drafted()[0]).contextWindow, 128_000);

  // 管理员把上下文窗口从 128K 改到 1M，并勾上视觉输入
  harness.setModels([
    { id: "m-1", model_type: "chat", context_length: 1_000_000, supports_vision: true },
  ]);
  await service.syncModels();

  assert.equal(harness.drafted().length, 2, "第二次同步必须再次刷新，不能因为已存在就跳过");
  assert.equal(
    draftProperties(harness.drafted()[1]).contextWindow,
    1_000_000,
    "新值必须真正写下去",
  );
  const inputFormat = draftProperties(harness.drafted()[1]).inputFormat as Record<string, unknown>;
  assert.equal(inputFormat.supportsImage, true, "多模态开关的新值必须真正写下去");
});

test("新模型走 addPersonalModel、下线模型走 deletePersonalModel（不回归）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const harness = createReconcileHarness({
    existingModelIds: ["gone-1"],
    models: [{ id: "brand-new", model_type: "chat", context_length: 64_000 }],
  });
  const service = createService(harness, dir);

  const synced = await service.syncModels();

  assert.deepEqual(synced, ["brand-new"]);
  assert.deepEqual(
    harness.added().map((a) => a.modelId),
    ["brand-new"],
    "目录里的新模型必须走 addPersonalModel",
  );
  assert.deepEqual(harness.deleted(), ["gone-1"], "目录里没有的旧模型必须删除");
  assert.equal(harness.drafted().length, 0, "没有已存在模型时不该触发刷新");
  assert.deepEqual(harness.existingIds(), ["brand-new"], "同步后本地清单应等于服务端目录");
});

test("单条模型刷新失败只记日志，不阻断整轮同步", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const harness = createReconcileHarness({
    // 两条都**已存在**（才会走刷新）；bad-1 的刷新被 mock 成抛错
    existingModelIds: ["bad-1", "good-1"],
    failRefreshFor: "bad-1",
    models: [
      { id: "bad-1", model_type: "chat", context_length: 128_000 },
      { id: "good-1", model_type: "chat", context_length: 256_000 },
    ],
  });
  const service = createService(harness, dir);

  // 不得 reject：一个坏模型不能让整份目录对不齐
  const synced = await service.syncModels();

  assert.deepEqual(synced, ["bad-1", "good-1"]);
  assert.equal(harness.drafted().length, 1, "坏模型记日志后应继续处理下一条");
  assert.equal(harness.drafted()[0].originalModelId, "good-1");
  assert.equal(
    draftProperties(harness.drafted()[0]).contextWindow,
    256_000,
    "好模型的配置仍要写下去",
  );
});

test("启动时自动同步一次模型目录（用户不必重新登录）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const harness = createReconcileHarness({
    existingModelIds: ["m-1"],
    models: [{ id: "m-1", model_type: "chat", context_length: 1_000_000 }],
  });
  // bootstrapOnStart 不显式关：启动即补一次
  createService(harness, dir, true);

  // 启动同步是 fire-and-forget；轮询等它落地（有上限，避免挂死）
  const deadline = Date.now() + 5000;
  while (harness.drafted().length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(harness.drafted().length, 1, "启动时必须自动同步一次模型目录");
  assert.equal(draftProperties(harness.drafted()[0]).contextWindow, 1_000_000);
});

test("未登录时启动不做模型同步（没有企业 provider，也无目录可对齐）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reactor-reconcile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const harness = createReconcileHarness({ models: [{ id: "m-1", model_type: "chat" }] });
  // 清掉登录态
  await harness.credentials.remove("reactor:serverUrl");
  createService(harness, dir, true);

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(harness.drafted().length, 0);
  assert.equal(harness.added().length, 0);
});
