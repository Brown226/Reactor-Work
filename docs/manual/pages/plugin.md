# 插件

插件用来扩展 Reactor 的能力。一个插件可以把技能、命令、子智能体、MCP 服务器、Hooks 打包在一起，让团队把可复用的工具沉淀成一个扩展包，在同一个工作台里启用。

本页覆盖两件事：普通使用者怎么在插件商店里浏览、安装、启停插件，以及开发者怎么做出自己的插件并分发。

## 插件里有什么

插件目录里有什么，Reactor 就识别什么，并在列表里用标签或数量展示：

| 组件 | 说明 |
| --- | --- |
| **技能** | 教 Agent 如何完成特定任务的 `SKILL.md`，见[技能](skill.md) |
| **命令** | 可用 `/` 调用的快捷命令，见[命令](command.md) |
| **子智能体** | 随插件注册的子智能体 |
| **MCP 服务器** | 随插件注册的外部工具服务，出现在 MCP 列表的 **Plugin MCP 服务器** 分组，见 [MCP](mcp.md) |
| **Hooks** | 在特定事件触发的自动化钩子，见 [Hooks](hooks.md) |

启用插件后，它附带的可运行组件会注册到当前工作台；停用后这些组件一起停用。

## 浏览与安装插件

进入 **设置 → 插件**，看到的就是插件商店。顶部是搜索框，下方分成 **公开** 与 **个人** 两个分段：

- 公开：本仓随安装包内置的官方插件目录，按「开发者工具」「生产力」「实用工具」等类别分组。
- 个人：你自己添加的插件市场，先展示推荐条目，其余按市场名称分组。想接入别的来源时，用右上角的 **创建 → 添加插件市场**。

> **提示**：插件页需要在打开工作区后才可用。如果提示「打开一个工作区以管理插件」，先打开任意项目即可。
>
> **本仓的默认行为**：官方市场的 **CDN 分片默认禁用**——商店只显示随安装包内置的官方插件，**不访问** `cdn-zcode.z.ai`，断网环境可用。需要恢复上游 CDN 目录（公网开发/联调用）时，设置环境变量 `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE` 为 `on`、`1`、`true` 或 `cdn`。内置插件的加载不经过 CDN，与这个开关无关。

找到想要的插件后，点卡片上的 **安装**，状态会依次变为「安装中…」和「已安装」。

点击任意插件可打开详情页，Reactor 会列出它实际包含的技能、命令、子智能体、MCP 服务器和 Hooks，并附上开发者、类别、版本、网站等信息，让你在安装前先看清它会带来哪些能力。

### 添加自己的插件市场

点右上角的 **创建 → 添加插件市场**，在弹层里指定一个来源：

- GitHub 仓库（例如 `owner/repo` 或其链接）
- Git URL
- 本地的市场清单文件或目录，也可以把文件夹拖进来，或点「选择目录」
- 指向 `marketplace.json` 的 HTTP 地址、npm 包

添加前 Reactor 会先校验这个市场，成功后它发布的插件会以市场名称分组出现在 **个人** 分段里。

点搜索框上方的齿轮图标可以打开 **市场源** 面板，查看每个市场收录了多少插件、上次更新时间，并单独 **刷新该市场** 或 **移除该市场**。官方目录只能刷新，不会被移除。

## 内置插件

Reactor 内置了一批官方插件。下表按默认状态分组列出本仓随包分发的插件：

| 插件 | 能力 | 默认状态 |
| --- | --- | --- |
| **documents / pdf / presentations / spreadsheets** | 内网办公四件套：DOCX、PDF、PPTX、XLSX 的创作与审阅 | 默认启用 |
| **browser-use** | 操作 Reactor 内置浏览器，检查网页并验证交互 | 默认启用 |
| **image-search** | 查找插图与参考配图 | 默认启用 |
| **file-tools / ocr-tools / dwg-tools** | 文档解析、扫描件 OCR、DWG 图纸解析与修改 | 默认启用 |
| **review-skills** | 文件审查板块的判定规则与输出格式 | 默认启用 |
| **skill-creator / plugin-creator** | 创建、编辑、验证技能与插件 | 默认启用 |
| **zcode-guide** | Reactor 配置指南与扩展自诊断技能 | 默认启用 |
| **superpowers** | 软件开发工作流技能集（头脑风暴、计划执行、TDD、调试、评审等） | 默认启用 |
| **obsidian** | Obsidian 笔记创作技能集 | 默认启用 |
| **accounting-and-reporting** | 财务核算与报告技能集 | 默认启用 |
| **computer-use** | 电脑控制：驱动鼠标、键盘与界面元素 | 默认关闭 |
| **android-emulator / ios-simulator** | 移动开发工作流与模拟器自动化 | 默认关闭 |
| **restore-legacy-sessions** | 把旧版会话恢复为 Reactor 任务与会话记录 | 默认关闭 |

> **说明**：`node-repl-host` 是浏览器操作与电脑控制共用的运行时宿主，它必须随包内置并在需要时可用，但不进入商店、没有技能与商店条目，因此不会出现在插件列表里。

