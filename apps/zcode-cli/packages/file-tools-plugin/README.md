# @zcode/file-tools-plugin

官方内置插件 `file-tools` 的 MCP server：桌面端本地文档解析 / OCR / DWG 图纸抽取。
安装后默认启用，Agent 获得四个只读工具，全部离线可用（无需 Python / poppler / tesseract）。

| 工具 | 能力 | 引擎 |
| --- | --- | --- |
| `parse_document` | Office/PDF → Markdown（docx/doc/xlsx/xls/pptx/ppt/odt/rtf/csv/epub/pdf） | `@firecrawl/anydoc`（napi） |
| `ocr_scan` | 图片/扫描件 PDF → 文本 + 置信度 | PP-OCRv5 mobile（ONNX）+ pdfjs 栅格化 |
| `dwg_modify` | DWG 读（图层/文本/尺寸/标准引用）+ 结构化修改（replace_text/rename_layer） | ACadSharp（.NET sidecar，MIT） |
| `dwg_graph` | DWG 符号/连接拓扑图（块引用符号节点 + 线段连接边，节点带文本 tag，全部挂 cadHandleId 锚点） | ACadSharp（.NET sidecar，MIT）+ 插件内纯 TS 融合 |

## 开发

```bash
# 依赖安装（根目录）
pnpm install

# 生成资产（下载 OCR 模型 sha256 固定 + dotnet 发布 DWG sidecar + 拷贝原生绑定）
node scripts/prepare-file-tools-assets.mjs            # 当前平台
node scripts/prepare-file-tools-assets.mjs --platform darwin-arm64   # 交叉平台（需对应平台 node_modules）

# 构建 + 类型检查 + lint
pnpm --filter @zcode/file-tools-plugin build
pnpm --filter @zcode/file-tools-plugin typecheck
pnpm --filter @zcode/file-tools-plugin lint

# 测试（真实 fixture：docs/审查板块原始数据/标准库测试文档）
pnpm --dir apps/zcode-cli/packages/file-tools-plugin exec tsx --test "test/*.test.ts"

# MCP stdio 冒烟（spawn dist server，四工具 + 错误路径；须在插件目录下执行，脚本按 cwd 解析 dist/mcp/server.js）
 cd apps/zcode-cli/packages/file-tools-plugin
 node scripts/smoke-stdio.mjs <docx> <dwg>
```

## 资产与分发

- 原生绑定 / ONNX 模型 / wasm 以只读资产树分发：安装包 `resources/tools/file-tools/<platformKey>/`
  （electron-builder extraResources），seed 缓存副本覆盖开发态（definition.runtimeTopLevelPaths: ["assets"]）。
- MCP 子进程自解析资产（env → resourcesPath → 包内 assets），候选链见 `src/assets.ts`。
- 版本与哈希固定：npm 依赖取 lockfile；OCR 模型 sha256 见 `scripts/prepare-file-tools-assets.mjs`。
- ACadSharp 与 .NET runtime 均为 MIT；THIRD-PARTY-NOTICES.txt 随资产目录分发。

## 已知约束

- pdfjs 固定 6.2.x：5.4 在 `@napi-rs/canvas` 上渲染真实 PDF 会段错误；升级必须跑
  `test/fixtures.test.ts` 的栅格化回归。
- `dwg_graph` 只认块引用（INSERT）符号、只收 LINE/多段线（圆弧不收）、tag 只取模型空间
  文本（块属性 ATTRIB 位号不取）；符号为散落图元绘制的图纸返回空图并在 `note` 明示。
- DWG 上限 50MB、文本实体上限 5000 条（可调）；`ocr_scan` 单文件 PDF 默认最多 20 页。
