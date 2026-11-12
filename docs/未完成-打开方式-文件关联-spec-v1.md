# 协议注册 + 打开方式（文件关联）— spec v1

## 背景与现状核验（重要）

来源：Namiwork 的"系统分享 / 打开方式 / 协议深链"。**核验后必须区分**：

- **`zcode://` 自定义协议注册：Reactor 已实现，不重复造。**
  证据：`desktopOAuthDeepLink.ts:409/426`（`app.setAsDefaultProtocolClient`）+
  `desktopLinuxDeepLinkRegistration.ts`（Linux .desktop 注册）+
  `electron-builder.config.js`（打包态双 scheme）+ `desktopDeepLinkUrl.ts`
  （`oauth/callback`、`payment/callback`、`workspace/open`、`share/import` 分支）。
- **"用 NewMax/Reactor 打开文件"（OS 文件类型关联 / `fileAssociations`）：缺口。**
  全仓无 `fileAssociations` 命中；现有 deep link 只处理 **workspace 目录**，不处理**文件**。

本项只补"文件关联 + 用应用打开文件"。

## 产品规则

1. 打包态在 `electron-builder.config.js` 声明 `fileAssociations`：把常用**文本/标记文档**
   关联到本应用（`txt` / `md` / `markdown` / `json` / `log`），macOS 用 `ext`，
   Windows/Linux 用 `ext` 列表。**不关联可执行/二进制类型**，避免误双击。
2. 应用收到"用本应用打开某文件"时（Windows/Linux 走 `second-instance` argv，
   macOS 走 `open-file`），把该文件**所在的目录**作为 workspace 打开
   ——复用既有 `--open-workspace` 语义与 `handleOpenWorkspacePath`，不新增 IPC、
   不新增打开路径。
   - 依据：Reactor 的 workspace 是目录级概念，文件级"在应用内打开"没有对应语义；
     把文件所在目录打开后，用户可在既有文件树/预览里看到该文件。这是**最小且语义安全**的映射。
3. 只接受**存在的常规文件**路径；目录、不存在的路径、含 `\0` 的路径一律忽略（不解析、不打开）。
4. 强制升级期间沿用既有门槛：`forceUpdateBlocked` 时忽略请求（与 workspace deep link 一致）。

## 状态所有者

- argv → 文件路径的解析是纯函数，落在 `desktopDeepLinkUrl.ts`（与既有 argv 解析同处）。
- 打开动作仍由 `handleOpenWorkspacePath` 唯一承担，不新增写入路径。

## 验收场景

- [ ] 双击关联的 `.md` 文件（应用未启动）→ 应用启动并打开该文件所在目录。
- [ ] 应用已启动时双击 `.txt` → 主窗口前置并打开该文件所在目录。
- [ ] 传入不存在的路径 / 目录路径 → 忽略，不报错、不打开。
- [ ] macOS `open-file` 事件同样映射到所在目录。

## 验证口径

行为改动（main + 打包配置）→ 全量 `pnpm typecheck` + `pnpm lint` + 单独
`tsc -b packages/desktop/tsconfig.main.json`。文件关联的 OS 级行为需打包 + 真实双击验证，
本项以编译 + lint + 配置正确性为准，如实注明未做运行期验证。
