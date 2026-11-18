/**
 * 计算结果的可信交付流程：把预检、执行、门禁串成一条链。
 *
 * 逆向自 PKPM Agent 的工程确定性体系。三步缺一不可：
 *   1. 提交前预检规格 —— 缺项就停，不替用户补
 *   2. 执行计算
 *   3. 用证据门禁判定结果 —— 未通过只能报告未验证
 *
 * 为什么需要这个编排而不是让调用方自己拼：
 * 三步的顺序与「失败即停」的语义是这套体系的核心。拆散给调用方
 * 拼装，很容易变成「预检有警告也继续跑」或「算完直接说成功」——
 * 那正是这套设计要防的事。
 */

import type { AnalysisSpec, AcceptanceCriterion, PreflightResult } from "../determinism/types.js";
import { describePreflight, preflightSpec } from "../determinism/preflight.js";
import type { EvidenceVerdict } from "../determinism/types.js";
import { describeVerdict, evaluateEvidence } from "../determinism/evidence.js";

/** 一次可信交付的输入。 */
export interface VerifiedRunRequest {
  /** 分析规格；缺项会在预检阶段被拦下。 */
  spec: AnalysisSpec;
  /** 执行计算的函数；预检通过后才会被调用。 */
  run: () => Promise<{ ok: boolean; error?: string; evidence?: Record<string, unknown> }>;
  /** 验收标准；缺省取规格里的。 */
  criteria?: AcceptanceCriterion[];
}

/** 可信交付的结果。 */
export interface VerifiedRunResult {
  /** 整体是否可用于交付。 */
  deliverable: boolean;
  /** 停在哪一步。 */
  stage: "preflight" | "run" | "gate" | "done";
  /** 面向用户的完整说明。 */
  summary: string;
  preflight?: PreflightResult;
  verdict?: EvidenceVerdict;
}

/**
 * 执行一次带验证的计算。
 *
 * 每一步失败都立即返回，不继续下一步。这是有意为之：
 * 预检不过就跑计算，等于把不合格的输入送进求解器；
 * 门禁不过就交付，等于把未验证的结果当设计依据。
 */
export async function verifiedRun(request: VerifiedRunRequest): Promise<VerifiedRunResult> {
  // 第一步：预检。FAIL 直接停，WARN 继续但保留提示。
  const preflight = preflightSpec(request.spec);
  if (preflight.status === "FAIL" || preflight.status === "UNSUPPORTED") {
    return {
      deliverable: false,
      stage: "preflight",
      summary: describePreflight(preflight),
      preflight,
    };
  }

  // 第二步：执行。
  const runResult = await request.run();
  if (!runResult.ok) {
    return {
      deliverable: false,
      stage: "run",
      summary: `计算未完成：${runResult.error ?? "求解器返回失败"}\n\n${
        preflight.warnings.length > 0 ? describePreflight(preflight) : ""
      }`.trim(),
      preflight,
    };
  }

  // 第三步：门禁。没有证据就无法判定，等同于未验证。
  const criteria = request.criteria ?? extractCriteria(request.spec);
  if (criteria.length === 0) {
    return {
      deliverable: false,
      stage: "gate",
      summary:
        "计算已完成，但规格里没有可用于判定的验收标准，结果未经确认，不能作为设计依据。",
      preflight,
    };
  }

  const evidence = runResult.evidence ?? {};
  const verdict = evaluateEvidence(criteria, evidence);

  if (!verdict.passed) {
    return {
      deliverable: false,
      stage: "gate",
      summary: describeVerdict(verdict),
      preflight,
      verdict,
    };
  }

  // 全部通过：把预检的 WARN 一并带上，不让它消失在成功消息里。
  const warns =
    preflight.status === "WARN" ? `\n\n注意：\n${describePreflight(preflight)}` : "";
  return {
    deliverable: true,
    stage: "done",
    summary: `${describeVerdict(verdict)}${warns}`,
    preflight,
    verdict,
  };
}

/** 从规格里取验收标准；形状不对时返回空数组，不猜。 */
function extractCriteria(spec: AnalysisSpec): AcceptanceCriterion[] {
  const raw = spec.acceptance_criteria;
  if (!Array.isArray(raw)) return [];
  const result: AcceptanceCriterion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const metric = typeof record.metric === "string" ? record.metric : undefined;
    const operator = record.operator;
    if (!metric) continue;
    if (operator !== "between" && operator !== "approximately" && operator !== "review") continue;
    const criterion: AcceptanceCriterion = { metric, operator };
    if (Array.isArray(record.limit) && record.limit.length === 2) {
      const [lower, upper] = record.limit;
      if (typeof lower === "number" && typeof upper === "number") {
        criterion.limit = [lower, upper];
      }
    } else if (record.limit && typeof record.limit === "object") {
      const limit = record.limit as Record<string, unknown>;
      if (typeof limit.target === "number" && typeof limit.tolerance === "number") {
        criterion.limit = { target: limit.target, tolerance: limit.tolerance };
      }
    }
    if (typeof record.source === "string") criterion.source = record.source;
    result.push(criterion);
  }
  return result;
}

export { extractCriteria };
