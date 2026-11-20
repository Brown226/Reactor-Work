# 主界面 Section 架构：从"单对话界面"升级为"可插拔能力域"

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-05 |
| 起因 | 参照 NewMax 的四个界面（定时任务 / 扩展 / 每日回顾 / 本地应用），结论是"每打开一个都是全新界面，右侧整块换" |
| 本文回答 | 这个模式的**准确名字、成立前提、Reactor 的目标架构、迁移顺序、代价与陷阱** |
| 关联 | [未完成-Bot范式-04-Bot频道落地-v1.md](未完成-Bot范式-04-Bot频道落地-v1.md)（Bot 是其中一个 section）、[未完成-Bot范式-03-实施蓝图-v1.md](未完成-Bot范式-03-实施蓝图-v1.md)（团队实例层） |
| 性质 | 设计文档（未实现） |

---

## 一、结论

NewMax 那套不是"侧边栏换了个样子"，是**三段式 Section 架构**：

```
rail（能力域，恒定图标列） → panel（该域的列表/导航/动作） → canvas（该域的主画布，整块切换）
```

换 rail 项时，**panel 与 canvas 一起换**。它是"App Shell + 可插拔 Section"，不是弹窗、不是抽屉、不是路由到另一个页面。

对你的判断，我的结论是：**方向对，但要抄的是"原子统一 + 投影"，不是那排图标。**

---

## 二、截图骨架拆解（四张图共用同一副骨架）

| 部件 | 定时任务 | 扩展 | 每日回顾 | 本地应用 |
| --- | --- | --- | --- | --- |
| rail 选中项 | 时钟 | 礼盒 | 折线图 | 代码 |
| panel 头部 | `定时任务` + `...` | `扩展` + `...` | `每日回顾` + `...` | `本地应用` + `...` |
| panel 动作 | `+ 新建任务` | 子项：Skills / 插件 / MCP / 连接器 | 空态里的「前往设置开启」 | `+ 新应用`、`+ 激活应用` |
| panel 内二级导航 | 分段：`执行 / 任务` | 分段：`Skill 市场 45 / 我的 Skill 47` + 分类 chips | — | — |
| canvas | 居中空态「还没有执行记录」 | 两列卡片网格（已安装 / 官方 / 管理 / 使用） | 居中空态 | 大标题「想做一个什么应用?」+ 输入框 + 示例卡 |

三个可复用的细节：

1. **canvas 可以完全不是对话**（扩展是卡片网格、本地应用是输入框 + 示例）。
2. **panel 头部固定有 `...` 溢出菜单**——每个域自己的动作都收在那里，壳不感知。
3. **空态即引导**：`前往设置开启` 是可点的深链；`想做一个什么应用?` 下面直接给示例卡。这比"列表为空"强得多。

同类参照（说明这不是新发明，是被反复验证的骨架）：VS Code（活动栏 → 侧栏 → 编辑器）、Linear（Inbox / Views）、Slack（rail → channel list → 消息）。

---

## 三、为什么它"上限更高"（四个真实原因，不是视觉）

1. **新能力不必挤进对话**。定时任务、回顾、应用生成都不是聊天内容；塞进对话会污染主线，而且没人找得到。
2. **rail 即目录**：能力可发现。Reactor 现在的"自动化 / 插件市场"是二级入口（菜单项），用户不知道它存在。
3. **每个域可独立演进**：自己的空态、埋点、权限、快捷键、搜索范围，互不牵扯；一个域改版不影响别的域。
4. **异步任务有落点**："你不在场时发生的事"（定时执行、回顾汇总）天然需要一个非对话的容器。

---

## 四、隐藏前提：所有 section 必须是同一个原子的投影

NewMax 的 rail 之所以没变成杂物抽屉，是因为它的每个域都是**"对话"的不同投影**：

| section | 怎么投影出来的 |
| --- | --- |
| 对话 | 原子本身 |
| 定时任务 | 按计划**发起**一次对话 |
| 每日回顾 | 对一段对话的**聚合** |
| 扩展 | 给对话**加能力**（Skills/插件/MCP/连接器） |
| 本地应用 | 用对话**生成产物**（写代码并开独立窗口） |

