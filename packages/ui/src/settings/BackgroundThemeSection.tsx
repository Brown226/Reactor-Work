/**
 * 外观页的「背景主题」区：主内容区背景、预置/自定义图片，以及显示效果与强调色。
 *
 * 状态直接读 store（与主题、界面字号同一处），不经过 `AppearanceSectionContent` 的
 * 属性链，避免为一段可独立演进的外观设置改动设置页签名。
 * 图片的读取不在这一层：组件只负责选文件与展示状态，读盘与授权在
 * `useBackgroundImageSource`（应用根节点挂一次）。语义见 docs/已完成/已完成-appearance-background-theme.md。
 *
 * 布局对齐 NewMax 偏好面板（见 docs/未完成-外观主题设置布局改造-spec-v1.md）：
 * 壁纸是横排竖向胶囊、参数是三栏并排小卡、强调色是两列色块清单。
 * 只是视觉组织变化——预置清单、参数取值范围、持久化键全部不变。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CheckIcon, ImagePlusIcon, XIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BACKGROUND_PRESETS,
  getBackgroundPresetThumbImage,
  isSupportedBackgroundImagePath,
  MAX_BACKGROUND_BLUR_PX,
  MAX_BACKGROUND_SCRIM_PERCENT,
  MIN_BACKGROUND_BLUR_PX,
  MIN_BACKGROUND_SCRIM_PERCENT,
  type BackgroundPresetId,
} from "@/lib/backgroundTheme.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

const PRESET_OPTIONS: BackgroundPresetId[] = [
  "none",
  ...BACKGROUND_PRESETS.map((preset) => preset.id),
];

/**
 * 竖向壁纸卡片。
 *
 * 尺寸刻意固定为 88×120：横排 12 个预置必须能横向滚动，卡片再宽就退化成
 * 「一屏只看到四五个」的体验。名称压在底部渐变遮罩上，位图族才有足够对比度。
 */
