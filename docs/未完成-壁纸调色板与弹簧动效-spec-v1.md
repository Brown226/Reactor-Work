# 壁纸调色板与弹簧动效 spec v1

## 背景与目标

对比 NewMax 1.1.20 的主题系统（`globals-DxxR0sYp.js` + `percentages-*.js`）后发现：Reactor 的背景壁纸只是"贴上去的一张图"，界面配色不跟随，因此观感"不自然"。

NewMax 的做法是**每张壁纸带一份从图中提取的调色板**（`background` / `foreground` / `accent` / `accents.{neutral,soft,rich}` / `luminance` / `defaultVariant`），选中壁纸时整套 UI 色阶由它派生（OKLCH 空间递推 + 对比度迭代校验）。

本次只做其中收益最大、风险最低的两步：

1. **壁纸调色板**：给 6 张风景壁纸各配一份 accent 色，选中时接管强调色与主内容区底色；
2. **弹簧动效**：主题选择与壁纸卡片加轻微回弹，提升手感。

**明确不做**：不移植 NewMax 的 400 行 `generateRandomTheme` 色阶生成引擎、不做 4 档变体（mono/neutral/soft/rich）、不做随机主题、不做视频壁纸。这些是后续可选项，见"后续可选"。

## 关键约束

1. **不碰 `--color-brand`**（`DESIGN.md` 品牌色约束）。路线 C：壁纸只接管 `--color-accent` 与主内容区的中性表面。
2. **用户显式选择的 accent 优先级高于壁纸配色**。用户既然在某处明确选了强调色，壁纸不应悄悄覆盖它。
3. **不新增状态所有者**。调色板是壁纸预置的静态属性，不是用户状态；不新增 store 切片、不新增持久化键。
4. **默认零变化**：未启用壁纸（`presetId === "none"` 且无自定义图片）时，不写任何变量。
5. **渐变族不参与**：`mist/sky/dusk/dune/basalt` 是合成的抽象渐变，没有"从图中提取"的语义，不配调色板。

## 设计

### 一、壁纸调色板

每张风景壁纸在 `backgroundTheme.ts` 里带一份调色板：

```ts
interface WallpaperPalette {
  /** 浅色主题下的强调色。 */
  accentLight: string;
  /** 深色主题下的强调色。 */
  accentDark: string;
  /** 主内容区底色的着色倾向（半透明叠加用）。 */
  surfaceTintLight: string;
  surfaceTintDark: string;
}
```

取值依据：从图片逐像素采样（`jpeg-js`）得到主导色，再按"适合做弱强调面的明度与彩度"调整，避免直接用图片主色导致过暗或过艳。

实测主导色与推导值：

| 预置 | 实测主导色 | 亮度 | accentLight | accentDark |
| --- | --- | --- | --- | --- |
| highland-mist（实为湖心小屋） | `#d1d1ce` 云灰 17% | 0.365 | `#7b95a9` | `#a8c0d4` |
| lakeside-lodge（实为云雾雪岭） | `#2e2d17` 墨绿褐 16% | 0.071 | `#6b7a52` | `#9aad7a` |
| dusk-grass | `#cfb4b2` 暖粉 15% | 0.369 | `#b5765c` | `#d99a7d` |
| pink-willow | `#8bcce4` 天蓝 48% | 0.595 | `#5b9fc4` | `#8bcce4` |
| moon-terraces | `#9ab9c6` 灰蓝 46% | 0.395 | `#5f8fa8` | `#9ab9c6` |
| bird-perch | `#e2e2e0` 米白 62% | 0.658 | `#8a8a86` | `#bebbb6` |

### 二、优先级与写入方式

`applyWallpaperPalette()` 在 `applyBackgroundTheme()` 之后由同一个调用点触发，只写变量、不写属性：

```
优先级（CSS 变量覆盖顺序，后者胜）：
  1. 主题块的 --color-accent            （基础值）
  2. 壁纸调色板 --accent-color-light/dark  （启用壁纸时写入）
  3. 用户显式 accent（非 default）        （accentColor.ts 写入，优先级最高）
```

实现方式：壁纸写入 `--accent-color-light` / `--accent-color-dark` 与 `data-app-wallpaper-palette` 属性；`accentColor.ts` 在非 default 档时覆盖同一对变量并加 `data-app-accent`。

CSS 里用属性存在性同时要求，保证互斥：

```css
/* 壁纸调色板：仅在启用且用户没显式选 accent 时生效 */
:root[data-app-wallpaper-palette]:not([data-app-accent]) {
  --color-accent: var(--accent-color-light);
}
.dark[data-app-wallpaper-palette]:not([data-app-accent]) {
  --color-accent: var(--accent-color-dark);
}
```

