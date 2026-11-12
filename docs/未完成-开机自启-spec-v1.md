# 开机自启 — spec v1

## 背景

来源：Namiwork 3.25.0 解包源码的桌面壳层（开机自启）。Reactor 当前全仓无
`setLoginItemSettings` / 开机自启入口，而内网常驻场景下"开机自启"是刚需。

## 产品规则

1. 用户可在「设置 → 通用」里开关"开机自启"，默认**关闭**。
2. 开关状态是**用户偏好**，持久化到 setting.json 的 `launchAtLogin` 字段；
   每次启动时由 main 读取并**重新应用**到操作系统（`app.setLoginItemSettings`），
   避免用户在系统设置里手动改过之后偏好与真实状态不一致。
3. 只在桌面端有意义；Web/手机端不展示该开关。
4. 开发态（`process.defaultApp === true`，即 `electron .` 起的 dev）注册登录项会指向
   electron 可执行文件而非产品，因此**开发态跳过实际注册**，只保留偏好读写。
   打包态才真正调用 `app.setLoginItemSettings`。

## 状态所有者

- 偏好真值：setting.json（`AppSettings.launchAtLogin`），与其它桌面设置同源。
- 运行时副本：main 进程模块级 `launchAtLogin`，由 bootstrap 与
  `SyncAppSettings` 即时通道写入，是"上一次已应用值"用于幂等判断。
- 应用点唯一：main 的 `applyLaunchAtLogin`，读取模块级变量并调用系统 API。

## 接口

- `AppSettings.launchAtLogin?: boolean`（protocol.ts）+
  `launchAtLogin: z.boolean().default(false)`（objectSchema）+
  `launchAtLogin: z.boolean().optional()`（patchSchema）
- 复用现有 `PlatformChannels.SyncAppSettings` 即时通道，**不新增 IPC 通道**。
- UI 通过 `services.settingService.update({ launchAtLogin })` 落盘 +
  `platform.syncAppSettings({ launchAtLogin })` 即时通知 main。

## 验收场景

- [ ] 打开开关 → 落盘 + main 立即调用 `setLoginItemSettings({ openAtLogin: true })`。
- [ ] 关闭开关 → 同上但 `openAtLogin: false`。
- [ ] 重启后 main 按 setting.json 值重新应用（打包态）。
- [ ] 开发态不真正注册登录项，仅偏好读写。

## 验证口径

行为改动 → 全量 `pnpm typecheck` + `pnpm lint`；打包态行为本机无法验证，如实注明。
