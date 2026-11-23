# 工程软件 MCP 接入 — 工作交接

- 交接日期：2026-11-21（2026-11-23 更新进展，见 §十一）
- 当前阶段：**第 1 优先（UI 环境诊断面板 IPC 接线）与第 2 优先（PKPM/BIMBase 端口反查）均已完成并提交；剩余 references 资产入库方式等需产品决策（§十一）**
- 接手前必读：[AGENTS.md](../AGENTS.md)、[specs/engineering-mcp-link.md](../specs/engineering-mcp-link.md)、[apps/zcode-cli/docs/design/v2/engineering-mcp.md](../apps/zcode-cli/docs/design/v2/engineering-mcp.md)
- 交接原因：用户要求停止开发，转交另一个 AI 继续

---

## 一、交接摘要

目标是把 PKPM/BIMBase/AutoCAD 等工程软件的建模与计算能力接进 Reactor，让 Agent 通过 MCP 工具 + 技能包直接驱动这些软件（API 直连，不采集屏幕、不嵌窗口、不读像素）。

**已完成**：工程能力已作为 MCP 服务随 CLI 内置（5 个工具），22 份技能正文与配套资产已入库，AutoCAD 全链路实测打通（连接 → 绘图 → 读回验证），确定性门禁已强制化。

**未完成（2026-11-23 更新）**：UI 环境诊断面板与 PKPM/BIMBase 端口反查已补齐（`a74a443d`、`abc1b92a`）；仍剩 references 正文 216/238 是加密密文、98MB API 库入库方式待产品决策，以及连接器覆盖、完整打包等收尾项（§十一）。

**最关键的一句话**：代码是完整的、接线的、验证过的，但 **UI 部分未提交，且工作区混着另外两条开发线（桌面 Office 编辑器、插件 seed 降级）的改动**。接手第一件事是分清归属，**绝对不要 `git add .`**。

---

## 二、当前仓库状态（必须先看清）

### 2.1 提交状态

```
HEAD = abc1b92a
本地领先 origin/main 共 1 个提交（未推送；其余工程提交已随 origin/main 推送）
暂存区为空
```

9 个基础提交（全部属于本任务）：

| 提交 | 内容 |
|---|---|
| `21f4cfbe` | services 入口导出工程连接层 |
| `8ddc67bf` | 新增工程能力 MCP 服务（stdio，4 工具） |
| `d866650b` | MCP server 配置生成，供宿主注入 Agent |
| `6e656071` | **工程能力随 CLI 内置为 MCP 服务与技能包**（产品级接线） |
| `d069a9a0` | 补齐 22 份技能的 references/scripts 配套资产（289 文件） |
| `5c3cd3c1` | COM 系软件自动发现失败，补 ProgID 注册表兜底 |
| `c9d81996` | 新增带门禁的验证执行工具（第 5 个工具） |
| `e8dbdb80` | 诊断覆盖全部 COM 系软件 |
| `4b907ca7` | MCP 端口解析器可插拔 + 实机端口探测脚本 |

后续本任务提交（2026-11-22 ~ 11-23）：

| 提交 | 内容 |
|---|---|
| `a74a443d` | 设置页环境诊断面板接通桌面 IPC（含 `EngineeringSection`、共享契约、5 语言文案） |
| `d2ff9c1b` | 本文档与 `docs/README.md` 索引登记 |
| `5b998576` | 登记工程 MCP 与诊断面板新文件的架构例外 |
| `abc1b92a` | 端口反查改为按 PID 查询监听端口（`port-lookup.ts` + 回归测试） |

### 2.2 工作区：**三条开发线混在一起**

这是接手时最容易踩的坑。工作区同时包含：

**A. 本任务未提交的 UI 部分（7 个文件）**

| 文件 | 性质 | 改动 | 是否被 Office 组碰过 |
|---|---|---|---|
| `packages/ui/src/settings/EngineeringSection.tsx` | **新文件** | 164 行，只读诊断面板组件 | 否 |
| `packages/shared/src/engineering.ts` | **新文件** | 28 行，跨进程契约类型 | 否 |
| `packages/shared/src/index.ts` | 改 | +1 行 `export * from "./engineering.js"` | 否 |
| `packages/ui/src/SettingsPage.tsx` | 改 | +4 行（import + 条件渲染） | 否 |
| `packages/ui/src/lib/settingsNavigation.ts` | 改 | +5 行（`engineering` section id） | 否 |
| `packages/ui/src/settings/settingsPageConfig.ts` | 改 | +10 行（分区注册，`agentCapabilities` 组） | 否 |
| 5 个 i18n 文件 | 改 | 各 +8 行 `settings.engineering.*` | **是**，各有 1 行 `documentEditor.title` |

