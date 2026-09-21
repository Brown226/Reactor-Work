/**
 * 生成内置模型目录 `packages/server/src/gateway/model-presets.ts`（P1）。
 *
 * 为什么要有这个脚本：内置目录必须是**实测快照**而不是凭印象写的常量。上游改价/换窗口后，
 * 用它重新采集即可，避免「手抄一遍数字」既不透明也容易错。
 *
 * 用法（在仓库根执行）：
 *   # ① 从已有的 discover 结果生成（推荐：先在管理台「从上游拉取」一次，把响应存成 json）
 *   node packages/server/scripts/gen-model-presets.mjs --from .runtime/p0/discover2.json --write
 *
 *   # ② 直接打上游（需要能用的 key；会真实请求上游 /models，不消耗模型额度）
 *   node packages/server/scripts/gen-model-presets.mjs --base-url https://x.studio/v1 --api-key sk-xxx --write
 *
 *   # 不加 --write 只打印到 stdout（便于先 diff 再落盘）
 *
 * 采集时间会写入生成文件的注释里，便于判断快照是否过期。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = `${ROOT}packages/server/src/gateway/model-presets.ts`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * 上游 /models 单项 → 预设条目。
 *
 * ⚠ 兼容两种字段口径（生产上两种都会遇到）：
 *   · 上游原始响应：下划线（`context_length` / `supports_tools` / `input_price_per_million`）
 *   · 管理台 discover 响应：驼峰（`contextWindow` / `supportsTools` / `inputPricePer1M`，可直接喂给本脚本）
 */
function toEntry(raw) {
  const pick = (camel, snake) => (raw[camel] !== undefined ? raw[camel] : raw[snake]);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const id = String(raw.id ?? "").trim();
  const features = Array.isArray(raw.features)
    ? raw.features.filter((f) => typeof f === "string")
    : [
        pick("supportsTools", "supports_tools") ? "tools" : "",
        pick("supportsReasoning", "supports_reasoning") ? "reasoning" : "",
        pick("supportsAnthropic", "supports_anthropic") ? "anthropic" : "",
        pick("supportsVision", "supports_vision") ? "vision" : "",
      ].filter((f) => f !== "");
  return {
    id,
    displayName: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    contextWindow: num(pick("contextWindow", "context_length")),
    maxTokens: num(pick("maxTokens", "max_completion_tokens")),
    features,
    pricing: {
      inputPerM: num(pick("inputPricePer1M", "input_price_per_million")),
      outputPerM: num(pick("outputPricePer1M", "output_price_per_million")),
      cacheReadPerM: num(pick("cacheReadPricePer1M", "cache_read_price_per_million")),
      cacheWritePerM: num(pick("cacheWritePricePer1M", "cache_write_price_per_million")),
    },
    currency: typeof raw.currency === "string" ? raw.currency : null,
  };
}

async function collect() {
  const from = arg("from");
  if (from) {
    const parsed = JSON.parse(readFileSync(from, "utf8"));
    // 兼容两种形状：discover 响应 { models: [...] } 或 { data: [...] }（原始上游响应）
    const list = Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed?.data) ? parsed.data : null;
    if (!list) throw new Error(`${from} 里既没有 models[] 也没有 data[]`);
    const entries = list.map(toEntry).filter((e) => e.id);
    // 快照里若整片缺元数据，明确报错，别生成一份“全是 null”的假目录
    const withMeta = entries.filter((e) => e.contextWindow !== null || e.pricing.inputPerM !== null).length;
    if (entries.length > 0 && withMeta === 0) {
      throw new Error(`${from} 里 ${entries.length} 条全都没有窗口/价目字段 —— 字段口径不对？请检查该快照来源`);
    }
    return { entries, source: `discover 响应快照（${from}）`, withMeta };
  }

  const baseUrl = arg("base-url");
  const apiKey = arg("api-key");
  if (!baseUrl || !apiKey) {
    throw new Error("需要 --from <json> 或 --base-url/--api-key（见文件头注释）");
  }
  const target = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  const res = await fetch(target, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`上游 /models 返回 HTTP ${res.status}`);
  const payload = await res.json();
  const entries = (payload?.data ?? []).map(toEntry).filter((e) => e.id);
  return { entries, source: `上游 ${target}` };
}

