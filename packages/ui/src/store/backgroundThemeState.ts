/**
 * 背景主题在 store 侧的读写：载入、归一化、落盘、应用到文档根，以及自定义图片的运行态。
 *
 * 与 `codingPlanQuotaResetState.ts` 同样的拆分方式——状态语义留在
 * `@/lib/backgroundTheme.ts`，store 只装配，避免全局 store 因外观设置继续膨胀。
 * 产品语义见 `docs/已完成/已完成-appearance-background-theme.md`。
 */
import { logger } from "@/logger.js";
import {
  applyBackgroundTheme,
  applyWallpaperPalette,
  BACKGROUND_THEME_STORAGE_KEY,
  DEFAULT_BACKGROUND_THEME_SETTINGS,
  normalizeBackgroundThemeSettings,
  type BackgroundThemeSettings,
} from "@/lib/backgroundTheme.js";
import type { AccentColorSettings } from "@/lib/accentColor.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";

/** 自定义图片的运行态。只存在于内存：每次启动都要重新读盘，不持久化。 */
export interface BackgroundImageRuntime {
  status: "idle" | "loading" | "ready" | "error";
  /** 读到的 data URL；`ready` 之外为 null。 */
  url: string | null;
  /** 读取失败的原因（仅用于日志与诊断，界面显示本地化文案）。 */
  error: string | null;
}

export interface BackgroundThemeStoreState {
  /** 背景主题（工作区整窗背景 + 模糊/覆盖色）。 */
  backgroundTheme: BackgroundThemeSettings;
  setBackgroundTheme: (patch: Partial<BackgroundThemeSettings>) => void;
  backgroundImage: BackgroundImageRuntime;
  setBackgroundImage: (patch: Partial<BackgroundImageRuntime>) => void;
  /** 用当前设置与给定的图片 URL 重新应用一次（图片读取完成后调用）。 */
  applyCurrentBackgroundTheme: (imageUrl: string | null) => void;
  /**
   * 重新应用壁纸调色板的优先级判定。
   *
   * 用途：用户切换 accent 档位后，壁纸配色的"是否让位"要重新算一次——
   * accent 从 default 改成具体档位时壁纸要让位，改回 default 时壁纸要重新生效。
   * 不重新应用的话，`data-app-wallpaper-palette` 属性会停留在旧状态。
   */
  refreshWallpaperPalette: () => void;
}

const IDLE_BACKGROUND_IMAGE: BackgroundImageRuntime = { status: "idle", url: null, error: null };

function loadBackgroundThemeSettings(): BackgroundThemeSettings {
  const raw = readSafeLocalStorage(BACKGROUND_THEME_STORAGE_KEY);
  if (!raw) {
    return DEFAULT_BACKGROUND_THEME_SETTINGS;
  }

  try {
    return normalizeBackgroundThemeSettings(JSON.parse(raw), DEFAULT_BACKGROUND_THEME_SETTINGS);
  } catch {
    // 陈旧或手工改坏的取值只影响外观，回落默认值即可，不打断启动。
    return DEFAULT_BACKGROUND_THEME_SETTINGS;
  }
}

/** 合并补丁、落盘并应用（带上当前已读到的图片，避免改滑块时丢掉自定义背景）。 */
function resolveBackgroundThemeUpdate(
  current: BackgroundThemeSettings,
  patch: Partial<BackgroundThemeSettings>,
  imageUrl: string | null,
  accentPresetId: string,
): BackgroundThemeSettings {
  const next = normalizeBackgroundThemeSettings({ ...current, ...patch }, current);
  writeSafeLocalStorage(BACKGROUND_THEME_STORAGE_KEY, JSON.stringify(next));
  applyBackgroundTheme(next, imageUrl);
  // 壁纸调色板必须紧随其后：`applyBackgroundTheme` 负责图，这一步负责"图带来的配色"。
  applyWallpaperPalette(next, accentPresetId);
  return next;
}

/** 广播载荷还原：缺字段保留当前值；落盘交给 setter，避免两条写入路径。 */
export function normalizeBackgroundThemeBroadcast(
  current: BackgroundThemeSettings,
  payload: unknown,
): BackgroundThemeSettings {
  return normalizeBackgroundThemeSettings(payload, current);
}

/**
 * store 装配入口：载入持久化取值并立即应用（与主题、界面字号一样在窗口创建时生效）。
 * `read`/`write` 由调用方注入，避免本模块反向依赖 store。
 *
 * 自定义图片的读取不在这一层：它要访问服务，由 `useBackgroundImageSource` 在应用根节点
 * 统一读取，读完后通过 `setBackgroundImage` 回填；这里只负责"用当前 URL 应用一次"。
 */
export function createBackgroundThemeStoreActions(options: {
  read: () => {
    backgroundTheme: BackgroundThemeSettings;
    backgroundImage: BackgroundImageRuntime;
    accentColor?: AccentColorSettings;
  };
  write: (patch: {
    backgroundTheme?: BackgroundThemeSettings;
    backgroundImage?: BackgroundImageRuntime;
  }) => void;
}): BackgroundThemeStoreState {
  const initial = loadBackgroundThemeSettings();
  // 装配顺序上 accent 可能还没初始化（它在本函数之后执行），此时按 default 处理；
  // accent 初始化完成后会调 `refreshWallpaperPalette` 补一次，因此不会漏掉。
  // 注意：这里必须可选链到底——`get()` 在 store 首次装配阶段可能还没返回完整状态，
  // 直接解引用会抛 "Cannot read properties of undefined (reading 'accentColor')"。
  const initialAccentPresetId = options.read()?.accentColor?.presetId ?? "default";
  applyBackgroundTheme(initial, null);
  applyWallpaperPalette(initial, initialAccentPresetId);

  return {
    backgroundTheme: initial,
    setBackgroundTheme: (patch) => {
      const current = options.read();
      const next = resolveBackgroundThemeUpdate(
        current.backgroundTheme,
        patch,
        current.backgroundImage.url,
        current.accentColor?.presetId ?? "default",
      );
      options.write({ backgroundTheme: next });
    },
    backgroundImage: IDLE_BACKGROUND_IMAGE,
    setBackgroundImage: (patch) => {
      const next = { ...options.read().backgroundImage, ...patch };
      if (patch.status === "error" && patch.error) {
        logger.warn("[BackgroundTheme] 自定义背景图片不可用", { error: patch.error });
      }
      options.write({ backgroundImage: next });
    },
    applyCurrentBackgroundTheme: (imageUrl) => {
      const current = options.read();
      if (!current?.backgroundTheme) {
        return;
      }
      applyBackgroundTheme(current.backgroundTheme, imageUrl);
      applyWallpaperPalette(current.backgroundTheme, current.accentColor?.presetId ?? "default");
    },
    refreshWallpaperPalette: () => {
      const current = options.read();
      // store 首次装配阶段 `get()` 还不含本切片，`backgroundTheme` 会是 undefined。
      // 那一次不算"用户改了 accent"，跳过即可——随后本切片初始化时自己会应用一次。
      if (!current?.backgroundTheme) {
        return;
      }
      applyWallpaperPalette(current.backgroundTheme, current.accentColor?.presetId ?? "default");
    },
  };
}
