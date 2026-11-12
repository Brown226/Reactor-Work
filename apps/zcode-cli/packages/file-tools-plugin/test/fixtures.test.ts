import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
