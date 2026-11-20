# Bot 频道落地方案：双渠道 + 复用 OpenMausBot 源码

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-05 |
| 决定 | ① 产品保留**两个渠道**：Agent 工作台（现状）+ Bot 团队（新增），用户自选；② 形态**照截图**（左 roster / 中 线程 / 右 工作现场）；③ 实现**复用 OMB 源码**，能抄则抄 |
| 依据 | OpenMausBot @ `e7317a7`、Reactor-Work @ `a96e1d3`、截图（第三方产品，仅作形态参照） |
| 前置 | [可行性](未完成-Bot范式-01-可行性评估-v1.md)、[形态设计](未完成-Bot范式-02-产品形态-v1.md)、[实施蓝图](未完成-Bot范式-03-实施蓝图-v1.md) |
| 落点 | Bot 频道在 UI 上不是一个"新页面"，而是 [主界面 Section 架构](未完成-Bot范式-05-Section架构-v1.md) 里的一个 section（团队）；先落壳，再挂域 |

> **本文修正前两份文档里的两个错误判断**：① 我说过 OMB「自写 CSS、无组件库」——**错**，它是 Tailwind 4 + 501 个 `--color-*` token；② 我说"组件级融合 6–10 周、不建议"——在"双渠道 + 独立 Bot 面"的前提下，这个结论要改：**组件可以抄，抄的代价取决于你要不要连它的数据层一起抄。**

---

## 一、先说一个关键事实：截图 ≈ OMB 的 IA

截图里几乎没有 OMB 没有的东西：

| 截图元素 | OMB 对应实现 | 复用方式 |
| --- | --- | --- |
| 左栏 Agent roster（12 个，带认证勾） | `src/components/Sidebar*.tsx`（`SidebarTiles` / `SidebarThreadRow` / `SidebarSections`）+ bots 列表 | 抄组件 |
| `全部 / 私聊 / 群聊` 筛选 | bot thread + room/group（`Group`、`GroupTask`、`openRoomThread`） | 抄组件 + 数据 |
| 会话列表行：`名字 · 3m · 单聊·完成` | `SidebarThreadRow.tsx`（381 行）+ task 状态 | 抄组件 |
| 右栏 `Agent 浏览器`（可编辑地址栏 + 实时流） | **`BrowserPanel.tsx` + `components/browser/*`（`StreamSurface` 流、`ChromeRow`、`AgentCursor` 光标）+ `lib/browser-stream-v1/v2`** | **直接抄，这是最值钱的一块** |
| 流质量 HUD（UDP / fps / Mbps / loss） | 流客户端已有统计（v1/v2 通道） | 抄 |
| 审批卡 / 模式选择 | `ApprovalCard.tsx`（562 行）+ `ApprovalModeSelector.tsx` + `shared/approval-mode.ts` | 抄 |
| 活动现场 / 检查器 | `ActivityPanel.tsx`（181）+ `InspectorPanel.tsx`（247） | 抄 |
| 模型选择 | 每 bot 模型 + `quickModel` + `BotModelBadge` / 模型选择器组件 | 抄组件 |
| `新建 Agent` / `发起群聊` | bot creation / group creation 流程 | 抄 |
| 收件箱 | `src/state/inbox.ts` | 抄 |

**结论：你不需要"照图片从零实现"，图片就是 OMB 的 IA。** 差别只在视觉克制程度。这让"能抄则抄"从口号变成路径。

---

## 二、技术同构性：为什么这次"抄"是可行的

| 维度 | OMB | Reactor | 判断 |
| --- | --- | --- | --- |
| React | `^19.1.0` | `19.2.7`（override） | ✅ 兼容 |
| 样式 | Tailwind 4（`@import "tailwindcss"`）+ 501 个 `--color-*` | Tailwind 4.2 + 567 个 `--color-*` | ✅ 同构，**但 token 会撞名**（见 §5） |
| 工具类合并 | `tailwind-merge ^3.3.1` | `^3.5.0` | ✅ |
| 图标 | `lucide-react ^0.539.0` | `^1.17.0` | ⚠️ 大版本差，需对齐 |
| 数据层 | **单一 store（`src/state/store.tsx` 3354 行，458 个组件 `useStore`）**，只有 6 个组件直接用 `api()` | RPC 服务（`useServices`） | ⚠️ 这是"抄组件"的真正分界线 |
| i18n | 自带 `t()` + 7619 个 key（zh/en/ja/ko…） | `@zcode/ui` 自有 i18n | ⚠️ 保留 OMB 的更省 |

