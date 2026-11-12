/**
 * 背景主题：工作区主区域的背景图与它的两个可调参数。
 *
 * 产品语义（对齐 `docs/已完成/已完成-appearance-background-theme.md`）：
 * - 只影响工作区主区域（桌面/Web 的主内容列），侧栏、设置页、弹窗保持不透明；
 * - 背景永远是"垫底"层：界面上任何不透明表面都会盖住它，因此可读性由
 *   `scrimPercent`（用当前主题的底色混出一个半透明遮罩）统一兜底；
 * - 预置背景不使用位图素材，全部由渐变合成，并引用 `--app-background-base`
 *   跟随深浅主题，避免"浅色主题配一张深色照片"的割裂感。
 *
 * 这是本特性的单一事实源：新增预置只改 `BACKGROUND_PRESETS`，新增可调参数只改
 * `BackgroundThemeSettings` 与 `normalizeBackgroundThemeSettings`。
 */
import birdPerchThumbUrl from "@/assets/background-presets/thumbs/bird-perch.jpg";
import duskGrassThumbUrl from "@/assets/background-presets/thumbs/dusk-grass.jpg";
import highlandMistThumbUrl from "@/assets/background-presets/thumbs/highland-mist.jpg";
import lakesideLodgeThumbUrl from "@/assets/background-presets/thumbs/lakeside-lodge.jpg";
import moonTerracesThumbUrl from "@/assets/background-presets/thumbs/moon-terraces.jpg";
import pinkWillowThumbUrl from "@/assets/background-presets/thumbs/pink-willow.jpg";
import birdPerchUrl from "@/assets/background-presets/bird-perch.jpg";
import duskGrassUrl from "@/assets/background-presets/dusk-grass.jpg";
import highlandMistUrl from "@/assets/background-presets/highland-mist.jpg";
import lakesideLodgeUrl from "@/assets/background-presets/lakeside-lodge.jpg";
import moonTerracesUrl from "@/assets/background-presets/moon-terraces.jpg";
import pinkWillowUrl from "@/assets/background-presets/pink-willow.jpg";

/**
 * 预置背景标识。`none` 表示不使用预置；自定义图片存在时以图片为准。
 *
 * 分两族：
 * - 渐变族（mist/sky/dusk/dune/basalt）：零位图素材，用 CSS 渐变合成；
 * - 风景族（highland-mist/lakeside-lodge/dusk-grass/pink-willow/moon-terraces/bird-perch）：
 *   位图壁纸，素材取自 NewMax 1.1.20 的 renderer assets。
 */
export type BackgroundPresetId =
  | "none"
  | "mist"
  | "sky"
  | "dusk"
  | "dune"
  | "basalt"
  | "highland-mist"
  | "lakeside-lodge"
  | "dusk-grass"
  | "pink-willow"
  | "moon-terraces"
  | "bird-perch";

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
  /**
   * 动态壁纸：给背景层叠加一层极缓慢的缩放呼吸动效（Ken Burns）。
   *
   * 刻意**不做视频壁纸**（C 档，需单独评估解码功耗）；这里只用 CSS 动画，
   * 对渐变与图片同样有效、零额外素材、待机功耗可忽略。尊重系统「减弱动效」设置。
   * 默认关闭：动效是「主动选择」的个性化，不是默认负担。
   */
  motion: boolean;
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
  motion: false,
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
  // 风景族：位图壁纸，排在前列——写实壁纸的视觉辨识度明显高于纯渐变，
  // 放在首位让用户第一眼就能看到最有质感的选择。
  { id: "highland-mist" },
  { id: "lakeside-lodge" },
  { id: "dusk-grass" },
  { id: "pink-willow" },
  { id: "moon-terraces" },
  { id: "bird-perch" },
  // 渐变族：零位图素材，按主题底色合成，排在风景族之后。
  { id: "mist" },
  { id: "sky" },
  { id: "dusk" },
  { id: "dune" },
  { id: "basalt" },
];

/**
 * 风景族预置的位图素材。
 *
 * 用打包期资源导入而不是运行时路径：Web 与桌面共用同一份产物，不依赖任何本地文件；
 * 缩略图单独一份（设置页卡片只有 96px 高），避免为了画缩略图加载 795KB 的原图。
 */
const PRESET_BITMAP_IMAGE: Partial<Record<BackgroundPresetId, { full: string; thumb: string }>> = {
  "highland-mist": {
    full: highlandMistUrl,
    thumb: highlandMistThumbUrl,
  },
  "lakeside-lodge": {
    full: lakesideLodgeUrl,
    thumb: lakesideLodgeThumbUrl,
  },
  "dusk-grass": {
    full: duskGrassUrl,
    thumb: duskGrassThumbUrl,
  },
  "pink-willow": {
    full: pinkWillowUrl,
    thumb: pinkWillowThumbUrl,
  },
  "moon-terraces": {
    full: moonTerracesUrl,
    thumb: moonTerracesThumbUrl,
  },
  "bird-perch": {
    full: birdPerchUrl,
    thumb: birdPerchThumbUrl,
  },
};

