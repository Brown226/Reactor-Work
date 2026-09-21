# Reactor 去品牌化改造清单

> 目标：将 ZCode 二开为自有产品 **Reactor**，做全面去 ZCode 化。
> 决策基线（已确认）：仅改造可见层 + 产品身份；官方服务先保留；使用全新数据目录 `~/.reactor`；桌面版优先；协议双注册 `zcode+reactor`；CLI 双 bin `reactor+zcode`。

## 零、核心认知：改"单一事实源"，而非全局替换

仓库把产品身份收口在少数几个单一事实源文件中。修改这些文件会自然传导到全仓，**不需要**全局替换 2 万余处 `zcode` 字符串（其中绝大多数是 `window.zcode`、`@zcode/*` 等代码标识符，改动风险极高且无用户可见收益）。

| 关注点 | 单一事实源 | 传导范围 |
| --- | --- | --- |
| 桌面产品身份 | `packages/desktop/scripts/desktop-product-identity.mjs` L8-24 | appId / productName / Linux 包名 |
| 运行时应用名 | `packages/desktop/src/main/desktopRuntimeEnv.ts` L61-63 | Electron `userData` 目录、进程名、ARMS |
| 业务数据根 | `packages/services/src/paths.ts` L43-55 | 全部会话/配置/遥测落盘路径 |
| 服务端点 | `packages/shared/src/zcodeEndpoint.ts` L3-7 | 所有官方域名（已支持环境变量覆盖） |
| UI 文案 | `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` | 界面全部可见文案 |
| CLI 文案 | `apps/zcode-cli/packages/i18n/src/locales/{zh-CN,en-US}.ts` | 命令行/TUI 可见文案 |

## 一、P1 可见品牌层（零兼容风险，首批交付）

> **状态：已完成**（2026-09-21）。文案、图标、logo 均已落地并通过验证；细节与遗留项见 [brand/README.md](brand/README.md) 的「生产资产清单」。
> 已确认标记：**立方体**（风车系列不使用）。因立方体素材内部几何非规则内缩，标记以位图接入，矢量源待补。

### 1.1 界面文案（约 190 处，集中在 4 个文件）

- [ ] `packages/ui/src/i18n/locales/zh-CN.ts`（88 处）
- [ ] `packages/ui/src/i18n/locales/en-US.ts`（91 处）
- [ ] `apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts`（7 处）
- [ ] `apps/zcode-cli/packages/i18n/src/locales/en-US.ts`（7 处）

典型待改 key：`welcome.title`（Welcome to ZCode）、`login.title` / `login.description`、`startup.global.*`（正在启动 ZCode）、`titleBar.menu.help.about`（关于 ZCode）、`logout.confirm.title`、`occupationOnboarding.*`、`conversationShare.*`

**注意**：只改**文案值**，不改 i18n key 名，避免牵连组件引用。

### 1.2 Web 外壳

- [ ] `packages/web/index.html`：L15 `<title>ZCode</title>`、base64 内嵌 favicon、**L161-201 内嵌 SVG logo 副本（易漏改）**
- [ ] `packages/web/src/main.tsx`：L99 `"ZCode - Sign In"`、L124 `"ZCode 会话分享"`、L449 `"ZCode - Web + Server"`
- [ ] `packages/web/src/share/ConversationShareLandingPage.tsx`：L95 `brand`、L126 `"下载 ZCode"`

### 1.3 Logo（需替换为 Reactor 标记）

品牌素材见 [brand/README.md](brand/README.md)：主标记为**八片风车（叶轮）**，配「Reactor + 数智堆脑」字标，色板已提取。

- [ ] `packages/ui/src/components/ui/ZCodeAboutLogo.tsx`：`ZCodeAboutLogo`（图标 + wordmark）与 `ZCodeWordmarkLogo` 的 SVG path 是**硬编码的 Z/C 字母字形**，需换成 Reactor 风车标记与字标的矢量路径。
- 被引用于：`WelcomeScreen.tsx`、`OnboardingWelcomeView.tsx`（L22 `aria-label`）、关于页
- ⚠️ **前置依赖**：现有素材是带底色的 JPEG，需先产出风车标记与字标的**矢量源（SVG）**才能替换 —— 见 brand/README 的「待补齐的生产资产」。

### 1.4 图标资产（纯替换）

- [ ] `packages/desktop/build/`：`icon.icns`、`icon.ico`、`icon.png`、`icons/`（16–1024 全尺寸）、`icon_installer.icns/ico/png`、`icon_windows.png`
- [ ] `packages/desktop/build/dmg_background.png` 与 `@2x`（macOS 安装盘背景，含 ZCode 字样）
- [ ] `public/logo/icons/`（全套 + icns/ico）、`public/icon_512@2x.png`
- [ ] `packages/web/public/favicon.ico`
- [ ] 托盘图标：`packages/desktop/build/icon.ico` → 打包为 `resources/tray_icon.ico`（electron-builder L612-621）

### 1.4.1 品牌色接入（与 P4 视觉一并进行）

brand/README.md 已提取完整色板，核心取值：

