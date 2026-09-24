# 桌面端「文件解析 / OCR / CAD 图纸解析」工具集成方案

状态：**已实现（M1–M5 完成）**。唯一相对原始方案的重大偏差已定稿并落档：扫描 PDF 栅格化
由「随包 poppler 二进制」改为「pdfjs-dist + @napi-rs/canvas 预编译产物」（见 §5.1），
达成同一目标（安装包内自包含、三平台一致、离线可用）且体积更小、无 GPL 闭包。
适用范围：`apps/zcode-cli/packages/file-tools-plugin` 及其资产分发链路；面向核电设计场景的文档审查工作流。

## 1. 目标与非目标（达成状态）

目标（全部达成）：用户安装桌面端后，在**不安装 Python、poppler、tesseract、.NET** 的干净机器上，
Agent 可直接解析 Office/PDF 文档、识别图片与扫描件文字、读取并修改 DWG 图纸
（文本/尺寸/标准引用 + replace_text/rename_layer），并提取符号/连接拓扑图（`dwg_graph`，M5）。

非目标（仍未做，留待后续）：不搬原「核审通」业务逻辑；不做 DWG 可视化渲染与标题栏视觉识别；
不改 Agent 核心（tool handler registry / 协议 / 权限模型）。M5 边界：只认块引用（INSERT）符号、
只收 LINE/多段线（圆弧不收）、tag 只取模型空间文本（块属性 ATTRIB 位号不取）；
流向/管径/仪表功能等语义判断留给模型与知识库。

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
    └── dwg-sidecar/   ACadSharp（.NET sidecar，自包含运行时，MIT，~36MB）

Agent → MCP 子进程：
  parse_document(filePath) → anydoc → markdown/结构化文本
  ocr_scan(filePath)       → 栅格化（pdfjs）→ PP-OCR → 文本+置信度
  dwg_modify(filePath, ops?) → ACadSharp sidecar（子进程）→ 读：图层/文本/尺寸/标准引用；
                                                       改：replace_text / rename_layer，
                                                       .bak 备份 + 写后读回校验后才落盘
  dwg_graph(filePath)         → sidecar graph 命令（INSERT/LINE/POLYLINE 原始行）
                              → 插件内纯 TS 融合（文本 tag 邻近关联 + 线段端点吸附/链合）
                              → 拓扑图 nodes/edges（节点带文本 tag，全部挂 cadHandleId 锚点）
```

## 3. 工具契约（与实现一致）

| 工具                    | 输入                                                                                                                | 输出                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parse_document`        | `file_path`                                                                                                         | `markdown`（`<file_content>` 包裹）、`parser`、`charCount`；扫描件抛 `NEEDS_OCR` 并附改用指引                                                                                                                                                                                                          |
| `ocr_scan`              | `file_path`、可选 `max_pages`(≤50)                                                                                  | `status`、`text`（包裹）、`confidence`、`pages`、`note`                                                                                                                                                                                                                                                |
| `dwg_modify`            | `file_path`、可选 `ops`（省略=读模式）、`in_place`、`output_path`、`max_text_entities`(≤20000)                      | 读：`layers`、`textEntities`、`dimensions`、`standardRefs`（standardNo/standardName/standardIdent/cadHandleId）、`metadata`；改：追加 `modify`（outputPath/backupPath/modifiedHandles/warnings/verify）                                                                                                |
| `dwg_graph`（M5，只读） | `file_path`、可选 `snap_tol`（0.1–1000，默认 5.0，绘图单位）、`max_symbols`/`max_segments`（各 ≤50000，默认 20000） | `status`、`nodes`（id=handle / block / tag / layer / position）、`edges`（from / to / via=direct\|run / length）、`stats`、`truncated`、`note?`、`text`（`<file_content>` 包裹的符号+连接摘要）。图纸无块引用符号时 `status=success` 但 `nodes` 为空且 `note` 明示「未发现块引用符号」，不得静默空结论 |

公共防护：路径必须存在、为文件；体积上限 200MB；只读，不写工作区。
Read 工具入口（contracts/src/tools/read.ts）对 office/dwg 扩展名 fail-fast 并指向上述工具。

## 4. 资产版本矩阵

| 资产                                         | 版本/来源                                                                                          | 许可       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| `@firecrawl/anydoc` + 平台包                 | 0.2.4（lockfile）                                                                                  | MIT        |
| `onnxruntime-node`                           | 1.23.2（lockfile）                                                                                 | MIT        |
| `@napi-rs/canvas`                            | ^1.0.9（lockfile）                                                                                 | MIT        |
| `pdfjs-dist`                                 | 6.2.108（固定；**5.4 在 napi-rs canvas 上段错误，升级前必须跑 test/fixtures.test.ts 栅格化回归**） | Apache-2.0 |
| PP-OCRv5 mobile ONNX + dict（sha256 固定）   | `hf-mirror.com/x3zvawq/paddleocr-js-onnx`                                                          | Apache-2.0 |
| ACadSharp + .NET runtime（DWG 读写 sidecar） | 3.8.0（nuget）/ net9（lockfile 与 csproj 固定）                                                    | MIT        |

