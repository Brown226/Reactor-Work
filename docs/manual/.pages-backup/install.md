# 安装与部署

Reactor（数智堆脑）不提供公网下载页与安装包外链。本页说明的是**内网环境下的部署与分发方式**：从本仓库构建产物，在内网分发与启动。

读者是负责在本机或内网机器上把 Reactor 跑起来的人（开发者、运维、管理员）。所有命令都从**仓库根目录**执行。

## 前置条件

环境版本以仓库根的 `mise.toml` 为准（`mise install` 可按它安装）：

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Git | 任意近期版本 | 仓库以普通目录克隆，Agent CLI 源码随仓库一起克隆，无需初始化 submodule |
| Node.js | `24.14.0` | `package.json` 的 `engines` 要求 `>=24.0.0` |
| pnpm | `10.33.2` | `packageManager` 字段已钉住；`corepack` 或 `mise` 均可 |

## 初始化

```bash
pnpm bootstrap
```

`pnpm bootstrap` 会安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

按需选择其他初始化入口：

| 命令 | 用途 |
| --- | --- |
| `pnpm install` | 只安装依赖 |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源（默认含远程资源准备） |
| `pnpm prepare:remote-assets` | 单独准备远程运行资源 |
| `pnpm bootstrap:with-remote` | 初始化依赖、本地与远程资源并串行构建相关包，跳过桌面应用 bundle |
| `pnpm build` | 递归执行各 workspace 包的构建脚本（`packages/*` 与 `apps/zcode-cli/*`） |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发；要使用远程工作区时再运行对应准备命令。

## 启动

### 桌面端

```bash
pnpm dev:desktop        # 等同于 pnpm dev:desktop:prod，使用生产服务配置
pnpm dev:desktop:test   # 使用测试环境
```

启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 与源码监听。只改了渲染层 / host 层时可用：

```bash
pnpm dev:desktop:reuse
```

该命令复用上一次的 agent 产物并保留 `out/` 以启用增量构建；脚本会比对 agent 源码指纹，源码有变化时自动回到全量重建。

需要独立的数据目录时，设置 `ZCODE_DATA_BASE_DIR`（用户数据写入其下的 `.reactor/`）：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.reactor-dev-home" pnpm dev:desktop:test
```

### Web 端与后端

```bash
pnpm dev:web
```

同时启动 Web 开发服务器（默认 `http://localhost:5173`）与后端（默认 `http://localhost:3030`），浏览器访问前者。也可单独启动后端：`pnpm dev:server`。

需要指定后端工作区时用 `ZCODE_SERVER_WORKSPACE`：

```bash
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

## 构建与分发

### 桌面端产物

```bash
pnpm bundle:desktop
pnpm bundle:desktop -- --os win --arch x64
pnpm bundle:desktop -- --help
```

默认目标平台为 macOS arm64，默认输出目录为 `packages/desktop/dist/`；`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`。实际打包与签名需要目标平台对应的工具与配置。

### 命令行 / Web 发行包

```bash
pnpm build:zcode
pnpm build:zcode --base-url http://<内网托管地址>/zcode/
pnpm build:zcode --skip-build
pnpm build:zcode --help
```

发行包包含 TUI、Web 与 Agent，统一用 `zcode` 启动：无参数进入 TUI，第一个参数为 `--web` 时启动 Web。默认版本取根 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引与安装脚本。

脚本需要下载根地址 `ZCODE_DIST_BASE_URL`（可放 `.env`、`.env.local` 或环境变量，也可用 `--base-url` 传入）。**该地址必须指向内网可访问的托管位置**：把整个输出目录上传到该地址后，`install.sh` 从中下载运行包。安装脚本的安装目录可用 `ZCODE_DIST_HOME` 覆盖（默认位于当前用户 HOME 下，它是**安装树**而非用户数据目录，不随 `~/.reactor` 口径变更），写入命令的目录默认 `~/.local/bin`，可用 `ZCODE_DIST_BIN_DIR` 覆盖。运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

本地验证产物可以直接解压运行，不必上传：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" -C dist/zcode/debug

node dist/zcode/debug/zcode/bin/zcode.mjs            # TUI
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open           # Web
```

Web 模式默认监听 `127.0.0.1`，端口被占用时换 `--port`；局域网访问用 `--host 0.0.0.0`，此时默认生成访问令牌。通用 Web 服务的 HTTP 入口可通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API / WebSocket 认证。

### 内网依赖镜像

构建过程中需要拉取的二进制与依赖（Node dist、Electron、native 工具等）在内网环境应指向内网镜像，而不是公网源。可配置项见仓库根的 `.env.example`：

| 变量 | 用途 |
| --- | --- |
| `INTRANET_MACHINE_HOST` | 内网镜像机器地址 |
| `ZCODE_DEPS_BASE_URL` | 显式覆盖依赖下载根地址（优先级高于上者） |
| `ZCODE_DIST_BASE_URL` | 命令行安装脚本使用的下载根地址 |

未配置 `ZCODE_DEPS_BASE_URL` 且未配置 `INTRANET_MACHINE_HOST` 时，内部依赖下载会直接报错要求先配置，不会静默回落到公网。

## 部署边界

| 边界 | 说明 |
| --- | --- |
| 主仓 | 桌面 / Web / 命令行客户端与 Agent 运行时；构建与启动命令都在根 `package.json` |
| `server/` | 内网服务端与它的管理台，**独立 pnpm workspace**，不在主仓 `pnpm-workspace.yaml` 范围内 |
| 门禁互不覆盖 | 主仓的 `pnpm typecheck` / `lint` / `architecture:check` 不覆盖 `server/`，反之亦然；两边依赖与 lockfile 互不干扰 |

