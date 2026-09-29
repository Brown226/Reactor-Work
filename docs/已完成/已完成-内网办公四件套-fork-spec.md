# 内网办公四件套 · Fork 与分发 Spec

状态：已实施（Phase 1 完成登记）｜适用范围：内外网隔离部署｜维护者：桌面工具组

## 1. 背景与目标

部署环境为公司内网，与公网隔离。办公四件套（documents / pdf / presentations /
spreadsheets）此前以官方市场插件（`zcode-plugins-official`，CDN `cdn-zcode.z.ai`）
形式 seed，断网不可用。本 spec 确立：四件套 fork 进仓库、随安装包分发、离线可用，
并规定它与既有能力的分层边界，避免出现重复写入路径。

## 2. 目标形态：三层能力

| 层 | 组成 | 形态 | 负责人 |
| --- | --- | --- | --- |
| 创作层 | 四件套（docx / pdf / pptx / xlsx skill + 各 1 个 visual-judge agent） | 仓库内置插件，SEA 打包，默认启用 | 本 spec |
| 操作层 | file-tools（parse_document / ocr_scan / docx_patch / dwg_modify / dwg_graph）；PDF 批处理维持 pdf skill 的 `pdf.py`，不再规划 toolknit-tools | 确定性 MCP 工具 | 各自插件 |
| 核心层 | 原生工具（Read / Write / Bash / Agent / 计划 / 工作流） | 不变 | core |

分层规则（产品规则，不是实现细节）：

1. **读 vs 创作**：从既有文件抽取文本/Markdown = 操作层（`parse_document`，单次 MCP
   调用、确定性、无 Python 依赖）；从无到有产出文档 = 创作层（四件套 LLM 流程）。
2. **docx 写入路径二分（唯一 owner）**：`docx_patch` 是「确定性小修」的唯一 owner
   （手术式改字、格式不动）；docx skill 的 edit 路线是「结构性大改」的唯一 owner。
   两者不互相替代，review 一键修改走 docx_patch。
3. OCR（扫描件）、CAD/DWG 归 file-tools，四件套不得重复建设。

## 3. 本次变更（Phase 1）

- 四件套内容 fork 至 `apps/zcode-cli/packages/{documents,pdf,presentations,spreadsheets}-plugin/`，
  形态对齐 `review-skills-plugin`（纯内容型：无 package.json、不进 pnpm workspace）。
- 登记进 `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs` 的
  `officialSeaPlugins`：`requiresRuntime: false`，requiredSeedPaths 与
  `official-plugin-definitions.ts` 中四件套条目逐一对应。
- `official-plugin-definitions.ts` 无需改动：四件套条目（rootCandidates 已含
  `packages/<name>-plugin`、defaultEnabled: true）在 fork 前已存在，本地 root 优先于
  市场源。

### 版本一致性（强制）

三处版本必须同为 `0.1.7`，任一处漂移会导致加载到旧缓存或 seed 校验失败：

| 位置 | 字段 |
| --- | --- |
| `packages/<name>-plugin/.zcode-plugin/plugin.json` | `version` |
| `bootstrap/src/app/official-plugin-definitions.ts` | `.map()` 条目 `version` |
| `cli/scripts/sea-official-plugin-assets.mjs` | `officialSeaPlugins` 条目 `version` |

### requiredSeedPaths 对应表

| 插件 | requiredSeedPaths |
| --- | --- |
| documents | `agents/visual-judge.md`、`skills/docx/SKILL.md` |
| pdf | `agents/visual-judge.md`、`skills/pdf/SKILL.md` |
| presentations | `agents/visual-judge.md`、`skills/pptx/SKILL.md` |
| spreadsheets | `agents/visual-judge.md`、`skills/xlsx/SKILL.md` |

SEA 打包按 `includedTopLevelPaths` 白名单收录（agents / skills / scripts / docs /
package.json / .zcode-plugin 等），routes / scenes / references / env_setup 均位于
skills/ 下随 SKILL.md 一并入包；requiredSeedPaths 只是最小存在性闸门。

## 4. 离线约束

- 禁用官方市场源刷新（内网构建配置）；listing 图标此前指向 CDN，需本地化（Phase 1.5）。
- 四件套**运行时依赖尚未离线化**：python-docx/openpyxl、LibreOffice、字体，pdf 另有
  可选 Playwright/Chromium 与 Tectonic。env_setup 脚本当前仍指示去公网镜像安装。
