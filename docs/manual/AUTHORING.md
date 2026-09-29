# Reactor 说明书 · 改写规范

本文件是 `pages/*.md` 的唯一写作口径。所有页面按此规范改写，改完由 `node docs/manual/build.mjs` 生成 HTML。

## 0. 基准与素材

| 角色 | 位置 | 说明 |
| --- | --- | --- |
| 上游原文（参考素材，**不是**事实来源） | `.tmp/zdocs/md/*.md` | 官网 `/cn/docs/*` 抽取正文，仅用于了解结构与覆盖点 |
| 事实来源 | 本仓源码、`package.json`、`docs/已完成/*`、`docs/未完成-*` | 与上游冲突时一律以本仓为准 |
| 已归档契约 | `docs/已完成/已完成-*.md` | 已按源码核实的契约 |
| 进行中方案 | `docs/未完成-*.md` | 含尚未落地的能力，引用时必须写清"已落地 / 未落地" |
| 上游版本 | `https://zcode.z.ai/cn/docs/*` 当前 3.14.4 | 本仓 `package.json` 为 3.14.0 |

## 1. 产品名与称谓

- 产品名统一写作 **Reactor**，需要全称时用 **Reactor（数智堆脑）**。
- 不写 "ZCode" 作为产品名。以下情形**例外保留**：上游对照语境、"上游 ZCode 官方文档"、协议或包名（如 `@zcode/shared`）、工作区级目录 `.zcode`、`zcode` CLI 命令名。
- 面向使用者的口吻用"你"，不写"我们""本产品"之外的营销话术。

## 2. 路径与目录口径（最容易出错，逐条对齐）

用户级目录已从 `~/.zcode` 改为 **`~/.reactor`**；工作区级目录**保持 `.zcode` 不变**。依据 `docs/已完成/已完成-data-directory-contract.md`。

| 上游写法 | 本说明书写法 | 判定 |
| --- | --- | --- |
| `~/.zcode/v2/config.json` | `~/.reactor/v2/config.json` | 用户级 → 改 |
| `~/.zcode/cli/config.json` | `~/.reactor/cli/config.json` | 用户级 → 改 |
| `~/.zcode/skills/<名>/SKILL.md` | `~/.reactor/skills/<名>/SKILL.md` | 用户级 → 改 |
| `~/.zcode/commands` | `~/.reactor/commands` | 用户级 → 改 |
| `~/.zcode/agents/<名>.md` | `~/.reactor/agents/<名>.md` | 用户级 → 改 |
| `~/.zcode/AGENTS.md` | `~/.reactor/AGENTS.md` | 用户级 → 改 |
| `~/.zcode/cli/log/`、`~/.zcode/logs` | `~/.reactor/cli/log/`、`~/.reactor/logs` | 用户级 → 改 |
| `~/.zcode/cli/memories/...` | `~/.reactor/cli/memories/...` | 用户级 → 改 |
| `~/.zcode/v2/repo-wiki/...` | `~/.reactor/v2/repo-wiki/...` | 用户级 → 改 |
| `<repo>/.zcode/config.json` | `<repo>/.zcode/config.json` | 工作区级 → **不改** |
| `<repo>/.zcode/skills/`、`.zcode/agents/`、`.zcode/workflows/`、`.zcode/plans/` | 同左 | 工作区级 → **不改** |
| `.zcodeignore`、`.zcode-plugin/` | 同左 | 工作区级 → **不改** |
| `~/.agents/`、`~/.claude/` | 同左 | 跨工具约定目录 → **不改** |

环境变量 `ZCODE_*`（如 `ZCODE_DATA_BASE_DIR`、`ZCODE_HOME`）与协议字段名保持原样，不要改名。

## 3. 删除项（内网隔离部署无关，一律不写）

- 桌面端下载页与安装包外链（`cdn-zcode.z.ai`、`zcode.z.ai` 下载地址）。
- 套餐权益：GLM Coding Plan、Z.ai / BigModel 账号与端点、5 天免费体验、周额度、额度重置卡、闲时免费计费口径。
- 社群与商业入口：飞书群、微信群、公众号、小红书、GitHub feedback 仓库、邀请奖励、支付二维码。反馈改为内网渠道表述。
- Bot Channel（微信 / 飞书机器人）——本仓未提供该能力。
- 使用统计页中的"编程套餐"与"额度重置卡"部分；仅保留本地会话用量（若该内容在本仓有对应实现则写入，否则不写）。

## 4. 新增章节（上游没有，必须写入）

| 章节 | 页面 slug | 依据 |
| --- | --- | --- |
| 本仓特有功能 | `interface-modes`、`review-panel`、`office-suite`、`model-governance`、`data-contracts` | `docs/已完成/*`、`docs/未完成-*`、源码 |
| 内网服务端 | `server-overview`、`server-delivery`、`server-usage-policy` | `docs/未完成-服务端接线-*`、`docs/已完成/server-*`、`server/README.md` |

## 5. 事实纪律（本规范最重要的一节）

1. **只写能核实的**：每条行为、路径、默认值、上限都要能在源码或 `docs/` 契约里找到依据。
2. **核不实就标注**：拿不准的条目标注为
   > **待核实**：<此处写清不确定的是什么、需要怎么确认>。
   不要用猜测填空，不要把上游文档的数值当作本仓事实。
3. **不写上游有但本仓没有的**：例如 Bot Channel、额度重置卡、`~/.zcode` 用户级路径。
4. **区分已落地与未落地**：引用 `docs/未完成-*` 时写明"该能力当前已落地 / 尚未落地"。
5. **不编造数值**：上限、超时、字符数等若无源码依据则不写具体数字，或标注"待核实"。
6. **不复制大段上游原文**：改写为面向 Reactor 使用者的表述，保留必要术语。

## 6. 页面结构与写作要求

```markdown
# <页面标题>

<一段导语：这一页解决什么问题，读者是谁。>

## <一级小节>
<正文、表格、代码块>

> **提示**：可选的注意事项，用引用块。

## 与上游 ZCode 的差异
<若有差异：逐条列出「上游写法 → 本说明书写法 → 原因」。没有差异则写「本页与上游行为一致」。>
```

- 标题层级从 `#` 开始，只用 `#` ~ `####`。
- 表格用于**枚举对照**（入口、路径、默认值、状态、限制），不要用表格写连续叙述。
- 代码块标注语言（`bash`、`json`、`text`），路径用 `text`。
- 站内链接写**相对 `.md`**（构建脚本会自动改成 `.html`），如 `[技能](skill.html)` 在源文件里写成 `[技能](skill.md)`。
- 单页控制在 120~260 行，重点页可到 400 行；不要为了凑长度重复内容。
- 中文排版：中英文之间加空格，标点用全角。

## 7. 构建与自检

```bash
node docs/manual/build.mjs        # 生成全部 HTML
```

构建输出会报告缺少内容文件的 slug。提交前自检：

- `docs/manual/pages/` 里不出现 `~/.zcode` 用户级路径（工作区级 `.zcode` 允许）。
- 页面里不出现下载外链、套餐名、社群入口。
- 所有相对链接指向存在的页面。
