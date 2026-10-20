# 托盘跨平台 — spec v1

## 背景

来源：Namiwork 桌面壳层的托盘能力。Reactor 现状：`desktopTray.ts` 的
`createWindowsDesktopTray` 在非 win32 平台**直接 return null**，macOS/Linux 完全没有托盘。

## 产品规则

1. 托盘在 win32 / darwin / linux 三平台都创建（原先仅 win32）。
2. 图标按平台解析，沿用既有资源布局，不新增二进制资产：
   - **win32**：`tray_icon.ico`（打包态在 `resources/`，开发态 `build/icon.ico`），**保持现状不变**；
   - **darwin / linux**：复用 `build/icons/32x32.png`（打包态在 `resources/icons/32x32.png`）。
3. macOS 用 `nativeImage.setTemplateImage(true)`，让图标跟随菜单栏明暗自动反色
   （这是 macOS 托盘图标的规范做法；模板图由系统着色，颜色无关）。
4. 菜单项、点击/双击行为、悬停提示与现有 Windows 实现**完全一致**——
   本项只放宽平台门槛与图标解析，不改菜单语义。
5. 平台不支持、图标加载失败、Tray 构造失败时返回 null 并 warn，不影响应用启动。

## 状态所有者

- 托盘单例 `desktopTray` 与重建回调 `rebuildDesktopTrayContextMenu` 仍是模块级，
  语义不变；新增的只有"图标解析"这一纯函数，按平台返回路径/模板图标记。

## 验收场景

- [ ] Windows：行为与改动前完全一致（图标仍是 `tray_icon.ico`）。
- [ ] macOS：菜单栏出现托盘图标，点击/双击唤起窗口，菜单项可用，图标为模板图。
- [ ] Linux：出现托盘图标，提示与菜单可用（取决于桌面环境是否支持 tray）。
- [ ] 三平台图标解析路径在打包态指向 `resources/`，开发态指向 `build/`。

## 验证口径

行为改动（main）→ 全量 `pnpm typecheck` + `pnpm lint` + 单独
`tsc -b packages/desktop/tsconfig.main.json`。
**mac/Linux 本机无法运行验证**（当前环境为 Windows），如实注明：win32 路径保持
逐字节等价；darwin/linux 仅做静态正确性检查。
