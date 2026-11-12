# PDF 阅读器 · 论文模式 Spec

状态：P0a 已落地｜P0b 壳已落地｜适用范围：会话侧 PDF 研究 / 通用阅读｜维护者：桌面工具组
设计来源：LeAgent `frontend/src/features/pdf-reader/*`、
`backend/leagent/tools/doc/pdf_research_core.py`、`pdf_research.py`
（Apache-2.0）。只取「离线结构/引文抽取 + 阅读器 + 选区动作」，
不引入 LeAgent 的翻译供应商约定与其 Research Paper UI 品牌壳。

## 1. 背景与缺口

内网审查与技术文档场景大量输入是 **PDF 论文 / 标准 / 说明书**。现状：

| 能力   | 现状                                                  | 问题                               |
| ------ | ----------------------------------------------------- | ---------------------------------- |
| 读 PDF | `parse_document` / `read-pdf` / pdf skill `extract.*` | 只出正文，无大纲/引文/公式         |
| 定位   | 审查链路有字符高亮                                    | 域绑定在「审查问题」，不是通用阅读 |
| 公式   | 四件套 skill 渲 PNG                                   | 阅读时无法引用/分析                |
| 界面   | 无 PDF 阅读器                                         | 选区无法「解释/引用/翻译/提问」    |

与 `办公公式与字体管线-借入方案` 的关系：本 spec 管**读与研**；
OMML/fonts 管**写与排**。两者共用「公式候选」概念，但落点不同。

与审查板块的边界（产品规则）：

1. **审查** = 对「被审文件」出问题清单并定位；owner 是 `report-review-issues`。
2. **论文模式** = 对「打开的 PDF」做结构化阅读与提问；owner 是本 spec 的阅读器。
3. 审查可复用本 spec 的抽取 API；不得把 PaperSidebar 做成审查结果面板。

## 2. 目标与非目标

### 2.1 目标（P0）

1. **离线**结构抽取：章节树、页码、图/表位置（PyMuPDF，零公网）。
2. **离线**参考文献列表与文内引用候选（`extract_citations`）。
3. 阅读器 UI：分页/缩略图/搜索/文本层选择。
4. 侧栏四页签：**大纲 · 插图 · 公式 · 引文**；点击跳转页码。
5. 选区右键（或浮动）菜单：复制 / **解释** / **引用进会话** / 翻译 / 提问 / 截图 / 框选。
6. 「引用进会话」把页码+原文片段写入会话草稿，Agent 可直接回答。

### 2.2 非目标

- OCR 扫描件识别（归 file-tools `ocr_scan`）。
- PDF 写入/批注保存（归 pdf skill / 后续编辑器）。
- 在线翻译 API 默认接入（内网；菜单项可先调本地模型或隐藏）。
- 文献数据库/知网对接。

## 3. 分层与状态所有权

```text
┌─────────────────────────────────────────────────┐
│ 会话                                            │
│  ResearchPanel（研究态时钉在消息列上方）          │
│    └─ PaperSidebar（大纲/插图/公式/引文）         │
│  消息列（选区动作 → 会话草稿）                    │
├─────────────────────────────────────────────────┤
│  阅读器工作区                                    │
│  PdfReader（pdfjs）＋ PdfThumbnails ＋ Toolbar    │
│  PdfContextMenu（选区动作）                       │
├─────────────────────────────────────────────────┤
│  服务                                            │
│  pdf_research（MCP 或 core 工具）                 │
│    extract_structure / citations / page_text /   │
│    region_text / formula_candidates              │
│  复用：parse_document（纯文本）· ocr_scan（另案）│
└─────────────────────────────────────────────────┘
```

| 状态           | 唯一所有者                             | 说明                                        |
| -------------- | -------------------------------------- | ------------------------------------------- |
| 研究态目标文件 | `pdfResearchStore`                     | `target: fileId/path`、请求跳转页、聚焦区域 |
| 文档结构缓存   | 阅读器 feature 本地（文件 mtime 失效） | 不进全局业务 store                          |
| 选区           | 阅读器 DOM                             | 不落盘                                      |
| 抽取结果       | 服务工具返回值                         | 无服务端会话状态                            |

## 4. 服务接口（建议挂 file-tools 或 core）

