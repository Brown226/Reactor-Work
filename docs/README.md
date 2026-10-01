# Reactor 文档

本目录存放 Reactor（ZCode 二开产品）相关的设计与工程文档。

文档按**完成状态**分两类存放，文件名前缀即状态标记：

- **`未完成-*.md`**：仍在推进的方案 / 计划 / 缺陷清单，留在本目录根下便于日常查阅与续写。
- **`已完成-*.md`**：已按源码核实落地的契约、规范与实测报告，归档在 [`已完成/`](已完成/) 子目录。

## 未完成（进行中）

| 文档                                                                               | 内容                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [未完成-REACTOR-REBRAND-PLAN.md](未完成-REACTOR-REBRAND-PLAN.md)                   | 去 ZCode 化改造方案：分层清单、决策记录、风险与合规。**P5 服务解耦仍有待办**（插件市场 CDN、反馈/社群链接），P1–P4 已完成                                                                                |
| [未完成-服务端接线-方案-v1.md](未完成-服务端接线-方案-v1.md)                       | **桌面端 ↔ 自建服务端接线**：产品规则、状态所有者、服务端契约、P1–P4 分阶段与验收。P1–P3 已实现；**P4 端侧接线已完成（2026-09-30）**                                                                     |
| [未完成-服务端接线-P4-用量上报与策略.md](未完成-服务端接线-P4-用量上报与策略.md)   | **P4 开工计划**：用量上报（model_call）、桌面策略天花板、outbox/契约与阶段验收。**P4.1a/1b、P4.2a/2b、P4.3 两道闸已完成（§15）；tool_call/approval 与真机验收未做**                                      |
| [未完成-审查板块-方案-v1.md](未完成-审查板块-方案-v1.md)                           | **文件审查板块方案**：审查模式→Agent/Skill/确定性工具映射、管理员端「知识板块」、结果展示与原文高亮、缺口与分期。**M1/M2/M3a–c/M4b 已落地（含 M1b 读文件底座）；企业知识库「以库审文」、图纸类自检未做** |
| [未完成-审查板块-流程问题清单-v1.md](未完成-审查板块-流程问题清单-v1.md)           | **审查流程缺陷清单**：13 条不合理项（3 条会产出错误结论）。**8 条全修 + 1 条半修（P2-2 数据待补）+ 1 条载体消失（P2-3）+ 3 条待决策**                                                                    |
| [未完成-专家技能市场-方案-v1.md](未完成-专家技能市场-方案-v1.md)                   | **专家·技能市场方案**：参考图功能清单、复用/新建决策、前端设计（壳/卡片/详情/管理）、分期与数据源缺口。**M1 已实现，M2/M3 未实现**                                                                       |
| [未完成-file-tools拆三插件方案.md](未完成-file-tools拆三插件方案.md)               | **file-tools 拆三插件**：按引擎分家（file-tools / ocr-tools / dwg-tools），工具名不变。**已收口：两插件补 `mcpServers`、DWG 引擎只归 dwg-tools、冒烟与 README 重写；待真机验证与 SEA 资产链路**          |
| [未完成-PDF阅读器-论文模式-spec-v1.md](未完成-PDF阅读器-论文模式-spec-v1.md)       | **PDF 阅读器 / 论文模式**：离线结构/引文/公式候选 API、阅读器与 PaperSidebar、选区引用进会话。**P0a/P0b 已落地并修复（页签仍只两页、缩略图/搜索未做）；P1/P2 未做**                                      |
| [未完成-GenUI-消息体-最小内核-spec-v1.md](未完成-GenUI-消息体-最小内核-spec-v1.md) | **GenUI 消息体最小内核**：声明式 UI 树 schema、最小节点目录、emit_ui_tree/patch、动作回传。**动作回传与树槽位身份 key 已修；`GenUiInline` 无引用者、导出/调试开关/i18n/JSON Schema 未做**                |
| [brand/未完成-README.md](brand/未完成-README.md)                                   | 品牌素材与生产资产清单；**唯一产品标记为立方体**（风车系列仅存档）。**6 项已完成，5 项待补齐**（矢量源、字标、dmg 背景等）                                                                               |
| [未完成-后续任务清单-审计-v1.md](未完成-后续任务清单-审计-v1.md)                   | **全部未完成文档的源码核对与后续任务清单**：逐份判定表、P0/P1/P2 分级任务、证据路径、文档卫生与待验证项。基线 `af6384a`，静态核对（未跑门禁）                                                            |

## 已完成（已归档）

