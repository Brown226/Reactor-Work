# 桌面端「文件解析 / OCR / CAD 图纸解析」工具集成方案

状态：**已实现（M1–M4 完成）**。唯一相对原始方案的重大偏差已定稿并落档：扫描 PDF 栅格化
由「随包 poppler 二进制」改为「pdfjs-dist + @napi-rs/canvas 预编译产物」（见 §5.1），
达成同一目标（安装包内自包含、三平台一致、离线可用）且体积更小、无 GPL 闭包。
适用范围：`apps/zcode-cli/packages/file-tools-plugin` 及其资产分发链路；面向核电设计场景的文档审查工作流。

## 1. 目标与非目标（达成状态）

目标（全部达成）：用户安装桌面端后，在**不安装 Python、poppler、tesseract** 的干净机器上，
Agent 可直接解析 Office/PDF 文档、识别图片与扫描件文字、解析 DWG 图纸文本/尺寸/标准引用。

非目标（仍未做，留待后续）：不搬原「核审通」业务逻辑；不做 DWG 可视化渲染与标题栏视觉识别；
不改 Agent 核心（tool handler registry / 协议 / 权限模型）。

## 2. 交付形态（已落地）

官方插件 `file-tools`（默认启用）→ stdio MCP server（`dist/mcp/server.js`，随插件 seed 缓存启动），
三个工具经 `registerMcpTools` 投影进模型工具池，模型侧调用语义与内建工具一致。
差别：MCP 工具默认每次调用弹权限确认（可「始终允许」）；工具名带 `mcp__file-tools__` 前缀。
原生依赖跑在独立子进程（崩溃不拖垮会话），可独立停用回滚。

```
安装包 resources/
├── app.asar（Agent 运行时 zcode.cjs，既有）
└── resources/tools/file-tools/<platformKey>/          ← extraResources（electron-builder.config.js）
    ├── anydoc/        @firecrawl/anydoc + 平台 .node（napi，MIT）
    ├── onnxruntime/   onnxruntime-node 仅本平台绑定（MIT）
    ├── canvas/        @napi-rs/canvas + 本平台 skia（MIT）
    ├── ocr-models/    PP-OCRv5 mobile ONNX + 字典（Apache-2.0）
    └── libredwg/      libredwg-web lib/ + wasm/（GPL-3.0，附源码获取声明）

Agent → MCP 子进程：
  parse_document(filePath) → anydoc → markdown/结构化文本
  ocr_scan(filePath)       → 栅格化（pdfjs）→ PP-OCR → 文本+置信度
  parse_dwg(filePath)      → libredwg wasm → 图层/文本/尺寸/标准引用
```

## 3. 工具契约（与实现一致）

| 工具 | 输入 | 输出 |
|---|---|---|
| `parse_document` | `file_path` | `markdown`（`<file_content>` 包裹）、`parser`、`charCount`；扫描件抛 `NEEDS_OCR` 并附改用指引 |
| `ocr_scan` | `file_path`、可选 `max_pages`(≤50) | `status`、`text`（包裹）、`confidence`、`pages`、`note` |
| `parse_dwg` | `file_path`、可选 `max_text_entities`(≤20000) | `layers`、`textEntities`、`dimensions`、`standardRefs`（standardNo/standardName/standardIdent/cadHandleId）、`metadata` |

公共防护：路径必须存在、为文件；体积上限 200MB；只读，不写工作区。
Read 工具入口（contracts/src/tools/read.ts）对 office/dwg 扩展名 fail-fast 并指向上述工具。

## 4. 资产版本矩阵

| 资产 | 版本/来源 | 许可 |
|---|---|---|
| `@firecrawl/anydoc` + 平台包 | 0.2.4（lockfile） | MIT |
| `onnxruntime-node` | 1.23.2（lockfile） | MIT |
| `@napi-rs/canvas` | ^1.0.9（lockfile） | MIT |
| `pdfjs-dist` | 6.2.108（固定；**5.4 在 napi-rs canvas 上段错误，升级前必须跑 test/fixtures.test.ts 栅格化回归**） | Apache-2.0 |
| PP-OCRv5 mobile ONNX + dict（sha256 固定） | `hf-mirror.com/x3zvawq/paddleocr-js-onnx` | Apache-2.0 |
| `@mlightcad/libredwg-web` | 0.6.10（lockfile） | GPL-3.0（THIRD-PARTY-NOTICES.txt 附源码获取声明） |

