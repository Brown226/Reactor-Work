/**
 * 强制修改初始密码（阻断式门禁）。
 *
 * 为什么必须是阻断式，而不是一条可忽略的提示：
 *   初始密码是「用户名@123」这种**可预测值**（同事知道账号就能算出密码），
 *   留着它等于账号半公开。只有"不改就不让用"才能保证每个人都至少改过一次；
 *   提示条/横幅会被用户习惯性点掉，实测拦不住人。
 *
 * 为什么自绘而不用通用 Dialog：这里必须同时禁掉 **ESC、点遮罩、关闭按钮** 三条退出路径，
 * 而通用 Dialog 的 `onOpenChange` 语义是"用户可取消"，与需求正好相反。
 *
 * 本组件不持有任何服务状态：登录态与改密动作都由 host 侧 `IReactorServerService` 负责
 * （经 `useReactorServer` 传入），这里只做表单与校验。
 */
import { Loader2, LockKeyhole, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactorServerUserInfo } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PasswordInput } from "@/settings/account/PasswordInput.js";
import { PASSWORD_RULES, isStrongPassword } from "@/settings/account/passwordStrength.js";

export function ForcePasswordChangeDialog({
  user,
  busy,
  error,
  onChangePassword,
}: {
  user: ReactorServerUserInfo;
  /** 是否正在执行改密（父级 busy 态），用于禁用按钮防重复提交。 */
  busy: boolean;
  /** 上一次失败的提示（父级 error）；null 表示无。 */
  error: string | null;
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  // 每次弹出都是全新开始：不保留上一次输入，也不保留上一次的报错
  // （否则用户改成功后再次被要求改时，会看到上一条已无关的错误）。
  useEffect(() => {
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setLocalError(null);
  }, [user.uid]);

  const submit = useCallback(async () => {
    setLocalError(null);
    if (!oldPassword) {
      setLocalError(intl.formatMessage({ id: "settings.account.password.error.oldRequired" }));
      return;
    }
    if (!isStrongPassword(newPassword)) {
      setLocalError(intl.formatMessage({ id: "settings.account.password.error.weak" }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError(intl.formatMessage({ id: "settings.account.password.error.mismatch" }));
      return;
    }
    if (newPassword === oldPassword) {
      setLocalError(intl.formatMessage({ id: "settings.account.password.error.sameAsOld" }));
      return;
    }
    await onChangePassword(oldPassword, newPassword);
  }, [oldPassword, newPassword, confirmPassword, intl, onChangePassword]);

  const shownError = localError ?? error;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
      data-testid="force-password-change"
      // 阻断式：不响应 ESC / 点遮罩（根本不给关闭入口），只能改成功或退出登录。
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <LockKeyhole className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.account.password.forceTitle" })}
            </h2>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.account.password.forceReason" },
                { uid: user.uid },
              )}
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "settings.account.password.old" })}
            </span>
            <PasswordInput
              className="mt-1"
              autoComplete="current-password"
              value={oldPassword}
              onChange={setOldPassword}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "settings.account.password.new" })}
            </span>
            <PasswordInput
              className="mt-1"
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "settings.account.password.confirm" })}
            </span>
            <PasswordInput
              className="mt-1"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </label>

          {/* 规则实时勾选：用户看得见还差哪条，比提交后才报错少一半挫败感。 */}
          <ul className="space-y-1 pt-1">
            {PASSWORD_RULES.map((rule) => {
              const ok = rule.test(newPassword);
              return (
                <li
                  key={rule.key}
                  className={`flex items-center gap-1.5 text-ui-sm ${ok ? "text-emerald-600 dark:text-emerald-400" : "text-foreground-subtle"}`}
                >
                  <span aria-hidden="true">{ok ? "✓" : "○"}</span>
                  {intl.formatMessage({ id: rule.key })}
                </li>
              );
            })}
          </ul>
        </div>

        {shownError ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{shownError}</span>
          </div>
        ) : null}

        <div className="mt-5 flex justify-end">
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {intl.formatMessage({ id: "settings.account.password.submit" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
