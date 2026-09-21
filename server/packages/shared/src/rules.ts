/**
 * 声明式规则引擎（W3-②）—— 设计照搬 LeAgent `rules/`（Apache-2.0）。
 *
 * ## 它解决什么
 *
 * 把「业务校验」从**代码**固化成**数据**：运营改 YAML/JSON 即可调整校验规则，不必发版。
 * 同时它是治理能力的地基 —— 审批前筛、办公产物质检、工作流条件分支都能复用同一套判定。
 *
 * ## 8 种规则类型（照 LeAgent `RuleType`）
 *
 * | type | 语义 | 必需参数 |
 * |---|---|---|
 * | `compare` | 值比较（==/!=/</>/<=/>=/in/not_in/contains/not_contains） | left, operator, right |
 * | `date_range` | 日期在区间内 | date, start, end |
 * | `threshold` | 数值上下限 | value（+ min/max/min_exclusive/max_exclusive 至少一项） |
 * | `contains_all` | 必填值齐全 | source, required |
 * | `date_diff` | 日期差越界 | from_date, to_date（+ max_days/min_days/unit） |
 * | `regex_match` | 正则匹配/反匹配 | value, pattern |
 * | `cross_validate` | 字段关联校验 | fields, validation_type |
 * | `llm_judge` | 交模型判定 | prompt, criteria（异步，失败降级为 error） |
 *
 * ## 关键设计（照 LeAgent，都是踩过坑的）
 *
 * ① **模板求值保留类型**：`{{amount}}` 整体占位时返回**原值**（number 才能做数值比较）；
 *    只有多占位符混排时才做字符串插值。否则 `"{{amount}}" > 100` 会变成字符串比较。
 * ② **组合条件 `and/or/not`**：求值**不短路**（收集全部子结果）—— 便于审计"哪些项没过"。
 * ③ **单条规则异常不炸整批**：异常转成 `passed=false, severity=error` 的失败结果
 *    （照 LeAgent `engine.py` 的设计意图；但会掩盖配置错误，故同时打日志）。
 * ④ **`extra=forbid` 等价**：未知字段直接报错，不静默吞 —— 配置写错要立刻看得见。
 *
 * ## 与 LLM 的边界
 *
 * `llm_judge` 是**异步**的，且必须**显式注入** `llmJudge` 实现；未注入 → 该规则降级为
 * `error` 且 `passed=false`（fail-closed）。同步 `evaluate()` 遇到 `llm_judge` 直接报错，
 * 不静默跳过（照 LeAgent：混用会返回 error 结果）。这样「规则引擎」本身**保持纯函数**，
 * 只有需要模型的那一支才引入异步。
 */

// ---------------------------------------------------------------------------
// 枚举与契约
// ---------------------------------------------------------------------------

export type RuleType =
  | "compare"
  | "date_range"
  | "threshold"
  | "contains_all"
  | "date_diff"
  | "regex_match"
  | "cross_validate"
  | "llm_judge";

export type Severity = "error" | "warning" | "info";

export type CompareOperator =
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "in"
  | "not_in"
  | "contains"
  | "not_contains";

export type LogicalOperator = "and" | "or" | "not";

export type CrossValidateType =
  | "all_equal"
  | "all_different"
  | "sum_equals"
  | "at_least_one_present"
  | "all_present"
  | "mutex"
  | "conditional";

/** 一条规则的判定条件（判别联合，`type` 为判别键） */
export type RuleCondition =
  | { type: "compare"; params: { left: unknown; operator: CompareOperator; right: unknown } }
  | { type: "date_range"; params: { date: string; start: string; end: string; inclusiveStart?: boolean; inclusiveEnd?: boolean } }
  | { type: "threshold"; params: { value: number; min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean } }
  | { type: "contains_all"; params: { source: unknown; required: string[]; caseSensitive?: boolean } }
  | { type: "date_diff"; params: { from_date: string; to_date: string; max_days?: number; min_days?: number; unit?: "days" | "hours" | "minutes" } }
  | { type: "regex_match"; params: { value: string; pattern: string; flags?: string; mustMatch?: boolean } }
  | { type: "cross_validate"; params: { fields: string[]; validation_type: CrossValidateType; target?: number; condition_field?: string; condition_value?: unknown; required_fields?: string[] } }
  | { type: "llm_judge"; params: { prompt: string; criteria: string; temperature?: number; maxTokens?: number } };