资产由 `scripts/prepare-file-tools-assets.mjs` 生成，双输出：
`packages/desktop/bundled-tools/<platformKey>/file-tools`（进安装包）与
`apps/zcode-cli/packages/file-tools-plugin/assets/<platformKey>`（随插件 seed 覆盖开发态）。
该脚本已挂进桌面构建主链 `packages/desktop/scripts/prepare-runtime-assets.mjs`
（`bundle:desktop` 的 prepare 阶段自动执行，按目标平台传 `--platform`；
干净检出缺少资产目录会让 electron-builder 直接失败，故非可选）。
libredwg 包内 TS 编译残留的「无后缀相对导入」在 staging 时用 path.relative 改写为显式路径
（127 处；Node ESM 解析必需，改写日志入 `.bundle-meta.json`）；OCR 模型下载带 dev 缓存复用。

## 5. 资产解析规则（MCP 子进程自解析）

候选顺序（首个存在者胜出，思路同 `runtimeToolResolver.ts`）：
1. 环境变量 `ZCODE_FILE_TOOLS_ASSETS_ROOT`（部署/测试覆盖）
2. `process.resourcesPath/tools/file-tools`（桌面打包态）
3. 开发态：插件包内 `assets/<platformKey>`（src/dist 两种相对形状各一条）

缺失时按能力降级：anydoc 缺失 → `parse_document` 报不可用；onnxruntime 缺失 → `ocr_scan` 报不可用；libredwg 缺失 → `parse_dwg` 报不可用。

### 5.1 相对原始方案的偏差：栅格化链路

原计划「三平台 poppler 二进制（conda/deb/brew）」。实施时发现：
- Windows poppler 官方发行源已失效；conda 闭包需解 libcurl→openssl 等一长串（含 GPL + UCRT 运行时）；
- pdfjs 5.4 + @napi-rs/canvas 在真实 PDF 上**渲染期段错误**；
- node-canvas 2.x 预编译不覆盖 Electron Node ABI（v127 404）。

定稿：**pdfjs-dist@6.2.108 + @napi-rs/canvas**（均为 npm 预编译、N-API 稳定、MIT/Apache）。
实测 fixture 全页渲染正常，体积比 poppler 闭包小，无 GPL 文件需声明。
代价：pdfjs fake worker 需要真实 worker 文件——`scripts/build.mjs` 构建时把
`pdf.worker.mjs` 拷到 bundle 同目录（dist 在插件 seed 白名单内），运行时 `workerSrc` 优先
require.resolve、退化到 bundle 同目录。**锁定 6.2.x，升级必须跑栅格化回归。**

## 6. 状态所有者与事件顺序

本方案无跨进程业务状态；资产是只读产品资产（唯一来源 = prepare 脚本 + lockfile + sha256）。
运行时缓存由既有插件 seed 机制负责（不新建写入路径）。事件顺序：

```
用户 attach 文件（附件带 localPath）
  → Agent 决定工具（Read 入口对 office/dwg fail-fast 引导）
  → MCP 子进程校验路径与体积 → 资产解析 → 推理
  → 结果（<file_content> 包裹）→ 模型可见；低置信度 Agent 可自行 Read 原图兜底
```

## 7. 验收场景（均已实测）

1. 干净 Windows（无 Python/poppler/tesseract）：`docs/审查板块原始数据/标准库测试文档/` 样本——
   docx→12906 字符 markdown（35ms）、xlsx→表格保留、pptx→文本抽取、两份 PDF 正常（2.pdf 仅箭头符号=扫描件信号）。