内网办公四件套已 **fork 进本仓库并随安装包分发**，不再依赖上游 CDN 目录；它们的运行时依赖（Python wheels 等）按内网部署方案单独准备，详见[内网办公四件套](office-suite.md)。

## 管理插件

装过插件后，搜索框下方会出现一条 **已安装** 图标带，点图标直接进入该插件详情；点这一行右侧的齿轮图标则进入 **管理已安装** 页面，本机所有插件以列表形式展开，显示名称、版本、来源标签和组件数量。

在这里可以：

- 用右上角筛选器按启用 / 停用状态过滤。
- 查看插件来源标签，例如「内置」，或某个市场的名称。
- 用右侧开关启用或停用插件。
- 点 **检查更新** 拉取各插件的最新版本，有更新的插件会带上标记。
- 点击插件条目查看它包含的具体技能、命令、MCP 等组件，并可在此卸载。

> **检查更新的版本对比口径**：「最新版本」取自市场 `marketplace.json` 里该插件条目声明的 `version`，「已安装版本」取自插件自身的 `plugin.json`。自建市场发版时若忘了同步改 `marketplace.json` 的 version，即使插件代码已更新也不会提示可更新。

启用或停用插件后，Reactor 会刷新受影响的技能和会话，让改动生效。停用插件后它的全部组件立即从会话中移除，再次启用即可恢复。

> **停用还是卸载？** 停用只是让插件暂时不生效，随时可以开回来；卸载则把它从列表中移除。内置插件的安装包随应用一起分发，卸载时 Reactor 会记录一条屏蔽标记，应用升级后也不会把它装回来——想重新使用，在商店里重新安装即可。

在远程工作区里，本机装的插件默认不会跟过去。连上 SSH 或 WSL 远程后，可以用工作区标题栏 **同步** 下拉里的 **同步 Plugin** 把它们搬过去，详见[远程开发](remote-development.md)。

## 配置插件

有些插件需要先提供参数才能工作，例如默认设备、开关或路径。点开插件详情，展开底部的 **高级信息**，在 **配置** 区填写可填项——必填项会标注「必填」，填完点 **保存配置**。

标记为敏感的项（例如 API 密钥）会提示「该值需要安全存储接入后才能配置」，当前暂不支持在界面里直接填写。遇到这类插件，按其说明在系统层面准备好密钥即可。

## 装好的插件怎么用

插件启用后，它带来的能力会自动出现在客户端对应位置：

| 能力 | 在哪里用 |
| --- | --- |
| **技能** | 合适时机会自动触发；也可在输入框输入 `$` 或 `/`，从「技能」分组手动选用 |
| **命令** | 在输入框输入 `/`，从「命令」分组选用 |
| **子智能体** | 会话中可被自动调度执行任务；在设置里可查看（来自插件，只读） |
| **MCP 服务器** | 在设置 → MCP 中显示为 **Plugin MCP 服务器**，随插件启停自动加载 |
| **Hooks** | 随插件启停，在设置 → Hooks 里以只读条目展示 |

## 开发自己的插件

只需写 JSON 和 Markdown，不用改 Reactor 本体。做好后，通过「添加自己的插件市场」把本地目录加进来，即可在客户端里直接安装测试。

### 一个插件长什么样

插件就是一个文件夹：根目录放一份清单 `plugin.json`，再按需放各类组件目录（全部可选）。

```text
my-plugin/
├── .zcode-plugin/
│   └── plugin.json     清单（唯一必需）
├── commands/           斜杠命令，每个一个 .md
├── skills/             技能，每个子目录含 SKILL.md
├── agents/             子智能体 .md
├── hooks/hooks.json    钩子
└── .mcp.json           MCP 服务声明
```

清单按优先级查找：`.zcode-plugin/plugin.json`（推荐）→ `.claude-plugin/plugin.json`（兼容 Claude Code）。

五类组件的写法：

| 组件 | 格式与位置 |
| --- | --- |
| **命令** | `commands/*.md`，YAML frontmatter + 正文；正文用 `$ARGUMENTS` 接收参数 |
| **技能** | `skills/<名>/SKILL.md`，frontmatter 写清 `name` / `description` |
| **子智能体** | `agents/*.md`，frontmatter 必填 `name` / `description`，正文即其 system prompt |
| **Hooks** | `hooks/hooks.json`，标准位置自动发现；随插件启停，详见 [Hooks](hooks.md) |
| **MCP 服务** | 根目录 `.mcp.json` 或清单 `mcpServers`，键名自动加命名空间 `plugin:<插件名>:<服务名>` 避免冲突 |

### plugin.json 字段速查

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | ✅ | 插件名，须匹配 `^[a-z0-9][a-z0-9._-]{0,127}$` |
| `version` | | 版本号，建议语义化版本 |
| `description` | | 一句话描述，显示在插件管理界面 |
| `author` | | 作者，可写字符串或对象 `{ name, email, url }` |
| `homepage` / `repository` | | 主页与仓库地址 |
| `license` / `keywords` | | 许可证与关键词 |
| `commands` / `skills` / `agents` / `hooks` / `mcpServers` | | 组件声明，可写目录路径字符串、路径数组或内联对象 |
| `dependencies` | | 依赖的其他插件，写 `name@market` 或同市场内裸 `name` |
| `userConfig` | | 用户可配置项 |

