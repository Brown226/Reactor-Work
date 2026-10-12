# file-tools 拆三插件方案

状态：已收口（2026-09-30，待真机验证）｜适用范围：`apps/zcode-cli/packages/{file,ocr,dwg}-tools-plugin`｜维护者：桌面工具组

## 1. 背景

`file-tools` 单包捆了 5 块能力、3 套原生引擎：

| 能力        | 工具                       | 资产                        | 体积  |
| ----------- | -------------------------- | --------------------------- | ----- |
| 文档解析    | `parse_document`           | anydoc                      | ~8MB  |
| OCR         | `ocr_scan`                 | 已迁 office-engines（薄壳） | ~0    |
| docx 手术刀 | `docx_patch`               | 无                          | ~0    |
| CAD/DWG     | `dwg_modify` / `dwg_graph` | dwg-sidecar                 | ~35MB |
| PDF 研读    | `pdf_*` ×5                 | canvas + pdfjs              | ~37MB |

模块 import 不交叉（仅共享 `guard.ts`），具备拆分条件。目标：**按引擎分家**，可单独启用/停用，资产不互相拖累。

## 2. 目标形态（3 插件）

| 插件                   | name         | 工具                                    | 资产                    | 体积  |
| ---------------------- | ------------ | --------------------------------------- | ----------------------- | ----- |
| **file-tools**（收窄） | `file-tools` | `parse_document`、`docx_patch`、`pdf_*` | anydoc + canvas         | ~45MB |
| **ocr-tools**          | `ocr-tools`  | `ocr_scan`                              | 无（调 office-engines） | <1MB  |
| **dwg-tools**          | `dwg-tools`  | `dwg_modify`、`dwg_graph`               | dwg-sidecar             | ~35MB |

**产品规则**

1. **工具名不变**：`parse_document` / `ocr_scan` / `dwg_modify` / … 全部保持，只动插件包名与 MCP server 描述。Agent prompt、review skill、文档零改。
2. **一引擎一 owner**：anydoc→file-tools，OCR→ocr-tools+office-engines，CAD→dwg-tools。禁止跨插件 require 原生资产。
3. **pdf-research 归 file-tools**：语义同属「读文档/论文」，canvas 只服务 pdfjs 栅格；若日后体积压力大再单列。
4. **`docx_patch` 归 file-tools**：无原生依赖，与 `parse_document` 同属文档操作面。
5. **共享代码**：只允许复制极薄的 `guard.ts`（路径防护）；不抽公共包（避免 4 包 workspace 耦合）。

## 3. 非目标

- 不改工具入参/出参 schema；
- 不改 anydoc / ACadSharp / office-engines 引擎选型；
- 不重命名已注册工具（见规则 1）。

## 4. 接线点

| 位置                                | 改动                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `official-plugin-definitions.ts`    | `file-tools` 条目收窄；新增 `ocr-tools`、`dwg-tools`                                     |
| `plugin-marketplaces.ts`            | 与 definitions 同步（bootstrap 单测机械对照）                                            |
| `sea-official-plugin-assets.mjs`    | 3 个 `officialSeaPlugins` 条目                                                           |
| `electron-builder.config.js`        | extraResources：`tools/file-tools`、`tools/dwg-tools`（ocr 无资产）                      |
| `prepare-file-tools-assets.mjs`     | 按插件切 staging：anydoc/canvas → file-tools；dwg-sidecar → dwg-tools                    |
| `contracts/tools/read.ts` fail-fast | 文案改为「file-tools（parse_document）/ dwg-tools（dwg_modify）/ ocr-tools（ocr_scan）」 |
| `bundled-plugins` seed              | 3 套 `runtimeTopLevelPaths`；防「剪掉原生资产」坑各测一遍                                |

## 5. 包布局

```text
apps/zcode-cli/packages/
  file-tools-plugin/          # parse_document + docx_patch + pdf_*
    src/{guard,native,assets,raster,server}.ts
    src/tools/{parse-document,docx-patch,pdf-research*}.ts
    assets/win32-x64/{anydoc,canvas}/
  ocr-tools-plugin/           # ocr_scan
    src/{guard,ocr-python,server}.ts
    src/tools/ocr-scan.ts
  dwg-tools-plugin/           # dwg_modify + dwg_graph
    src/{guard,dwg-sidecar,dwg-graph-fusion,server}.ts
    src/tools/{dwg-modify,dwg-graph}.ts
    assets/win32-x64/dwg-sidecar/
```