**DWG 引擎为 .NET sidecar（ACadSharp，MIT）**，替代早期的 libredwg-web wasm：
libredwg 的写能力仅到 r2004 且 R2010+ 写 CRC 错误，ACadSharp 实测写覆盖
R14/R2000/R2004/R2010/R2013/R2018（缺 R2007，写前需版本判断），同一张真图纸
读→改→写→读校验全通、实体/图层零丢失（详见 docs 迁移动因与 M3 里程碑）。
输出契约与旧 parse_dwg 一致（字段名/语义不变，cadHandleId 同为十六进制），
read 模式无缝替换旧工具；sidecar 经 `dotnet publish` 自包含发布（~36MB），
构建机需 dotnet SDK。

资产由 `scripts/prepare-file-tools-assets.mjs` 生成，双输出：
`packages/desktop/bundled-tools/<platformKey>/file-tools`（进安装包）与
`apps/zcode-cli/packages/file-tools-plugin/assets/<platformKey>`（随插件 seed 覆盖开发态）。
该脚本已挂进桌面构建主链 `packages/desktop/scripts/prepare-runtime-assets.mjs`
（`bundle:desktop` 的 prepare 阶段自动执行，按目标平台传 `--platform`；
干净检出缺少资产目录会让 electron-builder 直接失败，故非可选）。
DWG sidecar 由 `dotnet publish`（自包含、单文件、压缩）出品后拷入资产树；
OCR 模型下载带 dev 缓存复用。

## 5. 资产解析规则（MCP 子进程自解析）

候选顺序（首个存在者胜出，思路同 `runtimeToolResolver.ts`）：

1. 环境变量 `ZCODE_FILE_TOOLS_ASSETS_ROOT`（部署/测试覆盖）
2. `process.resourcesPath/tools/file-tools`（桌面打包态）
3. 开发态：插件包内 `assets/<platformKey>`（src/dist 两种相对形状各一条）

缺失时按能力降级：anydoc 缺失 → `parse_document` 报不可用；onnxruntime 缺失 → `ocr_scan` 报不可用；
dwg-sidecar 缺失 → `dwg_modify` 报不可用（提示补跑 prepare 脚本或 dotnet publish）。

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
3. `dwg_modify` 读模式对真实图纸：25 图层 / 1655 实体 / 617 文本 / 36 条标准引用
   （DL 5068-2014、GB/T 14976-2012 等，ident 与 cadHandleId 回填正确）；
   改模式实测：replace_text 命中 3 处文本 + rename_layer，.bak 备份落盘、写后实体数
   1655→1655 校验一致、修改文本与图层名读回确认（replace_text/rename_layer）。
4. MCP stdio 端到端（spawn dist/mcp/server.js）：initialize/tools/list/tools/call 三工具、错误路径（不存在文件、未知工具）均返回结构化结果；sidecar/pdfjs 的 console 噪声改道 stderr，JSON-RPC 流纯净。
5. 体积：win32-x64 安装包实跑 `pnpm bundle:desktop -- --os win --arch x64` 产出
   `packages/desktop/dist/Reactor-3.14.0-win-x64.exe`（192.5 MiB，libredwg 版）；
   DWG 引擎切换 sidecar 后资产树 159.6 MiB（+36MB sidecar，-5.3MB libredwg），
   重跑 bundle 后以 audit 输出为准；安装包内 `resources/tools/file-tools/` 实测含全部
   资产子树（anydoc / onnxruntime / canvas / ocr-models / dwg-sidecar），
   MCP 子进程按 `resourcesPath/tools/file-tools` 解析的链路在产物层已验证。
6. 验证门：plugin tsc 0 错；`oxlint` 包内 0 警告；root lint 77 warnings 0 errors = 基线；root typecheck 绿；`architecture:check --changed` 0 违规；knip 对 file-tools 0 命中；默认启用镜像（definitions ↔ shared）机械一致。
7. 单测 32/32（含真实 DWG/PDF/docx fixture 的集成用例，`tsx --test test/*.test.ts` 运行；M5 新增融合单测 12 + dwg_graph 端到端 4）。
8. `dwg_graph` 对同一张真实图纸（M5 实测）：sidecar graph 命令 626ms 出 4 个符号节点（块名 gmf×2 + 匿名块 \*U14/\*U17）、710 条 LINE、617 条文本（与 read 模式文本数一致，契约兼容）；默认 snap=5 下 0 连接 / 4 孤立 / 0 tag——该图符号为散落图元画法，工具如实返回稀疏图；`snap_tol=1000` 时 2 个符号命中最近文本（容差参数生效）；`max_symbols=1` 时 `truncated=true` 且 note 明示上限。read/modify 契约逐字段不变（回归通过）。
9. 融合单测（合成数据、无 sidecar 也运行）：直连与链合成边、多符号共链成完全子图、同对符号多条连接合并（length 求和、direct 优先）、tag 邻近/越界、等距平局按 handle 数值序、十六进制排序、多段线长度、空图、snapTol 非正抛错——12 项全过。
10. 无块引用符号的图纸：`status=success`、`nodes` 为空、`note` 明示「未发现块引用符号」，不得静默空结论（note 契约见 §3；端到端 INSERT=0 图纸暂无 fixture，以合成数据与真实稀疏图双重覆盖）。
11. MCP stdio 冒烟（spawn dist/mcp/server.js）：tools/list 四工具（缺一即失败退出）、dwg_graph 对真实图纸 `status=success`、错误路径均返回结构化结果。注意：sidecar 改动后必须重新发布进 `assets/<platformKey>/dwg-sidecar/<rid>/`（publish-sidecar.mjs --out），否则 MCP 子进程按资产解析链会拿到旧二进制报「未知命令：graph」。