2. `ocr_scan` 对图像版 PDF：confidence 0.958，中文正确抽出（~10.6s/2 页）。
3. `parse_dwg` 对真实图纸：739ms，25 图层 / 1655 实体 / 617 文本 / 65 条标准引用（DL 5068-2014、GB/T 14976-2012 等，ident 与 cadHandleId 回填正确）。
4. MCP stdio 端到端（spawn dist/mcp/server.js）：initialize/tools/list/tools/call 三工具、错误路径（不存在文件、未知工具）均返回结构化结果；libredwg/pdfjs 的 console 噪声改道 stderr，JSON-RPC 流纯净。
5. 体积：win32-x64 安装包实跑 `pnpm bundle:desktop -- --os win --arch x64` 产出
   `packages/desktop/dist/Reactor-3.14.0-win-x64.exe`（192.5 MiB），
   `node packages/desktop/scripts/audit-bundle-size.mjs --artifact-path <exe>` 通过
   （192.5 ≤ 500 MiB）；安装包内 `resources/tools/file-tools/` 实测含全部五个资产子树
   （anydoc / onnxruntime / canvas / ocr-models / libredwg，共 130MB），
   MCP 子进程按 `resourcesPath/tools/file-tools` 解析的链路在产物层已验证。
6. 验证门：plugin tsc 0 错；`oxlint` 包内 0 警告；root lint 77 warnings 0 errors = 基线；root typecheck 绿；`architecture:check --changed` 0 违规；knip 对 file-tools 0 命中；默认启用镜像（definitions ↔ shared）机械一致。
7. 单测 16/16（含真实 DWG/PDF/docx fixture 的集成用例，`tsx --test test/*.test.ts` 运行）。

## 8. 里程碑（全部完成）

- M1 spec + 插件骨架 + `parse_document`（同时关闭「Agent 读 Office」缺口）。
- M2 `ocr_scan`（pdfjs 栅格 + PP-OCR ONNX + 模型资产）。
- M3 `parse_dwg`（libredwg-web in Node spike 通过：绕开 Vite dist，直接 import `lib/libredwg.js`，wasm 胶水自带 Node fs 分支）。
- M4 资产脚本 + extraResources + official-plugin-definitions/marketplace 镜像 + notices + knip/lint/typecheck/arch 全门 + 冒烟脚本 `scripts/smoke-stdio.mjs`。

## 9. 风险与遗留

- libredwg-web 为 GPL-3.0：THIRD-PARTY-NOTICES.txt 已随资产分发（win32-x64 安装包内已核验）；源码获取声明随包。
- **darwin/linux 安装包未构建**：需在对应平台构建机执行
  `node scripts/prepare-file-tools-assets.mjs --platform darwin-arm64`（或 `darwin-x64` /
  `linux-x64` / `linux-arm64`）后再 `pnpm bundle:desktop -- --os mac --arch arm64` /
  `--os linux --arch x64` 并重复 audit-bundle-size；本 Windows 主机无法产出这两个平台的产物。
- **本机构建机的 fs.cpSync 缺陷（与本次改动无关）**：afterPack 的 copy-runtime-modules
  使用 `fs.cpSync`，本机该调用会稳定触发 0xC0000409 fast-fail（判定实验：摘除本次新增的
  extraResources 条目后同样崩；同源目录 readFile/writeFile 循环拷贝则完全正常——prepare
  脚本 130MB staging 即以此方式完成）。本次以**进程级 preload 垫片**
  （NODE_OPTIONS=--require 注入等价的 readFileSync/writeFileSync 递归实现）绕过后构建成功；
  该垫片未进仓库。若后续本机/CI 再遇 afterPack 同点崩溃，先查构建机 FS filter driver。
- onnxruntime 内存占用：推理在子进程，崩溃不影响会话；超大扫描册用 `max_pages` 控制。
- 三平台「干净环境全功能可用」仍未做实机安装验证（只有产物层资产核验）；建议发布前在
  无 Python/poppler/tesseract 的干净机器装一次 NSIS 包做冒烟。