移植自 `pdf_research_core.py`，**纯本地**，输入路径校验与 file-tools `guard.ts` 同口径
（存在、是文件、体积上限、不跟符号链接出工作区）。

| 工具                     | 入参                             | 出参                                                                                             |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pdf_structure`          | `path`                           | `{ page_count, outline:[{title,level,page}], sections:[…], figures:[{kind,number,page,bbox?}] }` |
| `pdf_citations`          | `path`, `max_items?`             | `{ items:[{text,page?,raw}] }`                                                                   |
| `pdf_page_text`          | `path`, `start_page`, `end_page` | `{ text }`                                                                                       |
| `pdf_region_text`        | `path`, `page`, `bbox`           | `{ text }`                                                                                       |
| `pdf_formula_candidates` | `path`, `max_items?`             | `{ items:[{page,text,confidence?}] }`                                                            |

约定：

- 与 `parse_document` **不重复写入路径**：parse 仍是「一次调用出正文」；
  本组是「结构化研究 API」。可在 parse 的 display 载荷里加 `hint: 'use pdf_structure'`。
- 页码口径统一 **1-based**：`outline[].page`、`sections[].page`、`figures[].page`
  与 `pdf_page_text` 的 `start_page`/`end_page` 一致；`outline[].page` 解析不出目标时为 `null`
  （坏书签、无效具名目标），UI 侧 `PaperModePanel` 的 `dest[0] + 1` 同口径。
- 错误码沿用 file-tools 风格：路径非法、加密 PDF、无文本层 → 可读中文 + 类名，
  不抛裸栈。
- 公式候选是启发式（公式行/图片区），**不是** LaTeX 识别；置信度低时 UI 标「候选」。

## 5. 前端落点

| 模块            | 建议路径                                    | 职责                                    |
| --------------- | ------------------------------------------- | --------------------------------------- |
| 阅读器          | `packages/ui/src/pdf-reader/`               | pdfjs 封装、缩略图、搜索、文本层        |
| PaperSidebar    | 同上                                        | 四页签 + 跳转 + 「总结论文」按钮        |
| ResearchPanel   | 同上                                        | 研究态钉札卡（风格对齐现有审查/任务卡） |
| PdfContextMenu  | 同上                                        | 选区动作                                |
| composer bridge | 同上 `readerComposerBridge.ts`              | 插入引用、追加 prompt、聚焦输入框       |
| store           | `packages/ui/src/store/pdfResearchStore.ts` | 研究态开关与目标文件                    |

选区动作 → 会话草稿格式（与 GenUI 动作回传风格一致）：

```text
[PDF 引用] path=<file> page=<n>
---
<选中原文>
---
```

「解释 / 翻译 / 提问」追加一行指令后发送。

### 5.1 与 GenUI 的关系

- PaperSidebar **不是** GenUI 树；它是专用阅读器面板。
- 公式分析结果、论文摘要卡等「对话中的结构化卡片」走 GenUI `Card`/`Markdown`（P1 后）。
- 不要在 P0 强行把阅读器做成 `HtmlFrame` 塞进消息体。

## 6. 研究态交互（对应官方截图）

1. 用户打开 PDF（附件 / 工作区文件 / `read-pdf` 结果里的「打开」）。
2. 右栏或分栏显示 PdfReader；消息列上方出现 ResearchPanel。
3. 侧栏点章节 → 页码跳转；点引文/图 → 跳转并高亮区域。
4. 选区菜单「引用进会话」→ 草稿区出现引用块 → 发送后 Agent 作答。
5. 「总结论文」→ 本地结构+全文摘要拼 prompt → 模型输出（依赖已登录模型，抽取本身离线）。

内网约束：文本抽取、结构、引文、公式候选**不得**触发公网；总结/翻译走企业模型出口。

## 7. 验收场景

1. **结构**：打开含书签的论文 PDF，大纲层级与页码正确，点击跳转误差 ≤1 页。
2. **引文**：`extract_citations` 返回参考文献条数与文末列表同量级（允许少量碎片），点选可跳转。
3. **公式候选**：含数学论文页能列出候选行；标注为「候选」，不误称已识别 LaTeX。
4. **选区引用**：选中段落 → 引用进会话 → 发送后回答能围绕该段，草稿含 page。
5. **离线**：断网环境上述 1–4 全绿；「总结」给出模型不可用的可读错误，而非静默空。
6. **边界**：加密 PDF、纯扫描件（无文本层）给出明确错误/提示走 OCR，不崩 UI。
7. **不越界**：审查入口不出现 PaperSidebar；`parse_document` 行为无回归。
8. 门禁：typecheck / lint / architecture:check --changed 零新增违规；core 工具有单测
   （fixture：1 篇带书签论文、1 篇双栏论文）。
   现状（2026-09-30）：带书签 / 无文本层 / 加密三种形态由测试内自造的最小 PDF 覆盖，
   真实论文 fixture（带书签、双栏）仍未入库；仓库现有两份 PDF fixture 实测无书签。

## 8. 分期

| 阶段 | 内容                                             | 完成定义                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0a  | 服务 API 移植 + 单测                             | **已落地**：file-tools `pdf_structure` / `pdf_citations` / `pdf_page_text` / `pdf_region_text` / `pdf_formula_candidates`（pdfjs，启发式在 `pdf-research-heuristics.ts`）；`test/pdf-research.test.ts` 11 项 + `test/guard.test.ts` 4 项，包内 `test/*.test.ts` 29 项全过 |
| P0b  | PdfReader + PaperSidebar + 引用进会话            | **已落地**：预览面板「论文模式」开关（默认关，不与审查定位叠加）；PaperSidebar 大纲/引文（自动抽尾部 References）；选区菜单（复制/引用/解释/翻译）；引用进 v4 composer 草稿。**可选增强**：referencesText 外部注入、区域框选                                              |
| P1   | 框选区域翻译/提问增强、图注对齐、摘要卡（GenUI） | 扩展验收                                                                                                                                                                                                                                                                  |
| P2   | 与审查定位互通（同一 bbox 协议另立）             | 跨域验收                                                                                                                                                                                                                                                                  |

### 落地进度（2026-09-28）

- **P0a**：五件离线 API 在 file-tools MCP，与 `parse_document` 边界写进工具 description。
- **P0b**：预览 PDF 工具条「论文模式」开关 → PaperModePanel（大纲跳页、引文、选区菜单、
  引用进会话写 v4 composer 草稿）。审查 `quoteHighlight` 与论文模式**互斥**，默认普通预览。
- **待做**：内网/产品侧验收场景 5–7 实测；P1 翻译/框选增强。

### 修复进度（2026-09-30）

工具侧四处硬缺口，均改在 `apps/zcode-cli/packages/file-tools-plugin`（`packages/ui/**` 未动）：

- **已修**：
  1. `pdf_structure.outline[].page` 不再恒为 `null`：`readOutline` 用 pdfjs
     `getDestination` / `getPageIndex` 解析 dest，输出 **1-based** 页码；坏书签、无 `/Dest`
     条目保留 `null` 且不影响其余解析（`deriveSectionsFromPages` 的优先书签分支据此生效）。
  2. 加密 PDF：`openPdf` 捕获 pdfjs `PasswordException` → `FileToolError`，提示
     「该 PDF 已加密，无法离线解析，请先解除密码保护」。
  3. 无文本层：`pdf_page_text` 空文本返回 `note`（提示改用 `ocr_scan`，措辞同
     `parse-document.ts` 的 needsOcr）；`pdf_region_text` 仅在该页整体无文本层时同样给 `note`。
  4. `guard.ts` 补 `realpath` 校验：工作区内路径解析后越出工作区（符号链接）即拒。
     工作区根取宿主注入的 `ZCODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR`，退回进程 cwd；
     调用方显式给出的区外绝对路径仍放行（附件/临时目录常在区外）。
- **仍未做**：
  - 插图 / 公式页签——**待决策**：数据来自服务端工具（`pdf_structure` 的 `figures`、
    `pdf_formula_candidates`），浏览器侧只有 pdf.js，没有现成的「UI 读工具产物」通道；
    做四页签必须先定"UI 如何拿到工具产物"（走工具 display 载荷，还是 Host 侧缓存）。
  - 缩略图 / 搜索（§2.1-3）——未做，且不在本轮范围内。
  - `pdfResearchStore` / `ResearchPanel` / 侧栏「总结论文」——**待决策**：需要先定状态所有者与
    数据来源（同上，取数依赖工具产物）。
  - 加密件 UI 处置：工具侧已给可读中文提示，阅读器仍无专门错误态。
  - 截图 / 框选（选区菜单余两项）：属 §6 的 P1/P2，未做。
- **本次验证**：`npx tsx --test "test/*.test.ts"` 29/29 通过；改动文件 `oxlint` 0 警告 0 错误；
  file-tools 包级 `tsc --noEmit` 通过。全量 `pnpm typecheck` / `pnpm lint` 由主脑统一跑。
- **验证边界**：仓库内两份 PDF fixture（`2.pdf`、`设计文件规范引用自查工具使用说明.pdf`）实测
  **都没有书签**，大纲页码只用自造带书签 fixture 验证；验收场景 1 需要一篇真实带书签论文复测。

### UI 侧收口（2026-09-30，第二批）

- **已修**：
  1. 「引用进会话」端到端打通：原先两条桥都写死根草稿槽 `__draft__`，会话内点击看不到内容；
     现改为经 `requestComposerTextInsert` 送入**当前会话**输入框（追加语义，不覆盖用户已输入文字），
     并贯穿传递 `workspaceIdentity`；无活跃会话时保持写根草稿槽的降级行为（`readerComposerBridge.ts`、
     `PaperModePanel`、`previewPaneContent`/`PreviewPane` 透传 `sessionId`）。
  2. 选区菜单补第 5 项「提问」：把选中原文与提问前缀放进输入框，等用户补完问题后自己发送。
  3. 论文模式全部可见文案进 i18n（`paperMode.*` 共 19 键，中英双语），替换
     `PaperSidebar` / `PdfSelectionMenu` / `PaperModePanel` / 预览面板按钮里的硬编码中文。
- **本次验证**：`npx tsc -b packages/ui` 通过；`oxlint` 改动文件 0 警告 0 错误；
  `npx tsx --test packages/ui/test/*.test.ts` 77/77 通过。
- **验证边界**：真实浏览器交互（选区菜单定位、问句落到输入框、Lexical 追加渲染）未跑。

### 四页签补齐（2026-09-30，第三批）

- **数据通道决策（替代原「待决策」）**：插图/公式页签采用**浏览器侧轻量启发式**，
  与 `readerComposerBridge` 里既有的 References 拆分同一先例（"浏览器侧轻量版，完整 API 仍在
  file-tools `pdf_*` 工具"），不新建"UI 读工具产物"通道；正则与去重口径从
  `pdf-research-heuristics.ts` 的 `FIGURE_RE` / `looksLikeFormulaLine` 同源移植。
- **已修**：
  1. `PaperSidebar` 从两页签扩为 **大纲 / 插图 / 公式 / 引文** 四页签，条目点击跳页。
  2. `PaperModePanel` 文档加载后逐页取文本（前 80 页 + 尾部 5 页，超长文档不无限扫描），
     喂给 `scanPaperPagesForFiguresAndFormulas`：图注按 label 去重（同服务端）、公式单行启发式；
     引文页签行为不变（仍只用尾部 5 页）。
  3. i18n 补 `paperMode.tab.figures` / `paperMode.tab.formulas` / 两条空态文案（中英）。
- **本次验证**：`npx tsc -b packages/ui` 通过；`oxlint` 0/0；ui 全量单测 80/80
  （含 3 项新纯函数测试：图注去重带页码、公式过滤噪声行、空输入）。
- **仍未做**：缩略图 / 搜索（§2.1-3）；`pdfResearchStore` / `ResearchPanel` / 「总结论文」；
  加密件 UI 错误态；截图 / 框选（P1/P2）。

## 9. 风险

| 风险                       | 处置                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| 与 parse_document 职责重叠 | §4 写死「研究 API vs 正文抽取」；description 互指                       |
| pdfjs 体积/worker          | 复用 file-tools 已带的 pdf worker 或按需分包；内网 CSP 允许 blob worker |
| 双栏/扫描件抽取质量        | 诚实标注置信度；扫描件引导 OCR                                          |
| 加密 PDF                   | 仅提示；解密不做（不在 P0）                                             |
| 密码/敏感文档              | 路径与内容不进日志；与 file-tools guard 同级                            |
