/**
 * docx_patch 的回归（`pnpm --dir apps/zcode-cli/packages/file-tools-plugin exec tsx --test "test/*.test.ts"`）。
 *
 * 这个工具动的是**用户的正式文件**，所以每一条都钉在「不破坏文档」上：
 * 段落/表格结构、run 格式（`w:rPr`）、未命中的文本、其余 zip 条目必须原样；默认绝不覆盖原件。
 * 最难的一类是 Word 最常见的形态：一句话被拆在多个 run 上（拼写检查、修订记录都会这么切）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";

import { docxPatch, docxPatchInputSchema, normalizeForMatch } from "../src/tools/docx-patch.js";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

/** 造一份最小但结构完整的 docx：段落带独立 run 格式、含表格，便于断言「没被重排」。 */
async function writeDocx(bodyXml: string, extraParts: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docx-patch-test-"));
  const filePath = join(dir, "sample.docx");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(CONTENT_TYPES),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
    ),
    "word/styles.xml": strToU8("<w:styles><!-- 样式表必须原样保留 --></w:styles>"),
  };
  for (const [name, content] of Object.entries(extraParts)) {
    files[name] = strToU8(content);
  }
  await writeFile(filePath, zipSync(files));
  return filePath;
}

function paragraph(runs: string): string {
  return `<w:p>${runs}</w:p>`;
}

