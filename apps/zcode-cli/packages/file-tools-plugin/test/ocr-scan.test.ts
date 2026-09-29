import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("ocr_scan：缺 office-engines Python 时返回 ENGINE_UNAVAILABLE 文案", async () => {
  const tmp = join(tmpdir(), `ocr-scan-${Date.now()}.png`);
  writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const result = await ocrScan({ file_path: tmp });
    // 有引擎则走真实识别；无引擎则必须是可读 failed，不得空成功
    if (result.status === "failed") {
      assert.match(result.note ?? "", /ENGINE_UNAVAILABLE|office-engines|Python|OCR/);
    } else {
      assert.equal(result.status, "success");
      assert.equal(result.pages, 1);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
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
