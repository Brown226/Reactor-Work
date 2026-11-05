# OpenMausBot × Reactor-Work：在 React 里融合 OpenMausBot 的可行性评估

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-05 |
| 评估对象 | [Brown226/OpenMausBot](https://github.com/Brown226/OpenMausBot) @ `e7317a7`（上游 `milind-soni/OpenMausBot`）<br>[Brown226/Reactor-Work](https://github.com/Brown226/Reactor-Work) @ `a96e1d3`（内部包名 `zcode`） |
| 方法 | 浅克隆两个仓库后**静态阅读**（目录结构、package.json、服务端路由、传输层、扩展点、许可证）。**未执行 `pnpm install` / 未构建 / 未运行**，文中性能与兼容性结论均为源码推断，标注了推断依据。 |
| 范围声明 | 本文只针对 **Reactor-Work（React 19）**。本文结论不可平移到非 React 技术栈的产品线（例如 Vue 产品）。 |

> 名词对齐：题面里的「Open mospool」按 **OpenMausBot**（原 OpenGrokBot / MausBot）理解；「Reactor」按 **Reactor-Work**（AI 编程工作台，桌面 + 浏览器 + 终端 Agent）理解。

---

## 一、结论先行

**能融合的是「能力」和「面板」，不是「代码库」。**

两个仓库在技术栈上几乎同构（Electron + React 19 + TypeScript strict + Vite + Node ≥ 24 + pnpm 10，仅 Electron 版本不同），这很容易让人误判成"把组件搬过去就行"。实际情况相反：

- OpenMausBot 的前端不是组件库，而是**一个和自家服务端强耦合的同源 Web 应用**：`fetch('/api/…')` 直连自家 HTTP 服务，服务端共 **738 个唯一 `/api/*` 路径**、**164 个路由模块**，SSE 事件流固定挂在 `/api/events`；`src/` 下 **857 个组件 / 2.78 万行**，绝大多数是产品页面（侧栏、机器人面板、审批卡、云电脑），不是可复用原子。
- Reactor 的前端是**RPC 客户端**：`@zcode/client`（WebSocket / MessagePort）→ `@zcode/rpc` ChannelServer → `packages/services`，UI 在 `@zcode/ui`（**115k 行 / 1542 文件**，Tailwind 4 + Radix + Lexical + streamdown）。它压根不认识 `/api/*` 这套 HTTP 语义。

因此，按"投入产出 + 可维护性"排序，四条路线的判定如下：

| # | 路线 | 可行性 | 工作量（1 人） | 能拿到什么 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **A** | **MCP 工具桥**：Reactor 作为 MCP 客户端加载 OMB 的 stdio MCP server | ✅ 高 | **2–3 天** | Reactor 的 Agent 能列 bot、派活、读转录、切模型（纯文本） | ★ 首选，先做 |
| **B1** | **桌面侧车 + 面板**：Reactor 托管 `openmausbot serve` 子进程，用 WebContentsView 嵌 OMB 的 Web UI | ✅ 中 | **4–6 天** | 完整的 OMB 体验（审批卡、云电脑、多 bot）原样可用 | ★ 次选，桌面端 |
| **D** | **Bot API 薄面板**：Reactor 自研一个 React 面板，只调 OMB 的 `/hooks/api/bots/:id/messages` | ⚠️ 中 | 3–5 天 | 只能"派活 + 取纯文本回复"，无审批、无过程流 | 备选（Web 端回退） |
| **B2** | **Web 端 iframe 直嵌** | ❌ 现成方案不可行 | 需改上游 | — | 被 OMB 的 `frame-ancestors 'none'` 硬挡，见 §3.3 |
| **C** | **组件级源码融合**（把 OMB 的 React 组件并入 `@zcode/ui`） | ❌ 不建议 | **6–10 周起** | 一个拼起来的混合 UI | 等于 fork，且上游几乎每日迭代、合并成本持续累积 |

推荐组合：**A（能力打通）→ B1（桌面体验）→ 有 Web 端诉求时给上游提 `OMB_FRAME_ANCESTORS` 的 PR 或退化为 D**；**C 放弃**。

如果你要的只是"在 Reactor 里指挥几个 AI 机器人干活"，A 一周内就能演示；如果要的是"Reactor 长出一个 OMB 的通讯录界面"，那是 B1 + 一个产品级的信息架构改造，真实工作量按 3–4 周估，不是几天。

---

## 二、两个项目的事实画像

| 维度 | OpenMausBot | Reactor-Work（zcode） |
| --- | --- | --- |
| 定位 | 本地优先的「AI 机器人通讯录」：每个 bot = 一个真实 Agent（Claude / Codex / Grok CLI），带人格、模型、云电脑、连接应用 | AI 编程工作台：桌面 App、浏览器工作台、终端 Agent（`zcode` / `reactor`） |
| 前端 | React 19 + Vite + **自写 CSS**（`src/styles.css`），无组件库 | React 19.2 + **Tailwind 4** + Radix + Lexical + streamdown + xterm，统一在 `@zcode/ui` |
| 渲染层与服务端的通道 | **同源 HTTP**：`fetch('/api/...')` + SSE `/api/events`；未发现 `window.omb` 之类的 preload 强依赖（`grep window.omb src` 命中 0） | **RPC**：`@zcode/client` 的 `connectViaWebSocket / connectViaMessagePort` → `@zcode/rpc` 的 `ChannelServer`/`SocketProtocol` |
| 服务端 | 原生 `node:http`，`server/index.ts` 单文件 1.57 万行 + `server/routes/*` 164 个模块；**738 个唯一 `/api/*` 路径** | Hono + `@hono/node-ws`（`packages/server/src/http.ts`），同时服务 Web 与桌面 host |
| Web 形态 | **有**：服务端自己托管静态资源（`OMB_STATIC_DIR`），可 `npx openmausbot serve` 无头运行；浏览器首次需配对登录 | **有**：`packages/web` 是薄入口（`main.tsx` + Chrome 109 垫片），复用 `@zcode/ui` |
| 默认端口 / 数据 | `127.0.0.1:8799`，数据在 `~/.openmausbot`（`OMB_PORT` / `OMB_DATA_DIR` 可改） | 服务端默认 3030，Web 开发 5173；数据在用户数据目录 |
| 扩展点 | ① stdio **MCP server**（`openmausbot mcp`，可列 bot / 读转录 / 派活 / 切模型）<br>② **Bot API**（`POST /hooks/api/bots/<botId>/messages`，Bearer key，默认等 50s，限 10 次/分）<br>③ `openmausbot://` 深链<br>④ 自定义 MCP、Composio 500+ 应用 | ① **插件** `plugin.json`：`agent / command / skill / hook / mcp / lsp`（`packages/shared/src/plugin-types.ts`）<br>② MCP 配置 `mcpServers: Record<string, McpServerConfig>`（stdio/http/sse）<br>③ 已内置 **WebContentsView + CDP 宿主**（`packages/desktop/src/main/browserView/*`，当前服务于 agent 的 browser-use），承载方式可复用 |
| 规模（非测试） | 前端 2.78 万行 / 857 组件；服务端 3.97 万行 | UI 11.5 万行 / 1542 文件（单文件上限由 `architecture-policy.yaml` 限制为 400 行） |
| Electron | `^43.5.0` | `41.0.3`（**版本不一致**，见 §5） |
| Node / 包管理 | Node ≥ 24，pnpm 10.33.0 | Node ≥ 24，pnpm 10.33.2 |
| 许可 | **Apache-2.0**，但 `enterprise/` 为 source-available（生产需 license key） | Apache-2.0 |

两个关键事实，直接决定了路线选择：

1. **OMB 的前端可以在浏览器里跑**（服务端自己托管静态资源、渲染层只依赖同源 HTTP/SSE、无 preload 强绑定）。所以"嵌面板"是可行的，**前提是绕过它的防嵌入头**（§3.3）。
2. **OMB 已经对外暴露了机器可调用的接口**（stdio MCP + Bot API）。所以"能力融合"根本不需要碰它的 UI，也不需要改它的代码。

---

## 三、路线详解

### 3.1 路线 A：MCP 工具桥（推荐先做，2–3 天）

**做什么**：让 Reactor 的 Agent 把 OMB 的 bot 团队当成一组工具来用。

```
Reactor 会话（Agent 运行时）
   └── MCP 客户端（已有能力，plugin.json 的 mcp 组件 / MCP 设置）
        └── stdio: openmausbot mcp  (env: OMB_PORT=8799, OPENMAUSBOT_TOKEN=omb_sess_...)
             └── OMB harness server (127.0.0.1:8799) ──► Claude/Codex/Grok CLI 跑真实 bot
```

**接入方式（二选一，推荐做成插件，用户一键装）**：

**方式 1 — 设置里加一条 stdio MCP**（零开发，先验证）：

```json
{
  "mcpServers": {
    "openmausbot": {
      "type": "stdio",
      "command": "openmausbot",
      "args": ["mcp"],
      "env": { "OMB_PORT": "8799", "OPENMAUSBOT_TOKEN": "omb_sess_xxx" }
    }
  }
}
```

**方式 2 — 做成 Reactor 插件**（可分发、可版本化）。参照 `apps/zcode-cli/packages/ocr-tools-plugin/.zcode-plugin/plugin.json` 的写法：

```json
{
  "name": "openmausbot-bridge",
  "version": "0.1.0",
  "description": "把 OpenMausBot 的机器人团队接进 Reactor（列 bot / 派活 / 读转录）",
  "mcpServers": {
    "openmausbot": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/mcp/omb-bridge.js"],
      "env": { "OMB_PORT": "8799" },
      "timeoutMs": 600000
    }
  }
}
```

（`dist/mcp/omb-bridge.js` 是一层薄包装：读 `OMB_PORT`/token、做健康检查、把 OMB 的原始工具名收敛成稳定命名，避免上游改工具名就断。）

**用户能看到什么**：在 Reactor 会话里说"让 OpenMausBot 的『参数审查员』把这份文件过一遍"，Agent 就会调 `list_bots` → `send_message` → 轮询 `read_transcript`，把 OMB 那边跑出来的结论拿回来。

**拿不到什么**：审批卡（OMB 的审批只能人在 OMB 界面点，Bot API 明确说"No one outside can give it"）、云电脑画面、bot 的人格化聊天体验。

**必做的四件事**：
1. **鉴权打通**：打包版 OMB 的写类工具需要配对会话（`POST /api/auth/pair` 拿 `omb_sess_` token，配对码一次性、在 OMB 设置里取）；只读工具在 loopback 可免会话——这条"免会话"正是安全面（§5）。
2. **工具白名单**：Reactor 侧只暴露 `list / read / send / wait / interrupt`，不给"改 bot 配置""切模型"这类写操作，除非显式开启。
3. **一个 skill 或命令**（`SKILL.md` / `command`）把"派活给外部 bot 团队"变成一句话，否则模型不会主动用。
4. **冒烟脚本**：无 OMB 窗口的情况下完成一次"列 bot → 派活 → 取回 reply"。

**验收标准**：Reactor 新会话输入"列出 OpenMausBot 的机器人"，得到真实 bot 列表；派一条任务后 60s 内拿到 OMB 侧的真实回复（不是模拟）。

---

### 3.2 路线 B1：桌面侧车 + 面板嵌入（4–6 天）

**架构**：

```
┌─────────────────────────────── Reactor 桌面（Electron 41） ───────────────────────────────┐
│  @zcode/ui  shell                                                        主窗口            │
│  ├─ 会话/工作区（原有 RPC 链路）                                                          │
│  └─ 新增「机器人团队」面板  ← WebContentsView 加载 http://127.0.0.1:<随机端口>            │
│           │                                                                              │
│           └─ 进程管理（主进程）：spawn / 健康检查 / 退出清理 / 崩溃重启 / 端口占用回退      │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                        │ 子进程（Node 24，不需要它自己的 Electron）
                              openmausbot serve --port <p> --data-dir <Reactor 数据目录>/omb
                                        │
                                        └─► ~/.openmausbot 同构的数据 + Claude/Codex CLI 会话
```

**为什么必须用 WebContentsView 而不是 iframe**：OMB 的 HTML 响应头是硬编码的
`content-security-policy: frame-ancestors 'none'` + `x-frame-options: DENY`
（`server/static-files.ts:20`，且**没有任何 env 可覆盖**）。任何 `<iframe>` 都会是白屏。
`WebContentsView` 是顶层页面，不受 framing 约束——Reactor 桌面端本来就有这套承载方式（`packages/desktop/src/main/browserView/`，目前用于 agent 的 browser-use guest；新增一个面板属于复用模式，不是复用现成组件，工作量已计入下表）。

**工作项清单**（这是真实工作量所在，不是"嵌一个网页"）：

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 子进程生命周期 | 启动 → `/api/health` 轮询 → 就绪；退出时 SIGTERM + 兜底 kill；崩溃指数退避重启；单实例锁 |
| 2 | 端口策略 | OMB 默认 8799，用户机器上可能已被独立安装的 OMB 占用 → 必须 `--port 0`/探测空闲端口并把实际端口回传 UI |
| 3 | 数据目录 | 放在 Reactor 的用户数据目录下（不要污染 `~/.openmausbot`），并在卸载/重置时提供清理入口（含 bot 的凭据与转录，属敏感数据） |
| 4 | 首次登录引导 | OMB 的**浏览器**即使在本机也要配对登录一次（`docs/self-hosting.md`）。要设计"打开 OMB 设置取配对码 → 填入"的引导，否则用户看到登录页就卡住 |
| 5 | 主题 / 通知 / 深链 | 深浅色不联动（两套主题变量）；OMB 的 `openmausbot://` 深链会打开独立 App，需在面板内拦截改写；桌面通知要合并 |
| 6 | 权限与安全 | 面板内的摄像头/麦克风/剪贴板/下载权限必须在 Reactor 主进程显式收口（默认拒绝） |
| 7 | 资源占用 | 双 Chromium 常驻（Reactor 渲染进程 + OMB 渲染进程 + 一个 Node 侧车），建议面板懒加载 + 失焦休眠 |

**验收标准**：终态用户机器只装 Reactor；首次打开面板 → 引导配对 → 能看到 OMB 的 bot 列表并正常对话；关掉 Reactor 后无孤儿进程（`tasklist` 无残留 `node`）；杀掉子进程后 10s 内自动恢复。

---

### 3.3 路线 B2：Web 端直接 iframe（现成方案不可行）

三个叠加障碍，任意一个都足以否决：

1. **响应头硬挡**：`frame-ancestors 'none'` + `X-Frame-Options: DENY`（同上，无开关）。
2. **路径前缀代理会碎**：OMB 的前端按根相对路径取资源（`/assets/*`、`/api/*`）。把 `https://reactor/omb/*` 反代到 `127.0.0.1:8799/*`，HTML 里的 `/assets/index-xxx.js` 仍会打到 Reactor 的根，除非做 HTML 重写（脆弱，且 OMB 每次发版都可能换构建产物路径）。
3. **Cookie 归属**：Web 端即便代理成同源，`localhost` 与 `127.0.0.1` 属不同 site，OMB 的会话 cookie 照样挂不住。

**唯一干净解法**：给上游提一个小 PR，把 `PAGE_HEADERS` 里的 frame-ancestors 改成可配置（例如 `OMB_FRAME_ANCESTORS=https://reactor.example`，约 5–10 行 + 一条测试）。OMB 自己已经有"检查别人能不能被我嵌"的实现（`server/web-panel-framing.ts`），语义上并不排斥这个开关，PR 通过概率不低；但在它合并之前，Web 端不要承诺 OMB 面板。

---

### 3.4 路线 D：Bot API 薄面板（Web 端回退方案）

在 Reactor 里写一个纯 React 面板（一个"任务卡"），只调 OMB 的 Bot API：

```
POST /hooks/api/bots/<botId>/messages   Authorization: Bearer <bot key>
  { "message": "...", "thread": "<可选>", "wait": 50 }
→ 200 {"reply":"…","thread":"…"} | 202 {"thread":"…","status":"working|needs_approval"}
GET  /hooks/api/bots/<botId>/messages?thread=<id>
```

**优点**：完全在 Reactor 侧实现，无 iframe、无 OMB UI、Web 与桌面都能用；天然是 React 组件，能进 `@zcode/ui` 的设计语言。
**硬限制**（摘自 `docs/bot-api.md`，不是我的推断）：只能拿**纯文本**回复；调用的会话被强制"confined + Ask"，**没有** shell / 电脑 / 浏览器 / 连接应用 / MCP；**无法审批**（审批只能人在 OMB 里点）；每个 key **10 次/分钟**；回答超过 `wait` 就变 `202` 要轮询。

**结论**：适合"把 OMB 当后台执行器派活"，不适合"把 OMB 的陪伴式对话搬进 Reactor"。如果产品叙事是前者，D 比 B1 更划算；如果是后者，只有 B1。

---

### 3.5 路线 C：组件级源码融合（不建议，理由要有数字）

把 OMB 的 React 组件搬进 `@zcode/ui`，会遇到**三重不兼容**：

| 维度 | 冲突点 |
| --- | --- |
| 设计系统 | OMB 用自写 CSS 类名（`src/styles.css`），Reactor 用 Tailwind 4 + Radix，两者没有共享 token；搬过来等于把两套视觉规则塞进同一个 DOM |
| 状态与数据 | OMB 组件直接 `fetch('/api/...')`（例：`src/components/ActivityPanel.tsx`、`InspectorPanel.tsx`、`SkillsSection.tsx`）；Reactor 组件拿的是 RPC service hook。要么在 Reactor 里伪造一套 OMB 的 HTTP 契约，要么逐个组件改数据源 |
| 契约耦合 | 组件入参是 OMB 的 `bot` / `thread` / `message` / `event` 形状，与 Reactor 的 session/message/artifact 模型不同（§4），跨模型转换层会长期存在 |

再叠加规模：857 个组件里，真正"可复用原子"只有消息气泡、markdown/代码块、附件预览这一小撮——而这一小撮 Reactor **已经有**（`streamdown`、`ai-elements/message`、Lexical）。

**真正可行的"源码级"做法**是 fork 而非 merge：把 OMB 整套前端作为一个独立构建产物嵌进 Reactor（即 B1 的 WebContentsView 路线），而不是拆成组件。若坚持逐个组件合并：857 个组件里就算只挑 80 个核心界面组件改造，按 0.5–1 天/个也 ≈ **6–10 周**；全量搬完是年级别的工作。且每次上游发版都要重做一次合并——这是不可持续的负债，不是架构。

---

## 四、数据模型对照（做 UI 融合时才需要）

| OpenMausBot | Reactor | 迁移难度 | 说明 |
| --- | --- | --- | --- |
| `bot`（人格 + 模型 + 权限 + 电脑） | 无直接对应；最接近 `subagent`（`packages/services/src/subagents`） | 高 | bot 是"有身份、有电脑、有记忆"的长驻实体；Reactor 的 subagent 是一次性任务角色 |
| `thread` | `session` / conversation | 中 | 都是对话容器，但 OMB 的 thread 带 bot 归属与"main thread"语义 |
| `message` | `message` | 低 | 文本/附件可映射，工具调用与审批卡需重新定义 |
| approval（Ask / auto / trusted） | `ElicitationDialog` + 审批模式 | 中 | 语义接近：都是一个需要人点的阻塞卡 |
| room / channel（多 bot 协作） | 无对应 | 高 | 这是 OMB 的产品核心，Reactor 侧没有承载结构 |
| routine（定时/主动任务） | 需核对是否有调度服务 | 高 | Reactor 侧未找到同名调度模块 |
| 云电脑 / 本地 VM（`computer`） | `zcode-cua`（computer-use 插件） | 高 | 两套 CUA 实现，短期不要合并 |

**结论**：数据层对齐只在"路线 C"才需要，而这正是最不该走的路线——这也是 A/B1 的另一个优势：**不需要映射任何数据模型**。

---

## 五、硬约束与风险清单

| # | 风险 | 具体内容 | 缓解 |
| --- | --- | --- | --- |
| 1 | **许可证** | OMB 主体 Apache-2.0，但 `enterprise/` 是 source-available，**生产使用需 license key**，不得随 Reactor 分发 | 打包时排除 `enterprise/`（上游支持"删掉即为 OSS 版"），保留 `NOTICE`/`LICENSE`，并在 Reactor 的第三方声明里登记 |
| 2 | **安全边界被放大** | OMB 默认**信任 loopback 为所有者**：任何能访问 `127.0.0.1:8799` 的本机进程即拥有全部控制权，包括 bot 的 shell 和云电脑。嵌进 Reactor 等于把这条信任边界带进产品 | 只绑 `127.0.0.1`、随机端口、强制 token、禁公网暴露；面板内权限默认拒绝；企业场景单独做威胁建模 |
| 3 | **双 Agent 运行时重复** | OMB 的引擎是 Claude/Codex/Grok CLI；Reactor 有自己的 `apps/zcode-cli` 运行时 + `zcode-cua`。融合后用户机器上同时存在两套 Agent 运行时、两套凭据、两套权限模型 | 明确分工：Reactor 管代码，OMB 管"拟人化常驻助理"；不要试图合并引擎（那是另一个量级的项目） |
| 4 | **Electron 版本不一致** | OMB `^43.5.0` vs Reactor `41.0.3`。若把两套前端打进同一个 Electron，API 行为差异会咬人 | 走**侧车**：OMB 用 Node 跑服务端（`openmausbot serve`），UI 由 WebContentsView 加载——绕开 Electron 版本耦合 |
| 5 | **Node / pnpm 版本** | 两边都要求 Node ≥ 24（一致，✅）；pnpm 10.33.0 vs 10.33.2（小差异） | 侧车不参与 Reactor 的 pnpm workspace，无冲突 |
| 6 | **网络依赖** | OMB 的 bot 依赖云端模型（Claude/Codex/Grok 登录）；Reactor 有自己的 provider 体系 | 两套凭据并存要在 UI 上讲清楚，否则用户会以为"登录一次全通" |
| 7 | **上游漂移** | OMB 版本号已到 `0.1.141`，迭代快（738 个 API 路径、大量 `*.e2e.test.ts`），MCP 工具集也可能变 | A 路线做一层工具名收敛包装；B1 只依赖"整站"，不依赖内部 API |
| 8 | **Windows 兼容** | 本机为 Windows；OMB 的 CUA/浏览器打包有多平台分支，`docs/self-hosting.md` 标明部分能力（听写、宿主桌面控制）仅桌面端 | 先按"仅用 MCP + Web UI"的最小集验证，不碰 CUA |
| 9 | **合规（受监管行业）** | bot 能执行 shell、操作云电脑、连外部应用；受监管类客户环境通常禁止模型自主执行 | 与 §5.2 同源：默认关闭 shell/computer，审批走人工 |

---

## 六、建议的落地节奏（4 周内可交付）

| 阶段 | 内容 | 产出 | 验收 |
| --- | --- | --- | --- |
| Phase 0（1 天） | 决策：要"能力"还是"门面"？是否随 Reactor 分发 OMB？ | 一页决策记录（ADR） | 三方（产品/架构/安全）签字 |
| Phase 1（3 天） | **路线 A**：stdio MCP 接入 + 工具白名单 + 一个 skill + 冒烟脚本 | 可演示：Reactor 里派活给 OMB bot 并取回真实回复 | 无 OMB 窗口；60s 内拿到回复；断连有明确报错 |
| Phase 2（5 天） | **路线 B1**：侧车进程管理 + WebContentsView 面板 + 首次配对引导 | 桌面端"机器人团队"面板 | 无孤儿进程；崩溃 10s 自愈；端口冲突自动回退 |
| Phase 3（5 天） | 打磨：主题、通知、深链、卸载清理；并行给上游提 `OMB_FRAME_ANCESTORS` PR | PR + Web 端可行性复核 | PR 有测试；Web 端结论有据 |
| Phase 4（可选） | 路线 D：Web 端 Bot API 薄面板 | React 组件 + 限流/超时处理 | 10 次/分限流有兜底；`202` 轮询正确 |

**明确不做**（写下来比写做什么更重要）：
- ❌ 不把 OMB 的 React 组件逐个搬进 `@zcode/ui`（路线 C）
- ❌ 不合并两套 Agent 运行时 / 两套 CUA
- ❌ 不新建统一的数据库或迁移 OMB 的转录到 Reactor 的存储
- ❌ 不在 Web 端承诺 iframe 面板，直到上游提供 `frame-ancestors` 开关

---

## 七、还需要你拍板的三件事

1. **目标是"能力"还是"门面"？** 能力 → 只做 A，一周出结果；门面 → 必须做 B1，并按产品级预算（3–4 周）而不是技术验证预算。
2. **要不要把 OMB 打进 Reactor 安装包？** 要 → 必须处理 `enterprise/` 许可、包体（侧车 + 运行时）、更新策略；不要 → 只做 A，用户自己装 OMB，我们只连过去（成本最低，体验最差）。
3. **企业合规是否允许 bot 持 shell / 云电脑？** 不允许的话，B1 的 OMB 面板在企业版里应当降级为只读/受限模式，这会反过来削弱 B1 的价值——那就只剩 A + D。

---

## 八、未验证事项（诚实声明）

以下结论基于**源码静态阅读**，未执行构建与运行，落地前需补实测：

- OMB 的 `openmausbot mcp` 在本机（Windows / Node 24）能否直接跑通、`OMB_PORT` 与 `OPENMAUSBOT_TOKEN` 的实际行为；
- `WebContentsView` 加载 OMB Web UI 时的首屏与 SSE 长连接是否正常、登录 cookie 在独立 profile 下是否持久；
- OMB 服务端实际内存/CPU 占用（侧车常驻的成本）；
- Reactor 侧 MCP 工具加载后的工具命名与审批交互细节（`McpServerConfig` 只确认了字段，未验证运行时链路）；
- OMB 的 `enterprise/` 在纯 OSS 构建下的裁剪是否影响本方案（按文档应不影响）。

> 如果需要，我可以在一个隔离目录里把 OMB 跑起来（`pnpm install` 约 391MB 仓库 + 依赖），用真实 HTTP 调用验证路线 A 的端到端链路，再回填本节的"未验证"项。
