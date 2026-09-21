/**
 * 背景主题在 store 侧的读写：载入、归一化、落盘、应用到文档根，以及自定义图片的运行态。
 *
 * 与 `codingPlanQuotaResetState.ts` 同样的拆分方式——状态语义留在
 * `@/lib/backgroundTheme.ts`，store 只装配，避免全局 store 因外观设置继续膨胀。
 * 产品语义见 `docs/appearance-background-theme.md`。
 */
import { logger } from "@/logger.js";
import {
  applyBackgroundTheme,
  BACKGROUND_THEME_STORAGE_KEY,
  DEFAULT_BACKGROUND_THEME_SETTINGS,
  normalizeBackgroundThemeSettings,
  type BackgroundThemeSettings,
} from "@/lib/backgroundTheme.js";
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
): BackgroundThemeSettings {
  const next = normalizeBackgroundThemeSettings({ ...current, ...patch }, current);
  writeSafeLocalStorage(BACKGROUND_THEME_STORAGE_KEY, JSON.stringify(next));
  applyBackgroundTheme(next, imageUrl);
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
  read: () => { backgroundTheme: BackgroundThemeSettings; backgroundImage: BackgroundImageRuntime };
  write: (patch: {
    backgroundTheme?: BackgroundThemeSettings;
    backgroundImage?: BackgroundImageRuntime;
  }) => void;
}): BackgroundThemeStoreState {
  const initial = loadBackgroundThemeSettings();
  applyBackgroundTheme(initial, null);

  return {
    backgroundTheme: initial,
    setBackgroundTheme: (patch) => {
      const current = options.read();
      const next = resolveBackgroundThemeUpdate(
        current.backgroundTheme,
        patch,
        current.backgroundImage.url,
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
      applyBackgroundTheme(options.read().backgroundTheme, imageUrl);
    },
  };
}
