/**
 * 上下文用量标尺的**单一算术**（W0-4）—— sidecar 与客户端共用，避免两处各算一份而漂移。
 *
 * ## 为什么需要它（修正的显示缺陷）
 *
 * Pi 的 `getContextUsage().percent` 分母是**模型上下文窗口**（`agent-session.js`:
 * `percent = estimate.tokens / contextWindow * 100`）。这在「1M 窗口 + 128k 压缩阈值」的
 * 模型上会严重误导：已经压过一大半了，圆环却只显示个位数百分比 → 用户以为「上下文还很空」。
 *
 * penguin 的做法（`llm/context-limits.ts`）：圆环标尺取**压缩阈值的生效值**
 * `min(Agent 阈值, 模型窗口 − 余量)`，与 Agent 实际触发压缩用的推导**是同一份**。
 *
 * ## 为什么直接复刻 Pi 的阈值公式
 *
 * Pi 自己的判定是（`agent-session.js` 的 `shouldCompact`）：
 *   `contextTokens > contextWindow - settings.reserveTokens`
 * 所以阈值就是 `contextWindow - reserveTokens`。这里**照抄同一条公式**，
 * 保证「圆环到达 100%」与「内核真的触发压缩」是同一时刻，而不是两个近似值。
 *
 * ## 回退（不编造数字）
 *
 * 压缩关闭、或窗口/阈值不可得时，回退为**模型窗口**标尺（与修复前的口径一致），
 * 并在结果里标明 `basis`，让 UI 与探针都能看出用的是哪把尺。
 */

/** 阈值低于窗口的这个比例时认为配置不可信（防 reserveTokens 配成几乎等于窗口） */
const MIN_THRESHOLD_RATIO = 0.01;

export interface ContextScaleInput {
  /** 模型上下文窗口（tokens）；未知/0 表示不可用 */
  contextWindow?: number | null;
  /** 压缩是否开启（Pi `getCompactionSettings().enabled`） */
  compactionEnabled?: boolean | null;
  /** 压缩预留 tokens（Pi `getCompactionSettings().reserveTokens`） */
  reserveTokens?: number | null;
}

export interface ContextScale {
  /** 模型上下文窗口（0 = 未知） */
  modelWindow: number;
  /**
   * 压缩阈值生效值（=窗口−预留）；不可得时为 0，
   * 此时调用方应以 `modelWindow` 为标尺（见 `basis`）。
   */
  compactionThreshold: number;
  /** 当前用哪把尺：`compaction` = 阈值生效值；`window` = 回退到模型窗口 */
  basis: "compaction" | "window";
}

/**
 * 推导上下文用量标尺。
 *
 * 返回的 `compactionThreshold` 与 Pi `shouldCompact` 完全同式，因此
 * `percentOfScale(tokens, scale)` 达到 100% 即内核触发压缩的那一刻。
 */
export function resolveContextScale(input: ContextScaleInput): ContextScale {
  const window = Number.isFinite(input.contextWindow) ? Math.max(0, Math.trunc(input.contextWindow as number)) : 0;
  const reserve = Number.isFinite(input.reserveTokens) ? Math.max(0, Math.trunc(input.reserveTokens as number)) : 0;
  const enabled = input.compactionEnabled === true;

  if (!enabled || window <= 0) {
    return { modelWindow: window, compactionThreshold: 0, basis: "window" };
  }

  const threshold = window - reserve;
  // 阈值必须为正且不贴着窗口（否则「有效阈值」与「窗口」没有区分意义）
  if (threshold <= 0 || threshold < window * MIN_THRESHOLD_RATIO) {
    return { modelWindow: window, compactionThreshold: 0, basis: "window" };
  }

  return { modelWindow: window, compactionThreshold: threshold, basis: "compaction" };
}

/** 可取用的标尺分母（0 = 不可用） */
export function scaleDenominator(scale: ContextScale): number {
  return scale.basis === "compaction" ? scale.compactionThreshold : scale.modelWindow;
}

/**
 * 按标尺算百分比。分母不可用时返回 `null`（**不编造数字** —— 与 Pi 在
 * 「压缩后尚无 usage」时返回 percent: null 同一取向）。
 */
export function percentOfScale(tokens: number | null | undefined, scale: ContextScale): number | null {
  if (tokens == null || !Number.isFinite(tokens)) return null;
  const denom = scaleDenominator(scale);
  if (denom <= 0) return null;
  return (tokens / denom) * 100;
}

/** token 数格式化（环形 tooltip / 面板共用） */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.trunc(n));
}