| 文档                                                                                      | 内容                                                                                                                        |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [已完成-data-directory-contract.md](已完成/已完成-data-directory-contract.md)             | **用户数据目录契约**：唯一所有者、用户级/工作区级边界、可覆盖项、失败语义、有意保留清单                                     |
| [已完成-interface-mode.md](已完成/已完成-interface-mode.md)                               | **界面模式（编程/办公/审查）契约**：状态所有者、全部入口、收敛判据与逐文件归属、分段控件唯一实现、验收场景                  |
| [已完成-appearance-background-theme.md](已完成/已完成-appearance-background-theme.md)     | **背景主题契约**：主区域背景层、模糊/覆盖色参数、渲染契约与验收场景                                                         |
| [已完成-model-governance-and-dev-mode.md](已完成/已完成-model-governance-and-dev-mode.md) | **模型治理契约**：本地模型配置的开发者模式隐藏策略（连点版本号 7 下）、企业目录即白名单                                     |
| [已完成-model-provider-catalog-pull.md](已完成/已完成-model-provider-catalog-pull.md)     | **模型目录拉取契约**：一键拉取 `/models` 的 host 侧执行边界、URL/鉴权策略、勾选与批量添加语义                               |
| [已完成-feedback-module.md](已完成/已完成-feedback-module.md)                             | **反馈 / 需求受理（FBK）契约**：客户端 wire 格式、公开段与鉴权段分工、报告人身份取令牌、红点与事件语义、附件字节直传        |
| [已完成-server-skill-delivery-plan.md](已完成/已完成-server-skill-delivery-plan.md)       | **P2 技能下发实施计划**：目标、旧项目取舍、步骤、风险与验收                                                                 |
| [已完成-server-skill-sync.md](已完成/已完成-server-skill-sync.md)                         | **服务端技能同步契约**：状态所有者、同步时序、失败语义与验收场景                                                            |
| [已完成-服务端接线-P3-Agent下发.md](已完成/已完成-服务端接线-P3-Agent下发.md)             | **P3 Agent 下发开工计划**：server scope 物化、字段映射、发现层/precedence、同步器步骤、风险与验收                           |
| [已完成-文档产出-规范-v1.md](已完成/已完成-文档产出-规范-v1.md)                           | **文档产出规范**：docx/xlsx 排版令牌唯一来源、样式表适配器、排版不变量与渲染验收                                            |
| [已完成-Markdown导出-方案-v2.md](已完成/已完成-Markdown导出-方案-v2.md)                   | **Markdown 导出方案**：PNG / PDF / DOCX 三格式，离屏渲染通道与状态 owner                                                    |
| [已完成-文件解析OCR-CAD-集成方案.md](已完成/已完成-文件解析OCR-CAD-集成方案.md)           | **文件解析 / OCR / CAD 集成**：M1–M5 完成；含 OCR 下沉 office-engines、DWG 切 ACadSharp、拆三插件                           |
| [已完成-OCR栈轻量化方案.md](已完成/已完成-OCR栈轻量化方案.md)                             | **OCR 栈轻量化**：推理下沉 office-engines Python（onnxruntime+numpy 最小 PP-OCR 管线），退役 Node OCR 栈                    |
| [已完成-内网办公四件套-fork-spec.md](已完成/已完成-内网办公四件套-fork-spec.md)           | **内网办公四件套 fork 与分发**：四件套 fork 进仓库、离线可用、三层能力边界；Phase 1/1.5/2 已实施                            |
| [已完成-办公公式与字体管线-借入方案.md](已完成/已完成-办公公式与字体管线-借入方案.md)     | **公式 OMML + CJK 字体管线借入**：LeAgent docgen 零件范围、office-engines 对接、P1–P5 全落地                                |
| [已完成-审查板块-标准库自测报告.md](已完成/已完成-审查板块-标准库自测报告.md)             | **标准引用自检实测报告**：用真实设计文件跑通取数+判定链路（含判定口径、逐条结论），修正白名单误删 77 条，登记数据与能力缺口 |

## 产品站点（官网 + 说明书）

面向使用者与管理员的**离线静态站点**，存放在仓库根目录的 [`portal/`](../portal/)，**单独构建 Docker 镜像**部署到内网服务器供用户查看，与 `server/` 的服务端镜像互相独立：

| 入口                                                          | 内容                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| [`portal/index.html`](../portal/index.html)                   | **官网首页**：产品定位、核心能力、本仓特有、三步部署         |
| [`portal/changelog.html`](../portal/changelog.html)           | **更新日志**：自 v3.14.0 起维护                              |
| [`portal/manual/index.html`](../portal/manual/index.html)     | **说明书首页**：章节导航与阅读建议，双击即可离线打开         |
| [`portal/manual/AUTHORING.md`](../portal/manual/AUTHORING.md) | **编写规范**：产品名与路径口径、不收录项、事实纪律、页面结构 |

