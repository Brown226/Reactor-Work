/**
 * 文档产出规范的不变量（`docs/文档产出-规范-v1.md`）。
 *
 * 这些断言存在的理由：报告"丑"从来不是审美问题，而是**排版被交给了读者本机的 Word 默认值**。
 * 只要 `document.xml` 里出现运行的字体/字号，样式表就被绕过了 —— 所以这里逐条钉死：
 *   ① 正文、页眉、页脚里的 `<w:rPr>` 只准有 `w:rStyle`，字体字号加粗颜色只准活在 styles.xml；
 *   ② 问题表必须固定布局且列宽之和等于版心宽度（不然 Word 自动分配会把窄列压成竖排两行）；
 *   ③ 页脚页码是域、文档属性有标题与作者；
 *   ④ docx 与 xlsx 的信息口径一致（结论状态不能只在一种格式里）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";
import { DOCUMENT_STYLE_TOKENS, contentWidthTwips } from "@zcode/shared";

import { buildDocxReport, buildXlsxReport } from "../src/tool/handlers/export-review-report.js";
import { REPORT_TABLE_COLUMNS, reportTableColumnWidths } from "../src/report/docx-style.js";
import type { ExportReviewReportInput } from "@zcode/contracts";

const INPUT: ExportReviewReportInput = {
  format: "docx",
  title: "循环水处理系统工艺设计说明（HX1CI0842）标准引用自检报告",
  conclusion: "passed",
  scope: "正文 + 表格；未含图纸",
  sourcePath: "E:\\设计文件\\HX1CI0842.docx",
  summary: "共 2 条问题，其中 1 条必须修改。",
  coverage: { referenceCount: 41 },
  basis: {
    standardsStamp: { maxUpdatedAt: "2026-09-22T14:25:38.502Z", fetchedAt: "2026-09-23T01:40:54.766Z", count: 13445 },
    uncoveredFamilies: ["DL"],
  },
  issues: [
    {
      severity: "error",
      code: "STD-ABOLISHED",
      quoted: "《氯气安全规程》GB11984-2008",
      message: "标准已废止；库中现行版为 GB11984-2024。",
      suggestion: "更新为 GB 11984-2024",
      location: "§4.5 设计依据",
      line: 418,
    },
    {
      severity: "info",
      code: "STD-NOT-IN-LIBRARY",
      quoted: "GB50050-2017",
      message: "库中无此标准，需人工确认。",
    },
  ],
};

const GENERATED_AT = "2026-09-23 10:00:00";

async function docxParts() {
  const zip = new AdmZip(await buildDocxReport(INPUT, GENERATED_AT));
  return {
    zip,
    names: zip.getEntries().map((entry) => entry.entryName),
    document: zip.readAsText("word/document.xml"),
    styles: zip.readAsText("word/styles.xml"),
    header: zip.readAsText("word/header1.xml"),
    footer: zip.readAsText("word/footer1.xml"),
    core: zip.readAsText("docProps/core.xml"),
  };
}

/** 取出所有运行属性块 —— 字体字号只准出现在 styles.xml，正文侧只能引用样式。 */
function runPropertyBlocks(xml: string): string[] {
  return [...xml.matchAll(/<w:rPr>([\s\S]*?)<\/w:rPr>/g)].map((match) => match[1] ?? "");
}

const FORBIDDEN_IN_RUN = ["<w:rFonts", "<w:sz", "<w:b", "<w:i", "<w:color"];

test("样式表：字体字号只准活在 styles.xml，正文/页眉/页脚的 run 只能引用样式", async () => {
  const parts = await docxParts();
  for (const [name, xml] of [
    ["word/document.xml", parts.document],
    ["word/header1.xml", parts.header],
    ["word/footer1.xml", parts.footer],
  ] as const) {
    for (const block of runPropertyBlocks(xml)) {
      for (const forbidden of FORBIDDEN_IN_RUN) {
        assert.ok(
          !block.includes(forbidden),
          `${name} 的 run 属性里出现了 ${forbidden}（排版被绕过样式表）：${block}`,
        );
      }
    }
  }
  // 反向断言：样式表里必须真的有字体字号，否则「不出现内联属性」可以靠什么都不设来蒙过。
  assert.match(parts.styles, /<w:rFonts[^>]*w:eastAsia="宋体"/, "docDefaults 必须指定中文字体");
  assert.match(
    parts.styles,
    new RegExp(`<w:sz w:val="${DOCUMENT_STYLE_TOKENS.sizePt.body * 2}"/>`),
    "docDefaults 必须指定正文字号",
  );
});

test("样式表：内置标题不得保留 Word 的蓝色，必须是黑体加粗", async () => {
  const parts = await docxParts();
  for (const styleId of ["Title", "Heading1", "Heading2"]) {
    const start = parts.styles.indexOf(`w:styleId="${styleId}"`);
    assert.ok(start >= 0, `缺少样式 ${styleId}`);
    const block = parts.styles.slice(start, parts.styles.indexOf("</w:style>", start));
    assert.ok(!block.includes("2E74B5") && !block.includes("1F4D78"), `${styleId} 仍是 Word 内置蓝色`);
    assert.match(block, /<w:b\/>/, `${styleId} 必须加粗`);
    assert.match(block, /w:eastAsia="微软雅黑"/, `${styleId} 必须指定中文字体`);
  }
});

