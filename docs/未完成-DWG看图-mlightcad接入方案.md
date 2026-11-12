# DWG 看图能力升级：mlightcad 接入方案（P0~P3 已实现，待真机验收）

> 状态：P0 spike 通过 → P1/P2/P3 已实现（2026-11-01），门禁全过，构建产物已验证；
> 剩余验收：dev:web 登录后人工点开图纸 + Chromium 109 回归 + 提交整理。
> 前置阅读：`docs/未完成-我的空间-方案-v1.md` §4.1（DWG 预览 v1/v2 边界）、
> `docs/已完成/已完成-文件解析OCR-CAD-集成方案.md`（ACadSharp sidecar 选型史）。

## 1. 前因后果（这个功能是怎么长出来的）

时间线与因果链：

1. **起点是 agent 的读写工具，不是预览。** 审图场景需要 agent 读改 CAD，
   诞生 `dwg-tools` MCP 插件：`dwg_modify`（读图层/文字/标注/标准引用 + 结构化改字/改层名，
   带 .bak 备份与读回校验）+ `dwg_graph`（符号-连接拓扑）。引擎是 **ACadSharp 3.8.0**
   的 .NET sidecar——选它而不是 LibreDWG 的硬原因：**libredwg 写能力只到 R2004，
   R2010+ 有 CRC 错误**（`tools/dwg-sidecar/Program.cs` 头注释）。
2. **「我的空间」（Web 文件管理器）加了 DWG 在线预览（v1）。** 服务端 spawn 同一个
   sidecar 的 `graph` 命令 → 前端手画 SVG。v1 只收 LINE/多段线与块插入点——圆弧、
   文字全部缺失，严格说是「缩略图」。
3. **v2（本次已完成，未提交）：把图元覆盖补全。** sidecar graph 补 ARC/CIRCLE/ELLIPSE
   （≤10° 采样）、LWPOLYLINE（含凸度弧）、TEXT/MTEXT（字高/旋转/锚点/纯文本）；
   前端新增纯绘制层 `MySpaceDwgDrawing.tsx` + 放大视图滚轮缩放/拖拽平移。
   两张真实图纸验证：工艺说明表（文字密集）效果达标；结构图_A（AC1032）能认图，
   但**块内图元缺失显形**（轴号成灰点）。
4. **定位升级：产品确认「需要看图」而不是「认图」。** 由此结论反转：
   继续给 sidecar 手写渲染（块展开/填充/标注）是在重复造轮子，
   应采用 **mlightcad**（开源浏览器 DWG/DXF 引擎，LibreDWG WASM + three.js，
   外壳 MIT、解析层 `@mlightcad/libredwg-web` GPL-3.0）作为渲染内核。
5. **同时要求：预览能力要进 agent 对话旁的文件预览面板，并能与会话联动。**
   面板即 `packages/ui/src/PreviewPane.tsx` + `previewPaneContent.tsx`
   （按 `source.type` 分发，PDF 已有 `quoteHighlight` 引文高亮范式，DWG 无分支）。

## 2. 这个功能在哪里表现（三处 UI，一条数据链）

| # | 位置 | 入口 | 现状 | 目标 |
| --- | --- | --- | --- | --- |
| A | **我的空间详情栏/放大视图**（仅 Web 宿主） | `MySpacePreview` → `MySpaceDwgPreview`（`packages/ui/src/my-space/`） | v2 SVG（曲线+文字+缩放平移） | 换 mlightcad 内核；SVG 版降级为解析失败兜底 |
| B | **对话旁文件预览面板**（桌面 + Web 共用） | `PreviewPane` → `PreviewPaneContent`（`packages/ui/src/`） | 无 dwg 分支 | 新增 dwg/dxf source 分支，复用同一渲染内核 |
| C | **agent 会话联动** | `dwg_modify` / `dwg_graph` 工具结果 ↔ 预览面板 | 无 | 改图回显 → 引用定位 →（远期）图上选实体进对话 |

数据链路（目标态）：