说明书覆盖章节：开始使用（4 页）、核心功能（12 页）、扩展体系（5 页）、本仓特有功能（5 页）、内网服务端（3 页）、帮助（4 页），共 34 页（含「关于本说明书」）。

- 说明书内容源是 `portal/manual/pages/*.md`，HTML 由 `node portal/manual/build.mjs` 生成（零依赖，仅需 Node）。
- 口径检查用 `node portal/manual/check.mjs`：站内链接可达性、无外链、无禁用内容、无用户级 `~/.zcode` 路径。
- 产物与浏览器渲染校验用 `node portal/manual/verify-html.mjs` 与 `node portal/manual/smoke-render.mjs`。
- 镜像构建与内网部署、两站互链与品牌口径见 [`portal/README.md`](../portal/README.md)。

## 说明

- 归类依据：**以源码核实为准**（不只看文档自述），并已同步修正文档内过期的状态语句；逐项判定见下表「状态依据」。
- 本目录的改名与链接修复：`docs/README.md` 索引、文档间相对链接、以及代码注释中引用的 `docs/*.md` 路径均已同步更新。
- `docs/审查板块原始数据/`：审查板块的原始数据与审计记录（标准清单、测试文档、实测脚本），非方案文档，未纳入状态归类。
- `portal/`（仓库根目录）：**产品站点（官网 + 说明书离线站点）**，见上方「产品站点」一节；它是面向使用者的改写产物，不是状态归类对象，也不参与本仓构建门禁，单独构建镜像部署。
- 仓库根目录的既有文档各司其职，不迁入此处：`AGENTS.md`（编码代理规则）、`DESIGN.md`（UI 设计系统）、`CONTEXT.md`（插件商店领域词汇）、`README.md`（面向使用者的说明）、`NOTICE.md` / `THIRD-PARTY-NOTICES.md`（合规声明）。
- `knip.json` 已将 `docs/**` 排除在未使用依赖检查之外，本目录不参与构建与打包。
- `server/` 是从旧独立项目 Reactor-Desktop 搬来的**服务端独立 pnpm workspace**：它自带 README 与 AGENTS.md，不在本仓 `pnpm-workspace.yaml` 内，也不参与本仓 lint / fmt / 架构门禁。

## 状态依据