/** 渐变族预置标识：只有这些才在 `PRESET_BACKGROUND_IMAGE` 里有取值。 */
type GradientPresetId = "mist" | "sky" | "dusk" | "dune" | "basalt";

/**
 * 风景壁纸的调色板：从图片实际主色采样后推导出的强调色与底色倾向。
 *
 * 为什么需要：只有背景图时，壁纸与界面配色互不相关，观感像"贴上去的"。
 * NewMax 的做法是每张壁纸带一份调色板，选中时整套 UI 色阶由它派生。
 * 这里只取其收益最大的一层：把强调色与主内容区底色染成壁纸的同调色。
 *
 * 取值方法（非凭感觉）：
 * 1. 用 jpeg-js 逐像素采样得到主导色与平均亮度；
 * 2. 按"适合做弱强调面"的明度/彩度调整——直接用图片主色往往过暗（如 lakeside-lodge
 *    的 #2e2d17 亮度仅 0.071），做强调色会糊成一片；
 * 3. 浅色档取该色相的中高明度版本，深色档取同色相的提亮版本（深色主题下强调色需更亮）。
 *
 * 只覆盖 6 张风景壁纸。渐变族（mist/sky/...）是合成抽象图形，没有"从图中提取"的语义。
 */
export interface WallpaperPalette {
  /** 浅色主题下的强调色。 */
  accentLight: string;
  /** 深色主题下的强调色（深色主题需要更高明度才看得清）。 */
  accentDark: string;
}

const WALLPAPER_PALETTE: Partial<Record<BackgroundPresetId, WallpaperPalette>> = {
  // 湖心小屋：云灰主导（#d1d1ce 占 17%），取其中的雾蓝倾向。
  "highland-mist": { accentLight: "#7b95a9", accentDark: "#a8c0d4" },
  // 云雾雪岭：墨绿褐主导（#2e2d17），亮度仅 0.071，需大幅提亮才可读。
  "lakeside-lodge": { accentLight: "#6b7a52", accentDark: "#9aad7a" },
  // 暮色草：暖粉调主导（#cfb4b2），取其中的陶土橙。
  "dusk-grass": { accentLight: "#b5765c", accentDark: "#d99a7d" },
  // 粉柳晴空：天蓝占 48%，直接以天蓝为强调色。
  "pink-willow": { accentLight: "#5b9fc4", accentDark: "#8bcce4" },
  // 月悬楼角：灰蓝 46%、陶土 17%，取灰蓝做主调（陶土作为图像内的撞色保留）。
  "moon-terraces": { accentLight: "#5f8fa8", accentDark: "#9ab9c6" },
  // 小鸟白墙：米白 62%，整体极简，取中性米灰避免引入额外色相。
  "bird-perch": { accentLight: "#8a8a86", accentDark: "#bebbb6" },
};

/** 某预置是否有调色板（只有风景族有）。 */
export function getWallpaperPalette(id: BackgroundPresetId): WallpaperPalette | null {
  return WALLPAPER_PALETTE[id] ?? null;
}

const PRESET_BACKGROUND_IMAGE: Record<GradientPresetId, string> = {
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
  // 必须同时认渐变族与位图族：只查 PRESET_BACKGROUND_IMAGE 会把风景族当成非法值，
  // 持久化后重新载入时被 normalize 回退成 none，用户会看到"选了但没生效"。
  return (
    value === "none" ||
    (typeof value === "string" &&
      (value in PRESET_BACKGROUND_IMAGE || value in PRESET_BITMAP_IMAGE))
  );
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
    motion: typeof record.motion === "boolean" ? record.motion : fallback.motion,
  };
}

export function isBackgroundEnabled(settings: BackgroundThemeSettings): boolean {
  return Boolean(settings.imagePath) || settings.presetId !== "none";
}

/** 某个预置在设置页缩略图上用的 `background-image` 取值。位图族优先用缩略图。 */
export function getBackgroundPresetThumbImage(id: BackgroundPresetId): string {
  if (id === "none") {
    return "none";
  }
  const bitmap = PRESET_BITMAP_IMAGE[id];
  if (bitmap) {
    return `url("${bitmap.thumb}")`;
  }
  // 走到这里只剩渐变族：`PRESET_BITMAP_IMAGE` 没命中，`none` 已在上面提前返回。
  return PRESET_BACKGROUND_IMAGE[id as GradientPresetId];
}

/** 某个预置的 `background-image` 取值（工作区主区域用）。 */
export function getBackgroundPresetImage(id: BackgroundPresetId): string {
  if (id === "none") {
    return "none";
  }
  const bitmap = PRESET_BITMAP_IMAGE[id];
  if (bitmap) {
    return `url("${bitmap.full}")`;
  }
  // 同上：只剩渐变族。
  return PRESET_BACKGROUND_IMAGE[id as GradientPresetId];
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
    "--app-background-crossfade": `${BACKGROUND_CROSSFADE_MS}ms`,
  };
}