```
                    ┌─ agent MCP 工具（dwg_modify 读写 / dwg_graph 拓扑）
ACadSharp sidecar ──┤        （保留，唯一 DWG「写」引擎；libredwg 写不了 R2010+）
（桌面端随包分发）
                    └─ 不再服务预览：/api/space/dwg 退役

文件字节 ──► mlightcad（LibreDWG WASM，浏览器本地解析+渲染）
              ├─ 我的空间预览（Web：/preview 文件流）
              └─ 对话预览面板（桌面：fileService 字节；Web：同 /preview 流）
```

关键含义：**预览不再依赖服务端解析**（无 spawn、无 LRU 缓存、服务端零 CAD 负载）；
sidecar 回归其本职——agent 读写。「两套解析引擎」的边界就此划清：
ACadSharp 管写与结构化读（agent），LibreDWG 管人看（渲染保真）。

## 3. 选型结论与理由

| 方案 | 保真度 | 成本 | 结论 |
| --- | --- | --- | --- |
| 继续 sidecar graph + 手写 SVG | 中（缺块/填充/标注，每项都要手搓） | 每个图元 1~3 天 | 放弃作为主渲染；留作兜底 |
| **mlightcad（cad-simple-viewer 核心）** | 高（块/填充/标注/图层/测量，开源里最活跃，日更） | 集成 + 109 验证 + React 包装 | **采用（P0 验证后）** |
| ODA / Aspose / Autodesk APS | 最高 / 高 | 商业授权；APS 图纸出内网 | 不采（不商用） |

许可：外壳 MIT；`libredwg-web` GPL-3.0——**内网自用（不分发）无义务**；将来对外交付需再评估。
浏览器：桌面端渲染进程为现代 Chromium 无约束；**Web 端必须过 Chromium 109 真机**（Win7 舰队），这是 P0 的闸门。

## 4. 分阶段计划

### P0 spike 结论（2026-11-01 实测）

- **Chromium 109 真机通过**：两张真实图纸（AC1018 工艺图 / AC1032 结构图）均打开成功，
  解析+渲染 2.4s / 2.9s，几何保真高（双线墙轮廓、图框、表格、填充管线齐备），
  自动画布适配；GL 警告为驱动性能提示，无害。
- **已排掉的坑**（P1 落地照做）：
  1. 包 peer 互相冲突（three ^0.172 vs ≥0.185）→ 钉 `three@0.172.0` + `--legacy-peer-deps`；
  2. `cad-simple-viewer` 漏声明传递依赖 `@velipso/polybool`（另需手动装 `mitt`/`rbush`）；
  3. 视图默认取 canvas 自身尺寸（300×150）→ 宿主必须传 `calculateSizeCallback`；
  4. 需要随包部署 3 个静态资产：`libredwg-parser-worker.js` + `libredwg-web.wasm`
     （converter `dist/`）+ `mtext-renderer-worker.js`（mtext-renderer `dist/`）。
- **关键发现——字体是外网依赖**：文字实体默认从 `cdn.jsdelivr.net` 拉字体清单与字体，
  内网必失（spike 实测 `fonts.json` 连接被重置 → **文字全不渲染**，几何正常）。
  P1 必须自建字体资产（fonts.json + 字体文件随镜像/桌面包分发，
  通过 mtext-renderer 的 FontManager 指向本地 URL），并把「缺字体」作为可观测告警。
- spike 集成面（已验证的最小调用）：注册
  `AcDbDatabaseConverterManager.instance.register(AcDbFileType.DWG, new AcDbLibreDwgConverter({useWorker:true, parserWorkerUrl}))`
  → `AcApDocManager.createInstance()` → `new AcTrView2d({container, calculateSizeCallback})`
  → `openDocument(fileName, arrayBuffer, {mode: AcEdOpenMode.Read}, view)`。


### P1 我的空间换内核（2~3 天）
- `MySpaceDwgPreview` 内部换 mlightcad 渲染；文件字节走已有预览流；
- SVG 组件保留为兜底（sidecar 501/解析失败时）；`/api/space/dwg` 标记 deprecated（观察一个版本后删）；
- **验收**：两张真图 + 自造几何图通过；109 真机通过；不新增主包体积（懒加载 chunk）。

