/**
 * 企业服务端登录表单：账号 → 密码 → 服务端地址。
 *
 * 登录页与设置页「企业服务端」分区**共用这一份实现**：字段顺序、地址预填、
 * 提交与错误展示只写一遍，避免两处登录行为慢慢分叉。
 * 令牌与企业 provider 的写入都由 `IReactorServerService` 独占，这里只负责收集输入。
 */
import { Loader2, LogIn, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  TID_REACTOR_SERVER_LOGIN,
  TID_REACTOR_SERVER_PASSWORD_INPUT,
  TID_REACTOR_SERVER_STATUS,
  TID_REACTOR_SERVER_URL_INPUT,
  TID_REACTOR_SERVER_USERNAME_INPUT,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useReactorServer } from "@/hooks/useReactorServer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** `settings` = 设置页卡片行布局；`login` = 登录页竖排表单。 */
export type ReactorServerLoginFormVariant = "settings" | "login";

export function ReactorServerLoginForm({
  variant,
  onLoggedIn,
  submitLabelId = "settings.reactorServer.login",
}: {
  variant: ReactorServerLoginFormVariant;
  /** 登录成功后的收尾动作（设置页用来刷新状态，登录页用来进入工作区）。 */
  onLoggedIn?: () => void | Promise<void>;
  submitLabelId?: string;
}) {
  const { intl } = useZCodeIntl();
  const { status, busy, error, login } = useReactorServer();
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const configuredServerUrl = status?.serverUrl ?? null;
  useEffect(() => {
    if (!configuredServerUrl) return;
    // 已配置过地址时回填成草稿，省掉每次重新登录手抄内网地址；
    // 用户自己输入的内容优先（例如正在改指向另一台服务端）。
    setServerUrl((current) => (current.trim() ? current : configuredServerUrl));
  }, [configuredServerUrl]);

  const isBusy = busy !== null;
  const canSubmit =
    !isBusy && serverUrl.trim().length > 0 && username.trim().length > 0 && password.length > 0;

  const handleLogin = useCallback(async () => {
    if (!canSubmit) return;
    const ok = await runUserActionAsync({
      input: { featureId: "settings.reactorServer", action: "login", trigger: "button" },
      operation: () => login({ serverUrl: serverUrl.trim(), username: username.trim(), password }),
      completed: { resultSource: "platform_result" },
      failureStage: "reactor_server_login",
    });
    // 登录成功后立刻清掉内存里的密码：它已经换成了加密落盘的令牌，留在组件状态里没有意义。
    if (ok) {
      setPassword("");
      await onLoggedIn?.();
    }
  }, [canSubmit, login, onLoggedIn, password, serverUrl, username]);

  const onEnter = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") void handleLogin();
    },
    [handleLogin],
  );

  // 登录失败是可重试状态，统一用 warning 语义（与产品里其它登录失败提示一致），不用红色。
  const errorNode =
    error || status?.lastError ? (
      <div data-testid={TID_REACTOR_SERVER_STATUS} data-state="error" role="alert">
        <Alert variant="warning" className="flex items-start gap-2">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <AlertDescription className="min-w-0 break-words text-left">
            {error ?? status?.lastError}
          </AlertDescription>
        </Alert>
      </div>
    ) : null;

  const submitLabel = intl.formatMessage({ id: submitLabelId });
  const submitSpinner = busy === "login" ? <Loader2 className="size-4 animate-spin" /> : null;

  if (variant === "login") {
    return (
      <div className="space-y-4">
        <LoginField label={intl.formatMessage({ id: "settings.reactorServer.username" })}>
          <Input
            size="lg"
            data-testid={TID_REACTOR_SERVER_USERNAME_INPUT}
            value={username}
            disabled={isBusy}
            autoComplete="username"
            autoFocus
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={onEnter}
          />
        </LoginField>
        <LoginField label={intl.formatMessage({ id: "settings.reactorServer.password" })}>
          <Input
            size="lg"
            type="password"
            data-testid={TID_REACTOR_SERVER_PASSWORD_INPUT}
            value={password}
            disabled={isBusy}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={onEnter}
          />
        </LoginField>
        <LoginField
          label={intl.formatMessage({ id: "settings.reactorServer.serverUrl" })}
          hint={intl.formatMessage({ id: "settings.reactorServer.serverUrlDescription" })}
        >
          <Input
            size="lg"
            data-testid={TID_REACTOR_SERVER_URL_INPUT}
            value={serverUrl}
            disabled={isBusy}
            placeholder={intl.formatMessage({
              id: "settings.reactorServer.serverUrlPlaceholder",
            })}
            className="font-mono"
            onChange={(event) => setServerUrl(event.target.value)}
            onKeyDown={onEnter}
          />
        </LoginField>

        {errorNode}

        <Button
          className="h-10 w-full justify-center text-ui-base"
          size="lg"
          data-testid={TID_REACTOR_SERVER_LOGIN}
          disabled={!canSubmit}
          onClick={() => void handleLogin()}
        >
          {submitSpinner ?? (
            <>
              <LogIn className="size-4" />
              {submitLabel}
            </>
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.reactorServer.username" })}
          control={
            <Input
              size="lg"
              data-testid={TID_REACTOR_SERVER_USERNAME_INPUT}
              value={username}
              disabled={isBusy}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={onEnter}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.reactorServer.password" })}
          control={
            <Input
              size="lg"
              type="password"
              data-testid={TID_REACTOR_SERVER_PASSWORD_INPUT}
              value={password}
              disabled={isBusy}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={onEnter}
            />
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.reactorServer.serverUrl" })}
          description={intl.formatMessage({ id: "settings.reactorServer.serverUrlDescription" })}
          control={
            <Input
              size="lg"
              data-testid={TID_REACTOR_SERVER_URL_INPUT}
              value={serverUrl}
              disabled={isBusy}
              placeholder={intl.formatMessage({
                id: "settings.reactorServer.serverUrlPlaceholder",
              })}
              className="font-mono"
              onChange={(event) => setServerUrl(event.target.value)}
              onKeyDown={onEnter}
            />
          }
        />
      </SettingsGroupCard>

      {errorNode}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          data-testid={TID_REACTOR_SERVER_LOGIN}
          disabled={!canSubmit}
          onClick={() => void handleLogin()}
        >
          {submitSpinner ?? (
            <>
              <LogIn className="size-4" />
              {submitLabel}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function LoginField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-ui-base font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-ui-base leading-5 text-foreground-subtle">{hint}</span> : null}
    </label>
  );
}