/** 交叉淡入时长（ms）。对齐 DESIGN.md「fast and low-drama」。 */
export const BACKGROUND_CROSSFADE_MS = 240;

/** 上一次交叉淡入的清理定时器；连续切换时先取消，避免上一次的清理把新一次打断。 */
let crossfadeCleanupTimer: (() => void) | null = null;

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

  const enabled = isBackgroundEnabled(settings);
  root.toggleAttribute("data-app-background", enabled);
  // 动态壁纸：开启动效时挂属性，CSS 据此给 ::before 叠加缓慢缩放；关闭时移除、还原静态。
  root.toggleAttribute("data-app-background-motion", enabled && settings.motion);

  // 写新值前先读旧值，用于判断是否需要交叉淡入。
  const previousImage = root.style.getPropertyValue("--app-background-image").trim();

  const nextVariables = buildBackgroundThemeCssVariables(settings, imageUrl);
  for (const [name, value] of Object.entries(nextVariables)) {
    root.style.setProperty(name, value);
  }

  if (!enabled) {
    // 关闭背景：立刻清理任何进行中的过渡状态。
    cancelBackgroundCrossfade(root);
    return;
  }

  scheduleBackgroundCrossfade(root, previousImage, nextVariables["--app-background-image"]);
}

/**
 * 背景图切换的交叉淡入。
 *
 * `background-image` 不可插值，浏览器只能硬切；这里把"旧图"作为独立的一层写在
 * `::after` 上，切图时先把旧图快照到 `--app-background-prev-image`，再用
 * `data-app-background-fading` 触发 240ms 的 opacity 1→0，露出下面的新 `::before`。
 *
 * 只在"旧值非空、且与新值不同"时触发：首次应用（旧值 none/未设置）不淡入，避免启动闪光。
 * 唯一副作用是文档根上的 `data-app-background-fading` 属性 + `--app-background-prev-image`
 * 变量，二者都在过渡结束后清理。
 */
function scheduleBackgroundCrossfade(
  root: HTMLElement,
  previousImage: string,
  nextImage: unknown,
): void {
  const next = typeof nextImage === "string" ? nextImage.trim() : "";
  if (!next || next === "none") {
    return;
  }

  // 旧值为空、为 none，或与新值相同：没有可交叉的对象，直接跳过。
  if (!previousImage || previousImage === "none" || previousImage === next) {
    return;
  }

  crossfadeCleanupTimer?.();
  root.style.setProperty("--app-background-prev-image", previousImage);
  root.setAttribute("data-app-background-fading", "");

  const timer = setTimeout(() => {
    crossfadeCleanupTimer = null;
    root.removeAttribute("data-app-background-fading");
    root.style.removeProperty("--app-background-prev-image");
  }, BACKGROUND_CROSSFADE_MS);
  crossfadeCleanupTimer = () => clearTimeout(timer);
}

function cancelBackgroundCrossfade(root: HTMLElement): void {
  crossfadeCleanupTimer?.();
  crossfadeCleanupTimer = null;
  root.removeAttribute("data-app-background-fading");
  root.style.removeProperty("--app-background-prev-image");
}

/**
 * 把壁纸调色板写到文档根，让壁纸配色接管强调色。
 *
 * 优先级设计（重要）：用户显式选择的 accent 高于壁纸配色。
 * 用户既然在某处明确选了强调色，壁纸不该悄悄把它覆盖掉。因此：
 * - `accentPresetId !== "default"` 时，不挂 `data-app-wallpaper-palette` 属性，
 *   CSS 的 `:not([data-app-accent])` 守卫也就不会放行壁纸配色；
 * - 但仍写入 `--accent-color-light/dark`，因为用户可能随时把 accent 切回「跟随主题」，
 *   那时无需重新计算就能立即生效。
 *
 * 与 `applyAccentColor` 共用同一对变量名，由 CSS 属性守卫决定谁生效，
 * 避免两处写不同变量导致"改了不生效"。
 */
export function applyWallpaperPalette(
  settings: BackgroundThemeSettings,
  accentPresetId: string,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  if (!root?.style?.setProperty) {
    return;
  }

  const userChoseAccent = accentPresetId !== "default";

  // 未启用背景（或选的是渐变族）时，不产生任何覆盖，回落到主题块默认值。
  const palette =
    !userChoseAccent && isBackgroundEnabled(settings)
      ? getWallpaperPalette(settings.presetId)
      : null;

  if (!palette) {
    root.removeAttribute("data-app-wallpaper-palette");
    // 只有用户没显式选 accent 时才清理变量；否则会抹掉 applyAccentColor 刚写入的取值。
    if (!userChoseAccent) {
      root.style.removeProperty("--accent-color-light");
      root.style.removeProperty("--accent-color-dark");
    }
    return;
  }

  // 走到这里必然是 accent=default：变量由壁纸提供，属性让 CSS 守卫放行。
  root.style.setProperty("--accent-color-light", palette.accentLight);
  root.style.setProperty("--accent-color-dark", palette.accentDark);
  root.setAttribute("data-app-wallpaper-palette", settings.presetId);
}
