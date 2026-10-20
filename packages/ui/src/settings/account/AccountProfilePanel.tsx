/**
 * 「账号」分区的**账号**页：我是谁 + 连到哪 + 有哪些企业模型 + 退出。
 *
 * 这里只做展示与转发，不持有任何状态：登录态、令牌、企业 provider 都在 host 侧
 * `IReactorServerService`，本文件读 `status` 并回调动作。
 * 「额度」与「组织权限」不放这里——它们属于「组织」页，避免把"我的身份"和
 * "组织给了我什么"混成一屏（这正是旧「企业服务端」分区最大的问题）。
 */
import { Loader2, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import type { ReactorServerStatus } from "@zcode/services";
import { REACTOR_SERVER_PROVIDER_NAME } from "@zcode/services";
import { TID_REACTOR_SERVER_LOGOUT, TID_REACTOR_SERVER_SYNC_MODELS } from "@zcode/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveAccountRoleProfile } from "@/settings/account/accountCapabilityProjection.js";
import { AccountCardHeader } from "@/settings/account/accountUiParts.js";
import { PasswordInput } from "@/settings/account/PasswordInput.js";
import { isStrongPassword } from "@/settings/account/passwordStrength.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type { ReactorServerAction } from "@/hooks/useReactorServer.js";

/** 模型清单最多平铺多少个条目，超出的用「等 N 个」概括，避免长列表把设置页撑开。 */
const MODEL_CHIP_LIMIT = 12;

/**
 * 「修改密码」卡：初始密码（用户名@123）可预测，这里给一个**随时能改**的入口。
 *
 * 与阻断式弹窗的分工：弹窗只在 mustChangePassword 时出现（强制），
 * 这张卡是日常自助改密的常规路径。校验口径与弹窗、服务端完全一致
 * （共用 `passwordStrength`），避免三处规则漂移。
 */
function ChangePasswordCard({
  busy,
  error,
  onChangePassword,
}: {
  busy: boolean;
  error: string | null;
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setLocalError(null);
  }, []);

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
    const ok = await onChangePassword(oldPassword, newPassword);
    // 成功后收起并清空：留着上一次的输入会让下一个人（或下次修改）看到旧内容。
    if (ok) {
      reset();
      setOpen(false);
    }
  }, [oldPassword, newPassword, confirmPassword, intl, onChangePassword, reset]);

  const shownError = localError ?? error;

  return (
    <SettingsGroupCard>
      <AccountCardHeader titleId="settings.account.security.title" />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.account.security.changePassword" })}
        description={intl.formatMessage({ id: "settings.account.security.changePasswordHint" })}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="account-change-password-toggle"
            onClick={() => {
              setOpen((v) => !v);
              setLocalError(null);
            }}
          >
            {open
              ? intl.formatMessage({ id: "settings.account.security.collapse" })
              : intl.formatMessage({ id: "settings.account.security.expand" })}
          </Button>
        }
        detail={
          open ? (
            <div className="space-y-3">
              <PasswordInput
                autoComplete="current-password"
                placeholder={intl.formatMessage({ id: "settings.account.password.old" })}
                value={oldPassword}
                onChange={setOldPassword}
                disabled={busy}
              />
              <PasswordInput
                autoComplete="new-password"
                placeholder={intl.formatMessage({ id: "settings.account.password.new" })}
                value={newPassword}
                onChange={setNewPassword}
                disabled={busy}
              />
              <PasswordInput
                autoComplete="new-password"
                placeholder={intl.formatMessage({ id: "settings.account.password.confirm" })}
                value={confirmPassword}
                onChange={setConfirmPassword}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.account.password.ruleHint" })}
              </p>
              {shownError ? (
                <p role="alert" className="text-ui-sm text-destructive">
                  {shownError}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({ id: "settings.account.password.submit" })}
                </Button>
              </div>
            </div>
          ) : null
        }
      />
    </SettingsGroupCard>
  );
}

