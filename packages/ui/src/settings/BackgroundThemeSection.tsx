/**
 * 外观页的「背景主题」区：工作区整窗背景、预置/自定义图片，以及模糊与覆盖色。
 *
 * 状态直接读 store（与主题、界面字号同一处），不经过 `AppearanceSectionContent` 的
 * 属性链，避免为一段可独立演进的外观设置改动设置页签名。
 * 图片的读取不在这一层：组件只负责选文件与展示状态，读盘与授权在
 * `useBackgroundImageSource`（应用根节点挂一次）。语义见 docs/appearance-background-theme.md。
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { ImagePlusIcon, XIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card.js";
import { cn } from "@/components/lib/utils.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BACKGROUND_PRESETS,
  getBackgroundPresetImage,
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
  /** 卡片底色是否来自图片/渐变：是则标签压深色底条，否则用普通弱化文字。 */
  imageBacked?: boolean;
  style?: CSSProperties;
  onSelect?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-pressed={selected}
        data-testid={testId}
        onClick={onSelect}
        className={cn(
          "relative h-20 w-full overflow-hidden rounded-lg border text-left transition-colors",
          selected ? "border-brand ring-2 ring-brand/40" : "border-border hover:border-border-hover",
          imageBacked ? "" : "border-dashed",
        )}
        style={style}
      >
        {children}
        <span
          className={cn(
            "absolute inset-x-0 bottom-0 truncate px-2 py-1 text-ui-sm font-medium",
            imageBacked
              ? "bg-black/35 text-white backdrop-blur-[2px]"
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
          className="absolute right-1 top-1 rounded-md bg-black/40 p-1 text-white transition-colors hover:bg-black/60"
        >
          <XIcon className="size-3" aria-hidden="true" />
        </button>
      ) : null}
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

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
                  ? { backgroundColor: "var(--color-background)" }
                  : {
                      backgroundColor: "var(--app-background-base)",
                      backgroundImage: getBackgroundPresetImage(presetId),
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

      <Card className="border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          <SettingsRow
            label={intl.formatMessage({ id: "settings.background.blur" })}
            description={intl.formatMessage({ id: "settings.background.blurDescription" })}
            controlLayout="wide"
            detail={
              <span className="w-12 text-right text-ui-base tabular-nums text-foreground-subtle">
                {backgroundTheme.blurPx}px
              </span>
            }
            control={
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
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.background.scrim" })}
            description={intl.formatMessage({ id: "settings.background.scrimDescription" })}
            controlLayout="wide"
            detail={
              <span className="w-12 text-right text-ui-base tabular-nums text-foreground-subtle">
                {backgroundTheme.scrimPercent}%
              </span>
            }
            control={
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
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
