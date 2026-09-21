/**
 * 质量门禁契约（W4-③）—— 「工具说成功」≠「产物真的合格」。
 *
 * 设计来源：LeAgent `context/artifact_error_tracker.py` 的**思路**
 * （工具产物校验 → 生成再生/修复指令 → 同 turn 收敛），
 * 但**刻意不抄它的具体指令文案** —— 那里面是大段面向 canvas_publish/emit_ui_tree 的英文
 * 业务字符串（见调研报告 §5.8）。我们只保留机制，检查项与提示文案由本仓自己定。
 *
 * 为什么落在 `on("tool_result")` 而不是 `withGate`（工具入口）：
 * 入口只能校验**参数**；产物质量必须看**结果**。Pi 的 `tool_result` 允许改写结果
 * （`{content, details, isError}`），于是「发现缺陷 → 给模型一条可执行的修复指令」
 * 能在**同一个 turn 内**完成，而不是等下一轮重新解释。
 *
 * 三条纪律：
 *  ① **不回改 `isError`**：质量问题通常是「能用但不够好」，把它变成错误会让模型
 *     重跑整条链路（更贵、更慢）。只在产物确实不可用时才由具体检查建议升级。
 *  ② **有界**：同 turn 对同一工具最多注入 N 条指令，避免「模型改不好 → 又注入 → 又改不好」
 *     的死循环（这是自纠闭环最典型的失控方式）。
 *  ③ **失败开放**：检查本身抛错 = 该检查放弃（不影响工具已产出的结果）。
 */

/** 严重程度（`info` 不触发注入，仅用于 UI/日志） */
export type QualitySeverity = "info" | "warn" | "error";

/** 一条质量发现 */
export interface QualityFinding {
  /** 稳定机器码（供 UI 分组/统计；不要随时间随意改名） */
  readonly code: string;
  readonly severity: QualitySeverity;
  /** 给人/模型看的问题描述（说清「哪里不对」） */
  readonly message: string;
  /** 可执行的修复建议（说清「怎么改」）—— 有它才能同 turn 收敛 */
  readonly hint?: string;
}

/** 一次门禁的整体结论 */
export interface QualityReport {
  readonly toolName: string;
  readonly findings: readonly QualityFinding[];
  /** 无 `warn`/`error` 即通过 */
  readonly ok: boolean;
  readonly worst: QualitySeverity | null;
}

/** 交给检查的上下文（工具结果的可读面） */
export interface QualityCheckContext {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** 结果里的纯文本片段（图片块被过滤掉） */
  readonly text: string;
  readonly isError: boolean;
  readonly details?: unknown;
}

/**
 * 一个质量检查。
 *
 * `run` 允许返回 Promise —— 有的检查必须读产物文件（如解压 docx 看字体），
 * 而 `tool_result` 处理本身就是异步的，没必要为此把它拆成两套机制。
 */
export interface QualityCheck {
  readonly id: string;
  /** 只对哪些工具生效（返回 false 则完全不跑，避免无谓开销） */
  appliesTo(toolName: string): boolean;
  run(ctx: QualityCheckContext): readonly QualityFinding[] | Promise<readonly QualityFinding[]>;
}

/** 严重度排序（越大越严重） */
export function severityRank(severity: QualitySeverity): number {
  return severity === "error" ? 2 : severity === "warn" ? 1 : 0;
}

/** 最高严重度（空数组 → null） */
export function worstSeverity(findings: readonly QualityFinding[]): QualitySeverity | null {
  let worst: QualitySeverity | null = null;
  for (const f of findings) {
    if (worst === null || severityRank(f.severity) > severityRank(worst)) worst = f.severity;
  }
  return worst;
}

/**
 * 依次跑检查（**单个检查抛错只放弃它自己**）。
 *
 * 顺序执行而非并发：检查之间有隐含的代价梯度（纯文本检查便宜、读文件检查贵），
 * 顺序执行让「便宜的先发现就够用了」成为可能，也避免同时打开多个文件句柄。
 */
export async function runQualityChecks(
  checks: readonly QualityCheck[],
  ctx: QualityCheckContext,
): Promise<QualityReport> {
  const findings: QualityFinding[] = [];
  for (const check of checks) {
    if (!check.appliesTo(ctx.toolName)) continue;
    try {
      const produced = await check.run(ctx);
      for (const f of produced) findings.push(f);
    } catch {
      // 检查失败 = 放弃该检查（不影响工具结果）
    }
  }
  const worst = worstSeverity(findings);
  return {
    toolName: ctx.toolName,
    findings,
    ok: worst === null || severityRank(worst) === 0,
    worst,
  };
}

/**
 * 渲染成注入给模型的指令块。
 *
 * 为什么用**显式标签**而不是自然语言夹带：标签让「这是系统质检结论」与「这是工具输出」
 * 在模型侧可区分；也让我们事后能从会话日志里 grep 出来统计触发率。
 * `onlyActionable` 默认 true —— 只注入有 `hint` 的发现，没建议的问题只是噪声。
 */
export function renderQualityDirective(
  report: QualityReport,
  options: { onlyActionable?: boolean; maxFindings?: number } = {},
): string {
  const onlyActionable = options.onlyActionable ?? true;
  const maxFindings = options.maxFindings ?? 4;
  const actionable = report.findings.filter(
    (f) => severityRank(f.severity) > 0 && (!onlyActionable || (f.hint !== undefined && f.hint !== "")),
  );
  if (actionable.length === 0) return "";

  const lines = actionable
    .slice(0, maxFindings)
    .map((f) => `- [${f.severity}] ${f.message}${f.hint !== undefined && f.hint !== "" ? `\n  建议：${f.hint}` : ""}`);

  return [
    `<quality_gate tool="${report.toolName}">`,
    "上一轮工具产物未通过质检，请在本轮内修正后重试（不要跳过）：",
    ...lines,
    "</quality_gate>",
  ].join("\n");
}

/**
 * 合并注入块到工具结果文本。
 *
 * 追加而非替换：原结果里的信息（模型可能需要）必须保留 —— 替换会丢掉它刚刚拿到的数据。
 */
export function appendDirective(original: string, directive: string): string {
  if (directive === "") return original;
  return original === "" ? directive : `${original}\n\n${directive}`;
}