/** 组合条件（`and`/`or`/`not`；子项可为叶子或嵌套组合） */
export type CompositeCondition =
  | { logic: "and"; conditions: ConditionNode[] }
  | { logic: "or"; conditions: ConditionNode[] }
  | { logic: "not"; condition: ConditionNode };

export type ConditionNode = RuleCondition | CompositeCondition;

/** 一条规则 */
export interface RuleDefinition {
  /** `^[a-zA-Z][a-zA-Z0-9_-]*$`（照 LeAgent 的约束） */
  id: string;
  name: string;
  description?: string;
  condition: ConditionNode;
  severity?: Severity;
  /** 失败时展示的文案（支持 `{{path}}` 模板） */
  message?: string;
  enabled?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** 规则集 */
export interface RuleSet {
  id: string;
  name: string;
  description?: string;
  version?: string;
  rules: RuleDefinition[];
  enabled?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** 单条规则的判定结果 */
export interface RuleResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  severity: Severity;
  /** 失败时的可读信息（模板已求值） */
  message?: string;
  /** 判定细节（供审计/排查） */
  details: Record<string, unknown>;
}

/** 规则集判定结果 */
export interface RuleSetResult {
  ruleSetId: string;
  /** **仅 error 级失败才算整体不过**（warning/info 不影响，照 LeAgent） */
  passed: boolean;
  totalRules: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  results: RuleResult[];
}

// ---------------------------------------------------------------------------
// 模板求值（关键：保留类型）
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** 取嵌套值（支持点号路径；缺失返回 undefined） */
export function getNestedValue(data: unknown, path: string): unknown {
  const parts = path.trim().split(".").filter((p) => p.length > 0);
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * 求值一个模板串。
 *
 * **整体占位（`"{{amount}}"`）返回原值类型** —— 这样 `{{amount}} > 100` 是数值比较。
 * 混排（`"金额 {{amount}} 元"`）才做字符串插值（缺失值渲染成空串）。
 */
export function resolveTemplate(template: unknown, data: unknown): unknown {
  if (typeof template !== "string") return template;
  const whole = TEMPLATE_RE.exec(template);
  if (whole) return getNestedValue(data, whole[1] ?? "");
  if (template.includes("{{")) {
    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, p: string) => {
      const v = getNestedValue(data, p);
      return v === undefined || v === null ? "" : String(v);
    });
  }
  return template;
}

/** 递归求值：对象/数组逐项处理（照 LeAgent `resolve_all_templates`） */
export function resolveAllTemplates<T>(value: T, data: unknown): T {
  if (typeof value === "string") return resolveTemplate(value, data) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveAllTemplates(v, data)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveAllTemplates(v, data);
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 比较与日期工具
// ---------------------------------------------------------------------------

/**
 * 归一成可比较值（照 LeAgent `_to_comparable`）。
 *
 * 布尔 → 0/1；可解析为数字的字符串 → 数字；其余原样。
 * 这样 `"100" > 20` 这类「模型/配置把数字写成字符串」不会静默比错。
 */
export function toComparable(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const t = value.trim();
    if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
    return value;
  }
  return value;
}

/** 解析日期：`YYYY-MM-DD` / `YYYY/M/D` / `YYYY年M月D日` / ISO；失败返回 null */
export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "") return null;
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(t);
  if (cn) return new Date(Date.UTC(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3])));
  const slash = /^(\d{4})[/](\d{1,2})[/](\d{1,2})$/.exec(t);
  if (slash) return new Date(Date.UTC(Number(slash[1]), Number(slash[2]) - 1, Number(slash[3])));
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `in` / `not_in` 的成员判断（右侧须为数组） */
function membership(left: unknown, right: unknown): boolean {
  if (Array.isArray(right)) return right.some((r) => toComparable(r) === toComparable(left));
  return String(right).split(",").map((s) => s.trim()).some((s) => s === String(left));
}