test("问题表：固定布局 + 列宽之和等于版心宽度，窄列不再被压成竖排", async () => {
  const parts = await docxParts();
  const tableIndex = parts.document.lastIndexOf("<w:tbl>");
  const table = parts.document.slice(tableIndex);
  assert.match(table, /<w:tblLayout w:type="fixed"\/>/, "必须固定布局，否则列宽由 Word 自动分配决定");
  assert.match(table, /<w:tblHeader\/>/, "表头必须跨页重复");
  assert.match(table, /<w:cantSplit\/>/, "行不得跨页断开");
  assert.match(table, /<w:shd[^>]*w:fill="E7E6E6"/, "表头必须有底纹");

  const grid = [...table.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  const expected = reportTableColumnWidths();
  assert.equal(grid.length, REPORT_TABLE_COLUMNS.length, "列数应与列定义一致");
  assert.deepEqual(grid, expected, "gridCol 必须与样式表算出的列宽一致");
  const contentWidth = contentWidthTwips(DOCUMENT_STYLE_TOKENS.page, true);
  assert.equal(
    grid.reduce((sum, width) => sum + width, 0),
    contentWidth,
    "列宽之和必须等于版心宽度：少了会拉出正文区，多了会再挤一次",
  );
  // 序号 / 严重度是最容易被压坏的两列：至少要放得下 3 个字（9pt ≈ 180twip/字）。
  assert.ok(grid[0]! >= 540 && grid[1]! >= 720, `窄列过窄：${grid[0]} / ${grid[1]}`);
  // 每个单元格也要自带 tcW，只有 tblGrid 时 Word 仍可能按内容重算。
  assert.match(table, /<w:tcW w:type="dxa" w:w="\d+"\/>/, "单元格必须带固定宽度");
});

test("页面与页脚：横向 A4、版心按令牌，页脚是页码域", async () => {
  const parts = await docxParts();
  assert.match(parts.document, /<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
  assert.match(parts.footer, /PAGE/);
  assert.match(parts.footer, /NUMPAGES/);
  assert.match(parts.document, /<w:footerReference[^>]*\/>/, "必须挂上页脚");
});

test("文档属性：标题与作者必须写进去（此前是 Un-named 且无标题）", async () => {
  const parts = await docxParts();
  assert.match(parts.core, /<dc:creator>Reactor<\/dc:creator>/);
  assert.match(parts.core, /<dc:title>[^<]*标准引用自检报告<\/dc:title>/);
});

test("信息口径：结论状态与核对引用数必须进 docx，不能只在 xlsx 里", async () => {
  const parts = await docxParts();
  assert.match(parts.document, /结论状态/);
  assert.match(parts.document, /已核对，未发现问题/);
  assert.match(parts.document, /核对引用数/);
  assert.match(parts.document, /数据边界/);
});

test("xlsx：列宽与字体同样来自令牌，摘要 sheet 与 docx 同口径", async () => {
  const zip = new AdmZip(await buildXlsxReport({ ...INPUT, format: "xlsx" }, GENERATED_AT));
  const sheet = zip.readAsText("xl/worksheets/sheet1.xml");
  const styles = zip.readAsText("xl/styles.xml");
  // ExcelJS 会省略宽度恰好等于库默认值的列，所以按「列号 → 宽度」核对而不是数个数。
  const columns = [...sheet.matchAll(/<col min="(\d+)"[^>]*width="([\d.]+)"/g)].map((match) => ({
    index: Number(match[1]) - 1,
    width: Number(match[2]),
  }));
  assert.ok(columns.length >= REPORT_TABLE_COLUMNS.length - 1, `列宽未写入：${JSON.stringify(columns)}`);
  // 不变量：宽度 = 同一比例 × 共享列配比（留 1 字符的取整余量）。用百分比最大的一列当基准，
  // 它的相对误差最小；任何一列脱队都说明列宽不再来自那份配比。
  const reference = columns.reduce((widest, column) =>
    REPORT_TABLE_COLUMNS[column.index]!.percent > REPORT_TABLE_COLUMNS[widest.index]!.percent ? column : widest,
  );
  const unit = (reference.width * 100) / REPORT_TABLE_COLUMNS[reference.index]!.percent;
  for (const column of columns) {
    const expected = (unit * REPORT_TABLE_COLUMNS[column.index]!.percent) / 100;
    assert.ok(
      Math.abs(column.width - expected) <= 1,
      `第 ${column.index + 1} 列的宽度脱队：${column.width} 与配比推出的 ${expected.toFixed(1)} 差得太多`,
    );
  }
  assert.match(styles, new RegExp(DOCUMENT_STYLE_TOKENS.font.heading.eastAsia), "表头必须用标题字体");
  const shared = zip.readAsText("xl/sharedStrings.xml");
  assert.match(shared, /结论状态/);
  assert.match(shared, /核对引用数/);
});

test("导出的 docx 仍是合法 OOXML 包", async () => {
  const buffer = await buildDocxReport(INPUT, GENERATED_AT);
  assert.equal(buffer.subarray(0, 2).toString("latin1"), "PK");
  const names = new AdmZip(buffer).getEntries().map((entry) => entry.entryName);
  assert.ok(names.includes("[Content_Types].xml"));
  assert.ok(names.includes("word/styles.xml"), "没有样式表就不是规范化产出");
});
