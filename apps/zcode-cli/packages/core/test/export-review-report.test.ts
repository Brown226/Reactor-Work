/**
 * ExportReviewReport 回归（`npx tsx --test packages/core/test/export-review-report.test.ts`）。
 *
 * 这里**真的生成文件**再验结构，因为报告的两个失败模式都不是类型能挡住的：
 *  ① Excel/Word 对非法字符（控制字符）与超长单元格是"写坏了才算"——生成时不报错，打开才说文件损坏；
 *  ② 默认输出路径派生错（例如把扩展名也算进 stem）会静默写出 `xx.docx-审查报告.docx`。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import AdmZip from "adm-zip";

import {
  buildDocxReport,
  buildXlsxReport,
  countBySeverity,
  exportReviewReportToolEntry,
  resolveReportPath,
  sanitizeReportText,
} from "../src/tool/handlers/export-review-report.js";
import type { ExportReviewReportInput } from "@zcode/contracts";

const ISSUES: ExportReviewReportInput["issues"] = [
  {
    severity: "error",
    code: "abolished",
    quoted: "GB/T 9123-2010",
    message: "已废止（钢制管法兰盖）；库中现行版本：GB/T 9124.1-2019",
    suggestion: "GB/T 9124.1-2019（钢制管法兰第1部分：PN系列）",
    line: 43,
  },
  {
    severity: "warning",
    code: "no_year",
    quoted: "GB 12238",
    message: "引用未注年代号，库中同编号有 2 个条目，现行为 GB/T 12238-2008",
    line: 22,
  },
  { severity: "info", code: "upcoming", quoted: "GB 12955-2024", message: "即将实施" },
];

const BASE: ExportReviewReportInput = {
  format: "docx",
  title: "循环水处理系统工艺设计说明",
  issues: ISSUES,
  scope: "正文 + 表格；未含图纸",
  summary: "共 3 条问题，其中 1 条必须修改。",
};

test("净化：控制字符必须去掉、超长必须截断（否则 Office 打开报文件损坏）", () => {
  assert.equal(sanitizeReportText("正常\u0000文本\u0007"), "正常文本");
  assert.equal(sanitizeReportText("保留\t制表\n换行"), "保留\t制表\n换行");
  const long = "字".repeat(50);
  const clipped = sanitizeReportText(long, 10);
  assert.equal(clipped.length, 10);
  assert.ok(clipped.endsWith("…"));
});

test("默认输出路径：落在被审文件同目录、按扩展名正确派生", () => {
  const path = resolveReportPath(
    { ...BASE, sourcePath: join("E:", "工作", "设计文件", "HX1CI0842.docx") },
    tmpdir(),
  );
  assert.ok(path.endsWith(".docx"), path);
  assert.ok(path.includes("HX1CI0842-审查报告-"), path);
  assert.ok(!path.includes(".docx-审查报告"), "stem 不应带上原扩展名");
  assert.ok(path.startsWith(join("E:", "工作", "设计文件")), path);

  const explicit = resolveReportPath({ ...BASE, outputPath: join(tmpdir(), "自定义.xlsx") }, tmpdir());
  assert.equal(explicit, join(tmpdir(), "自定义.xlsx"));
});

test("统计：按严重度分别计数", () => {
  assert.deepEqual(countBySeverity(ISSUES), { error: 1, warning: 1, info: 1 });
});

test("docx：是合法 OOXML 包，且问题表内容真的在里面", async () => {
  const buffer = await buildDocxReport(BASE, "2026-09-23 01:00:00");
  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK", "docx 必须是 zip 容器");
  // docx 里的 document.xml 是 DEFLATE 压缩的：直接 grep 原始字节**看不到正文**，
  // 必须解压后再断言 —— 否则这条测试会永远假绿（这也是它第一版失败的原因）。
  const zip = new AdmZip(buffer);
  const documentXml = zip.readAsText("word/document.xml");
  assert.ok(documentXml.length > 0, "缺少 word/document.xml");
  assert.ok(documentXml.includes("GB/T 9123-2010"), "报告里应含原文片段");
  assert.ok(documentXml.includes("必须修改"), "报告里应含严重度标签");
  assert.ok(documentXml.includes("建议改引") === false, "报告不该写入输入里没有的内容");
  const contentTypes = zip.readAsText("[Content_Types].xml");
  assert.ok(contentTypes.includes("wordprocessingml"), "不是 WordprocessingML 包");
});

test("xlsx：是合法 xlsx，含问题清单与摘要两个 sheet", async () => {
  const buffer = await buildXlsxReport({ ...BASE, format: "xlsx" }, "2026-09-23 01:00:00");
  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK");
  const zip = new AdmZip(buffer);
  const names = zip.getEntries().map((entry) => entry.entryName);
  assert.ok(names.includes("xl/workbook.xml"), "缺少 xl/workbook.xml");
  assert.ok(names.includes("xl/worksheets/sheet1.xml"), "缺少问题清单 sheet");
  assert.ok(names.includes("xl/worksheets/sheet2.xml"), "缺少摘要 sheet");
  // ExcelJS 默认把字符串放进 sharedStrings.xml，工作表 XML 里只有引用索引 —— 两处都要看。
  const workbookText = [
    zip.readAsText("xl/worksheets/sheet1.xml"),
    names.includes("xl/sharedStrings.xml") ? zip.readAsText("xl/sharedStrings.xml") : "",
  ].join("\n");
  assert.ok(workbookText.includes("GB/T 9123-2010"), "问题清单里应含原文片段");
  assert.ok(workbookText.includes("必须修改"), "问题清单里应含严重度标签");
});

test("工具入口：端到端写文件，输出路径与字节数一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-report-test-"));
  try {
    const source = join(dir, "设计说明.docx");
    writeFileSync(source, "placeholder");
    const handler = exportReviewReportToolEntry.handler;
    const context = {
      workingDirectory: dir,
      workspaceRoot: dir,
      traceId: "test",
      sessionId: "test",
    } as unknown as Parameters<typeof handler>[1];

    const result = (await handler(
      { ...BASE, format: "docx", sourcePath: source, outputPath: undefined },
      context,
    )) as { path: string; bytes: number; issueCount: number; bySeverity: { error: number } };

    assert.equal(result.issueCount, 3);
    assert.equal(result.bySeverity.error, 1);
    const written = readFileSync(result.path);
    assert.equal(written.byteLength, result.bytes);
    assert.equal(written.subarray(0, 2).toString("latin1"), "PK");
    assert.ok(result.path.endsWith(".docx"));

    // 入参校验：非枚举 format 必须被挡在写文件之前
    await assert.rejects(async () => handler({ ...BASE, format: "pdf" }, context));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