> 清单里写了 `channels` / `lspServers` / `outputStyles` / `settings` 时，当前运行时**仅登记、不执行**，会给出诊断提示，不影响其它组件加载。

`userConfig` 里每一项都会出现在插件详情弹窗的 **配置** 区：

| 字段 | 含义 |
| --- | --- |
| `type` | 类型：`string` / `number` / `boolean` / `directory` / `file` |
| `title` / `description` | 界面标题与说明 |
| `default` | 默认值 |
| `required` | 必填项，界面标「必填」 |
| `sensitive` | 敏感值，界面打码且暂不支持在界面直接填写 |

敏感配置可在 MCP 声明里用 `${user_config.键}` 引用。

### marketplace.json 字段速查

「插件市场」是一份目录清单，告诉客户端有哪些插件可装、各自在哪。

顶层字段：`name`（必填，命名规则同插件名）、`description`、`plugins`（必填，条目数组）、`pluginRoot`（解析条目 `source` 的基准目录）、`allowCrossMarketplaceDependenciesOn`（允许跨市场依赖的市场名数组）。

`plugins[]` 每个条目：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `name` | ✅ | 插件名 |
| `source` | | 插件代码在哪。最常用是相对路径字符串，也可写对象 |
| `description` / `version` | | 展示用描述与版本 |
| `category` / `tags` | | 分类与标签，便于检索 |
| `dependencies` | | 依赖的其他插件 |
| `strict` | | 布尔；对该条目做更严格的校验 |

`source` 的几种写法：`"./plugins/hello"`（相对市场根目录的子目录）、`{ "source": "directory", "path": "/abs/path" }`（本地绝对路径）、`{ "source": "github", "repo": "owner/repo", "path": "subdir", "ref": "main" }`、`{ "source": "git", "url": "https://...git", "path": "subdir", "ref": "..." }`、`{ "source": "url", "url": "https://.../plugin.json", "headers": {} }`、`{ "source": "file", "path": "..." }`。

### 组件文件字段速查

`commands/*.md` 的 frontmatter 支持：`description`（或正文非空即可）、`argument-hint`、`allowed-tools`（逗号分隔）、`model`、`skills`（逗号分隔，自动挂载的技能）、`disable-noninteractive`。命令名取自文件名，须匹配 `^[a-z0-9][a-z0-9_:-]{0,63}$`。

`skills/<名>/SKILL.md` 的 frontmatter 支持：`name`、`description`（最长 1024 字符）、`when_to_use`、`license`、`metadata`；其余非白名单字段会被忽略，不影响加载。字段语义与限制详见[技能](skill.md)。

MCP 声明可用模板变量 `${CLAUDE_PLUGIN_ROOT}`（亦可写 `${ZCODE_PLUGIN_ROOT}`）、`${CLAUDE_PLUGIN_DATA}`、`${CLAUDE_PROJECT_DIR}`、`${user_config.键}`；`type` 可省略，有 `command` 默认 `stdio`，有 `url` 默认 `http`。完整写法见 [MCP](mcp.md)。

### 在客户端本地测试

1. 本地建好插件目录，再写一份 `marketplace.json`，`plugins[].source` 用相对路径指向插件目录。
2. 打开 **设置 → 插件**，点右上角 **创建 → 添加插件市场**，填该目录的本地路径。
3. 在 **个人** 分段找到它，点 **安装** 并启用，在会话里触发组件验证；改完代码回到 **市场源** 面板刷新该市场即可。

> **安全提示**：启用插件就是授予代码执行信任。已启用的第三方市场插件与官方插件一样，可以执行本地进程并读取继承的 Agent 环境变量。启用前请审查来源、`hooks/hooks.json` 和脚本，不信任时停用或卸载插件。

## 与上游 ZCode 的差异

| 项 | 上游写法 | 本说明书写法 | 原因 |
| --- | --- | --- | --- |
| 产品名 | ZCode | Reactor | 本仓产品名与 rebrand 契约 |
| 用户级目录 | 上游写在用户 HOME 下的 `.zcode` 目录 | 改为 `~/.reactor/...` | 用户数据目录契约 |
| 市场目录来源 | 公开目录来自 GitHub，网络不畅时加载失败 | 默认只显示随包内置的官方插件，不访问上游 CDN；显式设置 `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE` 才恢复 CDN 目录 | 内网隔离部署，删去上游下载站与 CDN 依赖 |
| 内置插件清单 | 只列 5 个示例插件 | 按本仓实际随包插件分组列出，并说明 `node-repl-host` 不对外露出 | 以本仓源码为准 |
| 办公四件套 | 作为官方市场插件从 CDN 获取 | 已 fork 进仓库、随安装包分发 | `docs/已完成/已完成-内网办公四件套-fork-spec.md` |
| 在线商业与社群内容 | 含套餐、社群与下载入口 | 已删除 | 内网隔离部署无关 |
| 下一步/相关链接 | 站内链接指向官方文档站 | 改为本说明书相对链接 | 离线站点，不请求外部资源 |
