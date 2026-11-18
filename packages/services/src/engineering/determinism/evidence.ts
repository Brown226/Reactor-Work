/**
 * 输出门禁：用确定性代码判定计算结果是否可信。
 *
 * 逆向自 Abaqus-Link 的 evaluate_result_evidence.py。
 *
 * 最要紧的一条（原文）：门禁未通过时**只能报告未验证或失败**，
 * 不能仅凭求解器的 COMPLETED 宣称结果正确。
 *
 * 三种操作符：
 *   between       数值落在闭区间
 *   approximately 数值在目标±容差内
 *   review        必须人工判断，永远不自动通过
 *
 * `review` 永远返回 false 是有意为之：有些工程判定 AI 不许自己下结论。
 */

import type {
  AcceptanceCriterion,
  EvidenceIssue,
  EvidenceVerdict,
} from "./types.js";

/** 判定单条标准的结果。 */
type CriterionOutcome = "passed" | "failed" | "needsReview";

interface CriterionEvaluation {
  outcome: CriterionOutcome;
  issue?: EvidenceIssue;
}

function evaluateCriterion(
  criterion: AcceptanceCriterion,
  evidence: Record<string, unknown>,
): CriterionEvaluation {
  const raw = evidence[criterion.metric];

  // review 不看 evidence：它本来就是要人来判的。
  if (criterion.operator === "review") {
    return {
      outcome: "needsReview",
      issue: {
        metric: criterion.metric,
        reason: "该项需要人工判断，不能自动通过。",
        expected: criterion.source,
      },
    };
  }

  // 取不到值一律判失败：缺测不等于通过。
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return {
      outcome: "failed",
      issue: {
        metric: criterion.metric,
        reason:
          raw === undefined
            ? "证据中缺少该量的实测值，无法判定。"
            : `实测值不是有效数字（${String(raw)}），无法判定。`,
        expected: describeLimit(criterion),
      },
    };
  }

  const value = raw;

  if (criterion.operator === "between") {
    const limit = criterion.limit;
    if (!Array.isArray(limit) || limit.length !== 2) {
      return {
        outcome: "failed",
        issue: {
          metric: criterion.metric,
          reason: "between 需要 [下界, 上界] 形式的限值。",
          actual: value,
        },
      };
    }
    const [lower, upper] = limit;
    if (value >= lower && value <= upper) return { outcome: "passed" };
    return {
      outcome: "failed",
      issue: {
        metric: criterion.metric,
        reason: `实测值 ${value} 不在 [${lower}, ${upper}] 内。`,
        actual: value,
        expected: `[${lower}, ${upper}]`,
      },
    };
  }

  // approximately
  const limit = criterion.limit;
  if (!limit || Array.isArray(limit) || typeof limit !== "object") {
    return {
      outcome: "failed",
      issue: {
        metric: criterion.metric,
        reason: "approximately 需要 {target, tolerance} 形式的限值。",
        actual: value,
      },
    };
  }
  const { target, tolerance } = limit;
  if (typeof target !== "number" || typeof tolerance !== "number") {
    return {
      outcome: "failed",
      issue: {
        metric: criterion.metric,
        reason: "approximately 的 target 与 tolerance 必须是数字。",
        actual: value,
      },
    };
  }
  const deviation = Math.abs(value - target);
  if (deviation <= tolerance) return { outcome: "passed" };
  return {
    outcome: "failed",
    issue: {
      metric: criterion.metric,
      reason: `实测值 ${value} 偏离目标 ${target} 达 ${deviation}，超出容差 ${tolerance}。`,
      actual: value,
      expected: `${target} ± ${tolerance}`,
    },
  };
}

function describeLimit(criterion: AcceptanceCriterion): string {
  const limit = criterion.limit;
  if (Array.isArray(limit)) return `[${limit[0]}, ${limit[1]}]`;
  if (limit && typeof limit === "object" && !Array.isArray(limit)) {
    return `${limit.target} ± ${limit.tolerance}`;
  }
  return "未指定";
}

/**
 * 对一批验收标准求值。
 *
 * 判定规则：
 *   - 任何一条 failed → 整体不通过
 *   - 没有 failed 但有 needsReview → 整体不通过（需人工确认后才能算通过）
 *   - 全部 passed → 通过
 *
 * 这样 `review` 项不会因为「其它项都过了」而被顺带放过。
 */
export function evaluateEvidence(
  criteria: AcceptanceCriterion[],
  evidence: Record<string, unknown>,
): EvidenceVerdict {
  const reasons: EvidenceIssue[] = [];
  const summary = { passed: 0, failed: 0, needsReview: 0 };

  for (const criterion of criteria) {
    const { outcome, issue } = evaluateCriterion(criterion, evidence);
    if (outcome === "passed") {
      summary.passed += 1;
      continue;
    }
    if (outcome === "needsReview") summary.needsReview += 1;
    else summary.failed += 1;
    if (issue) reasons.push(issue);
  }

  return {
    passed: summary.failed === 0 && summary.needsReview === 0,
    reasons,
    summary,
  };
}

/**
 * 生成面向用户的结论文本。
 *
 * 不通过时不要说「结果正确」，也不要说「计算失败」——计算可能真的算完了，
 * 只是没通过验证。措辞必须区分这三件事。
 */
export function describeVerdict(verdict: EvidenceVerdict): string {
  if (verdict.passed) {
    return `结果已通过全部 ${verdict.summary.passed} 项验收。`;
  }

  const lines: string[] = [];
  if (verdict.summary.failed > 0) {
    lines.push(`结果未通过验收（${verdict.summary.failed} 项不通过，${verdict.summary.passed} 项通过）：`);
  } else {
    lines.push(`结果需要人工确认（${verdict.summary.needsReview} 项待判定，${verdict.summary.passed} 项通过）：`);
  }
  for (const reason of verdict.reasons) {
    lines.push(`- ${reason.metric}：${reason.reason}`);
  }
  lines.push("");
  lines.push("计算本身可能已经完成，但结果未经确认，不能作为设计依据。");
  return lines.join("\n");
}
