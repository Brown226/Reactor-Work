/**
 * 报告内容层 —— 措辞、统计、元信息行。**纯函数，不碰样式也不碰文件**。
 *
 * 拆出来的理由是 docx 与 xlsx 必须是同一条信息口径：报告的判定状态（查了没问题 / 没查到引用 /
 * 没查成）、库快照、覆盖缺口这些字段，不能只在一种格式里有 —— 收报告的人可能只看其中一种。
 * 所以元信息由 `reportMetaRows()` 一处产出，两个渲染器各自排版。
 */
import { basename, dirname, extname, join, resolve } from "node:path";

import type { ExportReviewReportInput, ReviewReportIssue } from "@zcode/contracts";

/** 单个 Excel 单元格上限 32767，留出余量。 */
export const EXCEL_CELL_LIMIT = 32_000;

export const SEVERITY_LABEL: Record<ReviewReportIssue["severity"], string> = {
  error: "必须修改",
  warning: "建议修改",
  info: "提示",
};

/** 问题表的列顺序与表头：docx 与 xlsx 共用，避免两种格式的列对不上。 */
export const ISSUE_TABLE_HEADERS = [
  "序号",
  "严重度",
  "类别",
  "位置",
  "原文片段",
  "问题说明",
  "建议",
] as const;

/** 结论状态的人类可读标签。docx 与 xlsx 共用，避免两种格式对同一次审查给出两种说法。 */
export const CONCLUSION_LABEL: Record<ExportReviewReportInput["conclusion"], string> = {
  passed: "已核对，未发现问题",
  no_reference: "未检出可机检的引用",
  partial: "仅覆盖部分范围",
  not_checked: "未完成审查",
};

/**
 * 文本净化：去掉控制字符（保留 \t\n）、脱掉模型的 markdown 行内强调记号、并截断超长单元格。
 * 不做前两步，Excel 会因为非法字符直接判文件损坏（而词法上"看起来"写入是成功的），
 * Word 报告里则会印出字面的 `**无法机检核对**` —— 报告是纯文本载体，没有 markdown 渲染器。
 */
export function sanitizeReportText(value: string, limit = EXCEL_CELL_LIMIT): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const plain = stripInlineMarkdown(cleaned);
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

/**
 * 脱掉行内 markdown 记号：`**粗**` / `__粗__` / `` `代码` `` → 纯文字。
 *
 * 只处理成对的强调与行内代码，**不动单个 `*` `_` `\``**：标准号里的 `*`（如 `GB/T 1.1*`）、
 * 文件名通配（`*.dwg`）都属于正文内容，误删比留着记号更糟。
 */
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 默认输出路径：`<被审文件同目录>/<文件名>-审查报告-<时间戳>.<ext>`。 */
export function resolveReportPath(input: ExportReviewReportInput, fallbackDir: string): string {
  if (input.outputPath) return resolve(input.outputPath);
  const stamp = (() => {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  })();
  if (input.sourcePath) {
    const source = resolve(input.sourcePath);
    const stem = basename(source, extname(source));
    return join(dirname(source), `${stem}-审查报告-${stamp}.${input.format}`);
  }
  return join(resolve(fallbackDir), `${input.title}-审查报告-${stamp}.${input.format}`);
}

