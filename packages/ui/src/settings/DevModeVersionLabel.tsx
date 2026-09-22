/**
 * 版本号（开发者模式入口）。
 *
 * 外观上就是一个普通的版本号：不写"连点解锁"之类的提示——隐藏入口不能自我暴露
 * （原项目 Reactor-Desktop 的口径：隐藏入口的进度条等于把后门画在门上）。只有真正解锁/反锁
 * 的那一刻才显示一行结果提示。
 *
 * 每个实例有自己的连点计数（见 `useDevTap`），因此"在这个地方连续点 7 下"是唯一能自我验证的操作。
 * 语义见 `docs/model-governance-and-dev-mode.md`。
 */
import { ZCODE_BUILD_TIME, ZCODE_VERSION } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useDevTap } from "@/lib/devMode.js";

export function DevModeVersionLabel({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const { onTap, hint } = useDevTap();

  return (
    <span className={cn("inline-flex min-w-0 flex-col items-start gap-0.5", className)}>
      {/* title 里带上构建时间：排查"改了没生效"时最先要看的就是它 */}
      <button
        type="button"
        data-testid="dev-mode-version"
        title={`v${ZCODE_VERSION} · ${ZCODE_BUILD_TIME}`}
        onClick={onTap}
        className="max-w-full cursor-default truncate rounded px-1 text-ui-xs text-foreground-subtlest transition-colors hover:text-foreground-subtle"
      >
        v{ZCODE_VERSION}
      </button>
      {hint ? (
        <span role="status" className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({
            id: hint === "unlocked" ? "settings.devMode.unlocked" : "settings.devMode.locked",
          })}
        </span>
      ) : null}
    </span>
  );
}
