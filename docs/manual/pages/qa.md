# 常见问题

本页汇总内网部署与日常使用中最高频的疑问。所有结论都可在源码或 `docs/` 契约中核实；无法核实的不写进本页。

## 1. 产品与定位

### Reactor 是什么？和 ZCode 是什么关系？

Reactor（数智堆脑）是面向内网部署的 Agentic Development Environment（ADE）。它由上游 ZCode 二次开发而来：保留 Agent 工作流、任务与文件管理、扩展体系等主体能力，替换掉面向公网的登录、模型网关、插件市场与社群链路，改为接入**自建内网服务端**。

差异汇总见[与上游 ZCode 的差异](upstream-diff.md)。

### 必须联网吗？

分两种情形：

| 情形 | 是否需要公网 |
| --- | --- |
| 接入内网自建模型网关 | 不需要公网，但需要内网服务端可达 |
| 使用历史版本的官方插件市场分片 | **默认关闭**，不会访问上游 CDN；只有显式开启时才访问 |

内网办公四件套（文档 / 表格 / 演示 / PDF）已 fork 进仓库随包分发，不再依赖上游 CDN。

### 数据存在哪里？

用户级数据在 `~/.reactor` 下，工作区级配置在项目的 `.zcode` 目录下，两者边界严格区分。详见[数据目录与背景主题契约](data-contracts.md)。

## 2. 模型接入

### 怎么接模型？

Reactor 通过内网服务端与模型网关访问模型。配置入口、企业目录白名单与本地模型配置的可见性策略见[接入模型](model-access.md)。

### 上下文窗口怎么算？

上下文窗口由模型配置决定。未显式配置时的兜底值与自动压缩口径如下（源码位置：`apps/zcode-cli/packages/core/src/compact/policy.ts`）：

| 项 | 值 |
| --- | --- |
| 兜底上下文窗口 `DEFAULT_COMPACT_CONTEXT_WINDOW` | 200000 |
| 输出预留 `PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS` | 至多 21000 |
| 安全缓冲 `AUTOCOMPACT_BUFFER_TOKENS` | 13000 |
| 自动压缩阈值 | `上下文窗口 − 输出预留 − 安全缓冲` |

也就是说，通常固定扣掉约 **3.4 万 token** 才触发自动压缩：20 万窗口约在 16.6 万触发，128K 窗口约在 9.4 万触发。

### 能关掉或调整自动压缩阈值吗？

自动压缩策略在代码里带 `enabled`、`contextWindow`、`bufferTokens`、`maxConsecutiveFailures` 等可选参数，但**界面上没有对应的开关或阈值设置项**。

> **待核实**：是否存在通过内网服务端下发或配置文件写入这些字段的受支持路径。若你需要关闭自动压缩，请先与维护方确认可用入口。

### 压缩失败了会怎样？

