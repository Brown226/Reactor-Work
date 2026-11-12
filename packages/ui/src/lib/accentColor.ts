/**
 * 独立主题色（Accent）：用户可选的弱强调面色。
 *
 * 产品语义（对齐 docs/未完成-独立主题色accent-spec-v1.md 与 DESIGN.md）：
 * - 只覆盖 `--color-accent`（Accent Surface：弱强调块、选中高亮、低强度品牌面）；
 * - **不碰 `--color-brand`**：DESIGN.md 要求品牌色保持克制、不开放自定义；
 * - 深浅主题各有一档取值，靠 CSS 的 `[data-app-accent]` / `.dark[data-app-accent]`
 *   选择器切换，避免"浅色主题配深 accent"的割裂；
 * - 默认档不写任何内联值，回落到各主题块既有的 `--color-accent`，零行为变化。
 *
 * 这是本特性的单一事实源：新增档位只改 `ACCENT_PRESETS` 与 `PRESET_ACCENT_COLORS`。
 */

/** 主题色档位。`default` 表示跟随主题块的既有 accent，不覆盖。 */
export type AccentPresetId = "default" | "azurite" | "teal" | "violet" | "amber";

export interface AccentColorSettings {
  presetId: AccentPresetId;
}

export const ACCENT_COLOR_STORAGE_KEY = "zcode-accent-color";

export const DEFAULT_ACCENT_COLOR_SETTINGS: AccentColorSettings = { presetId: "default" };

/** 可选的强调色档位（不含 default）。顺序即设置页展示顺序。 */
export const ACCENT_PRESETS: ReadonlyArray<{ id: Exclude<AccentPresetId, "default"> }> = [
  { id: "azurite" },
  { id: "teal" },
  { id: "violet" },
  { id: "amber" },
];

/**
 * 每档的浅/深两色值。
 *
 * 浅色档取高明度低饱和（贴近主题块里 sky-50 / #e6f4fa 的量级）；
 * 深色档取同色相深底色叠加半透明（贴近深色主题块里 sky-950@50% 的做法）。
 * 刻意保持低强度：accent 是弱强调面，过艳会盖过 `--color-brand` 的强调层级。
 */
const PRESET_ACCENT_COLORS: Record<
  Exclude<AccentPresetId, "default">,
  { light: string; dark: string }
> = {
  // 天青：与既有 sky accent 同调，作为最稳的一档。
  azurite: { light: "#e6f4fa", dark: "rgba(6, 42, 69, 0.5)" },
  // 青绿：偏冷的青色调。
  teal: { light: "#e0f5ef", dark: "rgba(4, 47, 46, 0.5)" },
  // 紫罗兰：低饱和紫。
  violet: { light: "#efeafb", dark: "rgba(46, 16, 101, 0.5)" },
  // 琥珀：暖中性色。
  amber: { light: "#fdf1dc", dark: "rgba(69, 26, 3, 0.5)" },
};

function isAccentPresetId(value: unknown): value is AccentPresetId {
  return value === "default" || (typeof value === "string" && value in PRESET_ACCENT_COLORS);
}

export function normalizeAccentColorSettings(
  value: unknown,
  fallback: AccentColorSettings = DEFAULT_ACCENT_COLOR_SETTINGS,
): AccentColorSettings {
  const record = (value ?? {}) as Partial<Record<keyof AccentColorSettings, unknown>>;
  return {
    presetId: isAccentPresetId(record.presetId) ? record.presetId : fallback.presetId,
  };
}

/** 某档在给定深浅模式下的 accent 取值；default 档返回 null（表示不覆盖）。 */
export function getAccentPresetColor(id: AccentPresetId, mode: "light" | "dark"): string | null {
  if (id === "default") {
    return null;
  }
  return PRESET_ACCENT_COLORS[id][mode];
}

/**
 * 把主题色写到文档根：一个属性（供 CSS 选择器切换深浅档）加两个变量。
 *
 * 与背景主题一样只改文档根的属性与变量，不碰组件树，因此 Web、桌面、手机远控
 * 三种运行形态走的是同一份实现。
 */
export function applyAccentColor(settings: AccentColorSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (!root?.style?.setProperty) {
    return;
  }

  const presetId = settings.presetId;
  if (presetId === "default") {
    // 默认档：移除覆盖，回落到主题块既有 accent。
    root.removeAttribute("data-app-accent");
    root.style.removeProperty("--accent-color-light");
    root.style.removeProperty("--accent-color-dark");
    return;
  }

  const colors = PRESET_ACCENT_COLORS[presetId];
  root.setAttribute("data-app-accent", presetId);
  root.style.setProperty("--accent-color-light", colors.light);
  root.style.setProperty("--accent-color-dark", colors.dark);
}