/** 有序比较（数值/字符串/日期；不可比返回 null） */
function orderedCompare(left: unknown, right: unknown): number | null {
  const a = toComparable(left);
  const b = toComparable(right);
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    const da = parseDate(a);
    const db = parseDate(b);
    if (da && db) {
      const ta = da.getTime();
      const tb = db.getTime();
      return ta === tb ? 0 : ta < tb ? -1 : 1;
    }
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return null;
}

/** 执行一次 compare 判定 */
function evalCompare(operator: CompareOperator, left: unknown, right: unknown): boolean {
  switch (operator) {
    case "==":
      return toComparable(left) === toComparable(right);
    case "!=":
      return toComparable(left) !== toComparable(right);
    case "in":
      return membership(left, right);
    case "not_in":
      return !membership(left, right);
    case "contains": {
      if (Array.isArray(left)) return left.some((l) => toComparable(l) === toComparable(right));
      return String(left ?? "").includes(String(right ?? ""));
    }
    case "not_contains":
      return !evalCompare("contains", left, right);
    default: {
      const c = orderedCompare(left, right);
      if (c === null) return false; // 不可比 → 不通过（保守）
      switch (operator) {
        case "<":
          return c < 0;
        case ">":
          return c > 0;
        case "<=":
          return c <= 0;
        case ">=":
          return c >= 0;
        default:
          return false;
      }
    }
  }
}

/** 「有值」判定：null/undefined/空白串/空数组/空对象都算缺失（照 LeAgent `_is_present`） */
export function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// 单类型判定（同步部分）
// ---------------------------------------------------------------------------

interface LeafOutcome {
  passed: boolean;
  /** 失败时补充的可读细节 */
  detail?: string;
  /** 覆盖 message 的变量（供模板求值） */
  vars?: Record<string, unknown>;
}