export function AccountProfilePanel({
  status,
  busy,
  onSyncModels,
  onLogout,
  onChangePassword,
}: {
  status: ReactorServerStatus;
  busy: ReactorServerAction | null;
  onSyncModels: () => void;
  onLogout: () => void;
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const isBusy = busy !== null;
  const user = status.user;
  const roleProfile = resolveAccountRoleProfile(user?.role);
  const roleLabel =
    roleProfile.labelId !== null
      ? intl.formatMessage({ id: roleProfile.labelId })
      : (user?.role ?? "");

  const models = status.models ?? [];
  const visibleModels = models.slice(0, MODEL_CHIP_LIMIT);
  const hiddenModelCount = models.length - visibleModels.length;
  const avatarText = (user?.name ?? user?.uid ?? "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="space-y-6">
      {/* 身份卡：头像 + 姓名 + 角色徽标是这一屏的主语，所以用自绘头部而不是 SettingsRow。 */}
      <SettingsGroupCard>
        <div className="flex items-center gap-4 px-4 py-4">
          <Avatar size="lg">
            <AvatarFallback>{avatarText}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-ui-lg font-semibold text-foreground">
                {user?.name ?? "—"}
              </span>
              {roleLabel ? (
                <span className="shrink-0 rounded-md bg-surface px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {roleLabel}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.account.identity.source" })}
            </div>
          </div>
        </div>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.account.identity.uid" })}
          control={
            <span className="truncate font-mono text-ui-base text-foreground-subtle">
              {user?.uid ?? "—"}
            </span>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.account.identity.dept" })}
          control={
            <span className="truncate text-ui-base text-foreground-subtle">
              {user?.deptPath ?? intl.formatMessage({ id: "settings.account.identity.deptNone" })}
            </span>
          }
        />
      </SettingsGroupCard>

      {/* 安全卡：自助改密。放在身份卡后面——"我是谁"之后紧接着"我的密码安全吗"。 */}
      <ChangePasswordCard
        busy={busy === "changePassword"}
        error={status.lastError}
        onChangePassword={onChangePassword}
      />

      {/* 连接卡：地址是排障第一现场，保持等宽字体便于核对。 */}
      <SettingsGroupCard>
        <AccountCardHeader titleId="settings.account.connection.title" />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.reactorServer.serverUrl" })}
          description={intl.formatMessage(
            { id: "settings.reactorServer.gatewayDescription" },
            { gatewayUrl: status.gatewayBaseUrl ?? "" },
          )}
          control={
            <span className="truncate font-mono text-ui-base text-foreground-subtle">
              {status.serverUrl}
            </span>
          }
        />
      </SettingsGroupCard>

      {/* 企业模型卡：模型清单是"这个账号能用什么"的第一层答案。 */}
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.account.models.title" })}
          description={intl.formatMessage(
            { id: "settings.reactorServer.modelsHint" },
            { provider: REACTOR_SERVER_PROVIDER_NAME },
          )}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={TID_REACTOR_SERVER_SYNC_MODELS}
              disabled={isBusy}
              onClick={onSyncModels}
            >
              {busy === "syncModels" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  <RefreshCw className="size-4" />
                  {intl.formatMessage({ id: "settings.reactorServer.refreshModels" })}
                </>
              )}
            </Button>
          }
          detail={
            visibleModels.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.reactorServer.modelsEmpty" })}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {visibleModels.map((modelId) => (
                  <span
                    key={modelId}
                    className="rounded-md bg-surface px-2 py-0.5 font-mono text-ui-base text-foreground-subtle"
                  >
                    {modelId}
                  </span>
                ))}
                {hiddenModelCount > 0 ? (
                  <span className="px-1 py-0.5 text-ui-base text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.reactorServer.modelsMore" },
                      { count: hiddenModelCount },
                    )}
                  </span>
                ) : null}
              </div>
            )
          }
        />
      </SettingsGroupCard>

      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_REACTOR_SERVER_LOGOUT}
          disabled={isBusy}
          onClick={onLogout}
        >
          {busy === "logout" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <>
              <LogOut className="size-4" />
              {intl.formatMessage({ id: "settings.reactorServer.logout" })}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