**一句话**：组件层几乎同构，**数据层是唯一的大耦合**（一个 3354 行的 store）。这也决定了下面三个档位的成本差距。

---

## 三、三个档位（先选档，再谈工期）

| 档 | 做法 | 工期 | 视觉一致 | 维护成本 | 适用 |
| --- | --- | --- | --- | --- | --- |
| **A. 整页嵌入** | Bot 频道 = Reactor 壳里的一个 surface，`WebContentsView` 加载 `openmausbot serve` 的 Web UI；只注入 token 换皮 | **1–2 周** | 中（换皮后 80%） | 极低（不改一行 OMB） | 先验证"用户要不要这个渠道" |
| **B. 前端并入** | 把 OMB 前端源码复制进 `packages/bot-ui`，用 Reactor 壳渲染；后端仍是 OMB sidecar | **3–5 周** | 高（可逐屏统一） | 中高（28k 行 fork，需季度 rebase） | 视觉必须统一、且要长期做 |
| **C. 形态复刻** | 只抄 Tier-1 组件（浏览器/审批/活动/会话行），数据层换成 Reactor 的 task/session（即实施蓝图） | **6–10 周** | 高 | 低（自研为主） | 终局形态，不是第一期 |

**推荐：A 先上（两周内可演示、可收集反馈），并行把 B 里最值钱的两块（右栏工作现场 + 审批卡）按 Tier-1 抄过来。** 不建议一上来做 C：你会先花 6 周重写 OMB 已经写好的数据语义。

---

## 四、复制清单（Tier 划分，含依赖闭包）

### Tier 1：直接抄（不改逻辑，最多改 import 路径）——建议优先做这三块

| 目标 | 文件（OMB 侧） | 依赖闭包 |
| --- | --- | --- |
| **右栏「工作现场」** | `src/components/BrowserPanel.tsx`、`src/components/browser/{StreamSurface,ChromeRow,MoreMenu,PasskeyNotice,AgentCursor,SelectPopup,AuthPrompt}.tsx` | `src/lib/{browser-control,browser-address,browser-stream-client,browser-stream-v1,browser-pip,team-browser,page-visible}.ts`、`shared/{browser-held,passkey-wall}.ts` |
| **审批** | `src/components/{ApprovalCard,ApprovalModeSelector}.tsx` | `shared/approval-mode.ts`、`src/lib/{approval-summary,bot-identity}.ts` |
| **活动/检查器** | `src/components/{ActivityPanel,InspectorPanel,ActivityRun,ActivitySection}.tsx` | `shared/activity.ts` |
| 会话行 | `src/components/SidebarThreadRow.tsx` | `src/lib/thread-*`、i18n |
| 消息渲染 | `src/components/ChatMarkdown.tsx` + renderers | `src/lib/markdown-*` |

### Tier 2：需要适配（接口不变，改数据源）

- `src/state/store.tsx`（3354 行）：**保持导出接口不变**，把它底下的 `api()` 指向 sidecar 的 base URL；若走档 C，则整层替换为 Reactor 服务。
- `src/components/{Composer,ChatView}.tsx`（996 / 1306 行）：依赖 store + 十余个 `src/lib/*`（send-key、follow-up、dictation、interface-mode…），这些 lib 一并复制即可，但**改动会散**，建议整块搬。
- i18n：直接保留 OMB 的 `src/lib/i18n.ts` 与 `src/locales/*`（7619 key，不要重写）。

### Tier 3：不抄（也不该抄）

- `src/App.tsx`（480 行壳编排）、`src/rail.tsx`、所有 `*-preview.tsx`（9 个预览文件，是设计预览不是产品）。
- `server/`（738 个端点；档 A/B 直接用它自带服务，档 C 才需要重写其中约 40 个 bot/thread/message/approval 相关端点）。
- 云账号 / 计费 / `enterprise/`（许可红线）/ mascot / onboarding / phone 相关。

---

## 五、样式统一：用作用域，不要全局合并 token