**原子 = 对话，其余都是投影。** 这是它连贯的根本原因，也是"可扩展性"真正的来源。

映射到 Reactor：原子是 **task/session + artifact**。

| 候选 section | 由什么投影出来 | 现状 |
| --- | --- | --- |
| 工作台（chat） | 原子本身 | ✅ 已有主界面 |
| 自动化 / 定时 | `automations` + scheduler → 生成 session | ✅ 已有，但埋在菜单里 |
| 扩展（专家·技能 / 插件 / MCP） | 给 session 加能力 | ✅ 已有 market / plugin-store |
| 我的空间 | 本机文件 | ✅ 已有 my-space |
| 团队（Bot） | 已安装专家 + 实例（见实施蓝图） | ⬜ 待建 |
| 计划 / 回顾 | `automation_runs` + session 聚合 | ⬜ 待建 |
| 本地应用 | 用 session 生成可运行的小应用 | ⬜ 远期，独立能力不是壳的一部分 |

**规则：投影不到同一原子的，不要加 rail 项。**

---

## 五、现状：Reactor 已经有 5 个 section，只是被降级成了二级入口

代码里已有（`packages/ui/src/app-shell/types.ts`）：

```ts
export type WorkspaceMainView = "chat" | "automations" | "plugin-store" | "market" | "my-space";
```

也就是说**能力域已经存在**，缺的是：

- 没有 rail（只能从菜单/命令面板进入）；
- 没有各自的 panel（进入后是整页，缺少域内导航）；
- 没有统一的空态、快捷键、角标、深链；
- 没有"壳"的抽象——每个 view 都要在 `WorkspaceShellLayoutProps` 上挂一堆专属 props（`openAutomationId`、`marketIntent`、`pluginStoreOpenVersion`、`openAutomationTab`…），**每加一个域就要改一次壳**，这是当前架构最贵的地方。

> 所以本次改造的目标不是"加功能"，而是**把 5 个已有域提升为一级 section，并让"加域"不再改壳**。

---

## 六、目标架构：Section Registry + 三栏壳

```ts
// 示意（非最终代码）
export interface SectionCtx {
  workspacePath: string;
  workspaceIdentity?: string;
  navigate: (to: string) => void;
}

export interface SectionDef {
  id: "chat" | "automations" | "market" | "plugins" | "my-space" | "team" | "plans";
  icon: LucideIcon;
  label: string;
  /** rail 角标：待批 / 未读 / 运行中 */
  badge?: (ctx: SectionCtx) => number | null;
  /** 左侧面板：域内列表 / 子导航 / 动作 */
  Panel: React.ComponentType<{ ctx: SectionCtx }>;
  /** 主画布 */
  Canvas: React.ComponentType<{ ctx: SectionCtx }>;
  /** 深链前缀，例如 zcode://section/automations/:id */
  route: string;
  requires?: "desktop" | "web" | "login";
  shortcuts?: { open?: string };
  /** 面板头部 `...` 菜单（域自己的动作，壳不感知） */
  overflowMenu?: React.ComponentType<{ ctx: SectionCtx }>;
}
```

壳只做三件事：**渲染 rail、挂当前 section 的 `Panel + Canvas`、记住每个 section 的选中项与滚动位置**。其余全部下沉到 section 内部。

配套要有的四样东西（现在都没有）：

1. **深链**：`zcode://section/<id>/<entity>`，让"从定时任务跳到它生成的会话"成立。
2. **每域导航状态**：切换 section 不丢选中项。
3. **命令面板接入**：`Cmd+K` 能跳到任意域的任意条目（这是把 rail 的好处放大的关键）。
4. **角标总线**：team 的"待批"、automations 的"运行中"、market 的"可更新"，统一由壳渲染。

---

## 七、布局与宽度策略（必须先定，否则壳要返工）

Reactor 比 NewMax 多一个区域：chat canvas 里还有 diff / 终端 / 浏览器。所以是**四个纵向区域**：

```
┌────┬──────────┬───────────────────────────────┬───────────────┐
│rail│  panel   │           canvas              │  evidence     │
│56px│ 240–320  │           flex ≥ 560          │  320–480 可收 │
└────┴──────────┴───────────────────────────────┴───────────────┘
```

