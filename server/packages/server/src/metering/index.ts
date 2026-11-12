/**
 * 计量数据域（额度分配 P1）公开入口。
 *
 * 跨模块只从这里导入（server/AGENTS.md「跨模块只从公开入口导入」）：
 *  - `schema`：建表（identity 启动批调用）
 *  - `repo`：写入（仅 gateway）、聚合（报表/告警/执行前计数）、回读
 */

export { ensureMeteringSchema } from "./schema.js";
export { ensureQuotaSchema } from "./quota-schema.js";
export {
  aggregateUsage,
  getLedgerRow,
  recordUsage,
  summarizeLedgerUsage,
  type LedgerGroupBy,
  type LedgerOutcome,
  type LedgerSubjectKind,
  type UsageLedgerEntry,
  type UsageLedgerFilter,
  type UsageLedgerRecord,
  type UsageLedgerTotals,
} from "./repo.js";
export {
  deleteQuotaRule,
  deptAncestorIds,
  deptSubtreeIds,
  existingDeptIds,
  existingRuleScopeKeys,
  listActiveUidsInDepts,
  listEnabledQuotaRules,
  listQuotaRules,
  resolveApplicableRules,
  uidStatusMap,
  upsertQuotaRule,
  type QuotaAction,
  type QuotaRule,
  type QuotaRuleInput,
  type QuotaScopeType,
} from "./quota-repo.js";
export {
  currentPeriod,
  evaluateQuotaFor,
  evaluateRules,
  listScopedQuotaAlerts,
  periodRange,
  summarizeRulesUsage,
  type QuotaEvaluation,
  type RuleUsage,
  type RuleUsageSummary,
  type ScopedQuotaAlert,
} from "./quota-eval.js";
export {
  applyQuotaBatch,
  MAX_BATCH_TARGETS,
  planQuotaBatch,
  QuotaBatchError,
  type QuotaBatchInput,
  type QuotaBatchPlan,
  type QuotaBatchResolved,
  type QuotaBatchResult,
  type QuotaBatchSkipped,
  type QuotaBatchTarget,
} from "./quota-batch.js";