### P2 对话预览面板接入（2~3 天）
- `PreviewPaneContent` 新增 dwg/dxf source 分支（桌面 + Web 同组件）；
- 桌面取字节走 fileService；Web 走 `/preview` 流；
- **验收**：对话中打开 .dwg 附件/工作区文件出图；桌面与 Web 行为一致。

### P3 会话联动（3~5 天，按序交付）
1. **改图回显**：`dwg_modify` 完成 → 面板自动刷新 + flyTo 高亮 `modifiedHandles`
   （sidecar 读回校验已返回 handles）；
2. **引用定位**：agent 回复中的文字/标注引用（read 输出带 handle）→ 点击 → 图上定位，
   对齐 PDF `quoteHighlight` 范式（`previewPaneContent.tsx`）；
3. （远期）图上选实体 → 作为上下文插入输入框。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Chromium 109 不兼容（three r172 新 API） | **P0 已实测通过**；P1 打包后仍需回归一次 |
| LibreDWG 读覆盖差异（个别 R2013+/异常文件失败） | SVG 兜底组件保留；失败文案引导下载原件 |
| **字体外网依赖（P0 实测）** | fonts.json + 字体文件本地化分发；缺字体时告警并引导 |
| GPL-3.0 传染 | 仅内网自用；对外交付前过法务 |
| 主包体积（wasm ~11MB + worker） | 动态 import 独立 chunk，仅打开 DWG 时加载 |
| 多图框竖排文件（结构图_A 实测 12 框 11 空） | 取景策略交给 mlightcad 的视图管理；不满足再补「聚焦内容」逻辑 |
| 双引擎认知成本 | 文档写明边界：ACadSharp=写+agent 读，LibreDWG=渲染；fixture 双跑 |

## 6. 落地记录（2026-11-01，P0~P3 全部实现）

实际落地的文件（与第 4 节计划的差异见括注）：

| 文件 | 内容 |
| --- | --- |
| packages/ui/vite/dwgViewerAssetsPlugin.ts（新增） | worker/wasm 资产：构建期 emitFile 进产物、开发态中间件直读 node_modules（复用 pdfJsCMapsPlugin 模式） |
| packages/web/vite.config.ts | 挂载 dwgViewerAssetsPlugin |
| scripts/fetch-dwg-fonts.mjs（新增） | 最小中文字体集（fonts.json + txt/simplex/hztxt/gbcbig/gbenor/gbeitc SHX + simsun.woff，约 3.7MB）多镜像下载到 packages/web/public/dwg/fonts/（gitignored）；web 构建机上必须先跑一次，产物随 dist 进镜像 |
| packages/ui/src/dwg/DwgMlightViewer.tsx（新增） | React 包装：单例初始化（转换器注册/字体/worker URL）、打开文档、字体缺失降级提示、bus 订阅 + 按 handle zoomTo |
| packages/ui/src/dwg/dwgViewerBus.ts（新增） | agent 改图/会话引用 → 查看器的解耦事件总线 + 路径后缀匹配 |
| packages/ui/src/my-space/MySpaceDwgPreview.tsx | 主渲染换 DwgMlightViewer；SVG 整体降级为兜底组件 |
| packages/ui/src/my-space/SvgDwgPreview.tsx（新增） | v2 SVG 实现原样保留为兜底（含缩放平移） |
| packages/ui/src/previewPaneDwgContent.tsx（新增） | 对话旁预览面板的 dwg/dxf 内容：fileService 字节 → 同一内核（计划是改 PreviewPaneContent，实际独立成文件避免它超 max-lines） |
| packages/ui/src/previewPaneContent.tsx | 新增 dwg/dxf 分支（排在 office 之前） |
| packages/ui/src/PreviewPane.tsx | dwgPreviewKind 判定 + 复用 readBinaryPreview 字节装载 + fileSource 排除 |
| packages/ui/src/ToolCallBlocks/renderers/dwg-modify.tsx（新增） | dwg_modify 工具卡：改图结果回显 + 「在图中定位」按钮 + 首次出现自动推定位事件（按 filePath+handles 去重） |
| packages/ui/src/ToolCallBlocks/resolveRenderer.ts | 按名认领 dwg_modify（MCP 名可带前缀） |
| packages/ui/package.json | 新依赖：@mlightcad/cad-simple-viewer、data-model、libredwg-converter、mtext-renderer、mtext-parser、three-renderer、three@0.172、@velipso/polybool、mitt、rbush、lodash-es |