| 文档                          | 判定   | 依据（源码/提交核实）                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REACTOR-REBRAND-PLAN          | 未完成 | P1/P3/P4 主体完成；**P1 的 `dmg_background.png` 仍为 ZCode 字样、P2 的 homepage/author 仍是 `example.com` 占位、P3 的 `REACTOR_*` 主名未做**；P5 仍有待办：插件市场 CDN 默认源、反馈/社群链接                                                                                                                                                                                                                                |
| 服务端接线-方案-v1            | 未完成 | P1–P3 已实现并真机验证（`reactorServerService` 等）；**P4 端侧接线已完成（2026-09-30）**，详见 P4 文档 §15                                                                                                                                                                                                                                                                                                                   |
| 服务端接线-P4                 | 未完成 | 端侧接线已完成（2026-09-30）：`postAuditBatch` + `IReactorServerService` 扩展 + `node.ts` 用量事实源、`ReactorPolicyCache`/`reactorPolicySync`、CLI 模式天花板与命令黑名单、出网白名单、设置页用量与策略简报；**未做真机验收（需真实服务端+登录态）与可选 tool_call/approval 上行**                                                                                                                                          |
| 审查板块-方案-v1              | 未完成 | M1/M2 技能、M3a–c 知识板块、M4b 定位均已在源码落地，M1b 读文件底座已超出文档记录（`parse_document` 默认启用 + `Read` fail-fast 指路）；「以库审文」企业知识库、图纸类自检、Excel 模板导入未做                                                                                                                                                                                                                                |
| 审查板块-流程问题清单         | 未完成 | 缺陷清单性质；13 条中 8 条全修 + 1 条半修（P2-2 代码侧已做、数据待补）+ 1 条载体已移除（P2-3 `review-batch`）+ 3 条未修（P2-4 导出权限实际比文档描述更宽、P3-1 快照生命周期、S-1 凭据密钥）                                                                                                                                                                                                                                  |
| 专家技能市场-方案-v1          | 未完成 | M1 已实现（`MarketPage.tsx`、`ExpertDetailDialog.tsx` 等）；M2/M3 未实现                                                                                                                                                                                                                                                                                                                                                     |
| file-tools拆三插件方案        | 未完成 | 已收口并真机验收（2026-09-30）：两插件 manifest 补 `mcpServers` 并删无效 `main`、file-tools 不再持有 dwg-sidecar、`prepare-file-tools-assets.mjs` 补 dwg assets 暂存、SEA 链路按声明采集 `assets`（含构建期防线）；**三包 build 全过 + 三份 stdio 冒烟 E2E-OK**（file-tools 恰 7 工具、dwg 真图解析出 36 条标准引用、ocr 实跑 PP-OCR）；剩余：装插件后的 MCP 池可见性、`jimp` 移除受阻（CLI workspace install 在 HEAD 即坏） |
| PDF阅读器-论文模式            | 未完成 | P0a/P0b 已落地并修复（2026-09-30）：outline 页码 1-based 解析、加密/无文本层中文提示、guard 补 realpath 越界校验、「引用进会话」改走会话内插入通道并带 `workspaceIdentity`、文案进 i18n、选区菜单补「提问」、**四页签补齐（大纲/插图/公式/引文，浏览器侧启发式）**；**仍未做：缩略图/搜索、`pdfResearchStore`/`ResearchPanel`/「总结论文」、加密件 UI 错误态、截图/框选（P1/P2）；浏览器内交互未跑**                         |
| GenUI-消息体-最小内核         | 未完成 | P0 已落地并修复（2026-09-30）：动作回传改走会话内插入通道并带 `workspaceIdentity`、树槽位 key 改用身份 key（`workspaceIdentity` 优先，回落 `workspacePath`）；**仍未做：`GenUiInline` 无引用者、导出、调试开关、i18n、JSON Schema 文件、节点数上限、工具名与 patch 入参口径回写 spec**                                                                                                                                       |
| brand/README                  | 未完成 | 图标全套已完成；矢量源 SVG、字标、macOS dmg 背景（仍为 ZCode 版）等 5 项待补                                                                                                                                                                                                                                                                                                                                                 |
| data-directory-contract       | 已完成 | `USER_DATA_DIR_NAME` 收口，遗留项已收口                                                                                                                                                                                                                                                                                                                                                                                      |
| interface-mode                | 已完成 | 三档 `interfaceMode` + 三个派生 hook 均在 `useInterfaceMode.ts` 落地                                                                                                                                                                                                                                                                                                                                                         |
| appearance-background-theme   | 已完成 | 主体落地；§5「未做」为明确的后续方向，不阻塞契约                                                                                                                                                                                                                                                                                                                                                                             |
| model-governance-and-dev-mode | 已完成 | 文档自述两条策略已落地，源码核实一致                                                                                                                                                                                                                                                                                                                                                                                         |
| model-provider-catalog-pull   | 已完成 | 契约性质，`providerModelCatalog.ts` 已实现                                                                                                                                                                                                                                                                                                                                                                                   |
| feedback-module               | 已完成 | 客户端 + `server/src/feedback/**` 闭环已实现                                                                                                                                                                                                                                                                                                                                                                                 |
| server-skill-delivery-plan    | 已完成 | 文档自述「已实施」，`serverSkillSyncService.ts` 核实一致                                                                                                                                                                                                                                                                                                                                                                     |
| server-skill-sync             | 已完成 | P2 全部落地，`packages/services/src/server-skills/**` 核实一致                                                                                                                                                                                                                                                                                                                                                               |
| 服务端接线-P3-Agent下发       | 已完成 | 9 个实施步骤全部在源码落地（`server-agents/**`、`useServerAgentSync.ts`、企业专家 i18n）                                                                                                                                                                                                                                                                                                                                     |
| 文档产出-规范-v1              | 已完成 | `document-style.ts` + `docxStyle.ts` 已生效，规范被 `9fe99a3` 等提交引用                                                                                                                                                                                                                                                                                                                                                     |
| Markdown导出-方案-v2          | 已完成 | 三格式随 `1493228` 发布（`desktopMarkdownExport.ts`、`markdownToDocx.ts`），文档自述「实现中」已过期                                                                                                                                                                                                                                                                                                                         |
| 文件解析OCR-CAD-集成方案      | 已完成 | M1–M5 完成（文档自述）；后续演进（OCR 下沉、三插件）另见对应文档                                                                                                                                                                                                                                                                                                                                                             |
| OCR栈轻量化方案               | 已完成 | `office_skill_lib/ocr.py` 落地，file-tools staging 已删 onnxruntime/ocr-models（`68ec34d`）；文档自述「待评审」已过期                                                                                                                                                                                                                                                                                                        |
| 内网办公四件套-fork-spec      | 已完成 | Phase 1/1.5/2 已实施，验收记录 §7.6 齐全                                                                                                                                                                                                                                                                                                                                                                                     |
| 办公公式与字体管线-借入方案   | 已完成 | P1–P5 全部 ✅（`omml.py`、`skill_fonts.py`、`insert_math.py`）；文档自述「待评审」已过期                                                                                                                                                                                                                                                                                                                                     |
| 审查板块-标准库自测报告       | 已完成 | 实测报告性质，结论已定稿                                                                                                                                                                                                                                                                                                                                                                                                     |
