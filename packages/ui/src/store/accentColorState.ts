/**
 * 独立主题色在 store 侧的读写：载入、归一化、落盘、应用到文档根。
 *
 * 与 `backgroundThemeState.ts` 同样的拆分方式——语义留在 `@/lib/accentColor.ts`，
 * store 只装配。产品语义见 `docs/未完成-独立主题色accent-spec-v1.md`。
 */
import {
  ACCENT_COLOR_STORAGE_KEY,
  applyAccentColor,
  DEFAULT_ACCENT_COLOR_SETTINGS,
  normalizeAccentColorSettings,
  type AccentColorSettings,
} from "@/lib/accentColor.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

export interface AccentColorStoreState {
  /** 独立主题色（弱强调面 accent）。 */
  accentColor: AccentColorSettings;
  setAccentColor: (patch: Partial<AccentColorSettings>) => void;
}

function loadAccentColorSettings(): AccentColorSettings {
  const raw = readSafeLocalStorage(ACCENT_COLOR_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_ACCENT_COLOR_SETTINGS;
  }
  try {
    return normalizeAccentColorSettings(JSON.parse(raw), DEFAULT_ACCENT_COLOR_SETTINGS);
  } catch {
    // 陈旧或手工改坏的取值只影响外观，回落默认值即可，不打断启动。
    return DEFAULT_ACCENT_COLOR_SETTINGS;
  }
}

/**
 * store 装配入口：载入持久化取值并立即应用（与主题、背景主题一样在窗口创建时生效）。
 * `read`/`write` 由调用方注入，避免本模块反向依赖 store。
 */
export function createAccentColorStoreActions(options: {
  read: () =>
    | { accentColor?: AccentColorSettings; refreshWallpaperPalette?: () => void }
    | undefined;
  write: (patch: { accentColor?: AccentColorSettings }) => void;
}): AccentColorStoreState {
  const initial = loadAccentColorSettings();
  applyAccentColor(initial);
  // 本函数在背景主题之后装配，此时壁纸调色板已按"accent 可能尚未初始化"跑过一遍；
  // 这里补一次，把真实的 accent 档位交给它，避免壁纸配色错误地压住用户已选的 accent。
  // 装配期 store 尚未建好：zustand 的 get() 此时可能返回 undefined，
  // 直接解引用会抛 "Cannot read properties of undefined (reading 'accentColor')" 白屏。
  options.read()?.refreshWallpaperPalette?.();

  return {
    accentColor: initial,
    setAccentColor: (patch) => {
      // `get()` 在 store 首次装配阶段可能还没返回完整状态，与 backgroundThemeState
      // 同口径做可选链兜底：拿不到当前值就按"首次装配"处理，用默认值起算。
      const state = options.read();
      const current = state?.accentColor ?? DEFAULT_ACCENT_COLOR_SETTINGS;
      const next = normalizeAccentColorSettings({ ...current, ...patch }, current);
      writeSafeLocalStorage(ACCENT_COLOR_STORAGE_KEY, JSON.stringify(next));
      applyAccentColor(next);
      options.write({ accentColor: next });
      // accent 优先级高于壁纸配色：切换后让壁纸重新判定要不要让位。
      state?.refreshWallpaperPalette?.();
    },
  };
}
