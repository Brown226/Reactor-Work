/**
 * 真实 docx 上的实测（不是合成的最小文档）：拿审查用的真件改一句，逐项检查格式有没有被动到。
 * 用法：npx tsx --test apps/zcode-cli/packages/file-tools-plugin/test/docx-patch-real.test.ts
 */
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { unzipSync } from "fflate";

import { docxPatch } from "../src/tools/docx-patch.js";
import { parseDocument } from "../src/tools/parse-document.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FIXTURE = join(
  REPO_ROOT,
  "docs",
  "审查板块原始数据",
  "标准库测试文档",
  "FZ9HX011101B25A43SDACFC (15169HX-JPS01-001)-审查报告-20260923-1133.docx",
);

test("真实 docx：只换命中的字，其余部件与格式逐项不变", async (t) => {
  let fixtureBytes: Buffer;
  try {
    fixtureBytes = await readFile(FIXTURE);
  } catch {
    t.skip("仓库里没有这份真实 docx fixture");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "docx-patch-real-"));
  const workCopy = join(dir, "审查报告.docx");
  await copyFile(FIXTURE, workCopy);

  // 用解析工具取出一句话，当作「审查说的那一句」——与真实链路同源
  const parsed = await parseDocument({ file_path: workCopy });
  const markdown = parsed.markdown.replace(/^<file_content>/, "").replace(/<\/file_content>$/, "");
  const line = markdown
    .split("\n")
    .map((entry) => entry.replace(/[#>*`|\-]/gu, " ").trim())
    .find((entry) => entry.length >= 8 && /[\u4e00-\u9fa5]/u.test(entry));
  assert.ok(line, "fixture 里应当能取到中文正文");

  const before = unzipSync(new Uint8Array(await readFile(workCopy)));
  const result = await docxPatch({
    file_path: workCopy,
    edits: [{ original_text: line, new_text: `${line}（已复核）` }],
  });

  assert.equal(result.status, "success", JSON.stringify(result.edits));
  assert.equal(result.verify?.newTextPresent, true);
  assert.equal(result.verify?.occurrencesReduced, true);

  const after = unzipSync(new Uint8Array(await readFile(result.output_path!)));
  const decoder = new TextDecoder();

  // 除正文外的每个部件都必须**逐字节相同**（样式表、编号、关系、媒体、页眉页脚…）
  const changed: string[] = [];
  for (const [name, bytes] of Object.entries(before)) {
    const next = after[name];
    if (!next) {
      changed.push(`${name}（丢失）`);
      continue;
    }
    if (bytes.length !== next.length || !bytes.every((byte, index) => byte === next[index])) {
      changed.push(name);
    }
  }
  assert.deepEqual(changed, ["word/document.xml"], "只有正文部件允许变化");

  // 正文部件的大小变化应该是「新增那几个字」的量级，而不是整篇重排
  const beforeXml = decoder.decode(before["word/document.xml"]!);
  const afterXml = decoder.decode(after["word/document.xml"]!);
  const sizeDelta = Math.abs(afterXml.length - beforeXml.length);
  assert.ok(
    sizeDelta < line.length * 4 + 64,
    `正文只应被改动极少量字节（实际变化 ${sizeDelta}）`,
  );

  // 段落/表格数量与 run 属性数量不变（结构没被重排）
  const countOf = (xml: string, pattern: RegExp) => (xml.match(pattern) ?? []).length;
  assert.equal(countOf(afterXml, /<w:p[ >]/gu), countOf(beforeXml, /<w:p[ >]/gu), "段落数不变");
  assert.equal(countOf(afterXml, /<w:tbl>/gu), countOf(beforeXml, /<w:tbl>/gu), "表格数不变");
  assert.equal(countOf(afterXml, /<w:rPr>/gu), countOf(beforeXml, /<w:rPr>/gu), "run 格式数不变");
  assert.equal(countOf(afterXml, /<w:numPr>/gu), countOf(beforeXml, /<w:numPr>/gu), "编号属性数不变");

  // 原文件未被改动
  assert.deepEqual(
    new Uint8Array(await readFile(workCopy)),
    new Uint8Array(fixtureBytes),
    "原件必须逐字节不变",
  );
});