/** 带格式的 run：加粗 + 字号，用来验证换字之后格式还在。 */
function styledRun(text: string, options: { bold?: boolean; size?: number } = {}): string {
  const rPr = `<w:rPr>${options.bold ? "<w:b/>" : ""}<w:sz w:val="${options.size ?? 21}"/></w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

const readDocumentXml = async (path: string): Promise<string> => {
  const entries = unzipSync(new Uint8Array(await readFile(path)));
  return new TextDecoder().decode(entries["word/document.xml"]!);
};

test("docx_patch：单 run 内替换，格式与其余部件原样，默认另存副本", async () => {
  const filePath = await writeDocx(
    paragraph(styledRun("点击", { bold: true }) + styledRun("完成退出安装向导。、", { size: 24 })),
  );
  const before = await readFile(filePath);

  const result = await docxPatch({
    file_path: filePath,
    edits: [{ original_text: "退出安装向导。、", new_text: "退出安装向导。" }],
  });

  assert.equal(result.status, "success");
  assert.equal(result.applied_count, 1);
  assert.ok(result.output_path?.endsWith("-modified.docx"), "默认另存为副本");
  assert.equal(result.verify?.newTextPresent, true);
  assert.equal(result.verify?.occurrencesReduced, true);
  assert.deepEqual(result.verify?.parts, ["word/document.xml"]);

  // 原件一个字节都不能变
  assert.deepEqual(await readFile(filePath), before, "默认不得覆盖原件");

  const xml = await readDocumentXml(result.output_path!);
  assert.ok(xml.includes("退出安装向导。"), "新文本已写入");
  assert.ok(!xml.includes("退出安装向导。、"), "旧文本已消失");
  // 未命中的 run 与其格式原样
  assert.ok(xml.includes('<w:rPr><w:b/><w:sz w:val="21"/></w:rPr><w:t xml:space="preserve">点击</w:t>'));
  assert.ok(xml.includes('<w:sz w:val="24"/>'), "命中 run 的字号格式必须保留");
  assert.ok(xml.includes("点击"), "前缀文本未被吞掉");

  const entries = unzipSync(new Uint8Array(await readFile(result.output_path!)));
  assert.ok(entries["word/styles.xml"], "其余 zip 条目必须原样带回");
  assert.ok(
    new TextDecoder().decode(entries["word/styles.xml"]!).includes("样式表必须原样保留"),
    "样式表未被重写",
  );
});

test("docx_patch：一句话被拆在多个 run 上（Word 常见形态）也能替换，取首个 run 的格式", async () => {
  const filePath = await writeDocx(
    paragraph(
      styledRun("安装进度条完成后，可选择是否", { size: 21 }) +
        styledRun("“立即启动智能辅助设计平台”", { bold: true, size: 24 }) +
        styledRun("。点击“完成”", { size: 21 }) +
        styledRun("退出安装向导", { bold: true, size: 30 }) +
        styledRun("。", { size: 21 }),
    ),
  );

  const result = await docxPatch({
    file_path: filePath,
    edits: [
      {
        original_text: "“立即启动智能辅助设计平台”。点击“完成”退出安装向导。",
        new_text: "“立即启动智能辅助设计平台”。点击“完成”。",
      },
    ],
  });

  assert.equal(result.status, "success");
  const xml = await readDocumentXml(result.output_path!);
  assert.ok(xml.includes("。点击“完成”。"), "跨 run 的片段被整体替换");
  assert.ok(!xml.includes("退出安装向导"), "旧片段已消失");
  assert.ok(xml.includes("安装进度条完成后，可选择是否"), "命中之前的前缀文本保留");
});

test("docx_patch：occurrence 指定第几处；越界或找不到一律跳过并给出中文原因", async () => {
  const filePath = await writeDocx(
    paragraph(styledRun("安装调试要求。")) + paragraph(styledRun("安装调试复核。")),
  );

  const second = await docxPatch({
    file_path: filePath,
    edits: [{ original_text: "安装调试", new_text: "安装调试验收", occurrence: 2 }],
  });
  assert.equal(second.status, "success");
  const xml = await readDocumentXml(second.output_path!);
  assert.ok(xml.indexOf("安装调试验收") > xml.indexOf("安装调试要求"), "第二处被替换");

  const missing = await docxPatch({
    file_path: filePath,
    edits: [{ original_text: "文档里没有这句话", new_text: "x" }],
  });
  assert.equal(missing.status, "failed", "一处都没命中时不得写出「看起来改过了」的副本");
  assert.equal(missing.output_path, undefined);
  assert.match(missing.edits[0]!.reason ?? "", /找不到这段原文/);
});

test("docx_patch：XML 实体与归一化差异都能命中（中文引号、全角空格、换行拆行）", async () => {
  const filePath = await writeDocx(
    paragraph(styledRun("本软件定位为&#x201C;智能交互中台&#x201D;。")) +
      paragraph(styledRun("支持dwg、docx、pdf")),
  );

  const result = await docxPatch({
    file_path: filePath,
    edits: [
      { original_text: "本软件定位为“智能交互中台”。", new_text: "本软件定位为“智能交互中台”。" },
      { original_text: "支持 dwg、docx、pdf", new_text: "支持 dwg、docx、pdf、xlsx" },
    ],
  });

  assert.equal(result.status, "success");
  const xml = await readDocumentXml(result.output_path!);
  // 替换写入的是**新文本**（含用户给的空白），原文的空白差异只用于「匹配」
  assert.ok(xml.includes("支持 dwg、docx、pdf、xlsx"), "空白差异被归一化吸收后完成替换");
  assert.ok(!xml.includes("支持dwg、docx、pdf</w:t>"), "旧片段已消失");
});

test("docx_patch：表格里的段落同样只换字，表格结构不动", async () => {
  const filePath = await writeDocx(
    `<w:tbl><w:tr><w:tc>${paragraph(styledRun("Windows 7 (64位)"))}</w:tc><w:tc>${paragraph(
      styledRun("Windows 10/11"),
    )}</w:tc></w:tr></w:tbl>`,
  );

  const result = await docxPatch({
    file_path: filePath,
    edits: [{ original_text: "Windows 7 (64位)", new_text: "Windows 7（64 位）" }],
  });

  assert.equal(result.status, "success");
  const xml = await readDocumentXml(result.output_path!);
  assert.ok(xml.includes("<w:tbl><w:tr><w:tc>"), "表格结构原样保留");
  assert.ok(xml.includes("Windows 7（64 位）"));
  assert.ok(!xml.includes("Windows 7 (64位)"));
});

test("docx_patch：in_place 才覆盖原件；非 docx 后缀直接拒绝", async () => {
  const filePath = await writeDocx(paragraph(styledRun("原文内容")));
  const result = await docxPatch({
    file_path: filePath,
    edits: [{ original_text: "原文内容", new_text: "改后内容" }],
    in_place: true,
  });
  assert.equal(result.status, "success");
  assert.equal(result.output_path, filePath);
  assert.ok((await readDocumentXml(filePath)).includes("改后内容"), "in_place 时原文件被更新");

  const docPath = join(await mkdtemp(join(tmpdir(), "docx-patch-test-")), "legacy.doc");
  await writeFile(docPath, "not a docx");
  await assert.rejects(
    () => docxPatch({ file_path: docPath, edits: [{ original_text: "a", new_text: "b" }] }),
    /只支持 \.docx/,
  );
});

test("docx_patch：schema 拒绝空 edits 与空原文；归一化规则与审查定位同口径", () => {
  assert.equal(docxPatchInputSchema.safeParse({ file_path: "a.docx", edits: [] }).success, false);
  assert.equal(
    docxPatchInputSchema.safeParse({ file_path: "", edits: [{ original_text: "a", new_text: "b" }] })
      .success,
    false,
  );
  assert.equal(
    docxPatchInputSchema.safeParse({ file_path: "a.docx", edits: [{ original_text: "", new_text: "b" }] })
      .success,
    false,
  );
  assert.equal(normalizeForMatch("ＧＢ／Ｔ　8163"), "GB/T8163");
  assert.equal(normalizeForMatch("a—b〜c"), "ABC");
  // 与审查定位同口径：连字符被忽略，抽取器把连字符读成空格也照样命中
  assert.equal(normalizeForMatch("15169HX-JPS01-001"), normalizeForMatch("15169HX JPS01 001"));
});