`applyWallpaperPalette` 需要知道当前 accent 是否非 default，因此接收一个 `accentPresetId` 参数，为 `default` 时才写属性。

### 三、弹簧动效

不引第三方库（NewMax 用 framer-motion 的 `useSpring`，Reactor 加这个依赖不值得）。用 CSS `cubic-bezier` 近似弹簧手感：

```css
--ease-spring-gentle: cubic-bezier(0.34, 1.56, 0.64, 1);
```

应用位置：

| 元素 | 动效 |
| --- | --- |
| 主题色选中圆点 | `transform: scale()` 回弹 180ms |
| 壁纸卡片 hover | `scale(1.02)` + 阴影加深 200ms |
| 壁纸卡片选中勾选圆点 | `scale(0 → 1)` 回弹 220ms |

一律尊重 `prefers-reduced-motion`。

## 验收场景

1. 选任意风景壁纸 → 主内容区强调色变成该图的配色；侧栏、设置页、弹窗不变。
2. 选「含品牌色」的元素（按钮、logo）→ 仍是 Reactor 品牌蓝，未被壁纸影响。
3. 用户显式选「青绿」accent 后再选壁纸 → 强调色保持青绿，壁纸不覆盖。
4. accent 回到「跟随主题」→ 壁纸配色重新生效。
5. 选渐变族（mist/sky/...）或无背景 → 强调色回到主题块默认值，无任何变量残留。
6. 悬停/选中主题色圆点与壁纸卡片 → 有轻微回弹，不刺眼。
7. 系统开启「减弱动效」→ 所有回弹与过渡退化为无动画。

## 后续可选（本次不做）

- 4 档变体（mono / neutral / soft / rich）：需要完整色阶引擎支撑，依赖 OKLCH 递推。
- 随机主题：依赖色阶引擎。
- 情绪（mood）参数化。
- 视频壁纸（功耗评估未做）。

## 实际落地（2026-10-20）

### 优先级实现的关键细节

初版把"壁纸写入 `--accent-color-light/dark`"和"accent 写入同一对变量"并列，导致 `setAccentColor` 之后 `refreshWallpaperPalette` 又把壁纸色写回去——**用户选的 accent 被壁纸覆盖**。修正为：壁纸只在 `accentPresetId === "default"` 时才写变量、才挂 `data-app-wallpaper-palette`；非 default 时完全不碰这对变量，避免抹掉 `applyAccentColor` 刚写入的取值。

### 运行时崩溃（tsc 未捕获）

首次启动报 `Cannot read properties of undefined (reading 'accentColor')`。根因：`createAccentColorStoreActions` 在装配阶段就调用 `refreshWallpaperPalette()`，而那一刻 Zustand 的 `get()` 还没有本切片，`backgroundTheme` 为 `undefined`，`applyWallpaperPalette(undefined, ...)` 内部解引用 `settings.presetId` 崩溃。

修法：`refreshWallpaperPalette` 与 `applyCurrentBackgroundTheme` 在 `current?.backgroundTheme` 缺失时直接返回。`tsc` 对此完全沉默（类型上是 `BackgroundThemeSettings`，运行时才是 `undefined`），只能靠运行时验证发现。

### CDP 实测证据

| 场景 | `--accent-color-light` | `--color-accent` | `data-app-wallpaper-palette` | `data-app-accent` |
| --- | --- | --- | --- | --- |
| 选粉柳晴空 | `#5b9fc4` | `#8bcce4` | `pink-willow` | null |
| 再选「青绿」accent | `#e0f5ef` | `rgba(4,47,46,0.5)` | **null（让位）** | `teal` |
| accent 切回「默认」 | `#5b9fc4` | `#8bcce4` | `pink-willow`（恢复） | null |
| 选渐变族 mist | 空 | `#062a45`（主题默认） | null | null |
| 选「不使用背景」 | 空 | `#062a45` | null | null |

动效实测：13 张壁纸卡 + 5 个 accent 卡均带 `transition: transform, box-shadow`，`--ease-spring-gentle` = `cubic-bezier(0.34, 1.56, 0.64, 1)`，选中勾选圆点 `[data-selected-dot]` 存在。

### 门禁

`pnpm typecheck` 通过、`pnpm lint` 0 error（80 warning 全为既有历史遗留）、`architecture:check --changed` violations 0、改动文件 `oxfmt --check` 全部合规。

## 已知遗留

- **`highland-mist` 与 `lakeside-lodge` 的文件内容与名称错位**：前者实际是湖心小屋，后者实际是云雾雪岭。修名会动到已持久化的 `presetId`，需单独决策。
- 调色板色值是按实测主导色人工推导的，未做逐像素对比度校验（NewMax 有迭代校验）。若后续要更精确，需引入 OKLCH 工具。
