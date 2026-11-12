// 登录页（T1-3 重写）：方向 A 视觉不变（无营销/无渐变，单栏 + 双源 + 合规底线），
// 控件换为 shadcn（Card/Input/Button/Label），认证走 stores/auth。

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeSlash, Key, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useAuthStore } from "../stores/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { cn } from "../lib/utils";

export function Login() {
  const login = useAuthStore((s) => s.login);
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!username || !password) {
      setErr("请输入账号与密码");
      return;
    }
    setBusy(true);
    try {
      const u = await login(username, password);
      nav(u.role === "user" ? "/account" : "/", { replace: true });
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login-visual">
        <div className="login-visual__top">
          <img
            className="login-visual__logo"
            src="/brand/reactor-logo-white.png"
            alt="Reactor 数智堆脑"
          />
          <span className="login-visual__admin-mark">管理端</span>
        </div>
        <div className="login-visual__badge">ADMIN CONSOLE · 仅限管理员</div>

        <div className="login-visual__content">
          <p className="login-visual__kicker">REACTOR CONTROL PLANE / 管理面</p>
          <h1>
            管理端控制台
            <br />
            <span>组织 · 模型 · 审计</span>
          </h1>
          <p>
            统一管理组织与权限、模型与网关、版本发布与审计日志。
            这里是 Reactor 的管理面，仅限管理员与运营人员。
          </p>
          <div className="login-visual__points">
            <span>组织与权限</span>
            <span>模型治理</span>
            <span>版本发布</span>
            <span>审计日志</span>
          </div>
        </div>

        <div className="login-visual__foot">REACTOR ADMIN CONSOLE · AUTHORIZED PERSONNEL ONLY</div>
        <div className="login-visual__watermark">
          ADMIN
        </div>

        <svg className="login-visual__diagram" viewBox="0 0 620 620" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeOpacity=".12">
            <circle cx="310" cy="310" r="250" />
            <circle cx="310" cy="310" r="180" strokeDasharray="3 12" />
            <circle cx="310" cy="310" r="110" />
            <path d="M310 20v580M20 310h580" />
            <path d="M310 90 530 310 310 530 90 310Z" />
          </g>
          <g fill="#d9a85a">
            <circle cx="310" cy="90" r="5" fillOpacity=".8" />
            <circle cx="530" cy="310" r="4" fillOpacity=".55" />
            <circle cx="310" cy="530" r="3" fillOpacity=".4" />
          </g>
        </svg>
      </aside>

      <main className="login-panel">
        <div className="login-card">
          <div className="login-brand" data-admin-login-brand="">
            <img className="brand-mark" src="/brand/reactor-icon.png" alt="" width={50} height={50} data-admin-login-logo="" />
            <div className="brand-name" data-admin-login-title="">
              <span className="login-brand-line">
                Reactor 管理台 <em className="login-admin-pill">管理端</em>
              </span>
              <small>数智堆脑 · REACTOR CONSOLE</small>
            </div>
          </div>
          <h1 className="login-title">登录管理端</h1>
          <div className="login-sub" data-admin-login-sub="">
            仅限管理员与运营人员，使用管理账号进入控制台。
          </div>

          {err && (
            <div className="login-err">
              <WarningCircle size={15} /> {err}
            </div>
          )}

          <form className="login-form" onSubmit={(e) => void submit(e)}>
            <div className="field">
              <Label className="login-label" htmlFor="login-username">账号</Label>
              <Input
                id="login-username"
                className="login-input"
                autoFocus
                autoComplete="username"
                placeholder="域账号或本地账号"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <Label className="login-label" htmlFor="login-password">密码</Label>
              <div className="password-wrap">
                <Input
                  id="login-password"
                  className="login-input"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  disabled={busy}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? <EyeSlash size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            <Button className={cn("w-full")} variant="default" type="submit" disabled={busy}>
              {busy ? <SpinnerGap size={15} className="spin" /> : <Key size={15} />}
              登 录
            </Button>
          </form>

          <div className="login-foot">
            域账号 / 本地账号统一登录 · LDAP 同步组织与部门
            <br />
            仅限管理员与运营人员使用
          </div>
        </div>
      </main>
    </div>
  );
}
