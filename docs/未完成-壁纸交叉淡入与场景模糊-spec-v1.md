# 壁纸交叉淡入 + 场景化模糊 — spec v1

（合并原计划第 4、5 项：两者同源，都改 `backgroundTheme` 一层。）

## 背景

来源：NewMax 1.1.20 的壁纸机制。Reactor 已有背景主题（`lib/backgroundTheme.ts` +
`store/backgroundThemeState.ts` + `styles.css` 的 `[data-app-background]` 规则），
但存在两个体验缺口：

1. **切换瞬间跳变**：`background-image` 是 CSS 变量，变量一变立即替换；而
   `background-image` 不可插值，浏览器只能硬切，深浅预置之间切换会有明显跳变。
2. **模糊是全局常量**：`blurPx` 一个值作用于所有场景，阅读/专注时无法自动加强模糊。

对齐 `DESIGN.md` 的 Motion 规范：过渡要"fast and low-drama"，用 subtle fade。

## 产品规则（A. 交叉淡入）

1. 背景图/预置变化时，旧图作为一层叠加在上一层之上，240ms 内 `opacity 1 → 0`
   淡出，露出下面的新图，形成交叉淡入。
2. **只在"已有旧背景且新旧不同"时淡入**：首次应用（旧值为空/`none`）不淡入，
   避免启动时出现一次无意义的闪光。
3. 过渡用一次性清理定时器；连续切换时先取消上一次清理再重播，不叠加。
4. 不改变 `resolveBackgroundImageValue` / `buildBackgroundThemeCssVariables` 的
   取值语义，只在 `applyBackgroundTheme` 这一"写文档根"的边界上增加过渡。

## 产品规则（B. 场景化模糊）

1. `blurPx` 仍是用户设定的基准模糊半径，保持现有语义与取值区间。
2. 新增"阅读/专注场景"叠加：当工作区进入阅读模式（`data-reading-mode` 出现）时，
   背景层在基准模糊之上再叠加一档场景模糊（`--app-background-scene-blur`）。
3. 场景切换同样走短过渡；退出场景回到基准模糊。
4. 场景模糊是**叠加增强**而非替换：基准 `blurPx = 0` 时，进入场景仍会模糊
   （用户显式关掉了常态模糊，但阅读时仍需要可读性）。

## 状态所有者

- 交叉淡入状态：`documentElement` 上的 `data-app-background-fading` 属性 +
  `--app-background-prev-image` 变量，生命周期由 `applyBackgroundTheme` 内的
  一次性定时器管理；无全局 store 字段。
- 场景模糊：由既有的阅读模式属性驱动（CSS 选择器），不新增 JS 状态。

## 验收场景

- [ ] 切换预置背景 → 旧图 240ms 淡出，看到交叉淡入而非硬切。
- [ ] 首次开启背景（从 none 到某预置）→ 直接出现，不淡入。
- [ ] 连续快速切换 → 不叠加多层，始终只淡入到最终值。
- [ ] 进入阅读模式 → 背景额外模糊一档；退出恢复基准模糊。

## 验证口径

交互/样式改动 → 全量 `pnpm typecheck` + `pnpm lint`；视觉过渡本机无法自动化验证，
以代码正确性 + 人工目视为准，如实注明。