export function countBySeverity(issues: ReviewReportIssue[]): { error: number; warning: number; info: number } {
  return {
    error: issues.filter((issue) => issue.severity === "error").length,
    warning: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
}

/** 结论措辞：空 issues 时三种真相必须分开写（P0-2，把「查不到」写成「没问题」是假阴性）。 */
export function emptyIssuesStatement(input: ExportReviewReportInput): string {
  const references = input.coverage?.referenceCount;
  switch (input.conclusion) {
    case "no_reference":
      return references === 0
        ? "本次审查未检出可机检的标准引用（已扫描正文，命中 0 条引用）——这不是「没有问题」，请确认审查范围是否覆盖正文。"
        : "本次审查未检出可机检的内容，请确认审查范围与抽取结果。";
    case "not_checked":
      return `本次审查未完成（${
        input.coverage?.extractionStatus === "no_text_layer" ? "图纸类无文本层" : "正文抽取失败或未执行"
      }），不得据此判断文件质量。`;
    case "partial":
      return "本次审查仅覆盖部分范围（详见「审查范围」），未覆盖部分没有结论。";
    case "passed":
    default:
      return references && references > 0
        ? `本次审查未发现问题（共核对 ${references} 条标准引用）。`
        : "本次审查未发现问题。";
  }
}

/** 库快照与覆盖缺口的元信息行：报告要能自证「对着哪一版库」判的（P1-1/P1-2）。 */
export function basisMetaLines(input: ExportReviewReportInput): string[] {
  const basis = input.basis;
  if (!basis) return [];
  const lines: string[] = [];
  const stamp = basis.standardsStamp;
  if (stamp) {
    lines.push(
      `标准库快照：库更新时间 ${stamp.maxUpdatedAt ?? "未标注"}，端侧同步于 ${stamp.fetchedAt}（${stamp.count} 条）`,
    );
  }
  const terminology = basis.terminologyStamp;
  if (terminology) {
    lines.push(`术语白名单：${terminology.count} 条（端侧同步于 ${terminology.fetchedAt}）`);
  }
  if (basis.ruleLibraries && basis.ruleLibraries.length > 0) {
    lines.push(`规范库：${basis.ruleLibraries.join("、")}`);
  }
  return lines;
}

/** 库覆盖缺口免责：库里没有的体系判不出对错，必须显式告知，不能让人误读成「编号有错」。 */
export function coverageDisclaimer(input: ExportReviewReportInput): string | null {
  const families = input.basis?.uncoveredFamilies ?? [];
  if (families.length === 0) return null;
  // 这句会直接印进 docx/xlsx：不带 markdown 记号（报告里没有渲染器，`**` 会原样显示）。
  return (
    `数据边界：本库当前未覆盖 ${families.join("、")} 等标准体系，` +
    "涉及这些体系的引用无法机检核对，需要另行人工确认；「未收录」不等于「标准不存在或编号有误」。"
  );
}

/** 报告必须自证的免责话术：机器出的初稿，正式交付前需人复核。 */
export const REPORT_DISCLAIMER =
  "本报告由 Agent 依据给定依据自动生成，供复核参考；正式交付前请由专业人员确认。";

/**
 * 元信息表 —— docx 排成两列小表，xlsx 排成「摘要」sheet，**内容完全一致**。
 *
 * `conclusion` 与 `coverage.referenceCount` 必须在这里出现：报告最该被复核的就是「到底查没查成」，
 * 而 docx 版此前只在 issue 为空时才写它，等于最需要看的时候看不到。
 */
export function reportMetaRows(
  input: ExportReviewReportInput,
  generatedAt: string,
): Array<[string, string]> {
  const counts = countBySeverity(input.issues);
  const rows: Array<[string, string]> = [["生成时间", generatedAt]];
  if (input.sourcePath) rows.push(["被审文件", input.sourcePath]);
  if (input.scope) rows.push(["审查范围", input.scope]);
  for (const line of basisMetaLines(input)) {
    const separator = line.indexOf("：");
    rows.push([line.slice(0, separator), line.slice(separator + 1)]);
  }
  if (input.coverage?.referenceCount !== undefined) {
    rows.push(["核对引用数", `${input.coverage.referenceCount} 条`]);
  }
  rows.push(["结论状态", CONCLUSION_LABEL[input.conclusion]]);
  if (input.issues.length === 0) {
    rows.push(["结论说明", emptyIssuesStatement(input)]);
  }
  rows.push([
    "问题合计",
    `${input.issues.length} 条（必须修改 ${counts.error}／建议修改 ${counts.warning}／提示 ${counts.info}）`,
  ]);
  const disclaimer = coverageDisclaimer(input);
  if (disclaimer) rows.push(["数据边界", disclaimer]);
  return rows;
}

/** 问题行 → 表格单元格文本（两套渲染器共用的列顺序）。 */
export function issueRowValues(issue: ReviewReportIssue, index: number): string[] {
  return [
    String(index + 1),
    SEVERITY_LABEL[issue.severity],
    issue.code,
    issue.location ?? (issue.line ? `第 ${issue.line} 行` : "—"),
    issue.quoted,
    issue.message,
    issue.suggestion ?? "—",
  ];
}
