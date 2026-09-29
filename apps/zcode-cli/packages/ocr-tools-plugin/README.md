# @zcode/ocr-tools-plugin

官方内置插件 `ocr-tools`：图片 / 扫描件 PDF 识字（`ocr_scan`）。
推理在 office-engines Python（`office_skill_lib.ocr`，PP-OCR ONNX），本插件无原生资产。
见 `docs/已完成/已完成-OCR栈轻量化方案.md`、`docs/未完成-file-tools拆三插件方案.md`。

```bash
pnpm --filter @zcode/ocr-tools-plugin build
pnpm --filter @zcode/ocr-tools-plugin typecheck
node --import tsx --test apps/zcode-cli/packages/ocr-tools-plugin/test/*.test.ts
```
