/**
 * Markdown → docx 导出的回归（`npx tsx --test packages/ui/test/markdownToDocx.test.ts`）。
 *
 * 导出三件套里 Word 是唯一完全在渲染层生成的格式：AST 映射错位不会崩，只会静默丢结构，
 * 所以用 zip 头 + 结构块数量兜住「映射链路整体可用」这条底线；图片缺失路径必须降级为
 * 文字占位而不是抛出（spec 3.2.1：不产出残缺文件，也不让导出整体失败）。
 *
 * 后半部分是**排版不变量**（`docs/文档产出-规范-v1.md`）：字体字号只准活在 styles.xml、
 * 标题不得带 Word 内置蓝、表格固定布局且列宽之和等于版心。这几条与 CLI 报告共用同一套令牌，
 * 所以两边各钉一遍 —— 令牌是共享的，绕过样式表的写法却可能只出现在其中一条链路上。
 */
import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";
import { DOCUMENT_STYLE_TOKENS, contentWidthTwips } from "@zcode/shared";

import { markdownToDocx } from "../src/lib/markdownToDocx.js";

const SAMPLE = `# 标题一

普通段落，含 **加粗**、*斜体*、\`行内代码\` 与 [链接](https://example.com)。

## 标题二

- 无序项一
- 无序项二

1. 有序项一
2. 有序项二

> 引用内容

| 列 A | 列 B |
| --- | --- |
| 值 1 | 值 2 |

\`\`\`ts
const a: number = 1;
\`\`\`

---

![示意图](./missing-image.png)
`;

test("markdownToDocx：完整块级结构产出合法 docx（PK zip）", async () => {
  const buffer = await markdownToDocx(SAMPLE);
  assert.ok(buffer.byteLength > 1000, `docx 体积异常：${buffer.byteLength}`);
  const head = new Uint8Array(buffer.slice(0, 2));
  assert.deepEqual([...head], [0x50, 0x4b], "docx 应以 PK zip 头开头");
});

test("markdownToDocx：图片不可读时降级为文字占位，不抛出", async () => {
  const buffer = await markdownToDocx("![x](./missing.png)\n\n后续段落仍在");
  const head = new Uint8Array(buffer.slice(0, 2));
  assert.deepEqual([...head], [0x50, 0x4b], "图片失败也应产出完整文档");
  assert.ok(buffer.byteLength > 500, "图片占位不应导致空文档");
});

test("markdownToDocx：空文档可导出", async () => {
  const buffer = await markdownToDocx("");
  assert.ok(buffer.byteLength > 0);
});

/** 解包取部件：正文在 zip 里是压缩的，直接 grep 字节看不到内容（会让断言永远假绿）。 */
async function parts(markdown: string = SAMPLE) {
  const zip = new AdmZip(Buffer.from(await markdownToDocx(markdown)));
  return {
    document: zip.readAsText("word/document.xml"),
    styles: zip.readAsText("word/styles.xml"),
    core: zip.readAsText("docProps/core.xml"),
  };
}

test("排版：字体字号只准活在 styles.xml，正文的 run 只能引用样式", async () => {
  const { document, styles } = await parts();
  const blocks = [...document.matchAll(/<w:rPr>([\s\S]*?)<\/w:rPr>/g)].map((match) => match[1] ?? "");
  for (const block of blocks) {
    // 加粗/斜体不在禁列：Markdown 里 `**粗**` 是**内容语义**，必须落在 run 上（等同于用户按 Ctrl+B）。
    // 报告没有这种强调，所以那边连 b/i 一起禁 —— 两处口径的差别只在这里。
    for (const forbidden of ["<w:rFonts", "<w:sz", "<w:color"]) {
      assert.ok(!block.includes(forbidden), `run 属性里出现了 ${forbidden}：${block}`);
    }
  }
  // 反向断言：样式表里必须真的有字体字号，否则「不出现内联属性」可以靠什么都不设蒙过。
  assert.match(styles, /<w:rFonts[^>]*w:eastAsia="宋体"/, "docDefaults 必须指定中文字体");
  assert.match(styles, new RegExp(`<w:sz w:val="${DOCUMENT_STYLE_TOKENS.sizePt.body * 2}"/>`));
  assert.match(styles, /w:eastAsia="微软雅黑"/, "标题必须用标题字体");
  assert.ok(!styles.includes("2E74B5") && !styles.includes("1F4D78"), "不得保留 Word 内置标题蓝");
});

test("排版：代码与引用走具名样式", async () => {
  const { document } = await parts();
  assert.match(document, /<w:pStyle w:val="ReactorCodeBlock"\/>/, "代码块必须有段落样式");
  assert.match(document, /<w:rStyle w:val="ReactorCode"\/>/, "行内代码必须有字符样式");
  assert.match(document, /<w:pStyle w:val="ReactorQuote"\/>/, "引用必须有段落样式");
});

test("排版：表格固定布局、列宽之和等于版心宽度", async () => {
  const { document } = await parts();
  assert.match(document, /<w:tblLayout w:type="fixed"\/>/);
  const grid = [...document.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  assert.equal(grid.length, 2, "样例是两列表格");
  assert.equal(
    grid.reduce((sum, width) => sum + width, 0),
    contentWidthTwips(DOCUMENT_STYLE_TOKENS.page, false),
    "列宽之和必须等于纵向版心宽度",
  );
  assert.match(document, /<w:tblHeader\/>/, "表头必须跨页重复");
});

test("排版：A4 纵向，文档属性带上标题", async () => {
  const { document, core } = await parts();
  assert.match(document, /<w:pgSz w:w="11906" w:h="16838" w:orient="portrait"\/>/);
  assert.match(core, /<dc:title>标题一<\/dc:title>/, "标题取第一个一级标题");
  assert.match(core, /<dc:creator>Reactor<\/dc:creator>/);
});
