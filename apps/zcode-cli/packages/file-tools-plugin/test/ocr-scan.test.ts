import assert from "node:assert/strict";
import test from "node:test";
import { ocrScan, ocrScanInputSchema } from "../src/tools/ocr-scan.js";
import {
  anydocEntryDir,
  onnxruntimeEntryDir,
  platformKey,
  resolveFileToolsAssets,
} from "../src/assets.js";

test("ocr_scan：非图片/PDF 输入返回 failed 与可读 note", async () => {
  const result = await ocrScan({ file_path: "C:/repo/notes.txt" });
  assert.equal(result.status, "failed");
  assert.match(result.note ?? "", /不支持 OCR 的文件类型/);
});

test("ocr_scan：不存在的文件走统一防护", async () => {
  await assert.rejects(ocrScan({ file_path: "Z:/missing.png" }), /文件不存在或不可读/);
});

test("ocr_scan：max_pages 默认与上限声明", () => {
  const parsed = ocrScanInputSchema.parse({ file_path: "a.pdf" });
  assert.equal(parsed.max_pages, undefined);
  assert.equal(ocrScanInputSchema.safeParse({ file_path: "a.pdf", max_pages: 99 }).success, false);
  assert.equal(ocrScanInputSchema.safeParse({ file_path: "a.pdf", max_pages: 20 }).success, true);
});

test("assets：platformKey 与解析入口（无资产时各目录为 null，不抛）", () => {
  assert.match(platformKey(), /^(win32|darwin|linux)-(x64|arm64)$/);
  const assets = resolveFileToolsAssets({ ZCODE_FILE_TOOLS_ASSETS_ROOT: "" }, process.cwd());
  assert.ok(assets.root === null || typeof assets.root === "string");
  if (assets.root === null) {
    assert.equal(assets.anydocDir, null);
    assert.equal(assets.onnxruntimeDir, null);
  } else if (assets.anydocDir) {
    assert.match(anydocEntryDir(assets.anydocDir), /anydoc/);
  }
  if (assets.onnxruntimeDir) {
    assert.match(onnxruntimeEntryDir(assets.onnxruntimeDir), /onnxruntime-node/);
  }
});