function render({ entries, source }) {
  const stamp = new Date().toISOString().slice(0, 10);
  const rows = entries.map((e) => `  ${JSON.stringify(e)},`).join("\n");
  const L = [];
  L.push("/**");
  L.push(" * 内置模型目录（P1）：按模型名给「窗口 / 最大输出 / 能力 / 四段价」，用于");
  L.push(" *   ① 管理台「一键填充」（含撤销）");
  L.push(" *   ② 上游 /models 只回 id 时的兜底（discover 会用它补齐，并在 UI 上标注来源）");
  L.push(" *");
  L.push(" * ⚠ 这是**实测快照**，不是凭印象写的常量。刷新方式：");
  L.push(" *   node packages/server/scripts/gen-model-presets.mjs --from <discover.json> --write");
  L.push(" *   node packages/server/scripts/gen-model-presets.mjs --base-url <上游 /v1> --api-key <key> --write");
  L.push(` * 本次快照：${stamp} · 来源 ${source} · ${entries.length} 条`);
  L.push(" *");
  L.push(" * ⚠ 快照会过期（上游改价后这里仍是旧值）→ UI 上对「只来自预设」的字段会标注来源。");
  L.push(" * 单位与 pi 一致：元 / 百万 tokens（见 common/pricing.ts）。");
  L.push(" */");
  L.push("");
  L.push('import type { ModelPricing } from "../common/pricing.js";');
  L.push("");
  L.push("export interface ModelPreset {");
  L.push("  /** 规范模型名（上游真实 id） */");
  L.push("  id: string;");
  L.push("  /** 归一化匹配键（去 vendor 前缀 / 去日期后缀），由 normalizeModelKey 生成 */");
  L.push("  matchKeys: string[];");
  L.push("  displayName: string;");
  L.push("  contextWindow: number | null;");
  L.push("  maxTokens: number | null;");
  L.push("  /** 能力标记：tools / reasoning / anthropic / vision（与 registry.KNOWN_FEATURES 一致） */");
  L.push("  features: string[];");
  L.push("  pricing: ModelPricing;");
  L.push("  currency: string | null;");
  L.push("}");
  L.push("");
  L.push("/** 预设来源说明（管理台直接展示，避免被误当成上游实时值） */");
  L.push(`export const MODEL_PRESET_SOURCE = ${JSON.stringify(`内置快照 · ${stamp} · ${entries.length} 条`)};`);
  L.push("");
  L.push("/**");
  L.push(" * 归一化匹配键：小写 → 去 vendor/ 前缀 → 去 -MMDD 日期后缀。");
  L.push(" * 例：`deepseek-v4-flash-0731` → `deepseek-v4-flash`；`openai/gpt-4o` → `gpt-4o`。");
  L.push(" */");
  L.push("export function normalizeModelKey(raw: string): string {");
  L.push("  let s = raw.trim().toLowerCase();");
  L.push('  const slash = s.lastIndexOf("/");');
  L.push("  if (slash >= 0) s = s.slice(slash + 1);");
  L.push('  s = s.replace(/-\\d{4}$/, "");');
  L.push("  return s;");
  L.push("}");
  L.push("");
  L.push("/** 原始记录（由脚本生成；勿手改数值——改了它就不再是快照） */");
  L.push('const RAW: Array<Omit<ModelPreset, "matchKeys">> = [');
  L.push(rows);
  L.push("];");
  L.push("");
  L.push("const PRESETS: ModelPreset[] = RAW.map((p) => {");
  L.push("  const keys = new Set<string>([p.id.toLowerCase(), normalizeModelKey(p.id)]);");
  L.push("  return { ...p, matchKeys: [...keys] };");
  L.push("});");
  L.push("");
  L.push("const BY_KEY = new Map<string, ModelPreset>();");
  L.push("for (const p of PRESETS) for (const k of p.matchKeys) if (!BY_KEY.has(k)) BY_KEY.set(k, p);");
  L.push("");
  L.push("/** 按模型名查内置目录（先精确、再归一化；找不到返回 null） */");
  L.push("export function findModelPreset(modelId: string): ModelPreset | null {");
  L.push("  const raw = modelId.trim();");
  L.push("  if (!raw) return null;");
  L.push("  return BY_KEY.get(raw.toLowerCase()) ?? BY_KEY.get(normalizeModelKey(raw)) ?? null;");
  L.push("}");
  L.push("");
  L.push("export function listModelPresets(): ModelPreset[] {");
  L.push("  return PRESETS;");
  L.push("}");
  L.push("");
  return L.join("\n");
}

const collected = await collect();
const text = render(collected);
if (has("write")) {
  writeFileSync(OUT, text);
  console.log(`已写入 ${OUT}（${collected.entries.length} 条，来源 ${collected.source}）`);
} else {
  process.stdout.write(text);
}
