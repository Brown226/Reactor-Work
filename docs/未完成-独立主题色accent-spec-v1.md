# 未完成：独立主题色 accent（spec v1）

## 背景

NewMax 的个性化体系是四维的（颜色主题 / 背景主题 / **主题色 accent** / AI 生成）。
Reactor 已有前两维（主题 + `backgroundTheme.ts`），**缺独立主题色**：
`--color-accent`（弱强调面）在四个主题块里写死，用户不可调。

## 产品规则

- 只让用户调 **`--color-accent`（Accent Surface）**，**绝不改 `--color-brand`**。
  DESIGN.md 明确规定 Brand 用于"key emphasis / important links / active indicators"，
  并要求 "Keep brand color usage sparse and intentional"——品牌色不开放自定义。
- accent 是低强度弱强调面，语义见 DESIGN.md「Accent Surface: weak emphasis blocks,
  selected highlights, low-intensity branded surfaces」。
- accent 必须**跟随深浅主题**分别取值，不能出现"浅色主题配深 accent"的割裂。
- 默认档不写任何内联值，回落到各主题块既有的 `--color-accent`（零行为变化）。

## 状态所有者

- 语义与取值：`packages/ui/src/lib/accentColor.ts`（单一事实源，同 `backgroundTheme.ts` 模式）。
- store 装配：`packages/ui/src/store/accentColorState.ts`。
- UI：`packages/ui/src/settings/AccentColorSection.tsx`，挂在外观页 `BackgroundThemeSection` 之后。

## 接口

```ts
export type AccentPresetId = "default" | "azurite" | "teal" | "violet" | "amber";
export interface AccentColorSettings { presetId: AccentPresetId; }
export const ACCENT_COLOR_STORAGE_KEY = "zcode-accent-color";
export const DEFAULT_ACCENT_COLOR_SETTINGS: AccentColorSettings;
export const ACCENT_PRESETS: ReadonlyArray<{ id: Exclude<AccentPresetId, "default"> }>;
export function normalizeAccentColorSettings(value: unknown, fallback): AccentColorSettings;
export function getAccentPresetColor(id, mode: "light" | "dark"): string | null;
export function applyAccentColor(settings: AccentColorSettings): void;
```

## 状态落点

- `document.documentElement` 上：
  - 属性 `data-app-accent="<presetId>"`（default 档移除）；
  - 变量 `--accent-color-light` / `--accent-color-dark`（default 档移除）。
- CSS 选择器绑定（`styles.css`）：
  - `:root[data-app-accent] { --color-accent: var(--accent-color-light); }`
  - `.dark[data-app-accent] { --color-accent: var(--accent-color-dark); }`
  - 特异性高于各主题块的 `--color-accent` 定义，故能覆盖且不误伤。

## 验收场景

1. 默认档：`document.documentElement` 无 `data-app-accent`，`--color-accent` 等于主题块原值。
2. 选「紫罗兰」：浅色下 `--color-accent` = 浅紫，深色下 = 深紫（`.dark` 生效）。
3. 刷新后保持（localStorage 落盘）。
4. 切主题（zai-light ↔ zai-dark）：accent 随深浅自动换档，不需要重选。
5. 品牌色 `--color-brand` 全程不变。

## 验证

- 受影响包链增量 `tsc -b` + 改动文件 `oxlint`。
- 纯前端确定性行为，以类型 + lint 为准；运行时视觉由卡片内色块自证。

## 边界与遗留

- 不做任意取色器（HEX 输入），只提供预置档，保持与 backgroundTheme 的"预置"风格一致、可控。
- 不联动 `--color-brand`、不做"重主题/轻主题"分层（另立评估）。
