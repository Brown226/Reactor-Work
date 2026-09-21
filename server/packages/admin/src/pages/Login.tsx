// 登录页（T1-3 重写）：方向 A 视觉不变（无营销/无渐变，单栏 + 双源 + 合规底线），
// 控件换为 shadcn（Card/Input/Button/Label），认证走 stores/auth。

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Key, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
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
      <div className="login-card">
        <div className="login-brand" data-admin-login-brand="">
          <img className="brand-mark" src="/brand/logo-cube.jpg" alt="" width={36} height={36} data-admin-login-logo="" />
          <div className="brand-name" data-admin-login-title="">
            Reactor 管理台
            <small>数智堆脑 · REACTOR CONSOLE</small>
          </div>
        </div>
        <div className="login-sub" data-admin-login-sub="">受控推理 · 自主执行 · 可信审计 —— 登录即组织身份，所有操作可审计</div>

        {err && (
          <div className="login-err">
            <WarningCircle size={15} /> {err}
          </div>
        )}

        <form className="login-form" onSubmit={(e) => void submit(e)}>
          <div className="field">
            <Label htmlFor="login-username">账号</Label>
            <Input
              id="login-username"
              autoFocus
              autoComplete="username"
              placeholder="域账号或本地账号"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <Label htmlFor="login-password">密码</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button className={cn("w-full")} variant="default" type="submit" disabled={busy}>
            {busy ? <SpinnerGap size={15} className="spin" /> : <Key size={15} />}
            登 录
          </Button>
        </form>

        <div className="login-foot">
          域账号 / 本地账号 统一登录 · LDAP 同步组织与部门
          <br />
          仅供授权人员使用
        </div>
      </div>
    </div>
  );
}
