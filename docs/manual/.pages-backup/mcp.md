# MCP

MCP（Model Context Protocol）可以把文件系统、浏览器、记忆、数据库等外部能力接入 Agent。Reactor 统一管理 **Reactor Agent** 使用的 MCP 服务器配置。

本页覆盖：在设置里新建与导入 MCP 服务器、配置文件的读取顺序与优先级、以及工作区 MCP 的自动连接行为。

## 列表分组

MCP 列表按来源分为两组：

- **已配置 MCP 服务器**：你手动添加的 MCP 服务，可直接编辑、删除或启用/停用。
- **Plugin MCP 服务器**：随插件一起安装的 MCP 服务，由对应插件统一管理，见[插件](plugin.md)。

列表中每个 MCP 都会展示名称、来源、启动方式和命令。

## 新建 MCP 服务器

进入 **设置 → MCP 服务器**，点击右上角 **新建 MCP 服务器**。**表单** 模式适合快速填写常见 stdio 服务：

1. 选择 **作用域**：用户（所有工作区可用）或工作区（仅当前项目可用）。
2. 填写名称，例如 `memory`。
3. 类型选择 `stdio`（本地命令），也支持 `SSE` 和 `HTTP` 类型的远程服务。
4. 填写命令，例如 `npx`，以及参数，例如 `-y @modelcontextprotocol/server-memory`。
5. 如服务需要密钥或路径，再展开 **环境变量（可选）** 填写。
6. 点击 **添加** 后回到列表，并确认开关处于启用状态。

除 stdio 本地命令外，还有两种录入方式：接入远程服务时类型选择 `HTTP` 或 `SSE`，填写服务地址即可，需要鉴权的服务可展开 **请求头（可选）** 补充 `Authorization` 等信息；如果已有现成 JSON 配置，则切换到 **完整配置** 模式直接粘贴，支持 `{"server-name": {...}}` 和 `{"mcpServers": {...}}` 两种常见结构。

> **版本兼容**：`type` 可省略——有 `command` 默认 `stdio`，有 `url` 默认 `http`。历史配置里用 `environment` 写的环境变量会在读取时归一化为 `env`；停用状态统一认 `enabled` 字段。

## 从外部 Agent 导入 MCP 服务器

如果你已经在 Claude Code、Codex CLI、OpenCode 等外部 Agent 中配置了一批 MCP 服务器，不需要在 Reactor 里逐个重建。在 **MCP 服务器** 页面右上角点击 **导入**，Reactor 会扫描这些外部 Agent 的配置文件，把已有的 MCP 服务器集中列出，供你一次性导入。

扫描范围包括 Claude Code 的 `.claude/settings.json` 与 `.mcp.json`、Codex CLI 的 `.codex/config.toml`、OpenCode 的 `opencode.json`、通用 `.agents/mcp.json` 等位置。

1. 在设置中进入 **MCP 服务器** 页面。
2. 点击右上角的 **导入** 图标，打开导入弹窗。
3. 在弹窗右上角选择导入的 **作用域**（全局或当前工作区）。
4. 勾选要导入的服务器，或点击 **全选**；弹窗实时显示发现的可导入数量与已选数量。
5. 点击 **导入** 完成导入，服务器会出现在列表中。

导入后的服务器会和手动添加的服务一样保存在对应作用域的配置文件中，可以在 Reactor 内继续编辑、启停或删除，**原外部 Agent 的配置文件不会被修改**。

## 配置文件与默认读取路径

设置面板只是入口之一。Reactor 按固定的目录约定读取 MCP 配置文件，你也可以直接手工编辑这些文件来批量管理服务：

| 作用域 | 文件路径 | 配置键 |
| --- | --- | --- |
| **用户**（所有工作区可用） | `~/.reactor/cli/config.json` | `mcp.servers` |
| **工作区**（仅当前项目可用） | `<项目根>/.zcode/config.json` | `mcp.servers` |
| 用户 · `.agents` 兼容 | `~/.agents/mcp.json` | `mcpServers` |
| 工作区 · `.agents` 兼容 | `<项目根>/.agents/mcp.json` | `mcpServers` |

