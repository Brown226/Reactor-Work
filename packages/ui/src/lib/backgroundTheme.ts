/**
 * 背景主题：工作区主区域的背景图与它的两个可调参数。
 *
 * 产品语义（对齐 `docs/appearance-background-theme.md`）：
 * - 只影响工作区主区域（桌面/Web 的主内容列），侧栏、设置页、弹窗保持不透明；
 * - 背景永远是"垫底"层：界面上任何不透明表面都会盖住它，因此可读性由
 *   `scrimPercent`（用当前主题的底色混出一个半透明遮罩）统一兜底；
 * - 预置背景不使用位图素材，全部由渐变合成，并引用 `--app-background-base`
 *   跟随深浅主题，避免"浅色主题配一张深色照片"的割裂感。
 *
 * 这是本特性的单一事实源：新增预置只改 `BACKGROUND_PRESETS`，新增可调参数只改
 * `BackgroundThemeSettings` 与 `normalizeBackgroundThemeSettings`。
 */

/** 预置背景标识。`none` 表示不使用预置；自定义图片存在时以图片为准。 */
export type BackgroundPresetId = "none" | "mist" | "sky" | "dusk" | "dune" | "basalt";

export interface BackgroundThemeSettings {
  presetId: BackgroundPresetId;
  /**
   * 自定义背景图片的绝对路径（仅桌面端可产生）。非空时优先于预置。
   *
   * 存路径而不是图片数据：路径可持久化、可读，但每次启动都要重新读一次文件
   * （见 `useBackgroundImageSource`），文件被移动或删除时回退到预置背景。
   */
  imagePath: string | null;
  /** 背景层模糊半径（px）。0 表示不模糊。 */
  blurPx: number;
  /** 覆盖色强度（%）：用当前主题底色压在背景上的比例，越高越接近纯色背景。 */
  scrimPercent: number;
}

export const BACKGROUND_THEME_STORAGE_KEY = "zcode-background-theme";

/** 自定义背景图片的体积上限，与 `fileService.readMediaPreview` 的上限保持一致（8 MB）。 */
export const MAX_BACKGROUND_IMAGE_BYTES = 8 * 1024 * 1024;

/** 可作为背景的图片扩展名。选中其它类型时直接拒绝，不去猜内容。 */
export const SUPPORTED_BACKGROUND_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
] as const;

export function isSupportedBackgroundImagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return SUPPORTED_BACKGROUND_IMAGE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export const MIN_BACKGROUND_BLUR_PX = 0;
export const MAX_BACKGROUND_BLUR_PX = 32;

/**
 * 覆盖色下限刻意不取 0：低于 40% 时浅色主题下的正文对比度会掉到可读性阈值以下，
 * 而背景层本身无法逐像素校验对比度，只能靠这个下限兜底。
 */
export const MIN_BACKGROUND_SCRIM_PERCENT = 40;
export const MAX_BACKGROUND_SCRIM_PERCENT = 100;

export const DEFAULT_BACKGROUND_THEME_SETTINGS: BackgroundThemeSettings = {
  presetId: "none",
  imagePath: null,
  blurPx: 10,
  scrimPercent: 60,
};

/**
 * 预置背景的 `background-image` 取值。
 *
 * 全部用 `var(--app-background-base)`（当前主题的底色字面值）参与合成，因此同一套
 * 预置在浅色与深色主题下都会得到与主题同调的结果，不需要维护两套素材。
 *
 * 底色占比刻意压得很低（8%–55%）：预置要看起来像"图"而不是"淡色底"，底色占比一高
 * 就会被覆盖色冲成一片灰白（实测 55%–88% 的版本肉眼几乎不可见）。
 */
export const BACKGROUND_PRESETS: ReadonlyArray<{ id: Exclude<BackgroundPresetId, "none"> }> = [
  { id: "mist" },
  { id: "sky" },
  { id: "dusk" },
  { id: "dune" },
  { id: "basalt" },
];

