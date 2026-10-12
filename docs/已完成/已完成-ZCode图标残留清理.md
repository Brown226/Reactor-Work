# ZCode 图标残留清理

日期：2026-10-12

## 背景

桌面端界面中仍可见 ZCode 旧图标。需要全仓检索残留的 ZCode 图标资产，统一替换为 Reactor 品牌立方体标记。

标记归属依据 [`docs/brand/未完成-README.md`](../brand/未完成-README.md)「标记选定（已确认）」：**立方体标记为 Reactor 的唯一产品标记**，风车系列素材不使用。

## 盘点方法

两层检索，缺一不可：

1. **按文件名与引用检索**：`*zcode*`、`*icon*`、`*logo*`、`*.ico`、`*.icns`，以及源码与构建配置中的 `build/icon`、`logo/icons`、`favicon` 等引用点。
2. **逐个人工读图确认**：文件名与内容不总是可靠——`zcode-guide.png` 名字带 zcode 但图已是立方体；`model-provider-zai-app.png` 名字像 Z.AI 图标但内容是从 ZCode 应用图标逐字节复制的。同源性用 md5 交叉校验（如 `dmg_background` 与其它图标无关联、两套 `icons/` 目录逐字节相同）。

## 盘点结果

### 已是立方体，无需改动（13 处）

`packages/desktop/build/icon.png`、`icon.ico`（7 帧全部确认）、`icon.icns`、`icon_installer.png/.ico/.icns`、`build/icons/` 全套 9 个尺寸、`packages/web/public/favicon.ico`、`public/logo/icons/*`、`public/icon_512@2x.png`、`packages/ui/src/assets/reactor-mark.png`、`packages/ui/src/assets/plugin-icons/zcode-guide.png`、`packages/desktop/src/main/aboutWindow.ts` 内嵌 base64、`server/packages/admin/public/brand/logo-cube.jpg`。

P1 品牌改造时这批已整体替换，与品牌 README「当前实现状态」记录一致。

### 确认是 ZCode 旧标，已替换（3 个文件）

| 文件 | 原内容 | 用途 |
| --- | --- | --- |
| `packages/ui/src/assets/provider-icons/model-provider-zai-app.png` | 黑底白色 **Z** 字（ZCode 应用图标副本） | Z.AI 账号位 provider 图标，`ProviderLogo.tsx` 以 `zai` key 引用，覆盖 4 个 providerId |
| `packages/desktop/build/dmg_background.png` | 大号 **ZCODE** 字样 | macOS DMG 安装盘背景 |
| `packages/desktop/build/dmg_background@2x.png` | 同上 @2x | 同上 |

### 不是 ZCode，明确不动

`packages/ui/src/assets/cli-icons/icon-glm*.png`（智谱 GLM 官方标志）、`payment-icons/`、`document-skill-icons/`、`feature-prompt-icons/`；`build/installer.nsh` 的 `ZCODE_*` 宏名（输出文件名已是 `Reactor-installer.log`）；`electron-builder.config.js` 中的包名 `@zcode/*` 与 `zcode://` 协议名——按 `portal/manual/about.html` 的品牌口径，协议名、包名、命令名保留原名。

## 改动

### 1. provider 图标

素材来源 `packages/ui/src/assets/reactor-mark.png`（256×256 RGBA，内容 bbox 仅占约 80%，四周有透明留白）。直接缩放到 128×128 会让立方体视觉重量明显小于原黑底满幅方块，因此先裁到内容 bbox，长边适配 116px，居中放到 128×128 透明画布。

同时把原「不透明黑底 Dock 方块」改为**透明底**——原稿在深色界面下是一块实心黑，透明底让浅色与深色主题都干净。这是相对原素材的一处刻意偏差，已记录在台账中。

台账 `packages/ui/src/assets/provider-icons/model-provider-logo-sources.json` 的 Z.AI 条目同步更新 `sourceUrl` / `sourceOwner` / `normalization`。该 JSON 无任何代码消费方，是纯人工台账。

`ProviderLogo.tsx` 的注释原文写「用户指定 Dock 应用图标」，与替换后的事实矛盾，已改为说明当前展示 Reactor 品牌立方体、并注明替换日期。

### 2. DMG 安装盘背景

背景不是纯白，而是约 `#F4F5F7` 的浅灰白且带微弱渐变（四角偏暗、中心偏亮），直接用白色填充会留下可见方块。因此**用原图自身的背景行作填充源**：取文字带正上方的一行像素，在文字带矩形内逐行复制，渐变完全连续，无痕迹。

具体参数（1x / @2x 严格 2:1）：

| 项 | 1x | @2x |
| --- | --- | --- |
| 原文字带 | y 78–118，x 174–360 | y 155–238，x 347–722 |
| 填充矩形 | x 150–390，y 70–126 | x 300–780，y 140–252 |
| 填充源行 | y 69 | y 138 |
| 立方体边长 | 104 | 208 |
| 立方体中心 | (267, 98) | (534, 196) |

只替换文字带；箭头带（1x y 189–217）与四周浅灰线稿装饰原样保留。DMG 布局坐标在 `electron-builder.config.js` 中未显式配置，走默认布局，因此背景图改动不影响图标摆放位置。

## 验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向 lint | `pnpm exec oxlint packages/ui/src/settings/model-provider-section/ProviderLogo.tsx` | 0 errors / 0 warnings |
| 增量类型检查 | `pnpm exec tsc -b packages/ui` | exit 0 |
| 架构检查 | `pnpm architecture:check --changed` | violations 0 |
| 台账 JSON 合法性 | `python -m json.tool` | 合法，13 条 |

像素级验证（确认只替换了文字带、箭头未受影响）：替换后 1x 深色带为 y 47–148（3227 像素，立方体）与 y 189–217（734 像素，箭头）；@2x 为 y 92–299 与 y 378–436（3688 像素）。箭头带像素数与替换前**完全一致**。

未做运行时验证：DMG 背景只在 macOS 打包产物中呈现，本机为 Windows，无法构建 DMG；provider 图标需登录企业服务端后进入模型设置才能看到填充内容。两者均为确定性位图替换，无逻辑分支。

## 遗留

- 立方体标记仍无矢量源（SVG），放到 256px 以上或做动画时受限——见品牌 README「仍待补齐」。
- 托盘图标 16px 下偏细节，可另出一版简化图标。