/** 判定一个**叶子**规则条件（不含 llm_judge；组合条件由 evaluateNode 递归处理） */
export function evaluateLeaf(node: RuleCondition, data: unknown): LeafOutcome {
  const params = resolveAllTemplates(node.params as unknown, data) as Record<string, unknown>;
  switch (node.type) {
    case "compare": {
      const passed = evalCompare(
        params.operator as CompareOperator,
        params.left,
        params.right,
      );
      return { passed, detail: `${String(params.left)} ${String(params.operator)} ${JSON.stringify(params.right)}` };
    }
    case "date_range": {
      const d = parseDate(params.date);
      const s = parseDate(params.start);
      const e = parseDate(params.end);
      if (!d || !s || !e) return { passed: false, detail: "日期不可解析" };
      const inclusiveStart = params.inclusiveStart !== false;
      const inclusiveEnd = params.inclusiveEnd !== false;
      const t = d.getTime();
      const okStart = inclusiveStart ? t >= s.getTime() : t > s.getTime();
      const okEnd = inclusiveEnd ? t <= e.getTime() : t < e.getTime();
      return { passed: okStart && okEnd, detail: `${String(params.date)} 需在 ${String(params.start)} ~ ${String(params.end)} 之间` };
    }
    case "threshold": {
      const value = Number(params.value);
      if (Number.isNaN(value)) return { passed: false, detail: "value 不是数字" };
      const violations: string[] = [];
      const { min, max, minExclusive, maxExclusive } = params as {
        min?: number;
        max?: number;
        minExclusive?: boolean;
        maxExclusive?: boolean;
      };
      if (typeof min === "number") {
        if (minExclusive === true ? value <= min : value < min) violations.push(`小于下限 ${min}`);
      }
      if (typeof max === "number") {
        if (maxExclusive === true ? value >= max : value > max) violations.push(`超过上限 ${max}`);
      }
      // 至少要有一项阈值，否则规则无意义（照 LeAgent loader 的必需项校验）
      if (typeof min !== "number" && typeof max !== "number") {
        return { passed: false, detail: "threshold 至少需要 min 或 max" };
      }
      return { passed: violations.length === 0, detail: violations.join("；"), vars: { value } };
    }
    case "contains_all": {
      const source = params.source;
      const required = Array.isArray(params.required) ? (params.required as string[]) : [];
      const caseSensitive = params.caseSensitive !== false;
      const norm = (s: string): string => (caseSensitive ? s : s.toLowerCase());
      let present: string[];
      if (Array.isArray(source)) present = source.map((s) => norm(String(s)));
      else if (source !== null && typeof source === "object") present = Object.keys(source as object).map(norm);
      else present = [norm(String(source ?? ""))];
      const missing = required.filter((r) => !present.includes(norm(String(r))));
      return { passed: missing.length === 0, detail: missing.length > 0 ? `缺少：${missing.join("、")}` : undefined, vars: { missing } };
    }
    case "date_diff": {
      const from = parseDate(params.from_date);
      const to = parseDate(params.to_date);
      if (!from || !to) return { passed: false, detail: "日期不可解析" };
      const unit = params.unit ?? "days";
      const divisor = unit === "days" ? 86_400_000 : unit === "hours" ? 3_600_000 : 60_000;
      const diff = (to.getTime() - from.getTime()) / divisor;
      const { min_days: minD, max_days: maxD } = params as { min_days?: number; max_days?: number };
      if (typeof maxD === "number" && diff > maxD) return { passed: false, detail: `相差 ${diff} ${unit}，超过上限 ${maxD}`, vars: { diff } };
      if (typeof minD === "number" && diff < minD) return { passed: false, detail: `相差 ${diff} ${unit}，低于下限 ${minD}`, vars: { diff } };
      return { passed: true, vars: { diff } };
    }
    case "regex_match": {
      const value = String(params.value ?? "");
      const flags = typeof params.flags === "string" ? params.flags.replace(/[^gimsuy]/g, "") : "";
      let re: RegExp;
      try {
        re = new RegExp(String(params.pattern ?? ""), flags);
      } catch {
        return { passed: false, detail: "正则表达式非法" };
      }
      const matched = re.test(value);
      const mustMatch = params.mustMatch !== false;
      return { passed: mustMatch ? matched : !matched, detail: matched ? "匹配" : "未匹配" };
    }
    case "cross_validate": {
      const fields = Array.isArray(params.fields) ? (params.fields as string[]) : [];
      const type = params.validation_type as CrossValidateType;
      const values = fields.map((f) => getNestedValue(data, f));
      switch (type) {
        case "all_equal": {
          const first = values[0];
          const allEq = values.every((v) => toComparable(v) === toComparable(first));
          return { passed: allEq, detail: allEq ? undefined : "字段值不完全相同" };
        }
        case "all_different": {
          const seen = new Set(values.map((v) => JSON.stringify(toComparable(v))));
          return { passed: seen.size === values.length, detail: seen.size === values.length ? undefined : "存在重复字段值" };
        }
        case "sum_equals": {
          const nums = values.map((v) => Number(toComparable(v)));
          if (nums.some((n) => Number.isNaN(n))) return { passed: false, detail: "存在非数字字段" };
          const target = Number(params.target);
          const sum = nums.reduce((a, b) => a + b, 0);
          // 浮点容差（照 LeAgent 1e-9）
          return { passed: Math.abs(sum - target) < 1e-9, detail: `合计 ${sum} ≠ ${target}`, vars: { sum } };
        }
        case "at_least_one_present": {
          const ok = values.some((v) => isPresent(v));
          return { passed: ok, detail: ok ? undefined : "至少需要一个字段有值" };
        }
        case "all_present": {
          const missing = fields.filter((f) => !isPresent(getNestedValue(data, f)));
          return { passed: missing.length === 0, detail: missing.length > 0 ? `缺少：${missing.join("、")}` : undefined, vars: { missing } };
        }
        case "mutex": {
          const count = values.filter((v) => isPresent(v)).length;
          return { passed: count <= 1, detail: count <= 1 ? undefined : `互斥字段同时出现 ${count} 个` };
        }
        case "conditional": {
          const condVal = getNestedValue(data, String(params.condition_field ?? ""));
          const trigger = toComparable(condVal) === toComparable(params.condition_value);
          if (!trigger) return { passed: true };
          const requiredFields = Array.isArray(params.required_fields) ? (params.required_fields as string[]) : [];
          const missing = requiredFields.filter((f) => !isPresent(getNestedValue(data, f)));
          return { passed: missing.length === 0, detail: missing.length > 0 ? `条件成立但缺少：${missing.join("、")}` : undefined, vars: { missing } };
        }
        default:
          return { passed: false, detail: `未知 validation_type：${String(type)}` };
      }
    }
    case "llm_judge":
      // 同步路径不支持（照 LeAgent：混用返回 error 结果，不静默跳过）
      return { passed: false, detail: "llm_judge 需要异步接口 evaluateAsync()" };
    default:
      return { passed: false, detail: `未知规则类型` };
  }
}