建议值（待实测）：

| 区域 | 展开 | 折叠 | 说明 |
| --- | --- | --- | --- |
| rail | 56px | 56px（不折叠） | 恒定；超过 7 个图标要合并或分组 |
| panel | 240–320px | 收成 56px 窄条（只留图标） | 拖拽宽度并持久化 |
| canvas | 自适应，最小 560px | — | 低于最小值时强制收 panel |
| evidence | 320–480px | 完全收起 | **默认收起**，有 diff/浏览器/终端时才展开 |

这条策略要写进 `WorkspaceShellLayoutProps` 的替代物里——**布局参数从"每个域各自的 props"收进一个 `layout` 对象**。

---

## 八、迁移计划（三阶段，每阶段可发布）

| 阶段 | 内容 | 工期 | 验收 |
| --- | --- | --- | --- |
| **S1 抽壳** | 新增 `SectionRegistry` + rail + 三栏壳；默认 `chat`；其余 5 个域以"假 section"挂上（面板为空、canvas 仍是原组件） | 3–5 天 | 现有功能零回归；rail 可切换；`typecheck` 通过 |
| **S2 归位** | 逐个域补 Panel + 空态 + 角标 + 深链：automations → market → plugin-store → my-space（**每域一个 PR**） | 每域 1–2 天 | 每域都有 panel、空态引导、快捷键；旧枚举保留映射 |
| **S3 加新域** | 团队（Bot，复用 OMB Tier-1 组件）、计划/回顾（吃 `automation_runs` + session 聚合） | 团队见前文 4 周；计划/回顾 1 周 | 团队渠道可派活/看现场/审批；回顾能按天汇总 |

**不做什么**：不重写 chat canvas；不动会话数据模型；不引入新路由框架（复用现有 view 切换）。

---

## 九、代价与陷阱

1. **每个 section 的隐性成本**：空态 / 加载 / 错误 / 搜索 / 快捷键 / 权限 / 埋点 / 测试，一个域约 1–2 天，不是 0。
2. **rail 别超过 7 个图标**。NewMax 现在 8 个，已经要靠 tooltip 认图标（截图里「本地应用」是 hover 才出名字）。能合并的合并：市场 + 插件 → 一个「扩展」。
3. **panel 套 panel 会挤死 canvas**。域内二级导航用分段控件（NewMax 的 `执行/任务`、`Skill 市场/我的 Skill`），不要再开第三列。
4. **禁止"域内自建弹层宇宙"**。每个域自己有 3 个弹窗，一年后就是 7 个小 App。公共交互（搜索、确认、审批、选择器）必须走壳的组件。
5. **空态即引导**：新域上线时先写空态（深链 + 示例卡），否则用户进去就是空白。
6. **旧 props 债务**：`WorkspaceShellLayoutProps` 上挂的 `openAutomationId` / `marketIntent` / `pluginStoreOpenVersion` 这类"域专属 props"要逐步收进 `SectionState`，否则壳永远在长。

---

## 十、怎么判断改造成立

- 新增一个域**不需要改壳文件**（只加一个 `SectionDef`）。
- 用户能在 2 次点击内到达任意域（rail + panel）。
- `Cmd+K` 能搜到跨域的实体（任务 / 自动化 / 专家 / 同事）。
- 切换 section 不丢上下文（选中项、滚动位置、输入草稿）。
- 空态点击率 > 0（说明引导有效，不是死胡同）。

---

## 十一、未验证

- 四栏布局在 1280×800（最小支持窗口）下的实际可用性未实测；`min canvas 560` 是估算值。
- NewMax 的 canvas 空态是否可点（截图只见文案与图标），"前往设置开启"确认是链接，居中空态未确认。
- 「本地应用」那类"生成代码并开独立窗口"的能力，Reactor 有 `zcode-cua` 与代码执行基础，但属于独立能力线，未评估工作量。
- S1 抽壳对 `WorkspaceShellLayoutProps` 的改动面（该接口目前有数十个字段）未逐项清点。