- 断网行为要求：env 检查必须报告明确依赖缺失（ENGINE_UNAVAILABLE 类可读错误），
  不得静默降级产出残缺交付物。

## 5. 验收场景

1. 断网启动：四个插件加载成功，8 个 skill、4 个 visual-judge agent 可见，无网络报错。
2. `pnpm typecheck`、`pnpm lint` 通过；`architecture:check --changed` 无新增违规。
3. SEA 资产收集脚本可枚举四插件且 manifest hash 稳定。
4. （Phase 2 前）干净账户 + 断网：env_check 对缺失依赖给出可读报告而非伪造成功。

## 6. Phase 1.5：内网开关与商店降级（已实施，语义已定稿为默认禁用）

**定稿语义**：官方市场的 **CDN 目录分片默认禁用**——商店只显示随安装包内置的官方插件，
不访问 `cdn-zcode.z.ai`。显式 `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE=on|1|cdn` 才恢复
CDN 目录（公网开发/联调用）。开关实现于 `packages/shared/src/runtimeEnv.ts`
`isOfficialPluginMarketplaceDisabled`，封堵在三层：

- **分片层**（`adapters/src/plugins/official-marketplace.ts`）：`rebuildOfficialMarketplaceSync`
  在禁用时不合并 CDN 分片（已存在的 `cdn-marketplace.json` 不删除、只是不参与合并——
  每次 App 启动 seed 重写内置分片并重建合并 manifest，已污染的存储**自愈收敛**，实测
  34 → 8 个纯内置条目、0 CDN 残留）；`writeCdnOfficialMarketplacePartitionSync` 在禁用时
  拒绝落盘 CDN 目录；
- **懒加载层**：`ensureMarketplaceManifestAvailable` 在禁用时对官方市场不做 CDN 拉取；
- **刷新层**：`updateMarketplace` 跳过官方市场刷新（刷新失败本就降级为 refresh failure，
  不误报、不阻塞）。

注意：官方市场**记录**（known_marketplaces.json）始终 seed——它是本地元数据，内置插件
分区在商店的展示依赖该 id 存在；禁用的只是 CDN 目录的获取与合并。市场卡片图标为字母
头像回退（`packages/ui/src/marketplace/MarketPage.tsx` 的 `item.icon || item.title.slice(0, 1)`）。
已安装的历史 CDN 插件（如 obsidian）不自动卸载，商店不再显示，用户可在设置里手动移除。

官方**内置**插件的加载不经过市场：SEA 资产 seed → 本地 catalog 分片，与 CDN 分片在
Agent storage 内合并（见 `packages/shared/src/plugin-marketplaces.ts` 注释）。

## 7. Phase 2：运行时离线化（最小依赖定稿）

### 7.0 部署前提（已确认）

内网办公环境**全员预装 Office 与 WPS**，操作系统为中文 Windows（自带宋体/黑体/雅黑，
满足技能的 CJK 字体检查）。据此确定最小依赖策略：

| 依赖 | 定稿处置 | 安装包增量 |
| --- | --- | --- |
| LibreOffice | **不打包**。解析顺序：系统 PATH 的 soffice → `ZCODE_LIBREOFFICE_PATH` /
 `ZCODE_SKILL_ENGINE_ROOT` 指向的受管引擎 → 报缺失走内网流程 | 0 |
| Python + wheels | 打包 embeddable Python 3.12.8 + 15 包闭包（docx/xlsx/pdf 三线 import 全集） | ~90MB |
| CJK 字体 | 不打包，用系统字体（`FONT_DIR` 语义不变）。解析/注册管线与 TrueType 资产策略见 `已完成-办公公式与字体管线-借入方案.md` | 0 |

两个可选的进一步归零项（需 IT 确认，不影响当前定稿）：基镜像预装 LibreOffice（则连
`ZCODE_LIBREOFFICE_PATH` 都不用配，PATH 直查）；基镜像预装 Python 3.12（则 embeddable
也可省，~90MB → 0）。

### 7.1 内网语义修订（fork 对上游的唯二语义改动之一）

上游 env_check 的 on-demand 策略是「缺失就去公网镜像下载、禁止 WPS 替代」。fork 改为：

- soffice 缺失时的处理顺序：已装但不在 PATH 的先注册 → IT 经内网镜像/基镜像提供，或配
  env 指向受管引擎 → **不得静默跳过 PDF 导出/视觉检查**；
