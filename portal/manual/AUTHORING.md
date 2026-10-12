# Reactor 说明书 · 编写规范

本文件是 `portal/manual/pages/*.md` 的唯一写作口径。改完内容后由 `node portal/manual/build.mjs` 生成 HTML。

## 1. 产品名与称谓

- 产品名统一写作 **Reactor**，需要全称时用 **Reactor（数智堆脑）**。
- 说明书正文中**不出现其他产品的名称**，也不描述与其他产品的关系或来源。
- 以下技术标识符**保持原名**（它们真实存在于仓库中，改了读者就对不上）：

| 类别 | 标识符 | 原因 |
| --- | --- | --- |
| 工作区级目录 | `<项目根>/.zcode`、`.zcodeignore`、`.zcode-plugin/` | 项目配置的产品语义，当前仍使用该字面量 |
| 环境变量 | `ZCODE_*`（如 `ZCODE_DATA_BASE_DIR`、`ZCODE_HOME`） | 仓库约定的环境变量前缀 |
| 包名 / 命令 | `@zcode/shared`、`zcode`、`zcode-cli` | 包名与 CLI 命令名 |
| 构建产物 | `dist/zcode/`、`bin/zcode.mjs`、`pnpm build:zcode` | 真实产物路径与脚本名 |
| 插件 / 技能 | `zcode-guide`、`zcode-configuration-guide` | 真实插件与技能标识 |
| 存储键 / 协议 | `zcode-interface-mode`、`zcode-background-theme`、`x-scheme-handler/zcode` | 真实持久化键与协议关联名 |

- 面向使用者的口吻用「你」。

## 2. 路径与目录口径（最容易出错，逐条对齐）

用户级目录是 **`~/.reactor`**；工作区级目录**保持 `.zcode` 不变**。依据 `docs/已完成/已完成-data-directory-contract.md`。

| 位置 | 写法 | 判定 |
| --- | --- | --- |
| 会话、凭据、配置、日志、用户级技能/命令/子智能体 | `~/.reactor/...` | 用户级 |
| 服务端下发内容 | `~/.reactor/server-skills`、`~/.reactor/server-agents` | 用户级 |
| 工作区配置 | `<repo>/.zcode/config.json` | 工作区级 → 保持 `.zcode` |
| 工作区技能 / 子智能体 / 工作流 / 计划 | `.zcode/skills/`、`.zcode/agents/`、`.zcode/workflows/`、`.zcode/plans/` | 工作区级 → 保持 `.zcode` |
| 跨工具约定目录 | `~/.agents/`、`~/.claude/` | 保持原名 |

> **提示**：判断方法是看基目录是谁——用户 HOME 下用 `.reactor`，工作区/当前目录下用 `.zcode`。

## 3. 不收录的内容（与内网隔离部署无关，一律不写）

- 桌面端下载页与安装包外链。
- 套餐权益：Coding Plan、Z.ai / BigModel 账号与端点、免费体验、周额度、额度重置卡、闲时计费口径。
- 社群与商业入口：飞书群、微信群、公众号、小红书、外部 issue 仓库、邀请奖励、支付二维码。反馈统一写成内网受理渠道。
- 机器人渠道（微信 / 飞书 Bot）——当前未提供该能力。
- 使用统计中的「编程套餐」与「额度重置卡」部分；只写本地会话用量。

## 4. 页面清单

| 章节 | 页面 slug |
| --- | --- |
| 开始使用 | `index`、`welcome`、`install`、`model-access`、`feedback` |
| 核心功能 | `agent`、`goal`、`memory`、`repo-wiki`、`task-management`、`edit-history`、`automations`、`idle-time-tasks`、`remote-development`、`subagents`、`browser-use` |
| 扩展体系 | `plugin`、`skill`、`mcp`、`command`、`hooks` |
| 本仓特有功能 | `interface-modes`、`review-panel`、`office-suite`、`model-governance`、`data-contracts` |
| 内网服务端 | `server-overview`、`software-update`、`server-delivery`、`server-usage-policy` |
| 帮助 | `keyboard-shortcuts`、`qa`、`linux-wsl`、`about` |

新增页面要在 `build.mjs` 顶部的 `NAV` 加一项，并建立同名 `pages/<slug>.md`，只加一边会导致构建报「缺少内容文件」。

## 5. 事实纪律

