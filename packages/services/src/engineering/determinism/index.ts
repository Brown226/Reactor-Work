/**
 * 工程确定性体系：输入预检 + 输出门禁。
 *
 * 这是产品能否用于工程交付的前提，不是可选项。
 * 三道闸：规格预检（提交前）→ 执行契约（过程中）→ 证据门禁（结果判定）。
 * 本模块实现第一道与第三道；执行契约由 CONTRACT.md 与各技能的约束承担。
 */

export {
  REQUIRED_SPEC_FIELDS,
} from "./types.js";
export type {
  RequiredSpecField,
  AnalysisSpec,
  PreflightStatus,
  PreflightIssue,
  PreflightResult,
  AcceptanceOperator,
  AcceptanceCriterion,
  EvidenceVerdict,
  EvidenceIssue,
} from "./types.js";

export { preflightSpec, describePreflight } from "./preflight.js";
export { evaluateEvidence, describeVerdict } from "./evidence.js";
