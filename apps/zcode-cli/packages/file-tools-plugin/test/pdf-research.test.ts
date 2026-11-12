import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  pdfCitations,
  pdfFormulaCandidates,
  pdfPageText,
  pdfRegionText,
  pdfStructure,
} from "../src/tools/pdf-research.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "docs", "审查板块原始数据", "标准库测试文档");

/** 把对象列表拼成最小 PDF（连续对象号 + 手写 xref），避免测试依赖生成库。 */
function assemblePdf(objects: string[], trailerExtra = ""): Buffer {
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** 手写最小 PDF（Helvetica 单页多行），避免测试依赖生成库。 */
function buildSamplePdf(): Buffer {
  const lines = [
    "Abstract",
    "This paper studies attention mechanisms.",
    "1 Introduction",
    "Figure 1. Architecture overview",
    "E=mc^2 and y = x_i + sum_j w_j",
    "References",
    "[1] A. Author and B. Writer. A paper. 2020. doi:10.1234/abcd.efgh",
    "[2] C. Collaborator. Another work. https://example.com/x",
    "[3] D. Doe. Third entry about transformers.",
  ];
  // 用 BT/ET 逐行 Tj；行距 14pt，起点 (50, 750)。
  const contentParts = ["BT", "/F1 11 Tf", "50 750 Td"];
  lines.forEach((line, index) => {
    const safe = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    if (index > 0) contentParts.push("0 -14 Td");
    contentParts.push(`(${safe}) Tj`);
  });
  contentParts.push("ET");
  const stream = contentParts.join("\n");

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  return assemblePdf(objects);
}

/**
 * 两页 + 书签 PDF：覆盖 pdfjs 的三种 dest 形态与坏书签。
 * - Chapter One： /Dest [3 0 R …] 页面引用 → 第 1 页（1-based）
 * - Chapter Two： /Dest (targetPageTwo) 具名目标 → 第 2 页
 * - Broken Bookmark：/Dest [99 0 R …] 指向不存在的页对象 → page 保持 null
 * - No Destination：没有 /Dest → page 保持 null
 */
function buildOutlinePdf(): Buffer {
  const content = (text: string): string => {
    const stream = `BT /F1 11 Tf 50 750 Td (${text}) Tj ET`;
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  };
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /Names << /Dests 10 0 R >> >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 9 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R /Resources << /Font << /F1 9 0 R >> >> >>\nendobj\n",
    `5 0 obj\n${content("Page one text")}\nendobj\n`,
    "6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 4 >>\nendobj\n",
    "7 0 obj\n<< /Title (Chapter One) /Parent 6 0 R /Dest [3 0 R /XYZ null null null] /Next 8 0 R >>\nendobj\n",
    "8 0 obj\n<< /Title (Chapter Two) /Parent 6 0 R /Prev 7 0 R /Dest (targetPageTwo) /First 12 0 R /Last 13 0 R /Count 2 >>\nendobj\n",
    "9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "10 0 obj\n<< /Names [(targetPageTwo) [4 0 R /XYZ null null null]] >>\nendobj\n",
    `11 0 obj\n${content("Page two text")}\nendobj\n`,
    "12 0 obj\n<< /Title (Broken Bookmark) /Parent 8 0 R /Dest [99 0 R /XYZ null null null] /Next 13 0 R >>\nendobj\n",
    "13 0 obj\n<< /Title (No Destination) /Parent 8 0 R /Prev 12 0 R >>\nendobj\n",
  ];
  return assemblePdf(objects);
}

/** 无文本层 PDF（页面只有一个填充矩形），走扫描件/无文本层提示分支。 */
function buildNoTextPdf(): Buffer {
  const stream = "q 0.5 g 10 10 100 100 re f Q";
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  return assemblePdf(objects);
}