> **注意**：用户级原生配置在 `.reactor/cli/` 目录下，而工作区级直接在 `.zcode/` 目录下，两个文件同名为 `config.json` 但层级不同。

Reactor 原生配置（`config.json`）的 MCP 部分形如：

```json
{
  "mcp": {
    "servers": {
      "memory": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "env": {}
      }
    }
  }
}
```

`.agents/mcp.json` 则使用业界通用的 `{"mcpServers": {...}}` 结构，便于和其他支持 `.agents` 目录约定的 AI 工具共享同一份 MCP 配置。

### 读取规则与优先级

1. **工作区优先加载**：打开工作区时先读取工作区作用域的配置，再读取用户作用域，两边的服务都会出现在列表中。
2. **同作用域内 `.zcode` 强优先**：只要 `.zcode` 配置文件里读到了任何 MCP 服务，**同作用域的 `.agents/mcp.json` 就会被整体跳过，不做合并**。`.agents` 只在 `.zcode` 没有配置任何服务时才作为兜底来源生效。
3. **启用状态记录在配置对象内**：在列表里停用某个 MCP 时，Reactor 会向该服务的配置对象写入 `"enabled": false`；没有这个字段即视为启用。
4. **面板写入永远落在 `.zcode`**：通过设置面板新增或编辑的服务，始终写回对应作用域的 `.zcode` 原生配置文件，`.agents` 文件不会被修改。

> **提示**：如果你在 `.agents/mcp.json` 里维护了一批服务，又在设置面板里新建了一个服务，原来 `.agents` 里的服务会因为 `.zcode` 优先规则而整体失效。此时把 `.agents` 里的配置合并进 `.zcode` 配置文件即可。

### 工作区 MCP 会自动连接

写在项目配置里的 MCP 服务，在会话启动时会和用户级服务一样 **自动连接**，不需要每次手动授权。这让团队把 MCP 配置提交进仓库后，成员克隆下来就能直接用。

方便之外有件事需要留意：**打开一个项目，就等于连上了它配置里写的所有 MCP 服务**，而 MCP 服务能执行命令、读写文件、访问网络。所以打开来路不明的仓库之前，建议先看一眼它的 `.zcode/config.json`，确认里面的 MCP 配置你都认得。

同名服务以你自己的用户级配置为准，项目配置覆盖不了它。

## 用 `/mcp` 查看与管理

在会话里可以输入 `/mcp` 查看已配置的 MCP 服务器状态；`/mcp connect <服务器名>` 与 `/mcp disconnect <服务器名>` 可以手动管理当前会话的连接。

## 与上游 ZCode 的差异

| 项 | 上游写法 | 本说明书写法 | 原因 |
| --- | --- | --- | --- |
| 产品名 | ZCode | Reactor | 本仓产品名与 rebrand 契约 |
| 用户级配置路径 | 上游 `.zcode/cli/config.json` | 改为 `~/.reactor/cli/config.json` | 用户数据目录契约 |
| 工作区级路径 | `<项目根>/.zcode/config.json` | 同左，不变 | 工作区级保持 `.zcode` |
| 跨工具目录 | `~/.agents/mcp.json`、`~/.claude/...` | 同左，不变 | 跨工具约定目录 |
| OAuth 授权与推荐配置 | 含 OAuth 授权章节与「推荐配置」（智谱 MCP 服务与套餐相关说明） | 已删除；保留本地 stdio / HTTP / SSE 三类配置与 `.agents` 兼容说明 | 内网部署环境与外部服务不可达，套餐类内容与内网无关 |
| `.agents` 读取规则 | 说明为「兜底」 | 明确写出「`.zcode` 命中后 `.agents` 整体跳过，不合并」 | 用更精确的口径描述同一行为，避免误以为会合并 |
| 停用字段 | 写作 `"enable": false` | 写作 `"enabled": false`（历史 `enable` 仅在读取时兼容迁移） | 与本仓配置契约字段一致 |
| 下一步/相关链接 | 站内链接指向官方文档站 | 改为本说明书相对链接 | 离线站点，不请求外部资源 |
