/**
 * main 进程事件循环延迟（event loop lag）采样。
 *
 * 背景：Reactor 已有完整的启动时间线（`shared/src/launchMarks.ts` 的 T0–T3 +
 * `ui/lib/launchToInputReport.ts` 的 T4–T6 + `uiPerfArmsTelemetry` 的分阶段上报），
 * 但没有任何"运行期主进程是否被阻塞"的观测。内网排障（界面卡顿、定时器漂移）时，
 * 缺这一项就分不清是渲染慢还是主进程被同步任务堵住。
 *
 * 参考 Namiwork 的启动可观测思路，只补事件循环 lag 这一块；采样用 Node 内置
 * `perf_hooks.monitorEventLoopDelay`，零额外依赖。
 *
 * 设计取舍：
 * - 低频周期汇总（60s）+ 每周期重置，统计的是"本周期"而非进程累计，才可反映近期劣化；
 * - 定时器 unref()，不阻止进程退出；
 * - 纯观测，任何异常只记 warn，绝不影响主流程。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** 汇总周期（ms）。 */
const SAMPLE_INTERVAL_MS = 60_000;
/** p99 超过该值（ms）视为本周期主进程有明显阻塞，按 warn 输出。 */
const LAG_WARN_P99_MS = 100;

export interface EventLoopLagMonitorDeps {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** 便于测试注入；默认 60s。 */
  intervalMs?: number;
}

export interface EventLoopLagMonitor {
  stop: () => void;
}

/**
 * 启动事件循环延迟采样。返回的 `stop` 幂等，可安全重复调用。
 */
export function startEventLoopLagMonitor(deps: EventLoopLagMonitorDeps): EventLoopLagMonitor {
  const intervalMs = deps.intervalMs ?? SAMPLE_INTERVAL_MS;

  let histogram: IntervalHistogram | null = null;
  try {
    // resolution = 20ms：默认分辨率下高频小延迟会被四舍五入成 0，测不出真实抖动。
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch (error) {
    deps.logger.warn("[event-loop-lag] 采样器初始化失败，跳过运行期延迟观测", error);
    return { stop: () => {} };
  }

  const timer = setInterval(() => {
    try {
      const activeHistogram = histogram;
      if (!activeHistogram) {
        return;
      }
      const p50 = activeHistogram.percentile(50) / 1e6;
      const p99 = activeHistogram.percentile(99) / 1e6;
      const max = activeHistogram.max / 1e6;
      // 必须先读取 count 再 reset：reset() 会清零计数，顺序颠倒会让 samples 恒为 0。
      const samples = activeHistogram.count;
      // 每周期重置，避免长时间运行把统计拉平成累计值。
      activeHistogram.reset();

      const payload = {
        p50Ms: Math.round(p50),
        p99Ms: Math.round(p99),
        maxMs: Math.round(max),
        samples,
      };
      if (p99 >= LAG_WARN_P99_MS) {
        deps.logger.warn("[event-loop-lag] 主进程事件循环出现阻塞", payload);
      } else {
        deps.logger.info("[event-loop-lag]", payload);
      }
    } catch (error) {
      deps.logger.warn("[event-loop-lag] 采样汇总失败", error);
    }
  }, intervalMs);
  // 不阻止进程退出。
  timer.unref?.();

  let stopped = false;
  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      try {
        histogram?.disable();
      } catch {
        /* 关闭失败可忽略 */
      }
      histogram = null;
    },
  };
}