1. **只写本仓提供的能力**：本仓没有的功能不写入，已移除的同步删除。
2. **能核实就核实**：路径、默认值、开关状态、上限等，能在源码或 `docs/` 契约里找到依据的，照依据写。
3. **核不实就标注**：拿不准的条目标注
   > **待核实**：<不确定的是什么、需要怎么确认>。
   不要用推测填空，也不要把上游数值当成本仓事实。
4. **本仓特有内容以 `docs/` 为准**：`docs/已完成-*` / `docs/未完成-*` 里写清的结论可直接整理引用；引用未完成文档时照抄其中的阶段标注（如「P4 未实现」「P1 已落地」），不要自行重新判断。
5. **不写平台专属路径之外的私密信息**：不写凭据、密钥示例、真实内网地址。

## 6. 页面结构与写作要求

```markdown
# <页面标题>

<一段导语：这一页解决什么问题，读者是谁。>

## <一级小节>
<正文、表格、代码块>

> **提示**：可选的注意事项，用引用块。
```

- 标题层级从 `#` 开始，只用 `#` ~ `####`。
- 开头先给**一句话定义**（「X 是……用来……」），紧接一句适用读者；篇幅长、读者分叉的页面（如协议、排查类），在开头加一段「这一页怎么读」，说明只想要结果的读哪几节、想深入原理的读哪几节。
- 过程性内容给步骤条（**1 … → 2 … → 3 …**）和耗时大头的说明，不写未经核实的时间数字。
- 注意事项统一用「**加粗结论句** + 解释」或 `> **提示**` 引用块，两种风格不要在同一段混用。
- 表格用于**枚举**（入口、路径、默认值、状态、限制），不要用表格写连续叙述。
- 代码块标注语言（`bash`、`json`、`text`），纯路径用 `text`。
- 站内链接写**相对 `.md`**（构建脚本会自动改成 `.html`）：源文件里写 `[技能](skill.md)`。
- 单页 100~260 行，重点页可到 400 行；不要为凑长度重复内容。
- 中文排版：中英文之间加空格，标点用全角。

## 7. 截图与占位框

截图存放在 `assets/img/`，在正文里**独立成行**引用。构建时文件存在就渲染真图，缺失就渲染占位框（占位框上写明应存放的路径），补图后重新构建即自动显示：

```markdown
![设置 → 常规 的网络代理三个字段（图中为演示值）](assets/img/settings-network-proxy.png)
```

- 文件名全小写连字符、见名知意（`app-new-task.png`、`agent-permission-modes.png`）；更新截图直接覆盖同名文件后重新构建，不必改 md。
- **alt 写完整描述句**：说清是什么界面、哪些字段；使用了假数据的标注「图中为演示值」。
- 截图里不得出现真实用户数据、凭据、真实内网地址（与日志纪律一致）。
- 密度 0~5 张：概念页可以完全无图，操作页在对应小节贴一张关键界面；同一主视觉（如新建任务界面）跨页复用同一文件。
- `check.mjs` 统计截图引用与占位数量，`verify-html.mjs` 校验已就位截图的文件可达。

## 8. 页尾相关页面与版本核对

- 每页底部的「相关页面」卡片来自 `build.mjs` 顶部 `NAV` 里该页的 `related: [...]`（最多展示 3 张）。新增页面时顺手配上，选读者读完本页最可能接着去的 2~3 页。
- 页面支持 frontmatter，目前只有 `last-verified` 一个字段：

```markdown
---
last-verified: 2026-09-29
---
```

  标了日期的页面会在页脚显示「本页内容核对于某日期」。**只在真的对照过源码复核内容时才写日期**；不要为了好看给没复核过的页面贴日期。行为改动合入后，同步更新受影响页面的核对日期。

## 9. 构建与自检

```bash
node portal/manual/build.mjs         # 生成全部 HTML
node portal/manual/check.mjs         # 内容自检：外链 / 禁用内容 / 路径口径 / 链接可达
node portal/manual/verify-html.mjs   # 产物自检：结构与全部链接
node portal/manual/smoke-render.mjs  # 真实浏览器渲染（需本机 Chrome）
```

构建输出会报告缺少内容文件的 slug。提交前应确保：

- 页面里不出现外部链接、套餐名、社群入口、其他产品名。
- 用户级路径一律为 `~/.reactor`；工作区级保持 `.zcode`。
- 所有相对链接指向存在的页面。
- 截图引用要么文件已就位，要么是刻意留的占位（占位数量会在构建输出里汇报）。