**这 7 个文件已用 `git diff` 逐个核实**：前 6 个只含本任务改动，可直接 `git add`。只有 5 个 i18n 需要先分离。

**B. 桌面 Office 编辑器（另一条活跃开发线，不属于本任务）**

已跟踪改动（`git status` 中 ` M`）：

```
packages/services/src/index.ts          ← 见 2.3，动了我的导出
packages/services/src/node.ts           ← 见 2.3
packages/services/src/accessor.ts
packages/shared/src/channels.ts
packages/shared/src/platform.ts
packages/shared/src/validation.ts
packages/desktop/src/host/index.ts
packages/desktop/src/main/index.ts
packages/desktop/src/main/desktopHostProcess.ts
packages/desktop/src/main/desktopWindowChrome.ts
packages/desktop/src/preload/index.ts
packages/desktop/src/renderer/src/desktopPlatform.ts
packages/desktop/src/renderer/src/main.tsx
packages/desktop/tsup.config.ts
packages/client/src/remoteServiceAccess.ts
packages/server/src/knowledge/routes.ts
packages/server/src/knowledge/routesExtra.ts
packages/ui/src/app-shell/AnimatedSidePanePanel.tsx
packages/ui/src/app-shell/SidePaneTabTrigger.tsx
packages/ui/src/app-shell/sidePaneTabPresentation.ts
packages/ui/src/hooks/useAppPanels.ts
packages/ui/src/lib/workspaceSidePane.ts
architecture-policy.yaml                ← 纯格式化 + 47 行新增（document-editing 模块登记）
docs/未完成-桌面Office编辑器-人机双写-spec-v1.md
docs/未完成-桌面Office编辑器-工作交接-v1.md
.gitignore                              ← 新增 .docedit-test/
mise.toml                               ← node 24.14.0 → 24.22.3
scripts/engineering-test-files.json
```

未跟踪（`??`）：

```
packages/desktop/src/host/documentEditorOriginBridge.ts
packages/desktop/src/main/documentEditor/
packages/desktop/src/preload/documentEditorBridge.ts
packages/desktop/src/renderer/src/document-editor/
packages/desktop/test/e2e/ui-shell/panels/manual-review/pending/document-editor-open-save.test.ts
packages/services/src/document-editing/
packages/ui/src/document-editor/
packages/ui/test/documentEditorSidePaneTab.test.ts
output/（9.5M，enbx-export）
```

**C. 第三条线：插件 seed 降级修复（也不属于本任务）**

```
apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts       +18/-2
apps/zcode-cli/packages/bootstrap/test/bundled-plugins.test.ts      +26/-1
```

改动性质（读 diff 确认）：`file-tools` / `dwg-tools` 的 assets 是 build 期产物，未跑 staging 的 checkout 里会「声明了 assets 却收不到文件」。旧实现抛 `ZCODE_PLUGIN_SOURCES_CHANGED` 被当成"源在重建"重试 3 次后致命失败，导致插件市场整体 500。改为可降级的 `ZCODE_PLUGIN_SEED_INCOMPLETE`，只拒绝该插件的缓存。

**这是一条真实的独立修复，不要丢，也不要混进工程提交。**

**5 个 i18n 文件是唯一真正混在一起的**：每个文件里既有我的 8 行 `settings.engineering.*`，也有 Office 组的 1 行 `documentEditor.title`。

其余 4 个我改过的文件（`shared/index.ts`、`SettingsPage.tsx`、`settingsNavigation.ts`、`settingsPageConfig.ts`）已逐个 `git diff` 核实**只含本任务改动**，可直接 `git add`。

### 2.3 必须知道的一个变化：engineering 导出已被移走

Office 组在 `packages/services/src/index.ts` 里把我的 `export * as engineering` **移到了 `node.ts`**，并加了注释说明原因：

> 该命名空间整体依赖 node:net / node:fs / node:child_process，只从 Node 入口导出。放在这里会被 renderer 的依赖链一并加载，浏览器环境访问 node:net.createConnection 即抛错，与 knowledge sidecar 白屏同因。

**这个改动是正确的、必要的**，不要改回去。同样的处理也发生在 `KnowledgeClient` 上。

已验证不受影响：`packages/services/dist/engineering/mcp-server-main.js` 实测启动正常，`tools/list` 返回 5 个工具（见第六节）。

---

## 三、已完成的工作（含实测证据）

### 3.1 产品级接线（`6e656071`）