## 6. 验收

1. 三个 MCP server 独立 stdio 启动，各自 `tools/list` 只含归属工具。
2. `parse_document` / `ocr_scan` / `dwg_modify` 各跑一条真文件冒烟（与拆前输出一致）。
3. 只装 `ocr-tools` 时（无 anydoc/dwg 资产）`ocr_scan` 仍可用；`dwg_*` 不可见。
4. Read 对 .docx/.dwg/.pdf 的 fail-fast 文案指向正确工具与插件名。
5. `pnpm typecheck`、`pnpm lint`、`architecture:check --changed` 无新增违规。
6. 安装包：file-tools 树 ≤ 50MB，dwg-tools 树 ≤ 40MB，ocr-tools 无 extraResources。

## 7. 实施顺序

| 步骤 | 内容                                           |
| ---- | ---------------------------------------------- |
| P1   | `ocr-tools-plugin`（最小、已解耦）             |
| P2   | `dwg-tools-plugin`（sidecar 整树迁出）         |
| P3   | `file-tools` 删 OCR/DWG，收窄定义与资产        |
| P4   | definitions / SEA / builder / fail-fast / 文档 |
| P5   | 三包测试 + 门禁                                |

---

## 8. 实施记录（2026-10-10，安装包插件清单补全）

**动机**：上线前核对安装包实际内容，发现 `packages/desktop/scripts/prepare-agent-node-bundle.mjs`
的官方插件清单**只有 3 个**（browser-use / node-repl-host / review-skills），而 dev 链从
`apps/zcode-cli/packages/` 源码 seed 能拿全部 16 个 ——「dev 有、安装包没有」静默存在。
根因是 `44b25ed46c`「remove bundled plugins except browser use and cua」移插件时只改了一部分。

**改动**：

| #   | 改动                                                                                                                                                                                                                                                                                                                                                                                                                              | 文件                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | 新建**单一数据源** `scripts/official-plugin-seeds.mjs`（11 内容型 + 3 运行时型条目 + 全量 stagedPath），两份 .mjs 构建脚本都从它导入 —— 三处平行清单的漂移根源就此消除                                                                                                                                                                                                                                                            | 新文件                                                                                    |
| 2   | 桌面打包清单补全 14 个插件，并从单一数据源导入                                                                                                                                                                                                                                                                                                                                                                                    | `packages/desktop/scripts/prepare-agent-node-bundle.mjs`                                  |
| 3   | 远端预构建清单同步补全                                                                                                                                                                                                                                                                                                                                                                                                            | `scripts/prepare-prebuilds.mjs`                                                           |
| 4   | 服务端远端合同（dev 态 SSH 部署校验）补全 14 个包名 + 54 条必需相对路径                                                                                                                                                                                                                                                                                                                                                           | `packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts`                            |
| 5   | staging 白名单补 `assets`：file-tools / dwg-tools 声明了 `runtimeTopLevelPaths: ["assets"]` 却收不到文件时，`bundled-plugins.hasDeclaredAssetsButNoFiles` 会**整体拒绝 seed**，症状是文档解析/图纸解析在安装包里直接消失                                                                                                                                                                                                          | 上述 2、4 两份白名单                                                                      |
| 6   | 顺手修 `eb9bcc5` 遗留漂移：research / analytics 加进了 definitions 的 defaultEnabled 却漏改 `packages/shared/src/plugin-marketplaces.ts`，bootstrap 单测当场抓到（seed 默认开、设置页不认）                                                                                                                                                                                                                                       | `packages/shared/src/plugin-marketplaces.ts`                                              |
| 7   | 补 `official-plugin-definitions.ts` 里 superpowers 漏列的 2 个技能（writing-plans / writing-skills，磁盘上一直有但 seed 校验不查）                                                                                                                                                                                                                                                                                                | `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`                |
| 8   | staging 过滤剔除 `dist/dwg-sidecar`：dwg-tools 的 sidecar 在源码树里有**两份**（`assets/win32-x64/dwg-sidecar/` 与 publish-sidecar.mjs 的发布产物 `dist/dwg-sidecar/<rid>/`），而 `src/assets.ts` 的候选链只认 env / resources/tools/dwg-tools / 插件根 `assets/<platformKey>`，从不解析 dist；两份都拷进 staged 树会让安装包里同一 35.31MB .NET 自包含二进制落三份（dist + assets + resources/tools），远端 4 个平台组件各翻一倍 | `packages/desktop/scripts/prepare-agent-node-bundle.mjs`、`scripts/prepare-prebuilds.mjs` |

