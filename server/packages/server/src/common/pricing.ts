/**
 * 模型价目（四段价）与计费公式 —— 单一来源。
 *
 * 单位：**元 / 百万 tokens**（与 pi 的口径一致；pi 内部按 1e6 折算）。
 * 四段：input / output / cacheRead / cacheWrite。
 *  - 缓存读价远低于正价（命中缓存的输入），必须分项才能算准；
 *  - 历史遗漏：早期只配 input/output，缓存 token 会被按输入价计（保守，不低估消耗）。
 *
 * 计费归属：**服务端按此公式核算并落库**（见 audit/repo.ts），端侧上报的 cost 仅作对照，
 * 避免各端算法漂移导致额度与审计口径不一致。
 */

export interface ModelPricing {
  inputPerM: number | null;
  outputPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
}

/** 可直接用于计费的费率（四段都为数值）。 */
export interface PricingRates {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** 归一化 pricing（缺字段补 null；兼容只有两段的旧数据）。 */
export function normalizePricing(p: unknown): ModelPricing {
  const o = (p ?? {}) as Record<string, unknown>;
  return {
    inputPerM: numOrNull(o.inputPerM),
    outputPerM: numOrNull(o.outputPerM),
    cacheReadPerM: numOrNull(o.cacheReadPerM),
    cacheWritePerM: numOrNull(o.cacheWritePerM),
  };
}

/**
 * 补全为可计费费率；返回 null 表示**该模型无法计费**（连输入价都没配）。
 * 缓存价缺省回落输入价：宁可高估（更早触发额度告警），也不要低估消耗。
 */
export function effectiveRates(p: unknown): PricingRates | null {
  const n = normalizePricing(p);
  if (n.inputPerM === null) return null;
  return {
    inputPerM: n.inputPerM,
    outputPerM: n.outputPerM ?? n.inputPerM,
    cacheReadPerM: n.cacheReadPerM ?? n.inputPerM,
    cacheWritePerM: n.cacheWritePerM ?? n.inputPerM,
  };
}

export interface UsageTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

/** 计费：Σ(tokens × 对应费率) / 1e6。四舍五入到 6 位（与 NUMERIC(16,6) 对齐）。 */
export function computeCost(usage: UsageTokens, rates: PricingRates): number {
  const raw =
    (usage.inputTokens ?? 0) * rates.inputPerM +
    (usage.outputTokens ?? 0) * rates.outputPerM +
    (usage.cacheReadTokens ?? 0) * rates.cacheReadPerM +
    (usage.cacheWriteTokens ?? 0) * rates.cacheWritePerM;
  return Math.round((raw / 1_000_000) * 1e6) / 1e6;
}

/** 该用量是否含有需要计费的 token（用于判断要不要核算）。 */
export function hasBillableTokens(u: UsageTokens): boolean {
  return (
    (u.inputTokens ?? 0) > 0 || (u.outputTokens ?? 0) > 0 || (u.cacheReadTokens ?? 0) > 0 || (u.cacheWriteTokens ?? 0) > 0
  );
}
