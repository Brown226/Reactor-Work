/**
 * 内置模型目录（P1）：按模型名给「窗口 / 最大输出 / 能力 / 四段价」，用于
 *   ① 管理台「一键填充」（含撤销）
 *   ② 上游 /models 只回 id 时的兜底（discover 会用它补齐，并在 UI 上标注来源）
 *
 * ⚠ 这是**实测快照**，不是凭印象写的常量。刷新方式：
 *   node packages/server/scripts/gen-model-presets.mjs --from <discover.json> --write
 *   node packages/server/scripts/gen-model-presets.mjs --base-url <上游 /v1> --api-key <key> --write
 * 本次快照：2026-09-12 · 来源 discover 响应快照（.runtime/p0/discover2.json） · 19 条
 *
 * ⚠ 快照会过期（上游改价后这里仍是旧值）→ UI 上对「只来自预设」的字段会标注来源。
 * 单位与 pi 一致：元 / 百万 tokens（见 common/pricing.ts）。
 */

import type { ModelPricing } from "../common/pricing.js";

export interface ModelPreset {
  /** 规范模型名（上游真实 id） */
  id: string;
  /** 归一化匹配键（去 vendor 前缀 / 去日期后缀），由 normalizeModelKey 生成 */
  matchKeys: string[];
  displayName: string;
  contextWindow: number | null;
  maxTokens: number | null;
  /** 能力标记：tools / reasoning / anthropic / vision（与 registry.KNOWN_FEATURES 一致） */
  features: string[];
  pricing: ModelPricing;
  currency: string | null;
}

/** 预设来源说明（管理台直接展示，避免被误当成上游实时值） */
export const MODEL_PRESET_SOURCE = "内置快照 · 2026-09-12 · 19 条";

/**
 * 归一化匹配键：小写 → 去 vendor/ 前缀 → 去 -MMDD 日期后缀。
 * 例：`deepseek-v4-flash-0731` → `deepseek-v4-flash`；`openai/gpt-4o` → `gpt-4o`。
 */
export function normalizeModelKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/-\d{4}$/, "");
  return s;
}

/** 原始记录（由脚本生成；勿手改数值——改了它就不再是快照） */
const RAW: Array<Omit<ModelPreset, "matchKeys">> = [
  {"id":"glm-5.1","displayName":"glm-5.1","contextWindow":200000,"maxTokens":128000,"features":["tools","reasoning","anthropic"],"pricing":{"inputPerM":8,"outputPerM":28,"cacheReadPerM":2,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"minimax-m2.7","displayName":"minimax-m2.7","contextWindow":200000,"maxTokens":192000,"features":["tools","reasoning","anthropic"],"pricing":{"inputPerM":2.1,"outputPerM":8.4,"cacheReadPerM":null,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"kimi-k2.6","displayName":"kimi-k2.6","contextWindow":256000,"maxTokens":128000,"features":["tools","reasoning","anthropic","vision"],"pricing":{"inputPerM":6.5,"outputPerM":27,"cacheReadPerM":1.3,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"mimo-v2.5-pro","displayName":"mimo-v2.5-pro","contextWindow":256000,"maxTokens":256000,"features":["tools","reasoning","anthropic"],"pricing":{"inputPerM":3,"outputPerM":6,"cacheReadPerM":null,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"qwen3.7-max","displayName":"qwen3.7-max","contextWindow":1000000,"maxTokens":131072,"features":["tools","reasoning"],"pricing":{"inputPerM":12,"outputPerM":36,"cacheReadPerM":2.4,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"kimi-k2.7-code","displayName":"kimi-k2.7-code","contextWindow":256000,"maxTokens":16000,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":6.5,"outputPerM":27,"cacheReadPerM":1.3,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"glm-5.2","displayName":"glm-5.2","contextWindow":1000000,"maxTokens":128000,"features":["tools","reasoning","anthropic"],"pricing":{"inputPerM":8,"outputPerM":28,"cacheReadPerM":2,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"qwen3.8-max","displayName":"qwen3.8-max","contextWindow":1000000,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":12,"outputPerM":36,"cacheReadPerM":1.5,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"deepseek-v4-flash-0731","displayName":"deepseek-v4-flash-0731","contextWindow":1000000,"maxTokens":384000,"features":["tools","reasoning"],"pricing":{"inputPerM":3,"outputPerM":9,"cacheReadPerM":0.1,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"seed-2.1-turbo","displayName":"seed-2.1-turbo","contextWindow":262144,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":3,"outputPerM":15,"cacheReadPerM":0.6,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"seed-2.1-pro","displayName":"seed-2.1-pro","contextWindow":262144,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":6,"outputPerM":30,"cacheReadPerM":1.2,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"deepseek-v4-pro-0813","displayName":"deepseek-v4-pro-0813","contextWindow":1000000,"maxTokens":384000,"features":["tools","reasoning","anthropic"],"pricing":{"inputPerM":9,"outputPerM":27,"cacheReadPerM":0.3,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"glm-5.3","displayName":"glm-5.3","contextWindow":1048576,"maxTokens":131072,"features":["tools","reasoning"],"pricing":{"inputPerM":8,"outputPerM":28,"cacheReadPerM":2,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"qwen3.7-flash","displayName":"qwen3.7-flash","contextWindow":1000000,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":1.2,"outputPerM":4.8,"cacheReadPerM":0.24,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"qwen3.8-27b","displayName":"qwen3.8-27b","contextWindow":1000000,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":3,"outputPerM":12,"cacheReadPerM":0.6,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"longcat-2.0","displayName":"longcat-2.0","contextWindow":1000000,"maxTokens":128000,"features":["tools","reasoning"],"pricing":{"inputPerM":5,"outputPerM":20,"cacheReadPerM":0.1,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"glm-5.3-flash","displayName":"glm-5.3-flash","contextWindow":1048576,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":0.8,"outputPerM":2.8,"cacheReadPerM":0.23,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"qwen3.8-flash","displayName":"qwen3.8-flash","contextWindow":1000000,"maxTokens":131072,"features":["tools","reasoning","vision"],"pricing":{"inputPerM":0.8,"outputPerM":2.7,"cacheReadPerM":0.1,"cacheWritePerM":null},"currency":"CNY"},
  {"id":"deepseek-flash","displayName":"deepseek-flash","contextWindow":1000000,"maxTokens":384000,"features":["tools","reasoning","anthropic","vision"],"pricing":{"inputPerM":2,"outputPerM":8,"cacheReadPerM":0.04,"cacheWritePerM":null},"currency":"CNY"},
];

const PRESETS: ModelPreset[] = RAW.map((p) => {
  const keys = new Set<string>([p.id.toLowerCase(), normalizeModelKey(p.id)]);
  return { ...p, matchKeys: [...keys] };
});

const BY_KEY = new Map<string, ModelPreset>();
for (const p of PRESETS) for (const k of p.matchKeys) if (!BY_KEY.has(k)) BY_KEY.set(k, p);

/** 按模型名查内置目录（先精确、再归一化；找不到返回 null） */
export function findModelPreset(modelId: string): ModelPreset | null {
  const raw = modelId.trim();
  if (!raw) return null;
  return BY_KEY.get(raw.toLowerCase()) ?? BY_KEY.get(normalizeModelKey(raw)) ?? null;
}

export function listModelPresets(): ModelPreset[] {
  return PRESETS;
}
