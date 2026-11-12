import { useState, type FormEvent } from "react";
import "./WebLoginScreen.css";

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg
      className="rl-eye-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {visible ? null : <path d="M3 3l18 18" />}
    </svg>
  );
}

/**
 * Web 网关登录页：企业账号是唯一入口。
 *
 * 这里不接 `@zcode/ui` 的 `useReactorServer`：那个 hook 走 WS RPC，而 WS 本身
 * 需要先有网关会话。登录只调 `POST /api/auth/login`，成功后 reload 再建立 WS。
 */
export function WebLoginScreen({
  identityUrl,
  onLoggedIn,
}: {
  identityUrl?: string;
  onLoggedIn?: () => void;
}) {
  const isZh = /^zh\b/i.test(navigator.language);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(identityUrl?.trim());

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !configured) return;
    const name = username.trim();
    if (!name || !password) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: name, password }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : isZh
              ? `登录失败（${response.status}）`
              : `Login failed (${response.status})`,
        );
      }
      setPassword("");
      if (onLoggedIn) onLoggedIn();
      else window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rl-page">
      <aside className="rl-brand">
        <img className="rl-logo" src="/brand/reactor-logo-white.png" alt="Reactor 数智堆脑" />
        <div className="rl-badge">
          {isZh ? "企业级 AI 办公 · 智能审查" : "AI OFFICE · INTELLIGENT REVIEW"}
        </div>

        <div className="rl-content">
          <p className="rl-kicker">AI WORKSPACE / 智能办公与审查</p>
          <h1 className="rl-title">
            {isZh ? (
              <>
                让办公更高效，
                <br />
                <em>让审查更可靠</em>
              </>
            ) : (
              <>
                Work smarter.
                <br />
                <em>Review with confidence.</em>
              </>
            )}
          </h1>
          <p className="rl-copy">
            {isZh
              ? "Reactor 把文档、表格、演示、资料检索与审查流程放进同一个 AI 工作台。写、查、改、审，一次完成。"
              : "One AI workspace for documents, spreadsheets, slides, research and review. Draft, check, revise and approve in one place."}
          </p>
          <div className="rl-points">
            <span className="rl-point">{isZh ? "AI 办公" : "AI office"}</span>
            <span className="rl-point">{isZh ? "智能审查" : "Smart review"}</span>
            <span className="rl-point">{isZh ? "企业知识" : "Enterprise knowledge"}</span>
            <span className="rl-point">{isZh ? "权限可审计" : "Auditable access"}</span>
          </div>
        </div>

        <div className="rl-foot">REACTOR / AI OFFICE &amp; REVIEW · INTERNAL DEPLOYMENT</div>

        <svg className="rl-diagram" viewBox="0 0 620 620" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeOpacity=".12">
            <circle cx="310" cy="310" r="250" />
            <circle cx="310" cy="310" r="180" strokeDasharray="3 12" />
            <circle cx="310" cy="310" r="110" />
            <path d="M310 20v580M20 310h580" />
            <path d="M310 90 530 310 310 530 90 310Z" />
          </g>
          <g fill="var(--rl-green)">
            <circle cx="310" cy="90" r="5" fillOpacity=".8" />
            <circle cx="530" cy="310" r="4" fillOpacity=".55" />
            <circle cx="310" cy="530" r="3" fillOpacity=".4" />
          </g>
        </svg>
      </aside>

      <main className="rl-panel">
        <section className="rl-card">
          <div className="rl-card-brand">
            <img src="/brand/reactor-icon.png" alt="" />
            <div>
              <strong>Reactor</strong>
              <span>{isZh ? "数智堆脑" : "DIGITAL BRAIN"}</span>
            </div>
          </div>

          <p className="rl-eyebrow">REACTOR AI WORKSPACE</p>
          <h2 className="rl-title2">
            {isZh ? "登录企业账号" : "Sign in to your workspace"}
          </h2>
          <p className="rl-desc">
            {isZh
              ? "使用组织身份继续，进入 AI 办公与审查工作台。"
              : "Continue with your organization account. Sign-in and actions are audited."}
          </p>

          <form className="rl-form" onSubmit={(event) => void submit(event)}>
            <label className="rl-field">
              <span className="rl-label">{isZh ? "账号" : "Username"}</span>
              <input
                autoFocus
                autoComplete="username"
                className="rl-input"
                placeholder={isZh ? "请输入组织账号" : "Organization account"}
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="rl-field">
              <span className="rl-label">{isZh ? "密码" : "Password"}</span>
              <div className="rl-password-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  className="rl-input"
                  placeholder={isZh ? "请输入密码" : "Password"}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="rl-password-toggle"
                  aria-label={
                    showPassword
                      ? isZh
                        ? "隐藏密码"
                        : "Hide password"
                      : isZh
                        ? "显示密码"
                        : "Show password"
                  }
                  aria-pressed={showPassword}
                  disabled={busy}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  <PasswordVisibilityIcon visible={showPassword} />
                </button>
              </div>
            </label>

            {error ? (
              <p role="alert" className="rl-error">
                {error}
              </p>
            ) : null}
            {!configured ? (
              <p className="rl-error">
                {isZh
                  ? "服务端未配置身份服务（REACTOR_IDENTITY_URL），请联系管理员。"
                  : "The server has no identity service configured. Contact your administrator."}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy || !configured || !username.trim() || !password}
              className="rl-submit"
            >
              {busy ? (isZh ? "登录中…" : "Signing in…") : isZh ? "登录" : "Sign in"}
              <span>→</span>
            </button>
          </form>

          <div className="rl-card-foot">
            {isZh
              ? "仅限授权人员使用 · 安全边界内运行"
              : "Authorized personnel only · Runs inside the security boundary"}
          </div>
        </section>
      </main>
    </div>
  );
}