| 文件 | 作用 |
|---|---|
| `apps/zcode-cli/packages/bootstrap/src/app/engineering-runtime.ts`（新，150 行） | 只读探测产物目录，产出 MCP 配置 + 技能根 |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | 并入 `builtInMcpServers` 与 `extraResolvedRoots` |
| `apps/zcode-cli/packages/bootstrap/tests/engineering-runtime.test.ts`（新） | 10 个用例 |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs` | 新增 `stageEngineeringRuntime()` |
| `apps/zcode-cli/docs/design/v2/engineering-mcp.md`（新） | spec |

**两个踩过的坑（务必保留）**：

1. **回溯层数是 6 层不是 5 层。** 入口 `bootstrap/dist/app` → 仓库根需要 6 层（app → src → bootstrap → packages → zcode-cli → apps → 根）。按 5 层写，开发态根本不命中。

2. **stage 时必须写 `{"type":"module"}`。** `dist/engineering` 是 ESM，而 `glm` 资源树没有 `package.json`——此时 `.js` 会被 Node 按 CJS 解析，`import` 直接抛 `SyntaxError`，症状是"工程 MCP 连不上"。

### 3.2 技能资产（`d069a9a0`）

- 从 `BKBM/` 复制 289 个文件、4.1M 进 `packages/services/src/engineering/skills/`
- 22 个技能目录，每个都有 `SKILL.md`
- 已同步到 `dist`（26 项含 `builtin-skills.*`，24 个 `references` 目录）

**实测统计（2026-11-21 交接时重跑，口径：正文中出现的 `references/` `scripts/` `assets/` 路径，无论是否加反引号）**：

```
引用总数 235，缺失 54
md 文件 238 个，其中加密 216 个
```

缺失分布（集中在 5 个技能）：

| 技能 | 引用 | 缺失 | 性质 |
|---|---|---|---|
| GBP-Link | 50 | **41** | BKBM 源本身缺 20 个子模块入口目录 |
| skill-creator | 10 | **8** | 源缺模板文件 |
| Rhino-Link | 11 | 2 | 源缺 |
| plugin-creator | 6 | 2 | 源缺 |
| STAADPro-Link | 8 | 1 | 源缺 |
| 其余 10 个技能 | 150 | **0** | ✅ 全部可解析 |

**核心技能全部零缺失**：PKPM-Link、AutoCAD-Link、SSG-Link、PKPMCAE-Link(46 引用)、Abaqus-Link(31)、Tekla-Link(26)、ETABS-Link(17)、SAP2000-Link(12) 全部 0 缺失。

> ⚠️ 口径说明：本任务过程中先后报告过「151→34」和「52→10」两组数字，都是不同正则口径下的中间结果。**以本节 235/54 为准**，这是交接时用「任意路径形态」重跑的结果。接手者可用下面的命令复现：

```bash
cd packages/services/src/engineering/skills && python -c "
import os,re
base='.'
total=miss=0
for sk in sorted(os.listdir(base)):
    p=os.path.join(sk,'SKILL.md')
    if not os.path.exists(p): continue
    txt=open(p,encoding='utf-8',errors='ignore').read()
    for m in re.findall(r'(references/[A-Za-z0-9_./-]+|scripts/[A-Za-z0-9_./-]+|assets/[A-Za-z0-9_./-]+)', txt):
        total+=1
        if not os.path.exists(os.path.join(sk,m)): miss+=1
