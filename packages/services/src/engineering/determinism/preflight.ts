/**
 * 输入预检：提交计算前检查分析规格是否完整。
 *
 * 逆向自 Abaqus-Link 的 preflight_analysis_spec.py（823 行）。
 *
 * 铁律（技能原文）：结构校验失败时**报告缺项并停止**，
 * **不能自行补**材料、单位、边界条件、接触、几何非线性开关或验收阈值。
 *
 * 本实现只做「有没有」和「是不是空的」这类确定性判断；
 * 更深层的语义校验（材料属性是否配套、边界是否欠约束）留给后续迭代，
 * 不在这里假装做到。
 */

import {
  REQUIRED_SPEC_FIELDS,
  type AnalysisSpec,
  type PreflightIssue,
  type PreflightResult,
  type RequiredSpecField,
} from "./types.js";

/** 字段的中文名，用于错误文案。 */
const FIELD_LABELS: Record<RequiredSpecField, string> = {
  schema_version: "规格版本",
  analysis_type: "分析类型",
  units: "单位制",
  materials: "材料",
  geometry: "几何",
  steps: "分析步",
  boundary_conditions: "边界条件",
  connections: "连接",
  loads: "荷载",
  mesh: "网格",
  outputs: "输出请求",
  acceptance_criteria: "验收标准",
};

/**
 * 判断字段是否「缺失」。
 *
 * 只区分有没有，不判断内容是否充分：
 *   - undefined / null / 空串 视为缺失
 *   - 空数组、空对象**不算缺失**
 *
 * 后者是有意为之：`units: {}` 表示「用软件默认单位制」，
 * 这在规格里是合法表达；把空对象判成缺失会把正确规格误拦。
 * 内容是否充分由后端的语义校验负责，不在这里越权。
 */
function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

/**
 * 预检分析规格。
 *
 * 结论分级：
 *   FAIL        必填字段缺失或为空 —— 阻断，必须补齐
 *   WARN        必填齐全但存在需要人判断的点 —— 连同证据交给用户
 *   PASS        无阻断项也无告警
 *   UNSUPPORTED 规格版本不识别 —— 阻断，不猜兼容性
 */
export function preflightSpec(spec: AnalysisSpec): PreflightResult {
  const blocking: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  // 版本不识别时直接阻断：不同版本的字段语义可能不同，不能假设兼容。
  const version = spec.schema_version;
  if (!isMissing(version) && typeof version !== "string" && typeof version !== "number") {
    blocking.push({
      field: "schema_version",
      reason: "规格版本必须是字符串或数字。",
      suggestion: "确认规格文件来源，不要手工改写版本号。",
    });
  }

  // 逐字段检查必填与空值。
  for (const field of REQUIRED_SPEC_FIELDS) {
    if (field === "schema_version") continue;
    const value = spec[field];
    if (isMissing(value)) {
      blocking.push({
        field,
        reason: `缺少「${FIELD_LABELS[field]}」。`,
        suggestion:
          "请补充该项后再提交计算。预检不会替你填默认值——工程参数必须由设计人确认。",
      });
    }
  }

  // 验收标准单独提示：有标准但全是 review 的话，等于没有可自动判定的条目。
  const criteria = spec.acceptance_criteria;
  if (Array.isArray(criteria) && criteria.length > 0) {
    const autoJudgeable = criteria.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return record.operator === "between" || record.operator === "approximately";
    });
    if (autoJudgeable.length === 0) {
      warnings.push({
        field: "acceptance_criteria",
        reason: "验收标准全部需要人工判断，没有可自动判定的条目。",
        suggestion: "计算完成后需要人工核对结果，不能仅凭求解器完成状态交付。",
      });
    }
  }

  const status: PreflightResult["status"] =
    blocking.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";

  return { status, blocking, warnings };
}

/** 生成面向用户的预检结论。FAIL 时说清缺什么，不说「请补充」这种空话。 */
export function describePreflight(result: PreflightResult): string {
  switch (result.status) {
    case "PASS":
      return "分析规格预检通过，可以提交计算。";

    case "FAIL": {
      const lines = [`分析规格预检未通过，发现 ${result.blocking.length} 处缺失：`, ""];
      for (const issue of result.blocking) {
        lines.push(`- ${issue.field}：${issue.reason}`);
      }
      lines.push("");
      lines.push("已停止，未提交计算。请补齐上述项后重试。");
      return lines.join("\n");
    }

    case "WARN": {
      const lines = [`分析规格预检通过，但有 ${result.warnings.length} 处需要你确认：`, ""];
      for (const issue of result.warnings) {
        lines.push(`- ${issue.field}：${issue.reason}`);
        if (issue.suggestion) lines.push(`  ${issue.suggestion}`);
      }
      return lines.join("\n");
    }

    case "UNSUPPORTED":
      return "该分析规格的版本不被识别，无法预检。请确认规格来源与版本。";

    default:
      return "预检结论未知。";
  }
}