/** 加密 PDF（标准安全处理器，无密码打开）：pdfjs 抛 PasswordException。 */
function buildEncryptedPdf(): Buffer {
  const zeros = "0".repeat(32);
  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length 40 >>\nstream\nBT /F1 11 Tf 50 750 Td (Secret) Tj ET\nendstream\nendobj\n`,
    `5 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -1 >>\nendobj\n`,
  ];
  return assemblePdf(
    objects,
    "/Encrypt 5 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] ",
  );
}

async function writePdf(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-research-test-"));
  const filePath = join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

async function writeSamplePdf(): Promise<string> {
  return writePdf("sample.pdf", buildSamplePdf());
}

test("pdf_structure：样本 PDF 出页数与启发式章节", async () => {
  const filePath = await writeSamplePdf();
  const result = await pdfStructure(filePath);
  assert.equal(result.page_count, 1);
  assert.ok(Array.isArray(result.outline));
  assert.ok(Array.isArray(result.sections));
  assert.ok(Array.isArray(result.figures));
  // 启发式应识别 Abstract / Introduction 或 Figure 1
  const titles = result.sections.map((s) => s.title.toLowerCase()).join(" | ");
  assert.match(titles, /abstract|introduction/);
});

test("pdf_citations：References 段拆出多条", async () => {
  const filePath = await writeSamplePdf();
  const { items } = await pdfCitations(filePath);
  assert.ok(items.length >= 2, `引文条数应 ≥2，实际 ${items.length}`);
  const joined = items.map((i) => i.text).join("\n");
  assert.match(joined, /Author|Writer|Collaborator|transformers/i);
  // 样本含 DOI 时应回填
  assert.ok(items.some((i) => i.doi) || items.some((i) => i.url));
});

test("pdf_page_text：页范围抽取含正文", async () => {
  const filePath = await writeSamplePdf();
  const result = await pdfPageText(filePath, 1, 1);
  assert.equal(result.start, 1);
  assert.equal(result.end, 1);
  assert.match(result.text, /attention|Abstract/i);
});

test("pdf_region_text：整页 bbox 能拿到文本，框外为空", async () => {
  const filePath = await writeSamplePdf();
  const whole = await pdfRegionText(filePath, 1, [0, 0, 612, 792]);
  assert.ok(whole.text.length > 0);
  const empty = await pdfRegionText(filePath, 1, [500, 700, 520, 720]);
  assert.ok(empty.text.length < whole.text.length);
});

test("pdf_formula_candidates：标 approx 且能抓到 E=mc", async () => {
  const filePath = await writeSamplePdf();
  const { items, note } = await pdfFormulaCandidates(filePath);
  assert.ok(note.includes("启发式") || note.includes("approx"));
  assert.ok(items.every((item) => item.approx === true));
  const joined = items.map((i) => i.latex).join("\n");
  assert.match(joined, /E=mc|sum|_i|\^/i);
});

test("pdf_*：不存在的文件人话报错", async () => {
  const missing = join(tmpdir(), "pdf-research-missing", "none.pdf");
  await assert.rejects(pdfStructure(missing), /文件不存在或不可读/);
});

test("pdf_structure：书签 dest 解析成 1-based 页码，坏书签保留 null", async () => {
  const filePath = await writePdf("outline.pdf", buildOutlinePdf());
  const result = await pdfStructure(filePath);
  assert.equal(result.page_count, 2);
  const outline = result.outline.map((node) => [node.title, node.level, node.page]);
  assert.deepEqual(outline, [
    // 页面引用 dest（3 0 R = 第 1 页）与具名目标 dest（4 0 R = 第 2 页）都解析成 1-based 页码
    ["Chapter One", 1, 1],
    ["Chapter Two", 1, 2],
    // 指向不存在页对象的坏书签、以及没有 /Dest 的条目保持 null，且不影响其余解析
    ["Broken Bookmark", 2, null],
    ["No Destination", 2, null],
  ]);
  // 优先书签分支（deriveSectionsFromPages）用的就是这批 1-based 页码
  assert.deepEqual(
    result.sections.map((section) => [section.title, section.page]),
    [
      ["Chapter One", 1],
      ["Chapter Two", 2],
    ],
  );
});

test("pdf_structure：无书签 PDF 不报错，outline 为空并退回标题行启发式", async () => {
  const filePath = await writeSamplePdf();
  const result = await pdfStructure(filePath);
  assert.deepEqual(result.outline, []);
  assert.ok(result.sections.length > 0, "无书签时应由标题行启发式兜底");
});

test("pdf_page_text / pdf_region_text：无文本层返回 note 指向 ocr_scan", async () => {
  const filePath = await writePdf("no-text.pdf", buildNoTextPdf());
  const pageText = await pdfPageText(filePath);
  assert.equal(pageText.text, "");
  assert.match(pageText.note ?? "", /ocr_scan/);
  const regionText = await pdfRegionText(filePath, 1, [0, 0, 612, 792]);
  assert.equal(regionText.text, "");
  assert.match(regionText.note ?? "", /ocr_scan/);
});

test("pdf_*：加密 PDF 给人话报错（FileToolError + 中文指引）", async () => {
  const filePath = await writePdf("encrypted.pdf", buildEncryptedPdf());
  await assert.rejects(pdfStructure(filePath), (error: Error) => {
    assert.equal(error.name, "FileToolError");
    assert.match(error.message, /该 PDF 已加密，无法离线解析，请先解除密码保护/);
    return true;
  });
  await assert.rejects(pdfPageText(filePath), /已加密/);
});

test("pdf_*：真实论文 PDF（fixture 在则跑）", async (t) => {
  const candidates = [
    "设计文件规范引用自查工具使用说明.pdf",
    "2.pdf",
  ];
  const fixture = candidates.map((n) => join(FIXTURE_DIR, n)).find((p) => existsSync(p));
  if (!fixture) {
    t.skip("fixture PDF 不在检出的 docs 目录，跳过真实结构抽取");
    return;
  }
  const structure = await pdfStructure(fixture);
  assert.ok(structure.page_count >= 1);
  const text = await pdfPageText(fixture, 1, Math.min(2, structure.page_count));
  assert.ok(text.text.length >= 0);
  const cites = await pdfCitations(fixture);
  assert.ok(Array.isArray(cites.items));
});