// ---------------------------------------------------------------------------
// 组合条件求值（不短路）
// ---------------------------------------------------------------------------

/**
 * 递归判定一个条件节点（叶子或组合）。
 *
 * `and`/`or` **不短路** —— 收集全部子结果，便于审计「哪些项没过」（照 LeAgent 设计）。
 */
export function evaluateNode(
  node: ConditionNode,
  data: unknown,
  hooks: { facts?: (node: RuleCondition) => LeafOutcome | null } = {},
): LeafOutcome {
  if ("logic" in node) {
    if (node.logic === "not") {
      const inner = evaluateNode(node.condition, data, hooks);
      return { passed: !inner.passed, detail: inner.detail ? `非（${inner.detail}）` : undefined, vars: inner.vars };
    }
    const sub = node.conditions;
    const results = (sub as ConditionNode[]).map((c) => evaluateNode(c, data, hooks));
    const failed = results.filter((r) => !r.passed);
    if (node.logic === "and") {
      return {
        passed: failed.length === 0,
        detail: failed.length > 0 ? failed.map((f) => f.detail).filter(Boolean).join("；") : undefined,
      };
    }
    return {
      passed: results.some((r) => r.passed),
      detail: results.every((r) => !r.passed) ? results.map((r) => r.detail).filter(Boolean).join("；") : undefined,
    };
  }
  const hook = hooks.facts?.(node);
  if (hook) return hook;
  return evaluateLeaf(node as RuleCondition, data);
}

// ---------------------------------------------------------------------------
// 规则集求值
// ---------------------------------------------------------------------------

/** 规则 id 合法性（照 LeAgent 的约束） */
const RULE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** 校验一个规则定义（配置写错要立刻看得见，不静默吞） */
export function validateRule(rule: RuleDefinition): string[] {
  const errors: string[] = [];
  if (!RULE_ID_RE.test(rule.id ?? "")) errors.push(`rule.id 非法（须匹配 ${RULE_ID_RE.source}）：${String(rule.id)}`);
  if (!rule.name || rule.name.trim() === "") errors.push(`rule.name 不能为空（id=${rule.id}）`);
  if (!rule.condition || typeof rule.condition !== "object") errors.push(`rule.condition 缺失（id=${rule.id}）`);
  const knownKeys = ["id", "name", "description", "condition", "severity", "message", "enabled", "tags", "metadata"];
  for (const key of Object.keys(rule)) {
    if (!knownKeys.includes(key)) errors.push(`未知字段 "${key}"（id=${rule.id}）—— 配置写错不静默吞`);
  }
  return errors;
}

/** 校验一个规则集 */
export function validateRuleSet(set: RuleSet): string[] {
  const errors: string[] = [];
  if (!RULE_ID_RE.test(set.id ?? "")) errors.push(`ruleSet.id 非法：${String(set.id)}`);
  if (!Array.isArray(set.rules)) errors.push("ruleSet.rules 必须是数组");
  const seen = new Set<string>();
  for (const rule of set.rules ?? []) {
    errors.push(...validateRule(rule));
    if (seen.has(rule.id)) errors.push(`规则 id 重复：${rule.id}`);
    seen.add(rule.id);
  }
  return errors;
}

export interface EvaluateOptions {
  /** 只跑这些规则 id（未给 = 全部启用的规则） */
  only?: readonly string[];
  /** `llm_judge` 的异步实现；未注入 → 该规则按 error 记（fail-closed） */
  llmJudge?: (judge: { prompt: string; criteria: string }, data: unknown) => Promise<boolean>;
}