- 品牌蓝 `#0061AF`（字标主色）
- 深蓝底 `#032D73` / `#02174B`
- 青（主强调）`#2FE0F9`
- 紫（次强调）`#B384E8`

### 1.5 验证

```bash
pnpm typecheck
pnpm lint
pnpm dev:desktop   # 肉眼确认界面文案与图标
```

## 二、P2 产品身份（与官方版平行共存）

> **状态：已完成**（2026-09-21）。身份单一事实源、运行时应用名、electron-builder 消费方、安装器、Linux 集成、CLI 双 bin 均已落地。
>
> **已定值**：appId `com.cnpe.reactor`（Preview 为 `com.cnpe.reactor.preview`）、productName `Reactor` / `Reactor Preview`、Linux 包名与可执行名 `reactor` / `reactor-preview`、开发态 AUMID `com.cnpe.reactor.dev`。
>
> **⚠️ 待替换的占位值**（对外发布前必须替换，已在代码中留 TODO）：
> - `electron-builder.config.js` 的 `homepage` → 现为 `https://example.com`
> - `author.email` / `maintainer` → 现为 `dev@example.com`
> - `author.name` / `maintainer` → 现为 `China Nuclear Power Engineering Co., Ltd.`（据 appId 推断，待确认）
> - `about.ts` 的版权主体 → 现为占位 `Reactor`
>
> **仍沿用旧名的部分**（有意保留，见下方各条）：CLI 产物文件名 `zcode.cjs`、CLI 发行包目录 `dist/zcode/` 与 tarball 名、`ZCODE_*` 环境变量、`@zcode/*` 包名。
>
> **打包验证状态**：代码验证全部通过（typecheck 0 错、lint 0 error、架构检查 0 违规），身份解析经脚本确认。实际打包在 Windows 上**被环境阻塞**：electron-builder 解压 `winCodeSign` 工具集时因 Windows 符号链接权限不足失败（7z 报 `Cannot create symbolic link`），该步骤同时负责写入 exe 的版本信息与图标、以及后续签名，因此 `signApp` 未能完成，NSIS 安装包未产出。
> **解除方法**：开启 Windows 开发者模式（设置 → 系统 → 开发者选项）或以管理员身份运行终端，然后重跑 `pnpm bundle:desktop -- --os win --arch x64`。注意此时 exe 的「属性 → 详细信息」（ProductName / 版权）与图标才会被写入；工具链就绪前，产物仍是 Electron 的默认元数据。



### 2.1 单一事实源

- [ ] `packages/desktop/scripts/desktop-product-identity.mjs` L8-24
  - `appId: "dev.zcode.app"` → 你的 appId
  - `productName: "ZCode"` → `"Reactor"`
  - `linuxExecutableName` / `linuxPackageName`：`zcode` → `reactor`
  - L17-24 Preview 身份同步；L87 开发态 AUMID `cn.aminer.zcode` → 自有

### 2.2 Electron 运行时身份

- [ ] `packages/desktop/src/main/desktopRuntimeEnv.ts` L61-63：`runtimeApplicationName`（`ZCode Dev`/`ZCode Preview`/`ZCode` → Reactor 系列）
  - 该值经 `index.ts` L261 `app.setName()`、L274 `process.title` 生效，并决定 L75 的 `userData` 目录

### 2.3 electron-builder 消费方（消费身份，非定义方）

- [ ] L459 `homepage: "https://zcode.z.ai"` → 自有站点
- [ ] L460 `author: { ... "ZCode <dev@zcode.z.ai>" }`（deb/fpm 校验）
- [ ] L649-656 **协议双注册**：`schemes: ["zcode", "reactor"]`
- [ ] L167 `WINDOWS_INSTALL_MANIFEST_NAME = ".zcode-install-manifest"` → `.reactor-install-manifest`
- [ ] L703 `maintainer: "ZCode <dev@zcode.z.ai>"`（Linux）

### 2.4 安装器与 Linux 集成

- [ ] `packages/desktop/build/installer.nsh` L4-27：安装器日志名 `ZCode-installer.log` / `ZCode-uninstaller.log`、清单名
- [ ] `packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts` L11-13：`zcode.desktop` 文件名、`x-scheme-handler/zcode`（需同时注册 reactor）
- [ ] `packages/desktop/src/main/desktopLinuxAppImageIcon.ts`：hicolor 图标名

### 2.5 CLI 身份（双 bin，零回归）

- [ ] `apps/zcode-cli/packages/cli/package.json` L6-8：`bin` 增加 `reactor`，保留 `zcode`（指向同一 `./dist/zcode.cjs`）
- [ ] `packages/zcode-server-cli/package.json` L4-6：同上双 bin
- [ ] `apps/zcode-cli/packages/cli/src/process-name.ts`：`CLI_COMMAND_NAME`（新增 reactor 展示名）

**关键约束**：桌面端 spawn 的是**固定路径** `resources/glm/zcode.cjs`（electron-builder L624-628，由 `prepare:agent-bundle` 生成）。因此**产物文件名 `zcode.cjs` 不动**，只增加命令别名，避免改动桌面启动链路。

### 2.6 验证

