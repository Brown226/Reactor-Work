/**
 * 内置质量检查（W4-③）—— 纯函数，零 IO。
 *
 * 选这三条的理由：它们覆盖的是**模型输出最常见的三类真实缺陷**，且都能给出可执行建议
 * （只说「不好」而不说「怎么改」的检查没有价值，只会消耗模型的注意力）。
 *
 *  1. **markdown 表格列数不齐** —— 模型生成表格时行列错位，产出文档里表格会串列。
 *     这是办公场景最高频的缺陷，且在**入口参数**就能发现（不必读产物）。
 *  2. **占位符泄漏** —— `TODO` / `xxx` / `<placeholder>` / `待补充` 未替换就交付。
 *  3. **产物空壳** —— 工具声称成功，但字节数/文本长度明显不足以承载声明的内容
 *     （如「生成 10 页报告」却产出 300 字节）。
 */

import type { QualityCheck, QualityFinding } from "./types.js";

/** 从工具结果里取一个数值型 details 字段（容错：字符串数字也认） */
function numericDetail(details: unknown, key: string): number | null {
  if (typeof details !== "object" || details === null) return null;
  const value = (details as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 从参数里取字符串（容错） */
function stringParam(input: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// 检查 1：markdown 表格列数不齐
// ---------------------------------------------------------------------------

/** 把一行 markdown 表格拆成单元格（去掉首尾空段） */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

/** 是否为「分隔行」（`| --- | :-: |`） */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * 表格形状检查（作用于**参数里的 markdown**）。
 *
 * 只报「同一张表内列数不一致」，不报「表格语法奇怪」—— 后者会变成噪声。
 * `hint` 给出具体行号，模型才能精确修。
 */
export const markdownTableShapeCheck: QualityCheck = {
  id: "markdown.table_shape",
  appliesTo: (toolName) => toolName === "md_to_docx" || toolName === "md_to_pdf" || toolName === "md_to_html",
  run: (ctx) => {
    const markdown = stringParam(ctx.input, "markdown") ?? stringParam(ctx.input, "content");
    if (markdown === null || markdown === "") return [];

    const lines = markdown.split(/\r?\n/);
    const findings: QualityFinding[] = [];
    let index = 0;
    while (index < lines.length) {
      // 找表格起点：连续两行以 `|` 开头，且第二行是分隔行
      if (!lines[index]!.trim().startsWith("|")) {
        index += 1;
        continue;
      }
      const headerCells = splitRow(lines[index]!);
      const next = lines[index + 1];
      if (next === undefined || !next.trim().startsWith("|") || !isSeparatorRow(splitRow(next))) {
        index += 1;
        continue;
      }
      const expected = headerCells.length;
      let row = index + 2;
      const badRows: number[] = [];
      while (row < lines.length && lines[row]!.trim().startsWith("|")) {
        const cells = splitRow(lines[row]!);
        if (cells.length !== expected) badRows.push(row + 1); // 1-based 行号（给人看）
        row += 1;
      }
      if (badRows.length > 0) {
        findings.push({
          code: "markdown.table_column_mismatch",
          severity: "warn",
          message: `表格第 ${index + 1} 行声明 ${expected} 列，但第 ${badRows.join("、")} 行的列数不一致（表格会串列）。`,
          hint: `把这些行补齐或删减到 ${expected} 列（每个单元格用 | 分隔，行首行尾的 | 可留可去）。`,
        });
      }
      index = row;
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// 检查 2：占位符泄漏
// ---------------------------------------------------------------------------

/**
 * 占位符模式（**保守**：只匹配「几乎不可能是正常内容」的形态）。
 *
 * 刻意不包含 `TODO` 的宽松变体（如 `todos` 表名）—— 误报会让模型反复改正常内容，
 * 比漏报更伤。`xxx` 要求**独立成词**（避免 `xxxxl` 尺码这类正常文本）。
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /\bTODO\b/, label: "TODO" },
  { pattern: /\bFIXME\b/, label: "FIXME" },
  { pattern: /<placeholder>/i, label: "<placeholder>" },
  { pattern: /\{\{[^}]{1,40}\}\}/, label: "{{模板变量}}" },
  { pattern: /待补充|待填写|请填写此处|此处省略/, label: "待补充" },
  { pattern: /(?<![A-Za-z0-9])x{3,}(?![A-Za-z0-9])/, label: "xxx" },
  { pattern: /\.\.\.\s*(?:其余|其他|略)/, label: "……其余略" },
];

/**
 * 占位符检查（作用于**参数里的正文 + 结果文本**）。
 *
 * 只报占位符名字（不贴上下文）—— 贴上下文会把大段内容再喂一遍，代价高于收益。
 */
export const placeholderLeakCheck: QualityCheck = {
  id: "content.placeholder_leak",
  appliesTo: (toolName) => toolName === "md_to_docx" || toolName === "md_to_pdf" || toolName === "md_to_html",
  run: (ctx) => {
    const markdown = stringParam(ctx.input, "markdown") ?? "";
    if (markdown === "") return [];
    const hits = PLACEHOLDER_PATTERNS.filter((p) => p.pattern.test(markdown)).map((p) => p.label);
    if (hits.length === 0) return [];
    return [
      {
        code: "content.placeholder_leak",
        severity: "warn",
        message: `交付内容里仍含未替换的占位符：${hits.join("、")}。`,
        hint: "把这些占位符替换为真实内容；确实无法确定的部分请向用户提问，而不是留在文档里。",
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// 检查 3：产物空壳
// ---------------------------------------------------------------------------

/** 产物字节数下限（低于此值几乎不可能是正常办公文档；正常 docx 至少数 KB） */
export const MIN_ARTIFACT_BYTES = 2_048;

/**
 * 空壳检查：工具返回成功，但 `details.bytes` 明显过小。
 *
 * 只认**显式声明**了 `bytes` 的工具 —— 没有该字段就跳过（不猜）。
 * 这条检查的价值在于把「静默产出空文件」变成可见问题：模型拿到的是「文件已生成」，
 * 用户拿到的是打不开的文档。
 */
export const emptyArtifactCheck: QualityCheck = {
  id: "artifact.too_small",
  appliesTo: (toolName) => toolName === "md_to_docx" || toolName === "md_to_pdf" || toolName === "md_to_xlsx",
  run: (ctx) => {
    const bytes = numericDetail(ctx.details, "bytes");
    if (bytes === null || bytes >= MIN_ARTIFACT_BYTES) return [];
    return [
      {
        code: "artifact.too_small",
        severity: "warn",
        message: `产物只有 ${bytes} 字节（低于 ${MIN_ARTIFACT_BYTES} 字节的安全下限），疑似空文档。`,
        hint: "确认 markdown 参数是否为空或只有标题；补上正文后重新生成。",
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// 检查 4：会**静默丢失**的 markdown 构造
// ---------------------------------------------------------------------------

/**
 * 在 docx/PDF 渲染里会被**静默丢弃**的 markdown 构造。
 *
 * 为什么这条重要：渲染器遇到不支持的语法时通常**不报错**（best-effort 渲染），
 * 于是模型以为「已经放进去了」、用户看到的却缺了一块 —— 这是最难发现的一类交付缺陷。
 * 检查只对**已知不支持**的构造报警，保守不猜。
 */
const LOSSY_MARKDOWN_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    pattern: /!\[[^\]]*\]\([^)]+\)/,
    label: "图片",
    hint: "docx 渲染当前不嵌入图片：改为在文档里描述图片内容，或把图片放在文档之外单独交付。",
  },
  {
    pattern: /^\s{4,}[-*+]\s/m,
    label: "多层嵌套列表",
    hint: "把嵌套列表改写成带编号的小节（如「1.1」「1.2」）或扁平列表。",
  },
];

/** 不支持的构造检查（作用于参数里的 markdown） */
export const lossyMarkdownCheck: QualityCheck = {
  id: "markdown.lossy_constructs",
  appliesTo: (toolName) => toolName === "md_to_docx" || toolName === "md_to_pdf",
  run: (ctx) => {
    const markdown = stringParam(ctx.input, "markdown") ?? "";
    if (markdown === "") return [];
    const findings: QualityFinding[] = [];
    for (const item of LOSSY_MARKDOWN_PATTERNS) {
      if (!item.pattern.test(markdown)) continue;
      findings.push({
        code: "markdown.lossy_construct",
        severity: "warn",
        message: `内容里的${item.label}不会出现在产出的文档里（渲染器会静默跳过）。`,
        hint: item.hint,
      });
    }
    return findings;
  },
};

/** 默认检查集（顺序 = 执行顺序：先便宜的纯文本检查） */
export const DEFAULT_QUALITY_CHECKS: readonly QualityCheck[] = [
  markdownTableShapeCheck,
  placeholderLeakCheck,
  lossyMarkdownCheck,
  emptyArtifactCheck,
];
