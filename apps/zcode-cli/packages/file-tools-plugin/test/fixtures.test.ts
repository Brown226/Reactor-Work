import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDwg, parseDwgInputSchema } from "../src/tools/parse-dwg.js";
import { rasterizePdfPages } from "../src/raster.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "docs", "审查板块原始数据", "标准库测试文档");

function fixture(name: string): string | null {
  const path = join(FIXTURE_DIR, name);
  return existsSync(path) ? path : null;
}

test("raster.ts：真实 PDF 页 → RGBA（pdfjs + @napi-rs/canvas Node 链回归）", async (t) => {
  const pdf = fixture("设计文件规范引用自查工具使用说明.pdf") ?? fixture("2.pdf");
  if (!pdf) {
    t.skip("fixture PDF 不在检出的 docs 目录，跳过栅格化回归");
    return;
  }
  const { images, totalPages } = await rasterizePdfPages(pdf, [1], { dpi: 120, maxPages: 1 });
  assert.ok(totalPages >= 1);
  assert.equal(images.length, 1);
  const image = images[0];
  assert.ok(image.width > 100 && image.height > 100, `尺寸异常：${image.width}x${image.height}`);
  assert.equal(image.data.length, image.width * image.height * 4);
  // 页面应有内容：至少存在非纯黑像素。
  let nonBlack = 0;
  for (let index = 0; index < image.data.length; index += 4000) {
    if (image.data[index] > 20) {
      nonBlack += 1;
      break;
    }
  }
  assert.ok(nonBlack > 0, "渲染结果不应全黑");
});

test("parse_dwg：真实 DWG → 图层/文本/标准引用", async (t) => {
  const dwg = fixture("FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg");
  if (!dwg) {
    t.skip("fixture DWG 不在检出的 docs 目录，跳过真实解析");
    return;
  }
  await readFile(dwg);
  const result = await parseDwg({ file_path: dwg });
  assert.equal(result.status, "success");
  assert.equal(result.metadata.layerCount, result.layers.length);
  assert.ok(result.metadata.layerCount >= 10, `图层数应 ≥10，实际 ${result.metadata.layerCount}`);
  assert.ok(result.metadata.textCount >= 100, `文本实体应 ≥100，实际 ${result.metadata.textCount}`);
  assert.ok(result.standardRefs.length >= 10, `标准引用应 ≥10，实际 ${result.standardRefs.length}`);
  const refs = result.standardRefs.filter((ref) => ref.standardIdent.length > 0);
  assert.equal(refs.length, result.standardRefs.length, "每条引用都应有 ident");
  const standardNos = result.standardRefs.map((ref) => ref.standardNo).join(" ");
  assert.match(standardNos, /GB|DL|HG/);
  assert.match(standardNos, /\d{4}/, "标准号应带年份");
});

test("parse_dwg：非 dwg 拒绝；schema 校验", () => {
  assert.equal(parseDwgInputSchema.safeParse({ file_path: "" }).success, false);
  assert.equal(parseDwgInputSchema.safeParse({ file_path: "a.dwg", max_text_entities: 10 }).success, true);
});
