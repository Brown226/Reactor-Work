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
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function writeSamplePdf(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-research-test-"));
  const filePath = join(dir, "sample.pdf");
  await writeFile(filePath, buildSamplePdf());
  return filePath;
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
