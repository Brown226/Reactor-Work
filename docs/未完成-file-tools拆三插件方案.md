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