print('TOTAL',total,'MISS',miss)
"
```

**⚠️ 必须知道的限制**：238 个 `.md` 里 **216 个是加密密文**（`<!--PKPM-SKILL-ENC:v1-->` + base64），仓库里**没有任何解码实现**。BKBM 的 license 明确禁止逆向还原，**不要尝试破解**。真正可读的只有 22 个 `SKILL.md`、70 个 `.py` 脚本、2 个 schema。

这意味着「引用缺失从 151 降到 34」这个成果要打折看——**文件名齐了，正文多数读不出来**。

### 3.3 COM 系自动发现修复（`5c3cd3c1`）

**根因**：`featurePaths: []` 且 `registryRoots` 从未被传入，候选根恒空。

**修复**：给 `ComSoftwareLink` 加 `progId` 与 `registryRoots`，补注册表兜底；`win-registry.ts` 新增 `isComProgIdRegistered` / `resolveComProgIdExe`。

**实测**：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `connectToServer("autocad")` 不传 exePath | ❌「未能自动定位 AutoCAD」 | ✅ `true`，解析到 `C:\Program Files\Autodesk\AutoCAD 2021\acad.exe` |

**踩坑记录**：用 `reg.exe` 从 Node 查注册表时，反斜杠会被 `spawnSync` 吃掉（`HKCR\AutoCAD` → `HKCRAutoCAD`）。**不要在 Node 里调 `reg.exe` 查带反斜杠的键**，改用 `winreg` 的 Python 或直接用 Node 的注册表读取方式。当前实现已绕过这个问题，但重新实现时容易再踩。

### 3.4 强制门禁（`c9d81996`）

新增第 5 个工具 `run_verified_engineering_script`，把「预检 → 执行 → 判定」固定在**一个调用内**，解决「Agent 只跑脚本不判定就宣称成功」的问题。

**六条分支实测**：

```
预检失败   → stage=preflight，脚本未执行 ✅
超界       → stage=gate，deliverable=false ✅
缺测值     → stage=gate，deliverable=false ✅
全部满足   → stage=done，deliverable=true ✅
review     → stage=gate，永不自动通过 ✅
执行失败   → stage=run ✅
```

**设计铁律**（不要改）：`review` 操作符**永远返回 false**——有些工程判断不允许 AI 下结论。

### 3.5 诊断与端口解析器（`e8dbdb80`、`4b907ca7`）

- `diagnose()` 扩展到全部 COM 系软件，实测 AutoCAD 正确识别，其余如实报未安装
- `setPortResolver` 现在由 `registry.ts:46` 调用，可插拔生效
- `packages/services/scripts/probe-engineering-port.mts`：实机端口探测脚本（直接复用 `port-lookup.ts` 的解析与排序，探测结果与连接层一致）

### 3.6 AutoCAD 全链路（本任务最有价值的验证）

三层验证全部通过，环境为系统 Python 3.13.16 + AutoCAD 2021（24.0）：

| 验证层 | 结果 |
|---|---|
| 原生 win32com + VARIANT 传点 | `DRAW_OK before=0 after=2`，句柄 80/81 |
| 社区版 pyautocad + `APoint` | `DRAW_OK before=2 after=4`，句柄 82/83 |
| 读回验证（不看屏幕） | `line_start_x=0.0 line_end_y=100.0`、`circle_radius=25.0 center_x=50.0` |

已装依赖：`pywin32 312`、`comtypes 1.5.0`、`pyautocad 0.2.0`。

**技能文档已改写为社区版可执行写法**（`5c8bdd29`），改写后严格照文档跑过 `ALL_OK`。

**⚠️ 已知限制**：技能原文档依赖定制版 pyautocad（`acad.connection.selected_by`、`CadSelectionRequiredError`、`acad.constants` 等），**这些社区版全都没有，仓库里也没有任何实现文件**。已改写为社区版写法，并明确标注**只支持 AutoCAD**，浩辰/中望需定制版补齐后才能声称支持。

---

## 四、未完成的工作（按优先级）

### 第 1 优先：UI 环境诊断面板接线（约 150 行，本机可做）✅ 已完成（`a74a443d`）

> **实现结果（2026-11-22）**：IPC 五件套已落地——`PlatformChannels.EngineeringDiagnose`、`IPlatformService.engineering?: EngineeringPlatformPort`、preload `diagnoseEngineeringEnvironment`、main `ipcMain.handle(..., () => engineering.diagnose())`、renderer `createDesktopPlatform` 组装；`SettingsPage.tsx` 已传 `loadReport`。`diagnose()` 用 `npx tsx .tmp-probe/verify-diagnose.mts` 实跑通过（识别 AutoCAD、如实报未安装）。下方为交接时的原始分析，保留备查。

**已完成**：组件、契约类型、分区注册、文案全部写好（7 个文件，见 2.2 A）。

**缺的是 IPC 四件套**：

| 文件 | 要加什么 |
|---|---|
| `packages/shared/src/channels.ts` | `EngineeringDiagnose` 通道名 |
| `packages/shared/src/platform.ts` | 可选的 `engineering?: { diagnose() }` 端口 |
| `packages/desktop/src/preload/index.ts` | 暴露调用 |
| `packages/desktop/src/main/index.ts`（或 host） | 注册 handler，转调 `diagnose()` |
| `packages/desktop/src/renderer/src/desktopPlatform.ts` | 组装 |

**然后**：`SettingsPage.tsx` 第 2177 行把 `loadReport` 传进去：

```tsx
<EngineeringSection isDesktop={Boolean(isDesktop)} />
// 改为
<EngineeringSection isDesktop={Boolean(isDesktop)} loadReport={...} />
```

**当前行为**：没传 `loadReport` 时组件显示「桌面端环境诊断接口尚未接入」（`settings.engineering.notWired`），不会崩，也不会伪造数据。

**为什么绕不开那四个文件**：`diagnose()` 依赖 `node:fs` / `child_process` / Windows 注册表，renderer 进程跑不了，必须 IPC 到 main 转调。

**冲突判断**：语义零冲突（那四个文件里 `grep -i engineering` 零命中，Office 组动的是 `documentEditor`），但文件共用，`git add` 会混。**建议等 Office 组提交后再动**。

### 第 2 优先：PKPM/BIMBase 端口反查（唯一硬阻塞，**必须在装了 PKPM 的机器上做**）✅ 已完成（`abc1b92a`，实机待复验）

> **实现结果（2026-11-23）**：新增 `packages/services/src/engineering/mcp-link/port-lookup.ts`，按 PID 取该进程 TCP 监听端口（Windows `Get-NetTCPConnection`→`netstat` 回退；Linux `ss`→`lsof`；其它 POSIX `lsof`），候选按「回环优先→非特权端口优先→端口号升序」排序后逐个连通确认，`waitForMcpPortByPid` 轮询等待（默认 100s，与逆向出的 `wait_local_mcp_ready(port, timeout=100)` 对齐）。`BimBaseLink` 已把「找到进程」与「拿到端口」分开表达：已运行但端口未开时等该 PID，不再退化成再启动一个实例。本机无 PKPM/BIMBase，**实机连通仍需在装有软件的机器上复验**（跑 `npx tsx packages/services/scripts/probe-engineering-port.mts BIMBase` 对照输出即可）。下方为交接时的原始分析，保留备查。

实测现状：

```ts
// packages/services/src/engineering/mcp-link/discovery.ts:57 和 :112
return undefined;
```

| 项目 | 现状 |
|---|---|
| `readMcpPortForPid()` | 恒返回 `undefined`（注释承认"无实机无法确定格式"） |
| `setPortResolver` 调用点 | ✅ 已由 `registry.ts:46` 调用（`4b907ca7` 修复） |
| 实机验证 | ❌ 无法在本机做（本机未装 PKPM/BIMBase） |

**后果**：BIMBase/PKPM 启动后必然返回「已启动 BIMBase，但未能在约定时间内取得 MCP 服务端口」，**走不到 `waitForPort` 和握手**。这不是等久一点能解决的。

**接手方法**：

```bash
npx tsx packages/services/scripts/probe-engineering-port.mts BIMBase
```

输出会直接告诉你「哪个 PID 的哪个端口可连接」，然后注入一条 `setPortResolver` 即可。本机已验证该脚本能正确识别 node 进程的 4 个端口。

### 第 3 优先：references 正文可读性（需决策）

| 资产 | 体积 | 现状 |
|---|---|---|
| references 258 项 | 28MB | 文件名已入库，**216/238 的 md 是密文** |
| API 知识库 10 个 .db | 98MB | **0 个入库** |

98MB 不可能进 git。**入库方式未定**（git LFS / 构建时下载 / 服务端下发），这是需要产品决策的事，不要擅自决定。

### 第 4 优先：连接器覆盖

`registry.ts` 实测登记 6 个：`bimbase`、`pkpmmcp`、`sap2000`、`etabs`、`autocad`、`rhino`。

| 情况 | 数量 |
|---|---|
| 已登记 | 6 |
| 未登记 | 16（SSG、GBP、PlantS、MIDAS、Tekla、SketchUp、Excel、Word、PPT、Abaqus、STAADPro…） |
| 已登记且实测连通 | **1 个（AutoCAD）** |

**⚠️ 重要纠正（此前判断错过一次，不要重复）**：22 个技能里**只有 3 个**用 `connect_to_server`（PKPM-Link、SSG-Link、plugin-creator）。Office、PlantS、MIDAS、Tekla、Rhino、SketchUp 用的是 `PKPMAgent.software_link_kit`，**这个包不在仓库里**。所以**给 registry 加 excel/word/ppt 没有意义**——它们不走连接器。

技能实际有三类入口：

| 入口 | 技能 | 现状 |
|---|---|---|
| `connect_to_server("xxx")` | PKPM-Link、SSG-Link、plugin-creator | `pkpmmcp` 已登记；`ssgmcp` 未登记 |
| `from PKPMAgent.software_link_kit...` | PlantS、Excel、Word、PPT、MIDAS、Rhino、SketchUp、Tekla | **仓库没有该包** |
| 原生 `win32com`/`pyautocad` | AutoCAD、SAP2000、ETABS、STAADPro、Abaqus | 可用（AutoCAD 已验） |

### 第 5 优先：工程化收尾

| 缺口 | 说明 |
|---|---|
| `copy-engineering-skills` 未进 services build | `packages/services/package.json` 的 scripts 只有 `lint` / `lint:fix`，靠打包脚本调用 |
| 完整打包未跑 | 只做了「模拟同样目录结构 + 实际启动 MCP」的等价验证 |
| `output/`（9.5M） | 未跟踪，内容 `enbx-export`，不是本任务产物 |

---

## 五、关键设计决策（改代码前必读）

### 5.1 形态：隐形能力层，不是独立界面

```
用户说话
  → Agent（独立 CLI 进程）按技能 description 自动加载 SKILL.md
  → 调 5 个 MCP 工具（stdio）
  → EngineeringExecutor（window-scoped Local Host）
  → Python Worker Pool（会话常驻）
  → 注入桩 + 文件桥转发
  → PKPM/AutoCAD 进程用自己的内核建模
  → Agent 读回结构化数字验证（不看屏幕）
