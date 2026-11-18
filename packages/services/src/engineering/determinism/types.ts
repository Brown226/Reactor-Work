/**
 * 工程确定性体系：分析规格与证据门禁的类型定义。
 *
 * 逆向自 PKPM Agent 的 Abaqus-Link：
 *   - analysis-spec.schema.json 定义 12 个必填字段
 *   - preflight_analysis_spec.py (823 行) 做输入预检
 *   - evaluate_result_evidence.py (736 行) 做输出门禁
 *
 * 核心原则（技能原文）：
 *   「结构校验失败时报告缺项并停止，不能自行补材料、单位、边界条件、
 *     验收阈值。」——LLM 最擅长补全，工程场景这是灾难。
 */

/** 分析规格的 12 个必填字段。缺一个就不许提交计算。 */
export const REQUIRED_SPEC_FIELDS = [
  "schema_version",
  "analysis_type",
  "units",
  "materials",
  "geometry",
  "steps",
  "boundary_conditions",
  "connections",
  "loads",
  "mesh",
  "outputs",
  "acceptance_criteria",
] as const;

export type RequiredSpecField = (typeof REQUIRED_SPEC_FIELDS)[number];

/** 分析规格；字段值不做结构假设，由预检逐项判断。 */
export interface AnalysisSpec {
  schema_version?: unknown;
  name?: unknown;
  model_name?: unknown;
  job_name?: unknown;
  analysis_type?: unknown;
  units?: unknown;
  materials?: unknown;
  geometry?: unknown;
  steps?: unknown;
  boundary_conditions?: unknown;
  connections?: unknown;
  loads?: unknown;
  mesh?: unknown;
  outputs?: unknown;
  acceptance_criteria?: unknown;
  metadata?: unknown;
}

/** 预检结论。 */
export type PreflightStatus = "PASS" | "WARN" | "FAIL" | "UNSUPPORTED";

export interface PreflightIssue {
  /** 出问题的字段路径，如 `materials.0.elastic`。 */
  field: string;
  /** 面向用户的原因说明。 */
  reason: string;
  /** 建议动作；FAIL 时说清「缺什么」，WARN 时说清「交给谁判断」。 */
  suggestion?: string;
}

export interface PreflightResult {
  status: PreflightStatus;
  /** FAIL / UNSUPPORTED 时列出缺项与阻断原因。 */
  blocking: PreflightIssue[];
  /** WARN 时必须连同证据交给用户判断，不得自行放行。 */
  warnings: PreflightIssue[];
}

/** 验收操作符。三种，其中 review 永远不自动通过。 */
export type AcceptanceOperator = "between" | "approximately" | "review";

/** 单条验收标准。 */
export interface AcceptanceCriterion {
  /** 要核对的量名，对应 evidence 里的 key。 */
  metric: string;
  operator: AcceptanceOperator;
  /** between: [下界, 上界]；approximately: {target, tolerance}；review: 可省略。 */
  limit?: [number, number] | { target: number; tolerance: number };
  /** 说明这条标准从哪来（规范条号、用户要求）。 */
  source?: string;
}

export interface EvidenceVerdict {
  passed: boolean;
  /** 未通过的逐条原因；通过时为空数组。 */
  reasons: EvidenceIssue[];
  /** 通过 / 未通过 / 需人工判断 的条目统计。 */
  summary: { passed: number; failed: number; needsReview: number };
}

export interface EvidenceIssue {
  metric: string;
  reason: string;
  /** 实际取到的值；缺测时为 undefined。 */
  actual?: number;
  /** 期望的范围或目标，供报告引用。 */
  expected?: string;
}