连续失败有上限（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`），达到上限后触发熔断，不再反复重试。压缩期间的界面文案区分「正在压缩」「正在重试（第 n/m 次）」「上下文已是最新，无需压缩」「已自动压缩」「压缩失败」「压缩已中断」等状态。

## 3. 会话与上下文

### `AGENTS.md` 和项目记忆有什么区别？

| 对比项 | `AGENTS.md` | 项目记忆 |
| --- | --- | --- |
| 谁来写 | 你手写 | Agent 自动提炼 |
| 存放位置 | 用户级 `~/.reactor/AGENTS.md` 与工作区根目录 `AGENTS.md` | `~/.reactor/cli/memories/projects/<工作区>/` |
| 是否进仓库 | 工作区那份跟着代码走 | 只在本机，不进 Git |
| 适合什么 | 需要评审和共享的团队约定、编码规范 | 协作过程中积累的零散事实 |

详见[项目记忆](memory.md)。

### 项目记忆默认开着吗？

**默认关闭**（`memoryEnabled ?? false`）。开启路径为**设置 → 记忆 → 工作区记忆**，开关只对新会话生效，且开启后可能增加模型调用与 Token 成本。

### 项目记忆在哪里查看？远程工作区能用吗？

记忆详情**仅支持在本地桌面端查看**（界面文案：「记忆详情仅支持在本地桌面端查看」）。按工作区保存，可搜索、按文件查看，单文件超过 5 MiB 不预览。

> **待核实**：跨设备或远程工作区下记忆的可见性边界，需结合实际部署方式确认。

### 子智能体的 `model` 写了为什么没生效？

子智能体定义文件在 `~/.reactor/agents/<name>.md`。模型字段的解析规则（源码 `packages/shared/src/subagent-markdown-selection.ts`）：

- `model` 必须是字符串；`inherit`、`main`、`sonnet`、`opus`、`haiku` 都视为**继承主会话模型**，不视为具体模型。
- `thoughtLevel` 只有在同时写了一个**具体模型**时才参与解析；只写 `thoughtLevel` 不会生效。
- 正式字段就是字符串 `model` + `thoughtLevel`；**不解释中间态字段**，未知字段被忽略。

### 子智能体能再派发子智能体吗？

不能。子智能体运行在 `subagent` 作用域，不能再派发下一层子智能体。相关边界见[子智能体](subagents.md)。

### 改了子智能体配置要重启吗？

需要**新建会话**。已启动的会话不会热更新。

## 4. 配置与排障

### 文件、命令与配置分别在哪？

| 用途 | 位置 |
| --- | --- |
| 用户数据根 | `~/.reactor` |
| 应用配置 | `~/.reactor/v2/config.json` |
| CLI 配置 | `~/.reactor/cli/config.json` |
| 凭据 | `~/.reactor/v2/credentials.json` |
| 设备身份与遥测状态 | `~/.reactor/v2/telemetry-state.json` |
| 技能（用户级） | `~/.reactor/skills/<技能名>/SKILL.md` |
| 服务端下发技能 | `~/.reactor/server-skills` |
| 自定义命令 | `~/.reactor/commands` |
| 子智能体 | `~/.reactor/agents/<名称>.md` |
| 项目记忆 | `~/.reactor/cli/memories/projects/<工作区>/` |
| 命令输出留档 | `~/.reactor/cli/exec` |
| 工作区配置 | `<项目根>/.zcode/config.json` |

### 换机器要复制哪些文件？

可复制用户级配置、`AGENTS.md`、`agents/`、`skills/`、`commands/`；**不要复制**凭据与设备身份文件（`credentials.json`、`telemetry-state.json`）。

> **提示**：`~/.reactor/cli/exec` 存放历史命令输出，不会自动清理，可以整目录删除，需要时会重建。

### 官方版 ZCode 的数据会被覆盖或迁移吗？

不会。两个产品在同一台机器上并存互不干扰：**读不到旧目录不删、不迁**。官方版应用自身的 `appData` 目录只作为**导入来源**被读取，不写入。

### 想切换数据基目录怎么办？

用环境变量或配置显式指定，优先级高于内置常量：

| 覆盖项 | 语义 |
| --- | --- |
| `ZCODE_DATA_BASE_DIR` | 数据基目录，用户数据根 = `{dataBaseDir}/.reactor` |
| `ZCODE_HOME` | 直接指定用户数据根，不再拼接目录名 |
| `ZCODE_STORAGE_DIR` | 同上 |

### 怎么看当前版本？

桌面端菜单栏 / 标题栏的**帮助 → 关于 Reactor**；设置里的「应用信息」也会显示版本号与构建时间。

### 检查更新失败怎么办？

菜单栏**帮助 → 检查更新**。开发环境不检查更新（提示「开发环境不检查更新」）。若提示当前版本低于最低可用版本，需要先完成升级才能继续使用。

### 中文输入法或 Linux 启动有问题？

见 [Linux / WSL 排查](linux-wsl.md)。

## 5. 与上游 ZCode 的差异

| 项 | 上游写法 | 本说明书写法 | 原因 |
| --- | --- | --- | --- |
| 套餐与额度 | 大篇幅讲 Coding Plan、免费体验、额度重置卡 | 全部删除，改为内网模型接入 | 内网隔离部署，无公网套餐链路 |
| 社群与反馈入口 | 飞书群、微信群、公众号、小红书、GitHub feedback | 改为内网受理渠道 | 社群入口与公网账号绑定 |
| 用户目录 | `~/.zcode` | `~/.reactor` | 本仓已把用户级目录收口为 `USER_DATA_DIR_NAME` 常量（值为 `.reactor`） |
| 上下文与压缩口径 | 给出约 3.4 万 token 的预留结论 | 保留该结论并**补上源码常量名** | 该口径在本仓可逐项核实 |
| `mode` 字段迁移 | 称子智能体配置键已由 `mode` 改为 `subagent` | 不收录该说法 | 本仓子智能体 frontmatter 的权限键名为 `permissionMode`，未核实到 `mode → subagent` 的迁移路径 |
| 技能/命令/子智能体目录 | `~/.zcode/...` | `~/.reactor/...`，并补上 `~/.reactor/server-skills` | 本仓用户级目录口径与服务端下发目录 |
