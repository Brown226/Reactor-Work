/**
 * EnterpriseLoginScreen —— 企业服务端登录页，**产品唯一的登录入口**。
 *
 * 这里刻意只做「登录」一件事：企业账号 / 密码 / 服务端地址。没有其它登录方式，
 * 因为本产品的模型与身份都由企业服务端统一提供；登录态由
 * `IReactorServerService` 在 host 侧持有，页面只负责收集输入。
 */
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { ReactorLogo } from "@/components/ui/ReactorLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ReactorServerLoginForm } from "@/login/ReactorServerLoginForm.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";

export type LoginCompleteReason = "enterprise";

export function EnterpriseLoginScreen({
  onComplete,
  showWindowControls = false,
  lockedServerUrl,
}: {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
  /** 自绘标题栏平台（Windows / 非 macOS 桌面）必须显示最小化/最大化/关闭，否则登录页无法关窗或缩窗。 */
  showWindowControls?: boolean;
  /**
   * 由宿主锁定的服务端地址（Web 端：web 容器经 /api/server-info 下发）。
   * 传入后登录页不再显示地址输入框；桌面端不传，保持可编辑。
   */
  lockedServerUrl?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground">
      <ThemeHeroVisual className="absolute inset-0" />
      <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 flex h-12 w-full items-center [app-region:drag]" />
      {showWindowControls ? (
        <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center px-2">
          <DesktopWindowControls />
        </div>
      ) : null}
      <section className="relative z-10 flex w-full max-w-[26rem] flex-col gap-6 rounded-2xl border border-card-border bg-card p-8 shadow-md">
        <header className="space-y-4">
          <div className="inline-flex items-center rounded-full border border-border bg-background-alt px-3 py-1 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "login.enterprise.eyebrow" })}
          </div>
          <div className="flex items-center gap-3">
            <ReactorLogo className="h-8 w-auto" />
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {intl.formatMessage({ id: "login.title" })}
            </h1>
          </div>
        </header>

        <ReactorServerLoginForm
          variant="login"
          onLoggedIn={() => onComplete("enterprise")}
          {...(lockedServerUrl?.trim() ? { lockedServerUrl } : {})}
        />

        <footer className="border-t border-border pt-4 text-ui-base leading-6 text-foreground-subtle">
          <p>{intl.formatMessage({ id: "login.enterprise.helpAdmin" })}</p>
        </footer>
      </section>
    </main>
  );
}