- 渲染保真度不再由「必须 LibreOffice」保证，改由 **visual-judge 逐页验收**兜底：渲染产出
  必须经对应 `*:visual-judge` 判定 pass 才算交付（产品约定，与四件套自带的质量门禁一致）；
- 三个 env_check 的提示文案已按此改写，公网镜像地址全部移除。

### 7.2 env 契约与解析层（已实施，见 7.3 前版表格）

`ZCODE_SKILL_ENGINE_ROOT` / `ZCODE_LIBREOFFICE_PATH` / `ZCODE_PYTHON_PATH` / `ZCODE_FONT_DIR`
契约不变；解析层落在三个 `skills/*/env_setup/env_check.sh`（env > 受管根布局 > 系统 PATH），
服务侧注入见 `packages/services/src/runtime-tools/officeEnginesEnv.ts`，安装器条件接入见
`packages/desktop/electron-builder.config.js`（目录存在才打，不打就不注入，全链路降级）。

### 7.3 资产准备脚本（已实施）

`scripts/prepare-office-engines-assets.mjs`：版本 + sha256 固定（manifest:
`scripts/office-engines-assets.json`），分 `--stage libreoffice|python|fonts` 执行，PyPI
走清华镜像。**当前策略下只运行 `--stage python`**；`--stage libreoffice` 保留为「将来若
决定打包 LibreOffice」的一键开关。

### 7.4 COM 垫片（备选，未实施）

若 IT 无法在基镜像提供 LibreOffice，做一个 ~100KB 的 soffice 兼容垫片（Node 单文件，
PowerShell COM 驱动已装的 Word/Excel/WPP 完成 `--headless --convert-to`），随
office-engines 分发并注册到 PATH。触发条件：IT 答复无法预装 LibreOffice。风险：WPS 的
COM 注册完整度需实测，验收以 visual-judge 判决为准。

### 7.5 验收（依赖上述资产）

干净账户 + 断网：env_check 对已具备的依赖全绿（系统 soffice + 内置 python）→ docx/xlsx/pdf
三条创作链路产出 → 各自 visual-judge pass；缺 soffice 时报内网指引而非公网地址。

### 7.6 已执行验收记录（2026-09-28，开发机）

| # | 验收项 | 方法与结果 |
| --- | --- | --- |
| 1 | 真实 CLI 插件发现 | `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE=off reactor plugins list`：四件套全部 [enabled]、0.1.7、各 1 skill；走 `.reactor` 全新缓存 = 干净机器语义 |
| 2 | seed 来源 | 缓存内 documents 0.1.7 含 README.md（仅 fork 有）、env_check 为内网版、agents/visual-judge.md 在 → 确认 seed 自仓库 fork 而非旧市场缓存 |
| 3 | manifest 校验 | `reactor plugins validate <四个插件源码路径>`：全部 valid |
| 4 | 打包态解析 | tsx 模拟 `process.resourcesPath` → `tools/office-engines` 正确产出 ZCODE_SKILL_ENGINE_ROOT / ZCODE_PYTHON_PATH / PATH 项 |
| 5 | env_check ×3 | 打包态环境下 documents/pdf/spreadsheets 全部全绿 |
| 6 | 真实脚本功能 | 内置 python 造真 docx/xlsx/pdf → postcheck（规则 JSON）、add_toc_placeholders（实际改写）、xlsx inspect/validate、pdf_qa 全部通过 |
| 7 | import 全集 | 19/19（含实测才发现的 python-docx 及其传递依赖 typing_extensions） |
| 8 | CI 链路 | prepare-runtime-assets 挂接；无 --record 校验模式 exit 0；冷启动（删缓存）自动重下 + hash 校验通过 |
| 9 | 门禁 | typecheck 0 / lint 0 error / architecture:check 0 新增违规 |

未在本机执行（需真实桌面环境或依赖 IT 决策）：完整 Electron 应用端到端、LibreOffice
相关路由（xlsx recalc / docx→PDF，待用户或基镜像提供 soffice）、visual-judge 逐页判决的
真实调用。另有一项待真实桌面复核：Bash 工具进程 PATH 中 Windows 形态目录条的解析
（与 ripgrep/bfs 等既有内置工具同一机制，非本次引入；env_check 自解析为主路径，不依赖它）。