const PRESET_BACKGROUND_IMAGE: Record<Exclude<BackgroundPresetId, "none">, string> = {
  // 雾林：深绿林雾，上冷下暖。
  mist: [
    "radial-gradient(120% 85% at 18% 12%, color-mix(in oklab, var(--app-background-base) 12%, #1f5c4a) 0%, transparent 62%)",
    "radial-gradient(110% 90% at 82% 6%, color-mix(in oklab, var(--app-background-base) 20%, #2f5d78) 0%, transparent 58%)",
    "linear-gradient(175deg, color-mix(in oklab, var(--app-background-base) 45%, #17332c) 8%, color-mix(in oklab, var(--app-background-base) 25%, #2f6f5e) 100%)",
  ].join(", "),
  // 晴空：高明度蓝，保留云隙光的方向感。
  sky: [
    "radial-gradient(115% 80% at 25% 0%, color-mix(in oklab, var(--app-background-base) 10%, #4f9ad6) 0%, transparent 60%)",
    "radial-gradient(100% 85% at 88% 15%, color-mix(in oklab, var(--app-background-base) 25%, #a8d0ef) 0%, transparent 55%)",
    "linear-gradient(180deg, color-mix(in oklab, var(--app-background-base) 55%, #cfe3f5) 0%, color-mix(in oklab, var(--app-background-base) 30%, #7fb0d8) 100%)",
  ].join(", "),
  // 暖霞：一暖一冷对角叠色，做傍晚天光。
  dusk: [
    "radial-gradient(95% 70% at 78% 12%, color-mix(in oklab, var(--app-background-base) 8%, #e2703a) 0%, transparent 58%)",
    "radial-gradient(120% 95% at 10% 80%, color-mix(in oklab, var(--app-background-base) 15%, #4a4f96) 0%, transparent 62%)",
    "linear-gradient(200deg, color-mix(in oklab, var(--app-background-base) 40%, #f0b070) 0%, color-mix(in oklab, var(--app-background-base) 20%, #7b4a6a) 100%)",
  ].join(", "),
  // 沙原：暖中性色分层，弱对比但保留纵深。
  dune: [
    "radial-gradient(130% 70% at 50% 0%, color-mix(in oklab, var(--app-background-base) 10%, #d9a961) 0%, transparent 65%)",
    "linear-gradient(168deg, color-mix(in oklab, var(--app-background-base) 35%, #b8935f) 12%, color-mix(in oklab, var(--app-background-base) 15%, #7a5a33) 100%)",
  ].join(", "),
  // 玄岩：近无彩的深色纹理，作为最克制的一档。
  basalt: [
    "radial-gradient(120% 80% at 20% 0%, color-mix(in oklab, var(--app-background-base) 30%, #3b4653) 0%, transparent 60%)",
    "linear-gradient(190deg, color-mix(in oklab, var(--app-background-base) 40%, #46525f) 20%, color-mix(in oklab, var(--app-background-base) 10%, #12171c) 100%)",
  ].join(", "),
};

function isBackgroundPresetId(value: unknown): value is BackgroundPresetId {
  return value === "none" || (typeof value === "string" && value in PRESET_BACKGROUND_IMAGE);
}

function clampRounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeBackgroundThemeSettings(
  value: unknown,
  fallback: BackgroundThemeSettings = DEFAULT_BACKGROUND_THEME_SETTINGS,
): BackgroundThemeSettings {
  const record = (value ?? {}) as Partial<Record<keyof BackgroundThemeSettings, unknown>>;
  return {
    presetId: isBackgroundPresetId(record.presetId) ? record.presetId : fallback.presetId,
    imagePath:
      typeof record.imagePath === "string" && record.imagePath.trim().length > 0
        ? record.imagePath
        : record.imagePath === null
          ? null
          : fallback.imagePath,
    blurPx:
      typeof record.blurPx === "number" && Number.isFinite(record.blurPx)
        ? clampRounded(record.blurPx, MIN_BACKGROUND_BLUR_PX, MAX_BACKGROUND_BLUR_PX)
        : fallback.blurPx,
    scrimPercent:
      typeof record.scrimPercent === "number" && Number.isFinite(record.scrimPercent)
        ? clampRounded(
            record.scrimPercent,
            MIN_BACKGROUND_SCRIM_PERCENT,
            MAX_BACKGROUND_SCRIM_PERCENT,
          )
        : fallback.scrimPercent,
  };
}

export function isBackgroundEnabled(settings: BackgroundThemeSettings): boolean {
  return Boolean(settings.imagePath) || settings.presetId !== "none";
}

/** 某个预置的 `background-image` 取值。设置页用它画缩略图，与主区域用的是同一份定义。 */
export function getBackgroundPresetImage(id: BackgroundPresetId): string {
  return id === "none" ? "none" : PRESET_BACKGROUND_IMAGE[id];
}

/**
 * 背景层最终使用的 `background-image` 取值。
 *
 * 优先用已读到的自定义图片（`imageUrl` 由 `useBackgroundImageSource` 每次启动重新读取）；
 * 图片路径存在但还没读到（读取中/失败）时回退到预置，避免出现"什么都没有"的空窗。
 */
export function resolveBackgroundImageValue(
  settings: BackgroundThemeSettings,
  imageUrl?: string | null,
): string {
  if (settings.imagePath) {
    return imageUrl ? `url("${imageUrl}")` : getBackgroundPresetImage(settings.presetId);
  }
  return getBackgroundPresetImage(settings.presetId);
}

/** 背景层要用的 CSS 变量；关闭时把图片置为 none，其余参数保留以便再次开启。 */
export function buildBackgroundThemeCssVariables(
  settings: BackgroundThemeSettings,
  imageUrl?: string | null,
): Record<string, string> {
  const enabled = isBackgroundEnabled(settings);
  return {
    "--app-background-image": enabled ? resolveBackgroundImageValue(settings, imageUrl) : "none",
    "--app-background-blur": `${settings.blurPx}px`,
    "--app-background-scrim": `${settings.scrimPercent}%`,
  };
}

/**
 * 把背景主题写到文档根：一个属性（供 CSS 决定是否透出）加三个变量。
 *
 * 与主题/字号一样只改文档根的属性与变量，不碰组件树，因此 Web、桌面、手机远控
 * 三种运行形态走的是同一份实现。
 */
export function applyBackgroundTheme(
  settings: BackgroundThemeSettings,
  imageUrl?: string | null,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  if (!root?.style?.setProperty) {
    return;
  }

  root.toggleAttribute("data-app-background", isBackgroundEnabled(settings));
  for (const [name, value] of Object.entries(
    buildBackgroundThemeCssVariables(settings, imageUrl),
  )) {
    root.style.setProperty(name, value);
  }
}