function BackgroundOptionCard({
  testId,
  label,
  selected,
  imageBacked = false,
  style,
  onSelect,
  onRemove,
  removeLabel,
  children,
}: {
  testId: string;
  label: string;
  selected: boolean;
  /** 卡片底色是否来自图片/渐变：是则标签压深色遮罩，否则用普通弱化文字。 */
  imageBacked?: boolean;
  style?: CSSProperties;
  onSelect?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-pressed={selected}
        data-testid={testId}
        // 动效钩子：CSS 依据这两个属性做轻微回弹（见 styles.css 的 --ease-spring-gentle）。
        data-wallpaper-card=""
        data-selected={selected ? "true" : "false"}
        onClick={onSelect}
        className={cn(
          "relative h-[120px] w-[88px] overflow-hidden rounded-2xl border text-left transition-[border-color,box-shadow]",
          selected
            ? "border-brand ring-2 ring-brand/40"
            : "border-border hover:border-border-hover",
          imageBacked ? "" : "border-dashed",
        )}
        style={style}
      >
        {children}
        {selected ? (
          <span
            data-selected-dot=""
            className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-brand text-white shadow-sm"
          >
            <CheckIcon className="size-3" aria-hidden="true" />
          </span>
        ) : null}
        <span
          className={cn(
            "absolute inset-x-0 bottom-0 truncate px-2 py-1.5 text-ui-sm font-medium",
            imageBacked
              ? "bg-gradient-to-t from-black/60 to-transparent text-white"
              : "text-foreground-subtle",
          )}
        >
          {label}
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          data-testid="background-image-remove"
          onClick={onRemove}
          className="absolute right-1.5 top-1.5 rounded-md bg-black/45 p-1 text-white transition-colors hover:bg-black/65"
        >
          <XIcon className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** 参数区的一张小卡：标题 + 右上角数值 + 下方控件。 */
function EffectCard({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{label}</span>
        {detail ? (
          <span className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle">{detail}</span>
        ) : null}
      </div>
      <div className="mt-2 flex h-7 items-center">{children}</div>
    </div>
  );
}

export function BackgroundThemeSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const backgroundTheme = useZCodeStore((state) => state.backgroundTheme);
  const setBackgroundTheme = useZCodeStore((state) => state.setBackgroundTheme);
  const backgroundImage = useZCodeStore((state) => state.backgroundImage);
  // 只表示"选到了不支持的格式"，读盘失败由 backgroundImage.status 表达。
  const [unsupportedPick, setUnsupportedPick] = useState(false);
  const presetScrollerRef = useRef<HTMLDivElement | null>(null);

  /**
   * 把垂直滚轮转成横向滚动。
   *
   * 为什么必须自己做：`overflow-x-auto` 只响应横向滚动事件，而桌面鼠标只有垂直滚轮，
   * Chromium 不会把 `deltaY` 自动映射到 `scrollLeft`。实测垂直滚轮、横向滚轮、鼠标拖拽
   * 三者都滚不动这个列表，只有触屏能滑——桌面用户等于用不了。
   *
   * 为什么用原生监听而不是 React 的 onWheel：React 18 把 `wheel` 注册为**被动监听器**，
   * 里面调 `preventDefault()` 会被忽略，结果是"列表横向滚了、页面也纵向滚了"。
   * 这里显式 `{ passive: false }` 才能拦下来。
   *
   * 边界：只在确实可横向滚动时接管；到达左右端点时放行，让页面恢复纵向滚动，
   * 避免"滚到底之后整页卡住"的错觉。
   */
  useEffect(() => {
    const scroller = presetScrollerRef.current;
    if (!scroller) {
      return;
    }
    const onWheel = (event: globalThis.WheelEvent) => {
      // 横向滚动量已足够（触控板双指横滑）时不干预，交给浏览器原生处理。
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        return;
      }
      const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
      if (maxScrollLeft <= 0) {
        return;
      }
      const atStart = scroller.scrollLeft <= 0;
      const atEnd = scroller.scrollLeft >= maxScrollLeft - 1;
      const scrollingForward = event.deltaY > 0;
      if ((atStart && !scrollingForward) || (atEnd && scrollingForward)) {
        return;
      }
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  const canPickImage =
    platform.canSelectFilePath === true && typeof platform.selectFiles === "function";
  const hasCustomImage = Boolean(backgroundTheme.imagePath);
  const customImageUrl = backgroundImage.status === "ready" ? backgroundImage.url : null;

  const pickImage = async () => {
    const selectedPaths = (await platform.selectFiles?.()) ?? [];
    const path = selectedPaths.find((candidate) => candidate.trim().length > 0);
    if (!path) {
      return;
    }
    if (!isSupportedBackgroundImagePath(path)) {
      setUnsupportedPick(true);
      return;
    }
    setUnsupportedPick(false);
    setBackgroundTheme({ imagePath: path });
  };

  const statusMessage = unsupportedPick
    ? intl.formatMessage({ id: "settings.background.imageUnsupported" })
    : backgroundImage.status === "loading"
      ? intl.formatMessage({ id: "settings.background.imageLoading" })
      : backgroundImage.status === "error"
        ? intl.formatMessage({ id: "settings.background.imageFailed" })
        : null;

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.appearance.backgroundTitle" })}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.appearance.backgroundDescription" })}
        </p>
      </div>

      {/* 横排胶囊：12 个预置在 max-w-4xl 内放不下，横向滚动是必要行为而不是妥协。
          必须自己做滚轮映射：`overflow-x-auto` 只吃横向滚动事件，而桌面鼠标只有垂直滚轮，
          Chromium 不会把 deltaY 映射成横向滚动——实测垂直滚轮/横向滚轮/鼠标拖拽全部无效，
          只有触屏能滑。所以这里把垂直滚轮转成 scrollLeft。
          滚动条保留可见（细样式）：隐藏后用户既滚不动也看不出"右边还有"。 */}
      <div
        ref={presetScrollerRef}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]"
        role="group"
        aria-label={intl.formatMessage({ id: "settings.appearance.backgroundTitle" })}
      >
        {PRESET_OPTIONS.map((presetId) => {
          const selected = !hasCustomImage && backgroundTheme.presetId === presetId;
          const label = intl.formatMessage({
            id:
              presetId === "none"
                ? "settings.background.none"
                : `settings.background.preset.${presetId}`,
          });
          return (
            <BackgroundOptionCard
              key={presetId}
              testId={`background-preset-${presetId}`}
              label={label}
              selected={selected}
              imageBacked={presetId !== "none"}
              style={
                presetId === "none"
                  ? undefined
                  : {
                      backgroundColor: "var(--app-background-base)",
                      // 设置页卡片只有 120px 高，位图族用缩略图，避免为预览加载原图。
                      backgroundImage: getBackgroundPresetThumbImage(presetId),
                      backgroundSize: "cover",
                      backgroundPosition: "center",
                    }
              }
              // 选预置等于放弃自定义图片：两者共用同一个垫底层，必须互斥。
              onSelect={() => setBackgroundTheme({ presetId, imagePath: null })}
            />
          );
        })}

        {canPickImage ? (
          <BackgroundOptionCard
            key="custom-image"
            testId="background-preset-custom-image"
            label={intl.formatMessage({
              id: hasCustomImage
                ? "settings.background.replaceImage"
                : "settings.background.uploadImage",
            })}
            removeLabel={intl.formatMessage({ id: "settings.background.removeImage" })}
            selected={hasCustomImage}
            imageBacked={Boolean(customImageUrl)}
            style={
              customImageUrl
                ? { backgroundImage: `url("${customImageUrl}")`, backgroundSize: "cover" }
                : undefined
            }
            onSelect={() => void pickImage()}
            onRemove={hasCustomImage ? () => setBackgroundTheme({ imagePath: null }) : undefined}
          >
            {customImageUrl ? null : (
              <span className="flex h-full w-full items-center justify-center text-foreground-subtle">
                <ImagePlusIcon className="size-5" aria-hidden="true" />
              </span>
            )}
          </BackgroundOptionCard>
        ) : null}
      </div>

      {statusMessage ? (
        <p className="text-ui-sm text-foreground-subtle" data-testid="background-image-status">
          {statusMessage}
        </p>
      ) : null}

      {/* 显示效果：三栏并排小卡。窄屏退化为单列，避免 3×88px 挤破一行。 */}
      <div className="min-w-0 space-y-2">
        <h4 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.background.effectsTitle" })}
        </h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <EffectCard
            label={intl.formatMessage({ id: "settings.background.blur" })}
            detail={`${backgroundTheme.blurPx}px`}
          >
            <input
              type="range"
              min={MIN_BACKGROUND_BLUR_PX}
              max={MAX_BACKGROUND_BLUR_PX}
              value={backgroundTheme.blurPx}
              aria-label={intl.formatMessage({ id: "settings.background.blur" })}
              data-testid="background-blur-slider"
              onChange={(event) =>
                setBackgroundTheme({ blurPx: Number(event.currentTarget.value) })
              }
              className="h-7 w-full accent-primary"
            />
          </EffectCard>
          <EffectCard
            label={intl.formatMessage({ id: "settings.background.scrim" })}
            detail={`${backgroundTheme.scrimPercent}%`}
          >
            <input
              type="range"
              min={MIN_BACKGROUND_SCRIM_PERCENT}
              max={MAX_BACKGROUND_SCRIM_PERCENT}
              value={backgroundTheme.scrimPercent}
              aria-label={intl.formatMessage({ id: "settings.background.scrim" })}
              data-testid="background-scrim-slider"
              onChange={(event) =>
                setBackgroundTheme({ scrimPercent: Number(event.currentTarget.value) })
              }
              className="h-7 w-full accent-primary"
            />
          </EffectCard>
          <EffectCard label={intl.formatMessage({ id: "settings.background.motion" })}>
            <Switch
              aria-label={intl.formatMessage({ id: "settings.background.motion" })}
              checked={backgroundTheme.motion}
              data-testid="background-motion-switch"
              onCheckedChange={(checked) => setBackgroundTheme({ motion: checked })}
            />
          </EffectCard>
        </div>
        <p className="text-ui-sm leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.background.effectsHint" })}
        </p>
      </div>
    </div>
  );
}
