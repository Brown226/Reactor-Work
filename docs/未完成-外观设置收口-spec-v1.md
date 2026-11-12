# 外观设置收口 spec v1

## 背景

两处来自实际使用的问题：

1. **「主题色」区冗余**：壁纸调色板上线后，选中风景壁纸时强调色已自动跟随壁纸主色；此时「主题色」的 5 个档位中只有「默认」有意义，其余档位会主动覆盖壁纸配色。用户判断"这项没什么用"。
2. **壁纸列表无法向右滑动**：`overflow-x-auto` + `!scrollbar-hide` 导致桌面鼠标用户完全滚不动（实测垂直滚轮、横向滚轮、鼠标拖拽均无效，仅触屏可用）。

## 一、删除「主题色」区

### 判定依据（实测）

| 检查 | 结果 |
| --- | --- |
| 引用点 | 仅 `BackgroundThemeSection.tsx:317` 一处渲染 |
| 独立组件 | `AccentColorSection.tsx` 仅被上述一处引用 |
| 状态切片 | `accentColor` / `setAccentColor` 仍在 store 与广播字段里 |
| 优先级逻辑 | `backgroundTheme.ts` 的 `applyWallpaperPalette` 依赖 `accentPresetId !== "default"` 判断让位 |

### 决定：删除 UI 区，**保留状态与优先级逻辑**

理由：
- 删 UI 不影响已持久化的 `zcode-accent-color`；用户此前若选过非默认档，行为保持不变（壁纸让位）。
- 保留 `applyWallpaperPalette` 的 `accentPresetId` 判断，避免删除引发连锁改动。
- 若只删组件就顺带删状态，会让 `backgroundThemeState.ts` 的 `refreshWallpaperPalette` 失去语义，属于扩大改动范围。

### 具体改动

1. 删除 `BackgroundThemeSection.tsx` 里 `<AccentColorSection />` 的渲染与 import；
2. 删除 `AccentColorSection.tsx` 文件（已成为无引用文件）；
3. 删除 i18n 中 `settings.appearance.accentTitle` / `accentDescription` 与 `settings.accent.*` 文案（若确认无其它引用）；
4. **不删** `accentColor.ts` / `accentColorState.ts` / store 切片 / 广播字段。

## 二、修复壁纸列表横向滚动

### 根因

`overflow-x: auto` 只响应横向滚动事件。桌面鼠标只有垂直滚轮，Chromium 不会把 `deltaY` 映射为横向滚动。同时 `!scrollbar-hide` 把滚动条也藏了，用户既滚不动也看不见可滚。

### 方案：垂直滚轮映射为横向滚动 + 恢复可见的滚动条

1. **滚轮映射**：在滚动容器上加 `onWheel`，当 `|deltaY| > |deltaX|` 时把 `deltaY` 转成 `scrollLeft` 增量，并 `preventDefault()` 阻止页面纵向滚动干扰。
2. **滚动条可见**：去掉 `!scrollbar-hide`，改用细滚动条样式，让用户看到"这里还能往右"。
3. **触屏不受影响**：原生 `overflow-x-auto` 的触屏滑动保留。

### 边界

- 仅在容器确实可横向滚动（`scrollWidth > clientWidth`）时拦截滚轮，否则不抢页面滚动。
- 到达左右端点时不 `preventDefault`，让事件继续冒泡（避免"卡住"感）。

## 验收场景

1. 外观页不再出现「主题色」区，背景主题区下方直接是"显示效果"。
2. 壁纸列表：鼠标滚轮上下滚动 → 列表左右滚动。
3. 壁纸列表：右侧有可见的细滚动条，提示还可向右。
4. 滚到最左/最右后继续滚 → 页面正常纵向滚动，不被卡住。
5. 触屏设备仍可左右滑动。
6. 选中风景壁纸 → 强调色仍跟随壁纸（调色板逻辑未受影响）。

## 已知遗留

- 「主题色」状态与广播字段保留但无 UI 入口。若后续确认彻底不需要，再单独清理（会涉及 store 类型、广播、持久化键三处）。
- `highland-mist` 与 `lakeside-lodge` 文件名与内容仍错位（既有遗留）。

## 追加改动（2026-10-20）：预置顺序调换

**需求**：风景壁纸（后 6 个）与前 5 个渐变预置调换位置，风景排在前面。

**实现**：只调整 `BACKGROUND_PRESETS`（`packages/ui/src/lib/backgroundTheme.ts:120`）的数组顺序。
`presetId` 字符串本身不变，因此已持久化的用户设置、调色板查表、资源映射全部不受影响。

**顺带发现的既有渲染细节**：
设置页卡片实际顺序是 `不使用背景` → 风景 6 张 → 渐变 5 张 → `自定义图片`。
`none` 与 `custom-image` 是设置页额外插入的固定项，不在 `BACKGROUND_PRESETS` 内。

**验收**：实测 13 张卡片的 `data-testid` 顺序为
`none / highland-mist / lakeside-lodge / dusk-grass / pink-willow / moon-terraces / bird-perch / mist / sky / dusk / dune / basalt / custom-image`。
