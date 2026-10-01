# @zcode/ocr-tools-plugin

官方内置插件 `ocr-tools`：图片 / 扫描件 PDF 识字（`ocr_scan`）。
推理在 office-engines Python（`office_skill_lib.ocr`，PP-OCR ONNX），本插件无原生资产。
见 `docs/已完成/已完成-OCR栈轻量化方案.md`、`docs/未完成-file-tools拆三插件方案.md`。

```bash
pnpm --filter @zcode/ocr-tools-plugin build
pnpm --filter @zcode/ocr-tools-plugin typecheck
node --import tsx --test apps/zcode-cli/packages/ocr-tools-plugin/test/*.test.ts

# MCP stdio 冒烟（spawn dist server；须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）
# 断言 tools/list 只含 ocr_scan（出现 file-tools / dwg-tools 的工具即失败），并对 fixture 跑 ocr_scan；
# 省略参数时用仓库 fixture。未配置 ZCODE_SKILL_ENGINE_ROOT 时脚本按 dev 候选
# （packages/desktop/bundled-tools/<platformKey>/office-engines）兜底；引擎缺失按 SMOKE-SKIP
# 显式跳过并打印原因，退出码 2（不算通过）。
# 退出码：0 通过；1 失败；2 有跳过的调用。
cd apps/zcode-cli/packages/ocr-tools-plugin
node scripts/smoke-stdio.mjs [图片或PDF]
```

## 引擎解析

- 走到 office-engines（LibreOffice/Python/OCR 模型）的同一个 env 契约：
  `ZCODE_SKILL_ENGINE_ROOT`（或 `ZCODE_PYTHON_PATH` / `OFFICE_SKILL_LIB_ROOT` / `OCR_MODELS_DIR`）。
- 桌面打包态引擎在 `resources/tools/office-engines`，资产由 `scripts/prepare-office-engines-assets.mjs` 生成；
  本插件自身不携带 extraResources（见 `docs/未完成-file-tools拆三插件方案.md` 验收 6）。
