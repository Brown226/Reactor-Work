import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dwgModify } from "../src/tools/dwg-modify.js";
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

test("dwg_modify：真实 DWG 读模式（无 sidecar 时跳过）", async (t) => {
  const dwg = fixture("FZ9HX011101B25A43SDACFC (15169HX-JPS01-001).dwg");
  const exe =
    process.env.ZCODE_DWG_SIDECAR_PATH ??
    join(
      REPO_ROOT,
      "apps/zcode-cli/packages/file-tools-plugin/tools/dwg-sidecar/bin/Release/net9.0",
      process.platform === "win32" ? "dwg-sidecar.exe" : "dwg-sidecar",
    );
  if (!dwg || !existsSync(exe)) {
    t.skip("fixture DWG 或 sidecar 未构建，跳过真实解析");
    return;
  }
  const result = await dwgModify({ file_path: dwg });
  assert.equal(result.status, "success");
  assert.equal(result.metadata.layerCount, result.layerDetails.length);
  assert.ok(result.metadata.layerCount >= 10, `图层数应 ≥10，实际 ${result.metadata.layerCount}`);
  assert.ok(result.metadata.textCount >= 100, `文本实体应 ≥100，实际 ${result.metadata.textCount}`);
  assert.ok(result.standardRefs.length >= 10, `标准引用应 ≥10，实际 ${result.standardRefs.length}`);
  for (const ref of result.standardRefs) {
    assert.ok(ref.standardIdent.length > 0, `引用缺少 ident：${ref.standardNo}`);
    assert.ok(ref.cadHandleId.length > 0, "引用应回填 cadHandleId");
  }
  assert.match(result.standardRefs.map((ref) => ref.standardNo).join(" "), /GB|DL|HG/);
});
