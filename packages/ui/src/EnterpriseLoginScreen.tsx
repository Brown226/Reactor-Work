/**
 * EnterpriseLoginScreen —— 企业服务端登录页，**产品唯一的登录入口**。
 *
 * 这里刻意只做「登录」一件事：企业账号 / 密码 / 服务端地址。没有其它登录方式，
 * 因为本产品的模型与身份都由企业服务端统一提供；登录态由
 * `IReactorServerService` 在 host 侧持有，页面只负责收集输入。
 */
import { ReactorLogo } from "@/components/ui/ReactorLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ReactorServerLoginForm } from "@/login/ReactorServerLoginForm.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";

export type LoginCompleteReason = "enterprise";

export function EnterpriseLoginScreen({
  onComplete,
}: {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground">
      <ThemeHeroVisual className="absolute inset-0" />
      <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 flex h-12 w-full items-center [app-region:drag]" />
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
          <p className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "login.enterprise.description" })}
          </p>
        </header>

        <ReactorServerLoginForm variant="login" onLoggedIn={() => onComplete("enterprise")} />

        <footer className="space-y-2 border-t border-border pt-4 text-ui-base leading-6 text-foreground-subtle">
          <p>{intl.formatMessage({ id: "login.enterprise.help" })}</p>
          <p>{intl.formatMessage({ id: "login.enterprise.helpAdmin" })}</p>
        </footer>
      </section>
    </main>
  );
}