服务端的部署方式（Docker Compose 一体化编排、身份与网关两个进程、数据卷）见[服务端总览与接线](server-overview.md)。

> **提示**：`pnpm build:zcode` 只生成发行包，**不会**替换 `PATH` 中已有的 `zcode`。若命令仍指向旧安装，macOS / Linux 用 `command -v zcode`、Windows 用 `where.exe zcode` 检查。

## 首次启动

1. 启动后进入「首次启动设置」页面；可点「开始使用 Reactor」直接进入，也可先走数据迁移向导（迁移支持情况见[常见问题](qa.md)），或先跳过、稍后在设置里继续。
2. 选择一个项目目录作为工作区。
3. 在对话框输入一句简单指令（例如让 Agent 列出当前目录的文件），确认响应正常。
4. 如果还没有可用模型，进入[接入模型](model-access.md)配置企业服务端地址并登录。

## 网络代理

如果内网访问模型网关需要走代理，在 **设置 → 常规** 里配置三个字段，保存后**需要重启应用才生效**：

| 字段 | 说明 |
| --- | --- |
| HTTP 代理 | 代理地址，例如 `http://127.0.0.1:7890`。留空时模型、MCP、命令工具与渲染层流量直连，**不读取系统环境变量** |
| 不使用代理的地址 | 走直连的主机规则，英文逗号分隔，例如 `localhost,127.0.0.1,::1,.example.com,*.corp.com` |
| 自定义证书 | PEM 根证书的本地文件路径；内网安全网关解密 HTTPS 时用它放行证书链，不是跳过证书校验 |

配置后，模型请求、MCP 服务、Agent 执行的命令工具以及应用界面的网络请求都会走此代理。

## 平台相关设置

| 平台 | 设置 | 行为 |
| --- | --- | --- |
| Windows | **设置 → 常规 → 终端** 的命令行环境 | 可选「自动选择」/ CMD / Git Bash（检测到已安装才出现）；仅对新建会话生效 |
| Windows | **设置 → 常规** 的「关闭窗口时隐藏到托盘」 | 默认开启：点关闭按钮不退出应用，定时任务与闲时任务继续在后台推进；托盘右键提供退出 |
| 通用 | **设置 → 常规** 的 Chrome 硬件加速 | 关闭后可规避部分显卡 / 驱动导致的白屏、闪退；需重启生效 |

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 打包时 `winCodeSign` 解压失败（Windows，报 `Cannot create symbolic link`） | 开启 Windows 开发者模式，或以管理员身份运行终端后重跑 `pnpm bundle:desktop -- --os win --arch x64` |
| 本地构建的 macOS 产物被系统拦截 | 这是未签名构建的预期现象，按系统提示放行后再打开 |
| `pnpm build:zcode` 报缺少下载根地址 | 设置 `ZCODE_DIST_BASE_URL` 或传 `--base-url` |
| 构建时内部依赖下载失败 | 检查 `ZCODE_DEPS_BASE_URL` / `INTRANET_MACHINE_HOST` 是否指向内网可达的镜像 |
| 桌面端能连内网而终端不能（或相反） | 检查代理设置：应用代理留空时不读系统环境变量 |
| Linux / WSL 下的安装、启动与输入法问题 | 见 [Linux / WSL 排查](linux-wsl.md) |

## 与上游 ZCode 的差异

- 上游写法：下载页 + 各平台安装包外链（macOS / Windows / Linux），双击安装包完成安装。→ 本说明书写法：改为「内网部署与分发」，只写本仓真实存在的初始化、启动与构建命令。→ 原因：内网隔离部署，不提供公网下载；本仓也没有可外链的安装包地址。
- 上游写法：按操作系统罗列安装包（`.dmg`、`.exe`、`.AppImage` / `.deb` / `.rpm`）与安装向导步骤。→ 本说明书写法：改为 `pnpm bootstrap` / `pnpm dev:desktop` / `pnpm dev:web` / `pnpm bundle:desktop` / `pnpm build:zcode` 等本仓 `scripts` 中真实存在的命令，并说明产物目录与 `install.sh` 分发方式。→ 原因：上游描述的是发行版用户视角，本页面向从仓库构建与内网分发的人。
- 上游写法：首次启动引导接入公网账号或填 API Key。→ 本说明书写法：改为登录企业服务端（见[接入模型](model-access.md)）。→ 原因：本仓的模型与身份都由内网服务端统一提供。
- 上游写法：故障排查以 macOS 隔离属性、杀软拦截为主。→ 本说明书写法：保留跨平台思路，替换为构建与内网镜像相关的实际故障项。→ 原因：本页的使用场景是仓库构建而非安装包安装。
- 上游写法：用户级数据目录写作 `.zcode`。→ 本说明书写法：用户级数据目录为 `~/.reactor`（由 `ZCODE_DATA_BASE_DIR` / `ZCODE_HOME` 覆盖时同理）；命令行安装脚本的**安装树**目录沿用上游默认值，作为已知例外单独说明。→ 原因：用户级数据目录已收口为 `.reactor`；安装树的改名属独立决策，未随本次收口变更。

> **待核实**：`server/` 服务端的内网正式部署拓扑（主机数量、反向代理与证书由谁提供）未在本页给出，请以管理员实际部署方案为准。
