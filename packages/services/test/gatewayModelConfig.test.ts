/**
 * 网关模型能力 → 桌面端 ModelConfig 映射回归。
 *
 * 运行（仓库无统一 test 入口，按 packages/services/test 既有约定手动执行）：
 *   cd packages/services && npx tsx --test test/gatewayModelConfig.test.ts
 *
 * 守的口径来自 docs/未完成-网关模型能力同步桌面端-方案-v1.md §2.3 / §3：
 *  ① 管理台配的 contextWindow / maxOutput / vision / tools 必须原样到达桌面端；
 *  ② 网关没有的信息保守 false / 不写，不猜 true（猜错会让 UI 承诺做不到的能力）；
 *  ③ 推理档位：服务端配置优先；未配置但模型声明支持推理时给安全缺省
 *     （`map:"{}"` 不写请求体 —— 这正是「打开思考就 400」的修复点）；
 *  ④ 模型不支持推理时不写 spec，避免让用户选一个不存在的档位。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ReactorServerModelInfo } from "../src/reactor-server/reactorServerClient.js";
import { buildGatewayModelConfig } from "../src/reactor-server/gatewayModelConfig.js";

function model(overrides: Partial<ReactorServerModelInfo> = {}): ReactorServerModelInfo {
  return {
    id: "smoke-model",
    modelType: "chat",
    displayName: "Smoke Model",
    contextWindow: null,
    maxOutputTokens: null,
    supportsTools: false,
    supportsReasoning: false,
    supportsVision: false,
    // 2026-10-14 起的 6 项布尔能力：默认 false，与扩量前的端侧硬编码行为一致
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
    reasoningLevels: null,
    reasoningMap: null,
    ...overrides,
  };
}

test("管理台配置的能力原样到达桌面端（窗口/最大输出/视觉/工具）", () => {
  const config = buildGatewayModelConfig(
    model({
      contextWindow: 200000,
      maxOutputTokens: 32000,
      supportsTools: true,
      supportsVision: true,
    }),
  );
  assert.equal(config.properties?.contextWindow, 200000);
  assert.equal(config.optionSpecs?.maxOutputTokens?.max, 32000);
  assert.equal(config.properties?.supportsToolCall, true);
  assert.equal(config.properties?.inputFormat?.supportsImage, true);
  assert.equal(config.properties?.inputFormat?.supportsText, true);
});

test("网关未给窗口/最大输出时不写字段（交给桌面端既有兜底，不写猜的默认值）", () => {
  const config = buildGatewayModelConfig(model());
  assert.equal(
    "contextWindow" in (config.properties ?? {}),
    false,
    "contextWindow 为 null 时不得写猜测值",
  );
  assert.equal(
    "maxOutputTokens" in (config.optionSpecs ?? {}),
    false,
    "maxOutputTokens 为 null 时不得写猜测值",
  );
});

test("未勾选的能力一律 false：不因支持视觉就顺带承诺 video/audio/pdf 或其它能力", () => {
  const config = buildGatewayModelConfig(model({ supportsVision: true }));
  assert.equal(config.properties?.inputFormat?.supportsVideo, false);
  assert.equal(config.properties?.inputFormat?.supportsAudio, false);
  assert.equal(config.properties?.inputFormat?.supportsPdf, false);
  assert.equal(config.properties?.supportsJsonSchemaOutput, false);
  assert.equal(config.properties?.supportsNativeWebSearch, false);
  assert.equal(config.properties?.supportsMidConversationSystem, false);
});

test("管理台勾选后，6 项高级能力原样到达桌面端（不再写死 false）", () => {
  const config = buildGatewayModelConfig(
    model({
      supportsVision: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsPdf: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: true,
      supportsMidConversationSystem: true,
    }),
  );
  assert.equal(config.properties?.inputFormat?.supportsImage, true);
  assert.equal(config.properties?.inputFormat?.supportsVideo, true);
  assert.equal(config.properties?.inputFormat?.supportsAudio, true);
  assert.equal(config.properties?.inputFormat?.supportsPdf, true);
  assert.equal(config.properties?.supportsJsonSchemaOutput, true);
  assert.equal(config.properties?.supportsNativeWebSearch, true);
  assert.equal(config.properties?.supportsMidConversationSystem, true);
});

test("requiresMfjsToolSchema 恒 false：它是端侧内部开关，与模型能力无关，管理台不暴露", () => {
  const config = buildGatewayModelConfig(
    model({
      supportsTools: true,
      supportsJsonSchemaOutput: true,
    }),
  );
  assert.equal(config.properties?.requiresMfjsToolSchema, false);
});

test("推理档位：服务端显式配置优先，档位与 map 都按配置生成", () => {
  const config = buildGatewayModelConfig(
    model({
      supportsReasoning: true,
      reasoningLevels: ["low", "high"],
      reasoningMap: '{"reasoning_effort": reasoningLevel}',
    }),
  );
  assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, ["low", "high"]);
  assert.equal(config.optionSpecs?.reasoningLevel?.map, '{"reasoning_effort": reasoningLevel}');
});

test("推理档位：服务端未配但模型声明支持推理 → 安全缺省，map 为 {}（不写请求体，避免 400）", () => {
  const config = buildGatewayModelConfig(model({ supportsReasoning: true }));
  assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, ["disabled", "enabled"]);
  assert.equal(config.optionSpecs?.reasoningLevel?.map, "{}");
});

test("推理档位：服务端未配且模型不支持推理 → 不写 spec（不让用户选不存在的档位）", () => {
  const config = buildGatewayModelConfig(model({ supportsReasoning: false }));
  assert.equal("reasoningLevel" in (config.optionSpecs ?? {}), false);
});

test("模型无任何可选参数时 optionSpecs 整体缺省（不留空对象）", () => {
  const config = buildGatewayModelConfig(model());
  assert.equal("optionSpecs" in config, false);
});