- 两边各有 500+ 个 `--color-*`，`accent`、`background` 等会撞名；把 OMB 的 `@theme` 直接并进 Reactor 的样式表，会**双向污染**两个渠道的配色。
- 正确做法：Bot 频道根节点加 `[data-surface="bot"]`，把 OMB 的 token 在该节点下重声明（Tailwind 的 `var(--color-*)` 按继承解析，子树内生效）。
- 工作量：2–3 天；做完立刻能让两个渠道色板一致，这是"看起来像一个产品"的最低成本手段。
- lucide 0.539 → 1.17：先跑一遍图标名比对，不一致的用薄包装映射，别逐个改组件。

---

## 六、双渠道的信息架构（这是产品成败处）

```
┌─ Reactor 窗口 ────────────────────────────────────────────────┐
│  [工作台]  [团队]                        ← 渠道切换（窗口级）  │
├───────────────────────────────────────────────────────────────┤
│ 工作台：项目/仓库 → 任务线程 → diff/终端/浏览器                │
│ 团队：  Agent roster → 私聊/群聊 → Agent 浏览器/活动/审批       │
└───────────────────────────────────────────────────────────────┘
```

**共享**：主题、模型凭据（尽量）、通知中心、快捷键、窗口与多标签。
**隔离**：会话存储（V1 两套，因为后端不同）、搜索、未读、设置项。

**边界规则（必须写死，否则用户一定会问"这俩有什么区别"）**：

- Bot 频道 V1 **不做**仓库/diff/终端提交；Agent 频道 V1 **不做**常驻、记忆、值守。
- 两个渠道的能力**不重叠**，用户不需要判断"该用哪个"——这是"不必纠结"的唯一实现方式。
- 空态语义化：工作台空态 = 选项目；团队空态 = roster（照截图）。

---

## 七、4 周里程碑

| 周 | 交付 | 验收 |
| --- | --- | --- |
| W1 | sidecar 进程管理（`openmausbot serve`，随机端口、独立数据目录、健康检查）+ 渠道切换壳 + 整页嵌入 | 打开"团队"能看到 OMB 界面并真实对话；关窗无孤儿进程 |
| W2 | token 作用域换皮 + 配对引导 + 通知/深链拦截 | 两个渠道看起来像同一个产品；首次使用有引导 |
| W3 | Tier-1 抄「右栏工作现场」+「审批卡」，接进 Reactor 壳（档 B 起步） | 右栏是 Reactor 组件渲染的真实 agent 浏览器；审批可点 |
| W4 | Tier-1 抄「会话行 / 消息渲染」；双渠道列表与未读 | 端到端：团队渠道完成一次"派活 → 看它干活 → 审批 → 取结果" |

---

## 八、合规、安全与维护

| 项 | 要求 |
| --- | --- |
| 许可 | Apache-2.0；**排除 `enterprise/`**（source-available，生产需 license）；保留 `NOTICE`，登记进 Reactor 的第三方声明 |
| 安全 | OMB 默认信任 loopback 为所有者（含 bot 的 shell/云电脑）→ 只绑 `127.0.0.1`、随机端口、强制 token；团队频道明示"本机完全信任" |
| 双凭据 | OMB 要 claude/codex 登录，Reactor 有自己的 provider → V1 在引导里讲清楚，别让用户以为登一次全通 |
| 上游漂移 | pin commit；**改动只放在新增 adapter 文件里，不 patch OMB 源文件**，方便季度 rebase；Tier-1 文件用目录隔离（`bot-ui/upstream/` vs `bot-ui/adapters/`） |
| 打包 | sidecar 体积（Node 运行时 + OMB 依赖）与 Electron 版本解耦（OMB 只跑 serve，不用它的 Electron） |

---

## 九、未验证事项

- OMB 的 Web UI 在 Reactor 的 Electron 41 / Chromium 里跑 SSE 与 WS 流是否稳定（浏览器端已验证，桌面端需实测）。
- `lucide-react` 0.539 → 1.17 的图标 API 差异面。
- OMB `api()` 的 base URL 是否集中可配（决定档 B 的适配工作量是 1 处还是 N 处）。
- 501 个 token 作用域化后的视觉回归量（需截图对比）。
- sidecar 在 Windows 下的端口/数据目录/杀进程行为（`tasklist` 验证无孤儿）。
