/**
 * 网关模型能力 → 桌面端 ModelConfig 映射。
 *
 * 为什么需要这个文件：网关 `/v1/models` 早已下发 context_length / max_completion_tokens /
 * supports_vision / reasoning_levels，但客户端接收段曾把它们整段丢弃，
 * `reconcileProviderModels` 又给 `addPersonalModel` 传空对象 `{}`，导致桌面端的网关模型
 * 只能靠兜底推断 —— 表现为上下文/最大输出与管理台不同步、管理台标了多模态端侧却不认、
 * 以及「打开思考后无法正常对话」。本文件把下发值翻译成桌面端 ModelConfig 的形状。
 * 背景与验收场景见 docs/未完成-网关模型能力同步桌面端-方案-v1.md。
 *
 * 纯函数、无 IO：便于单测钉住映射口径（改错了不会报错，只会静默显示成错误的事实）。
 */
import type { ModelConfigObject } from "@zcode/provider";

import type { ReactorServerModelInfo } from "./reactorServerClient.js";

/** 推理档位安全缺省：只作端侧状态，不往请求体写任何字段。 */
export const DEFAULT_GATEWAY_REASONING_MAP = "{}";

/**
 * 族推断兜底的档位集合。
 *
 * 选 `["disabled","enabled"]` 而非真实强度分级，是因为它配合 `map:"{}"` 时**不会**让请求
 * 携带上游可能不认的参数 —— 那正是本次要修的现象（打开思考就 400）。
 * 管理台显式配置 `reasoning_levels` + `reasoning_map` 后可获得真实分级与字段映射。
 */
const INFERRED_REASONING_LEVELS = ["disabled", "enabled"] as const;

/**
 * 网关模型 → 桌面端 ModelConfig。
 *
 * 口径（每一项都对应 spec §2.3）：
 * - 网关**没有**的信息一律保守 false / 不写，不猜 true；
 * - `contextWindow` / `maxOutputTokens` 为 null 时**不写**对应字段，让桌面端既有兜底接管，
 *   而不是写一个猜的默认值把上游真实限制盖掉；
 * - `reasoningLevels` 为空且 `supportsReasoning` 为假时**不写** `reasoningLevel` spec，
 *   桌面端便不会展示思考档位（模型不支持就不该让用户选）。
 */
export function buildGatewayModelConfig(model: ReactorServerModelInfo): ModelConfigObject {
  const properties: NonNullable<ModelConfigObject["properties"]> = {
    inputFormat: {
      supportsText: true,
      // 2026-10-14 起 video/audio/pdf 也由管理台勾选后经网关下发；未勾选 = false，
      // 与扩量前的硬编码行为一致。旧网关不下发这些字段，`=== true` 判定自然落到 false。
      supportsImage: model.supportsVision,
      supportsVideo: model.supportsVideo,
      supportsAudio: model.supportsAudio,
      supportsPdf: model.supportsPdf,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: model.supportsTools,
    // 同上：管理台勾选后经网关下发，未勾选保持 false。
    supportsJsonSchemaOutput: model.supportsJsonSchemaOutput,
    supportsNativeWebSearch: model.supportsNativeWebSearch,
    supportsMidConversationSystem: model.supportsMidConversationSystem,
    // requiresMfjsToolSchema 刻意保持 false：它是桌面端内部工具 schema 转换开关，
    // 与"模型支持什么"无关，暴露到管理台只会让人困惑，因此没有对应的网关字段。
    requiresMfjsToolSchema: false,
  };
  if (model.contextWindow !== null) properties.contextWindow = model.contextWindow;

  const optionSpecs: NonNullable<ModelConfigObject["optionSpecs"]> = {};
  if (model.maxOutputTokens !== null) {
    optionSpecs.maxOutputTokens = { max: model.maxOutputTokens };
  }

  const reasoning = resolveReasoningSpec(model);
  if (reasoning) optionSpecs.reasoningLevel = reasoning;

  return {
    enabled: true,
    properties,
    ...(Object.keys(optionSpecs).length > 0 ? { optionSpecs } : {}),
  };
}

/**
 * 推理档位 spec：服务端配置优先，缺失时按「模型是否声明支持推理」做族推断兜底。
 *
 * 返回 null = 不写 spec（模型不支持推理，或服务端明确配了空集合）。
 */
function resolveReasoningSpec(
  model: ReactorServerModelInfo,
): { values: readonly string[]; map: string } | null {
  if (model.reasoningLevels && model.reasoningLevels.length > 0) {
    return {
      values: model.reasoningLevels,
      map: model.reasoningMap ?? DEFAULT_GATEWAY_REASONING_MAP,
    };
  }
  // 反例：服务端没配档位，但模型声明支持推理 → 给安全缺省，让用户至少能切换且不 400
  if (model.supportsReasoning) {
    return { values: INFERRED_REASONING_LEVELS, map: DEFAULT_GATEWAY_REASONING_MAP };
  }
  return null;
}