```

**Agent 不知道「工程模块」存在**，只看到 5 个普通 MCP 工具和 22 个技能。这是刻意设计的。

### 5.2 状态所有权

- `registry` 持有**运行时**连接状态，`mcp-sync` 只管配置持久化，**不持有连接**
- 同一 server name 只允许一个活动实例，重复 connect 幂等
- 连接实例**不落盘**，进程重启后重建
- 失败一律返回 `string` 文案，**不抛异常、不自动重试**

### 5.3 UI 与 Agent 的连接状态天然隔离（重要）

MCP server 是 **CLI 子进程**，desktop host 是**另一个进程**，两边的 `registry` Map **不共享**。

所以 UI 面板**不能显示「Agent 现在连着谁」**——它只能显示「本机环境能不能用」。这是刻意设计的边界，**不要试图打通**，否则会误导用户。要真正打通需要 MCP server 状态回传通道，那是另一个量级的工程。

### 5.4 注入链路（最精妙的一环）

```
MCP tools/list → convertTools → 生成 Python 桩 → 拼在用户脚本**之前**
  → Python 执行 → 写 .req.json → 宿主 25ms 轮询 → session.callTool
  → 写 .res.json → Python 读取返回
```

三个细节：

1. **桩放在用户脚本之前**——同名函数后定义覆盖先定义，所以用户代码优先
2. **桥接目录按 key 做 sha1**，避免并发串台；每次 run 后 `finally` 里删掉
3. **辅助函数单独注入**：`connect_to_server` / `function_search` / `is_server_connected` 不在 `tools/list` 里，是普通 Python 函数，走 registry 不依赖 MCP 会话

### 5.5 三道闸（确定性体系）

| 闸 | 时机 | 铁律 | 位置 |
|---|---|---|---|
| 输入 `preflight` | 提交计算前 | 缺项就停，**不许 LLM 自己补材料/单位/边界/阈值** | `determinism/preflight.ts:80-91` |
| 过程 `execution_contract` | 执行中 | 失败不自动重试、完成即停、不自动优化 | `contract.ts` |
| 输出 `evidence` | 结果判定 | `review` 操作符**永远返回 false**；缺测值判失败；有 failed 或 needsReview → 整体不通过 | `determinism/evidence.ts:38/50/165` |

这三条是纯 Python 确定性代码，**不经过 LLM**。是目前仓库质量最高的一块，不要为了"灵活"放宽。

---

## 六、验证证据清单（区分「真跑过」与「没跑」）

### ✅ 真跑过并通过

| 项目 | 证据 |
|---|---|
| MCP server 启动（编译产物） | `initialize` 正常，`tools/list` 返回 **5 个工具** |
| 工具清单 | `connect_engineering_software`、`run_engineering_script`、`run_verified_engineering_script`、`search_engineering_functions`、`evaluate_engineering_evidence` |
| Python 执行池 | `print(1+1)` → `ok:true, stdout:"2\n"`；会话复用、异常上报正常 |
| 技能枚举 | `listBuiltinEngineeringSkills()` → 22 条 |
| AutoCAD 连接+绘图+读回 | 三层验证通过（见 3.6） |
| COM 自动定位 | 不传 exePath 成功解析到 `acad.exe` |
| 门禁六分支 | 全部符合预期 |
| 诊断 | `diagnose()` 正确识别 AutoCAD，其余如实报未安装 |
| CLI 运行时单测 | `vitest run tests/engineering-runtime.test.ts` → **10 passed** |
| bootstrap 类型检查 | `turbo run typecheck --filter=@zcode/bootstrap` → **9 tasks successful** |
| 本轮 UI 改动 lint | `oxlint` 4 个文件 → **0 error**，3 warning 全部来自 `SettingsPage.tsx` 既有代码 |
| 架构策略改动 | `git diff -w` 确认是**纯格式化 + 47 行新增**（Office 组的 document-editing 模块登记），无实质冲突 |
| UI 诊断 `diagnose()` 实跑 | `npx tsx .tmp-probe/verify-diagnose.mts`：6 个 server 全部枚举、AutoCAD 命中、Python 3.13.16 可用、`connected` 为空（符合设计边界） |
| 本任务文件类型检查 | `npx tsc -p packages/shared/tsconfig.json --noEmit` 通过；`tsconfig.main.json` 中本任务文件零报错；renderer 净增 1 行且与既有 `window.zcode` 类型缺失同族 |
| 全仓 `pnpm typecheck` | exit 2、42 error，逐文件核对**无一落在本任务文件**（全部是 rakazo/document-editor/quickInput/safeStorage 等既有问题） |
| 全仓 `pnpm lint` | 682 warnings / 43 errors，全部在 `server/` 等无关目录，本任务 9 个文件零 error |
| 端口反查单测 | `vitest run --project engineering packages/services/test/engineeringPortLookup.test.ts` → **24/24 通过** |
| 端口反查类型检查 | `npx tsc -p packages/services/tsconfig.json --noEmit` → **0 error** |
| 端口反查 lint | `npx oxlint`（port-lookup / bimbase / common / engineering index / 测试）→ **0 warning / 0 error** |

### ❌ 没跑完 / 不能声称通过

| 项目 | 状态 |
|---|---|
| **UI 类型检查** | `packages/ui` 单包全量 `tsc -p tsconfig.json --noEmit` 曾 OOM/超时未跑完；2026-11-22 已用根 `pnpm typecheck` 覆盖 `packages/ui`，42 个 error 均不在本任务文件，但**不能据此声称 UI 全量类型正确** |
| `pnpm typecheck` 全量 | 已跑：exit 2、42 error，全部为既有失败（`rakazoShims.ts`、`document-editor/*`、`quickInputWindow.ts`、`safeStorageMainBridge.ts` 等，与工程模块无关） |
| `pnpm lint` 全量 | 已跑：682 warnings / 43 errors，41 个 error 在 `server/` 目录，本任务文件零 error |
| 完整打包 `prepare:agent-bundle` | 未跑。改用等价验证（模拟目录结构 + 实际启动 MCP） |
| PKPM/BIMBase 实机连接 | 实现已完成（`abc1b92a`），但本机未装软件，**实机连通未验证** |

**接手者请自行重跑**，不要引用本文结论：

```bash
cd packages/ui && npx tsc -p tsconfig.json --noEmit    # 注意可能超时，建议后台跑
npx oxlint packages/ui/src/settings/EngineeringSection.tsx packages/ui/src/SettingsPage.tsx
```

---

## 七、风险与阻塞

| # | 风险 | 影响 | 处置建议 |
|---|---|---|---|
| 1 | **工作区混着 Office 组的改动** | `git add .` 会把别人的 50+ 行卷进你的提交 | 逐个文件确认，`git diff -- <file>` 看清归属再 add |
| 2 | **5 个 i18n 文件混杂** | 我的 8 行 + 他们的 1 行 `documentEditor.title` | 需要精确分离，参考 `.tmp-probe/stage-i18n-engineering.py`（已写但未跑） |
| 3 | **PKPM 端口反查未实现** | PKPM/BIMBase 永远连不上 | 必须在装了 PKPM 的机器上跑探测脚本 |
| 4 | **216/238 references 是密文** | 技能正文引用读不到内容 | 不要破解；需产品决策如何提供可读资产 |
| 5 | **`PKPMAgent.software_link_kit` 缺失** | Office/PlantS/MIDAS 等技能无法执行 | 需确认是定制包还是可从别处获取 |
| 6 | **UI 类型检查未完成** | 不能声称 UI 代码类型正确 | 接手后必须跑完 |
| 7 | `dist` 可能落后于 `src` | 本地运行读到旧代码 | 改完源码后手动跑 `copy-engineering-skills.mjs` + `tsc`，或接进 build |

---

## 八、建议的接手顺序

```
1. 基线验证（只读，零风险）— 2026-11-22 已跑
   ├─ git log --oneline -14          HEAD 已推进到 abc1b92a
   ├─ git status --porcelain         确认剩余改动仍属 Office/seed/环境线
   ├─ pnpm typecheck                 42 error 全部既有，不在工程任务文件
   └─ MCP tools/list                 返回 5 个工具

2. 提交 UI 部分（7 个干净文件）— ✅ 已提交 a74a443d
   └─ 5 个 i18n 已按 hunk 精确分离，仅提交 settings.engineering.* 8 行

3. IPC 五件套（约 150 行）— ✅ 已提交 a74a443d
   └─ channel / platform 端口 / preload / main handler / renderer 组装 + SettingsPage 传 loadReport

4. 端口反查 — ✅ 已实现并提交 abc1b92a（本机无 PKPM，实机连通待复验）
   └─ 待办：在装了 PKPM/BIMBase 的机器上跑 probe-engineering-port.mts 对照端口

5. 产品决策：98MB API 库怎么入库、加密 references 怎么提供
```

---

## 九、临时文件与清理

| 路径 | 内容 | 处置 |
|---|---|---|
| `.tmp-probe/`（已 gitignore） | **26 个**调试/验证脚本 | **建议保留**——是各次 bugfix 的回归证据。其中 `verify-autocad-autodiscover.mts`、`verify-gate.mts`、`verify-diagnose.mts`、`verify-port-resolver3.mts`、`verify-verified-tool.mts` 可复跑 |
| `.tmp-probe/stage-i18n-engineering.py` | i18n 精确分离脚本 | **未执行**，接手者可用 |
| `.zcode/config.json` | 已清理，只剩 `plugins` 段 | 不要重新手工写入 engineering MCP 配置（已由 CLI 内置） |
| `.zcode/skills/` | 已清空 | 不要放技能副本，会盖过内置根 |
| `output/`（9.5M） | `enbx-export`，非本任务产物 | 不动 |

---

## 十、交接一句话

**代码是完整的、接线的、验证过的；第 1、2 优先均已落地（`a74a443d`、`abc1b92a`），剩余是 references/API 库入库方式的产品决策与实机复验。工作区混着两条别人的开发线（Office 编辑器、插件 seed 降级），提交前必须分清归属。**

---

## 十一、后续进展（2026-11-23）

### 11.1 第 2 优先：端口反查实现要点（`abc1b92a`）

| 项目 | 内容 |
|---|---|
| 新增模块 | `packages/services/src/engineering/mcp-link/port-lookup.ts`（360 行） |
| 反查方式 | 按 PID 取该进程 TCP 监听端口，不解析厂商配置文件（逆向 `common_tools.pid_to_mcp_port(pid)` 得出） |
| Windows 命令 | `Get-NetTCPConnection -State Listen -OwningProcess <pid>`，结构化结果为空时回退 `netstat -ano -p TCP` |
| Linux / 其它 POSIX | `ss -lptnH`，回退 `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>`；其它 POSIX 直接 `lsof` |
| 候选排序 | 回环地址优先 → 非特权端口（≥1024）优先 → 端口号升序；同端口去重优先保留带地址记录 |
| 连通确认 | 排序后逐个 `isPortOpen` 探测，第一个连通的即返回；全不通返回 `undefined` |
| 等待策略 | `waitForMcpPortByPid` 默认 100s、1s 轮询，超时返回 `undefined` 不抛异常（对齐 `wait_local_mcp_ready(port, timeout=100)`） |
| 行为修正 | `BimBaseLink` 把「找到进程」与「拿到端口」分开：已运行但端口未开时等该 PID，不再退化成再启动一个实例 |
| 覆盖顺序 | 注入的 `setEngineeringPortResolver` 仍优先于自动反查 |
| 测试 | `packages/services/test/engineeringPortLookup.test.ts`（24 例），已注册进 `scripts/engineering-test-files.json` |
| 文档 | `specs/engineering-mcp-link.md` 新增「端口反查」章节与 4 条验收；`packages/services/src/engineering/CONTRACT.md` 新增 4 条不变量 |

### 11.2 仍未完成

| 项 | 原因 | 下一步 |
|---|---|---|
| references 正文 216/238 加密 | 厂商加密，不破解 | 产品决策：随安装包提供 / 构建时解密 / 服务端下发 |
| API 知识库 10 个 .db（98MB） | 体积不适合 git | 产品决策入库方式（git LFS / 构建下载 / 服务端下发） |
| 连接器覆盖 | 22 个技能只有 3 个走 `connect_to_server`；`PKPMAgent.software_link_kit` 不在仓库 | 需实机与厂商包确认，勿盲目给 registry 加 Office 项 |
| 完整打包 `prepare:agent-bundle` | 未跑 | 有发布需求时跑真打包并验证产物 |

### 11.3 本轮新增/更新的验证脚本（`.tmp-probe/`，已 gitignore）

`verify-diagnose.mts`（诊断实跑）、`stage-engineering.py`（混合文件按行写索引）、`stage-testlist.py`（工程测试清单按 blob 写入）、`register-engineering-test.py`（清单插入）、`renumber-acceptance.py`（spec 验收编号重排）。均可复用。