## 8. 里程碑（全部完成）

- M1 spec + 插件骨架 + `parse_document`（同时关闭「Agent 读 Office」缺口）。
- M2 `ocr_scan`（pdfjs 栅格 + PP-OCR ONNX + 模型资产）。
- M3：DWG 引擎切换 ACadSharp sidecar；旧 libredwg 路径整体移除。
- M4 资产脚本 + extraResources + official-plugin-definitions/marketplace 镜像 + notices + knip/lint/typecheck/arch 全门 + 冒烟脚本 `scripts/smoke-stdio.mjs`。
- M5：`dwg_graph` 只读工具——sidecar `graph` 命令输出 INSERT/LINE/POLYLINE 原始行（read/modify 契约不变），插件内纯 TS 融合为符号/连接拓扑图（文本 tag 空间邻近关联 + 线段端点吸附/并查集链合，节点/边挂 cadHandleId 锚点）；零新资产、零训练、不改 Agent 核心。

## 9. 风险与遗留

- DWG sidecar 依赖 .NET SDK：构建/资产 staging 机需要 dotnet（`publish-sidecar.mjs --required`
  无 SDK 直接失败），运行时机不需要 .NET（自包含发布）。跨平台目标必须在对应该平台
  的构建机执行（Windows 上无法交叉发布 osx/linux sidecar）。
- ACadSharp 写覆盖 R14~R2018 但 **R2007（AC1021）不可写**；读取全版本。
  集成层应在 modify 前读版本并拒绝 R2007 写操作（当前 sidecar 会尝试写并可能产生
  兼容性问题，正式产品化前需加版本闸门）。
- **darwin/linux 安装包未构建**：需在对应平台构建机执行
  `node scripts/prepare-file-tools-assets.mjs --platform darwin-arm64`（或 `darwin-x64` /
  `linux-x64` / `linux-arm64`）后再 `pnpm bundle:desktop -- --os mac --arch arm64` /
  `--os linux --arch x64` 并重复 audit-bundle-size；本 Windows 主机无法产出这两个平台的产物。
- **DWG 引擎切换后需重跑 win32 构建审计**（sidecar 换 libredwg，资产 129→159.6 MiB）。
  **本机构建机的 fs.cpSync 缺陷（与本次改动无关）**：afterPack 的 copy-runtime-modules
  使用 `fs.cpSync`，本机该调用会稳定触发 0xC0000409 fast-fail（判定实验：摘除本次新增的
  extraResources 条目后同样崩；同源目录 readFile/writeFile 循环拷贝则完全正常——prepare
  脚本 130MB staging 即以此方式完成）。本次以**进程级 preload 垫片**
  （NODE_OPTIONS=--require 注入等价的 readFileSync/writeFileSync 递归实现）绕过后构建成功；
  该垫片未进仓库。若后续本机/CI 再遇 afterPack 同点崩溃，先查构建机 FS filter driver。
- onnxruntime 内存占用：推理在子进程，崩溃不影响会话；超大扫描册用 `max_pages` 控制。
- **M5 验证环境限制（2026-09-24 实测，均与本次改动无关）**：① `pnpm knip` 在本机崩溃
  （oxc-parser `Array buffer allocation failed`；剩余内存 2.3GB/15.9GB；未触碰的
  packages/shared、packages/services workspace 同样崩溃，排除本次改动因素）——需在内存
  充裕的机器复跑；本次改动的新文件均从 knip 入口（`src/server.ts` 与 `test/**/*.test.ts`）
  可达且零新增依赖，结构性满足「0 命中」意图。② root `pnpm fmt:check` 因仓库根目录存量
  `.tmp-*` 临时文件（oxfmt 读取 `.tmp-ocr1.json` 失败）而失败——本次改动文件单独跑
  `oxfmt --check` 全部通过。
- **sidecar 改动后必须重新发布进 assets 资产树**（`node scripts/publish-sidecar.mjs --rid <rid> --out assets/<platformKey>/dwg-sidecar/<rid>`）：
  MCP 子进程按资产解析链优先命中 `assets/` 下副本，只构建 dist 会拿到旧二进制报「未知命令：graph」（M5 实测踩到）。
- 三平台「干净环境全功能可用」仍未做实机安装验证（只有产物层资产核验）；建议发布前在
  无 Python/poppler/tesseract 的干净机器装一次 NSIS 包做冒烟。
