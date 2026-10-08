/**
 * 用量上报器骨架（P4.1a：只做过滤 + 映射 + 入队，**不接线、不发起网络**）。
 *
 * 接线的部分留给 P4.1b：订阅 Host 的 `task_token_usage_delta`、按 30s 合并窗口 / 登录 / 退出触发 flush、
 * 通过 `reactorServerClient` POST `/desktop/audit/batch`。这样切片的边界是"纯逻辑可单测、网络单独接"。
 *
 * 过滤口径见 docs/未完成-服务端接线-P4-用量上报与策略.md §4.1，与模型治理契约同源：
 * **只报企业 provider 的调用**；开发者模式旁路的本地模型有意不报（产品既定，不是缺口）。
 */
import type { AuditOutbox } from "./auditOutbox.js";
import {
  buildBehaviorAuditEvent,
  buildModelCallAuditEvent,
  hasBillableUsage,
  type BehaviorAuditFact,
  type ModelCallUsageDelta,
} from "./auditEventMapping.js";

/** 上报上下文：由接线方（Host）从既有服务读好后传入，Reporter 不自己去查凭据或 devMode。 */
export interface ModelCallReportContext {
  /** 已登录企业服务端（未登录时不发起上报，事件留在本地等登录）。 */
  enterpriseLoggedIn: boolean;
  /** 本次调用的 provider 是否为企业哨兵条目（`isReactorServerManagedApiKey`）。 */
  enterpriseProvider: boolean;
}

/** 是否该把这条模型调用计入上报（三个条件同时满足；querySource v1 不区分）。 */
export function shouldReportModelCall(
  delta: ModelCallUsageDelta,
  context: ModelCallReportContext,
): boolean {
  if (!context.enterpriseLoggedIn) return false;
  if (!context.enterpriseProvider) return false;
  return hasBillableUsage(delta);
}

export interface AuditReporter {
  /** 记录一条模型调用用量；返回是否真的入队（便于探针/单测断言）。 */
  recordModelCallUsage(
    delta: ModelCallUsageDelta,
    context: ModelCallReportContext,
  ): Promise<boolean>;
  /**
   * 记录一条行为事实（tool_call / approval / policy_block，洞②）；返回是否真的入队。
   * 门禁只有企业登录态：这三类是受管设备的行为/治理审计、不计费，组织策略在本地模型
   * 会话同样生效，按 provider 过滤会漏掉旁路会话里的拦截记录（与 model_call 口径不同处）。
   */
  recordBehaviorFact(
    fact: BehaviorAuditFact,
    context: BehaviorReportContext,
  ): Promise<boolean>;
}

/** 行为事实上报上下文：登录态现读，无 provider 维度（见 recordBehaviorFact 注释）。 */
export interface BehaviorReportContext {
  enterpriseLoggedIn: boolean;
}

export function createAuditReporter(options: {
  outbox: AuditOutbox;
  /** 可注入时钟，便于单测；缺省 `new Date().toISOString()`。 */
  now?: () => string;
}): AuditReporter {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async recordModelCallUsage(delta, context) {
      if (!shouldReportModelCall(delta, context)) return false;
      const event = buildModelCallAuditEvent(delta, { ts: now() });
      if (!event) return false;
      await options.outbox.append([event]);
      return true;
    },
    async recordBehaviorFact(fact, context) {
      if (!context.enterpriseLoggedIn) return false;
      const event = buildBehaviorAuditEvent(fact, { ts: now() });
      if (!event) return false;
      await options.outbox.append([event]);
      return true;
    },
  };
}