```bash
pnpm bundle:desktop
# 检查：安装包名 / 应用名 / 图标 / zcode:// 与 reactor:// 是否都注册
```

## 三、P3 数据路径与运行时

### 3.1 业务数据根（改一行，全仓生效）

- [ ] `packages/services/src/paths.ts` L44：`getZCodeDataRootDir()` 返回 `{dataBaseDir}/.zcode` → `.reactor`
  - 连带生效：`getAppConfigDir()`（L54，`.reactor/v2`）、会话 L203-224、`tasks-index.sqlite` L187、feedback/export-log L161-179

### 3.2 其他硬编码 `.zcode` 路径

- [ ] `packages/services/src/node.ts` L1800 `ZCODE_HOME || ~/.zcode`；L1072 `~/.zcode/cli/config.json`（CLI/MCP/插件配置）
- [ ] `packages/services/src/device/deviceMid.ts` L25：`~/.zcode/v2/telemetry-state.json`
- [ ] `packages/services/src/telemetry/telemetryCore.ts` L130：同上

### 3.3 环境变量策略（建议）

全仓 `ZCODE_*` 去重约 352 个，无集中定义点，且渗入部署脚本与用户 shell。

- [ ] 新增 `REACTOR_*` 为主名，**保留 `ZCODE_*` 读取别名**（读取时先查新名再回退旧名）
- [ ] 集中在 `packages/shared/src/env.ts`、`packages/services/src/paths.ts`、`packages/desktop/src/main/desktopRuntimeEnv.ts` 三处加兼容层

**注意**：Electron `userData`（`appData/ZCode`，由 `runtimeApplicationName` 决定）与业务数据（`~/.zcode`，由 `paths.ts` 决定）是**两套独立路径**，归属不同文件，都要改。

### 3.4 验证

```bash
pnpm dev:desktop
# 确认数据落在 ~/.reactor 下，应用可正常启动新建会话
```

## 四、P4 界面视觉（"界面也要改"的实质）

文案之外，产品观感来源于 CSS 变量主题。

- [ ] `packages/ui/src/useTheme.ts` L3：`Theme` 联合类型的 `zai-light`/`zai-dark` 是**默认主题**（L86 默认 `zai-dark`）
- [ ] `packages/ui/src/styles.css` L461 / L606：`.theme-zai-light` / `.theme-zai-dark` 的完整变量集（`--color-brand`、`--color-icon-blue`、`--color-accent` 等）→ 换成 Reactor 品牌色
- [ ] `packages/web/index.html` L19-20：localStorage key `zcode-theme` + 默认主题

**强制约束（`DESIGN.md`）**：UI 字号只能使用 `text-ui-xl/lg/base/caption/sm/xs`；禁止 `text-sm`/`text-xs`/`text-[13px]` 或内联 `font-size`；禁止通过改 `html.fontSize` 实现字号缩放（只能改 `--ui-font-size`）。违反视为设计系统缺陷。

## 五、P5 服务解耦（后续，多数无需改码）

`packages/shared/src/zcodeEndpoint.ts` 已支持环境变量整体改指向，届时优先配 `.env` 而非改码：

| 耦合点 | 位置 | 切换方式 |
| --- | --- | --- |
| 官方端点 | `zcodeEndpoint.ts` L3-7 | `ZCODE_BASE_URL` / `ZCODE_ENDPOINT_ORIGIN` |
| OAuth | `services/src/oauth/providers/{zai,bigmodel}ProviderConfig.ts` | `ZAI_OAUTH_ORIGIN` / `ZAI_BUSINESS_BASE_URL` / `ZAI_OAUTH_CLIENT_ID` |
| 内置模型 | `config/provider/zcode-builtin.json` | `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` |
| 插件市场 CDN | `packages/shared/src/plugin-marketplaces.ts` L37（`cdn-zcode.z.ai`） | 需自建 |
| 更新源 | electron-builder L756 `publish` | 需自建 |
| 遥测 | ARMS RUM + OTLP | 运行时环境提供 |
| 反馈/社群 | `config/default.json` | 直接改配置 |

## 六、必须避开的坑

1. **OAuth 回调绑定 `zcode://`**：`zaiProviderConfig.ts` L27 与 `bigmodelProviderConfig.ts` L22 的 `redirectUri: "zcode://oauth/callback"` 已在 Z.ai 服务端注册。改 scheme 会断登录 → 采用**双注册**，OAuth 继续走 `zcode://`。
2. **改 bin 名牵连桌面端**：桌面 spawn 固定路径 `resources/glm/zcode.cjs` → 采用**双 bin**，产物名不变。
3. **appId/productName 改动导致与 ZCode 互不升级**：electron-updater 视其为两个产品。与"全新目录不迁数据"的决策一致，接受平行共存。
4. **不要全局替换 `zcode`**：`window.zcode`、`@zcode/*`、`ZCodeStore` 等是代码标识符，改动会破坏 API 与构建。可在产品稳定后按包逐个重构。

## 七、合规（Apache-2.0）

- [ ] 保留 `LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`
- [ ] 保留原版权声明；不得声明原创
- [ ] 商标（ZCode 名称/Logo）不在 Apache 授权范围，去品牌化本身即合规必要动作
