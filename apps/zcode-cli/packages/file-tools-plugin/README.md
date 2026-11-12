# @zcode/file-tools-plugin

官方内置插件 `file-tools` 的 MCP server：本地文档解析 / docx 定点修改 / PDF 研读。
OCR 在 `ocr-tools-plugin`（`ocr_scan`），DWG 在 `dwg-tools-plugin`（`dwg_modify` / `dwg_graph`）
（`docs/未完成-file-tools拆三插件方案.md`）。

| 工具 | 能力 | 引擎 |
| --- | --- | --- |
| `parse_document` | Office/PDF → Markdown | `@firecrawl/anydoc`（napi） |
| `docx_patch` | 已有 .docx 的**定点文字替换**（只改命中的 `<w:t>`，格式原样；默认另存副本） | `fflate`（OOXML zip） |
| `pdf_structure` / `pdf_citations` / `pdf_page_text` / `pdf_region_text` / `pdf_formula_candidates` | PDF 结构/引用/页文本/区域/公式候选（研读） | pdfjs + `@napi-rs/canvas` |

## 开发

```bash
# 依赖安装（根目录）
pnpm install

# 生成资产（file-tools=anydoc+canvas，dwg-tools=dwg-sidecar；DWG 需要 .NET SDK）
node scripts/prepare-file-tools-assets.mjs

# 构建（dist/mcp/server.js + dist/mcp/pdf.worker.mjs）
pnpm --filter @zcode/file-tools-plugin build
pnpm --filter @zcode/file-tools-plugin typecheck
pnpm --filter @zcode/file-tools-plugin lint

# 测试（真实 fixture：docs/审查板块原始数据/标准库测试文档）
pnpm --dir apps/zcode-cli/packages/file-tools-plugin exec tsx --test "test/*.test.ts"

# MCP stdio 冒烟（spawn dist server；须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）
# 断言 tools/list 只含本插件 7 个工具（出现 ocr_scan / dwg_* 即失败），并调用
# parse_document + pdf_structure；省略参数时用仓库 fixture，fixture 缺失按 SMOKE-SKIP 显式跳过。
# 退出码：0 通过；1 失败；2 有跳过的调用。
cd apps/zcode-cli/packages/file-tools-plugin
node scripts/smoke-stdio.mjs [office文档] [pdf]
```

## 资产与分发

- 原生绑定以只读资产树分发：安装包 `resources/tools/file-tools/<platformKey>/`
  （electron-builder extraResources），seed 缓存副本覆盖开发态（definition.runtimeTopLevelPaths: ["assets"]）。
- MCP 子进程自解析资产（env → resourcesPath → 包内 assets），候选链见 `src/assets.ts`。
- 版本固定：npm 依赖取 lockfile；`@firecrawl/anydoc` / `@napi-rs/canvas` 从本工作区 node_modules 拷贝。
- anydoc 与 @napi-rs/canvas 均为 MIT；THIRD-PARTY-NOTICES.txt 随资产目录分发。
- DWG sidecar（ACadSharp，MIT）与 OCR 引擎（office-engines Python）不属本插件，见各自包。

## 已知约束

- pdfjs 固定 6.2.x：5.4 在 `@napi-rs/canvas` 上渲染真实 PDF 会段错误；升级必须跑
  `test/fixtures.test.ts` 的栅格化回归。
- PDF 研读走内置 pdfjs；扫描件（无文本层）由 `pdf_page_text` 的 note 指向 `ocr_scan`
  （ocr-tools），本插件不做 OCR。