**验收（实跑）**：

| 项                                                                                                                                     | 结果                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node packages/desktop/scripts/prepare-agent-node-bundle.mjs`（`ZCODE_BOOTSTRAP_WITH_REMOTE=1` 命中已构建 runtime）                    | 17 个插件全部 stage 成功（含 3 个运行时型的 `dist/mcp/server.js`）                                                                                                                                                                                                                                     |
| 打包产物 seed 验证（`.tmp/verify-packaged-plugin-seed.mts`，chdir 到 `bundled-agents/win32-x64/glm` 走真实入口 `resolveZCodePlugins`） | **17/17 全部被发现**；13 个内容型插件技能数与磁盘逐一相符；4 个运行时型 `dist/mcp/server.js` 落盘；dwg sidecar 实体 35.31MB 落盘（去重后改钉 assets 路径）                                                                                                                                             |
| 体积（staged 插件树，`find -type f` 逐文件累计字节口径）                                                                               | **47.3MB / 379 文件**。其中 dwg-tools 35.33MB 全部是 `assets/win32-x64/dwg-sidecar/` 的 sidecar.exe 35.31MB（运行时唯一读取位置）；file-tools 4.74MB 全是 `dist/mcp/`（server.js 2.45MB + pdf.worker.mjs 2.27MB）；其余 14 个合计 7.2MB。剔除 dist/dwg-sidecar 前后为 82.7MB → 47.3MB，**净减 35.4MB** |
| `pnpm typecheck` / `pnpm lint` / `architecture:check --changed`                                                                        | 退出码 0 / 0 error（85 warnings，基线 87，无新增）/ 0 违规                                                                                                                                                                                                                                             |
| bootstrap `default-enabled-ids.test.ts` + `bundled-plugins.test.ts`（`npx tsx --test`）                                                | 4/4 通过（修漂移前 1 失败）                                                                                                                                                                                                                                                                            |

**已知局限（本轮不扩范围，记录备查）**：

1. **file-tools 的 `assets/win32-x64/{anydoc,canvas}` 在 staged 树里是空壳**：两个目录本身在（满足 `hasDeclaredAssetsButNoFiles` 的「非空」判据），但其下引擎实体全部埋在 `node_modules/@firecrawl/anydoc-win32-x64-msvc/` 与 `node_modules/@napi-rs/canvas/`，被 staging 的 `excludedOfficialPluginAssetNames`（含 `node_modules`）整棵裁掉，只剩 3 个 meta 文件（`.bundle-meta.json` / `SOURCES.json` / `THIRD-PARTY-NOTICES.txt`）。**安装包不受影响**：`src/assets.ts` 候选链第二优先是 `process.resourcesPath/tools/file-tools`，由 electron-builder.config.js:648 从 `bundled-tools/<platform>/file-tools` 独立分发，那条链路不经 staging 白名单。**远端受影响**：远端没有 resources/tools 独立分发，`loadAnydoc()` 的 `runtimeRequire("@firecrawl/anydoc")` 在工作区 node_modules 缺失时会落到空壳目录并抛「anydoc 资产加载失败」—— 这是远端 file-tools 的既有缺口，不是本轮引入（本轮之前它连插件都不在远端清单里）。
2. **dwg sidecar 只有 win32-x64 一份**（源码 assets 树即如此），远端 linux-arm64/x64、darwin-arm64/x64 四个平台拿到的是不可执行的 Windows 二进制；远端 DWG 能力取决于后续是否补跨平台 sidecar 发布，本轮不扩范围。