验证结果：pnpm typecheck 全过、pnpm lint 0 错误（82 条存量警告）、architecture:check --changed 0 违规、
pnpm --filter @zcode/web build 成功且产物含 dist/dwg-assets/（3 个 worker/wasm）、
dist/dwg/fonts/、mlightcad 懒加载 chunk（cad-simple-viewer-*.js，不进主包）。
运行时行为已在 P0 spike 的 Chromium 109 真机验证（同库同资产路径）；**待办**：登录态下
dev:web 人工点图验收 + 109 对打包产物（非 dev server）回归。

## 7. 已知上游缺口：LWPOLYLINE bulge 弧段不渲染（2026-11-01 定性）

现象：结构图_A/B 的弧形墙在 mlightcad 画布上变成直弦（AutoCAD 正常）。定性依据：

- sidecar 侧实体完好：ARC 18 个（半径仅 70 图元单位，适配视图下亚像素）；大弧墙实为带 bulge 顶点的 LWPOLYLINE；
- LibreDWG 解析无丢失：viewer 数据库里按弧 handle 反查（getObjectById）返回带完整 center/radius/angle 的 AcDbArc；
- three-renderer 1.7.6 / 1.7.7 / 1.7.8-preview.5 的 dist 中 bulge 处理均为 0 处——data-model 顶点有 bulge 字段，渲染层不实现；
- drawNoPlotLayers 开关无效；新版 peer 已升 three ^0.186（引入会破坏 Chromium 109 兼容，不可跟）。

处理：向 mlightcad 报 issue（复现要点：AC1032 图纸、带 bulge 的 LWPOLYLINE、three-renderer 直线化）；
上游修复后升级验证。SVG 兜底路径已正确渲染 bulge（自实现采样），agent 工具链不受影响。

## 8. 「选中 → 右键 → 加入对话」（2026-11-01 实现记录）

- 实测事实：viewer 的 view.selectionSet.ids 即十六进制 handle（与 sidecar cadHandleId 同体系）；
  db.getObjectById(id) 可取实体类型（constructor.name）/图层/文字值；selectByBox 需要真 AcGeBox2d 实例。
- 链路：DwgMlightViewer 开 enableChatQuote（宿主传 quoteTarget）→ 框选/点选实体 → 右键菜单
  「把选中的 N 个实体加入对话」→ dwgChatQuote.ts 生成引用块（文件名 + 类型统计 + 文字内容 + handle 清单）
  → 复用 GenUI/PDF 同款通道写入输入框（有会话走 requestComposerTextInsert 的 append，无会话落根草稿槽）。
- 落点：packages/ui/src/dwg/dwgChatQuote.ts（新增）、DwgMlightViewer（菜单 + 转发）、
  previewPaneDwgContent / previewPaneContent（宿主接线）。我的空间无 composer，不开启。
- 引用块里的 handle 供 agent 用 dwg-sidecar 反查实体语义，直接回答「当前选中是什么」。

## 9. 涉及文件清单（P1/P2 落地时，已被第 6 节取代）

- 改：`packages/ui/src/my-space/MySpaceDwgPreview.tsx`（内核切换 + 兜底分支）
- 改：`packages/ui/src/previewPaneContent.tsx`（新增 dwg/dxf 分支）
- 增：`packages/ui/src/.../DwgMlightViewer.tsx`（React 包装，懒加载）
- 增：依赖 `@mlightcad/cad-simple-viewer`、`three`（peer 由包要求）
- 改：`docs/未完成-我的空间-方案-v1.md` §4.1（口径更新：预览不再走服务端）
- 弃：`packages/server/src/user-space/dwg.ts`（deprecated → 删除，P1 验收后一个版本）
