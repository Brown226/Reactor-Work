import assert from "node:assert/strict";
import test from "node:test";
import { ocrScan, ocrScanInputSchema } from "../src/tools/ocr-scan.js";

test("ocr_scan：非图片/PDF 输入返回 failed 与可读 note", async () => {
  const result = await ocrScan({ file_path: "C:/repo/notes.txt" });
  assert.equal(result.status, "failed");
  assert.match(result.note ?? "", /不支持 OCR 的文件类型/);
});

test("ocr_scan：max_pages 上限声明", () => {
  assert.equal(ocrScanInputSchema.safeParse({ file_path: "a.pdf", max_pages: 99 }).success, false);
  assert.equal(ocrScanInputSchema.safeParse({ file_path: "a.pdf", max_pages: 20 }).success, true);
});

test("ocr_scan：缺引擎时可读失败，不空成功", async () => {
  const { writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tmp = join(tmpdir(), `ocr-tools-${Date.now()}.png`);
  writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const result = await ocrScan({ file_path: tmp });
    if (result.status === "failed") {
      assert.match(result.note ?? "", /ENGINE_UNAVAILABLE|office-engines|Python|OCR/);
    } else {
      assert.equal(result.pages, 1);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
});