/**
 * 判定一个规则集。
 *
 * - **`passed` 只看 error 级失败**（warning/info 不影响整体，照 LeAgent）。
 * - **单条规则异常不炸整批**：转成 `error` 级失败结果（设计意图 = 一个坏规则不该让整批白跑），
 *   但**同时打日志**（否则会掩盖配置错误 —— 这是 LeAgent 自己标注的可优化点）。
 * - `llm_judge` 在同步接口里按 error 记（不静默跳过）。
 */
export async function evaluateRuleSet(
  set: RuleSet,
  data: unknown,
  options: EvaluateOptions = {},
): Promise<RuleSetResult> {
  const results: RuleResult[] = [];
  const only = options.only ? new Set(options.only) : null;

  for (const rule of set.rules ?? []) {
    if (rule.enabled === false) continue;
    if (only && !only.has(rule.id)) continue;
    const severity: Severity = rule.severity ?? "error";

    // llm_judge：走异步分支（未注入实现 → error，绝不静默通过）
    const isJudge = !("logic" in rule.condition) && (rule.condition as RuleCondition).type === "llm_judge";
    if (isJudge) {
      const cond = rule.condition as Extract<RuleCondition, { type: "llm_judge" }>;
      let passed = false;
      let detail = "未注入 llmJudge 实现（按失败处理）";
      if (options.llmJudge) {
        try {
          passed = await options.llmJudge({ prompt: cond.params.prompt, criteria: cond.params.criteria }, data);
          detail = passed ? "模型判定通过" : "模型判定未通过";
        } catch (err) {
          passed = false;
          detail = `llm_judge 执行失败：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        passed,
        severity,
        ...(passed ? {} : { message: renderMessage(rule, data, { detail }) }),
        details: { type: "llm_judge", detail },
      });
      continue;
    }

    try {
      const outcome = evaluateNode(rule.condition, data);
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        passed: outcome.passed,
        severity,
        ...(outcome.passed ? {} : { message: renderMessage(rule, data, { ...outcome.vars, detail: outcome.detail }) }),
        details: { type: "logic" in rule.condition ? "composite" : rule.condition.type, ...(outcome.detail ? { detail: outcome.detail } : {}) },
      });
    } catch (err) {
      // 单条异常不炸整批，但必须留痕（否则配置错误被静默掩盖）
      const detail = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- 本模块在 shared，无 logger；由调用方收集 console
      console.error(`[rules] 规则判定异常（${set.id}/${rule.id}）：${detail}`);
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        passed: false,
        severity: "error",
        message: renderMessage(rule, data, { detail: `规则执行异常：${detail}` }),
        details: { type: "exception", detail },
      });
    }
  }

  const errorCount = results.filter((r) => !r.passed && r.severity === "error").length;
  return {
    ruleSetId: set.id,
    passed: errorCount === 0,
    totalRules: results.length,
    errorCount,
    warningCount: results.filter((r) => !r.passed && r.severity === "warning").length,
    infoCount: results.filter((r) => !r.passed && r.severity === "info").length,
    results,
  };
}

/** 渲染失败文案（模板求值；`{{missing}}` 这类变量由 vars 提供） */
function renderMessage(rule: RuleDefinition, data: unknown, vars: Record<string, unknown> = {}): string {
  const base = rule.message ?? `${rule.name} 未通过`;
  const merged = { ...(data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {}), ...vars };
  return String(resolveTemplate(base, merged));
}

/**
 * 找「适用于某查询」的规则集（按 tags 匹配；无 tags 则全不返回）。
 *
 * ⚠️ 照 LeAgent 的教训：**无 tags 时返回全部**会把不相干规则摘要注入提示
 * （其 `find_applicable_rules` 的已知可优化点）。本实现**保守**：无匹配 tags 就不返回，
 * 调用方需要「全部」时应显式处理。
 */
export function findApplicableRuleSets(sets: readonly RuleSet[], query: { tags?: readonly string[] }): RuleSet[] {
  const wanted = (query.tags ?? []).map((t) => t.toLowerCase());
  if (wanted.length === 0) return [];
  return sets.filter((s) => {
    if (s.enabled === false) return false;
    const tags = [...(s.tags ?? []), ...s.rules.flatMap((r) => r.tags ?? [])].map((t) => t.toLowerCase());
    return wanted.some((w) => tags.includes(w));
  });
}
