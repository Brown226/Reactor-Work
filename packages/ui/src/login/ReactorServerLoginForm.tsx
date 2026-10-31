/**
 * 企业服务端登录表单：账号 → 密码 → 服务端地址。
 *
 * 登录页与设置页「账号」分区**共用这一份实现**：字段顺序、地址预填、
 * 提交与错误展示只写一遍，避免两处登录行为慢慢分叉。
 * 令牌与企业 provider 的写入都由 `IReactorServerService` 独占，这里只负责收集输入。
 */
import { EyeIcon, EyeOffIcon, Loader2, LogIn, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  DesktopCommandIds,
  isCredentialDecryptError,
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
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** `settings` = 设置页卡片行布局；`login` = 登录页竖排表单。 */
export type ReactorServerLoginFormVariant = "settings" | "login";

export function ReactorServerLoginForm({
  variant,
  onLoggedIn,
  submitLabelId = "settings.reactorServer.login",
  lockedServerUrl,
}: {
  variant: ReactorServerLoginFormVariant;
  /** 登录成功后的收尾动作（设置页用来刷新状态，登录页用来进入工作区）。 */
  onLoggedIn?: () => void | Promise<void>;
  submitLabelId?: string;
  /**
   * 锁定的服务端地址。由宿主在「它自己知道该连哪个 identity」时传入（Web 端：
   * web 容器经 /api/server-info 下发），此时隐藏地址输入框，用户只需填账号密码。
   * 桌面端不传 → 完全保持原有行为（用户可编辑地址）。
   */
  lockedServerUrl?: string;
}) {
  const { intl } = useZCodeIntl();
  const { status, busy, error, login } = useReactorServer();
  const platform = usePlatform();
  const [serverUrl, setServerUrl] = useState(lockedServerUrl?.trim() ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);

  const configuredServerUrl = status?.serverUrl ?? null;
  useEffect(() => {
    if (!configuredServerUrl) return;
    // 已配置过地址时回填成草稿，省掉每次重新登录手抄内网地址；
    // 用户自己输入的内容优先（例如正在改指向另一台服务端）。
    // 锁定地址优先级最高：它来自部署配置，不能被历史配置或用户输入覆盖。
    setServerUrl((current) =>
      lockedServerUrl?.trim() ? lockedServerUrl.trim() : current.trim() ? current : configuredServerUrl,
    );
  }, [configuredServerUrl, lockedServerUrl]);

  const isBusy = busy !== null;
  // 登录成功到应用重启完成之间的过渡：避免「点完没反应，界面突然整块换掉」的断裂感。
  const [entering, setEntering] = useState(false);
  const canSubmit =
    !isBusy &&
    !entering &&
    serverUrl.trim().length > 0 &&
    username.trim().length > 0 &&
    password.length > 0;

  const handleLogin = useCallback(async () => {
    if (!canSubmit) return;
    const ok = await runUserActionAsync({
      input: { featureId: "settings.account", action: "login", trigger: "button" },
      operation: () => login({ serverUrl: serverUrl.trim(), username: username.trim(), password }),
      completed: { resultSource: "platform_result" },
      failureStage: "reactor_server_login",
    });
    // 登录成功后立刻清掉内存里的密码：它已经换成了加密落盘的令牌，留在组件状态里没有意义。
    if (ok) {
      setPassword("");
      // 企业登录会切换数据命名空间（marker 由 host 在登录落盘），而 scope 只在进程启动时
      // 解析一次、已打开的 tasks-index/db 句柄不会跟着搬。桌面端必须重启，否则新账号
      // 看到的仍是上一个人的任务与会话。
      // ⚠ 判据用显式能力位 supportsAppRelaunch，不能再用
      // `typeof executeDesktopCommand === "function"`：Web 的 stub 同样实现了该方法（no-op），
      // 旧判据在 Web 上恒真，登录成功后既不重启也不进工作区，卡在「登录中…」。
      if (platform.supportsAppRelaunch === true) {
        setEntering(true);
        await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
        return;
      }
      await onLoggedIn?.();
    }
  }, [canSubmit, login, onLoggedIn, password, platform, serverUrl, username]);

  const onEnter = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") void handleLogin();
    },
    [handleLogin],
  );

  // 登录失败是可重试状态，统一用 warning 语义（与产品里其它登录失败提示一致），不用红色。
  //
  // 2026-10-30：凭据解密失败不再静默。它此前被整条吞掉，而它恰恰会让每次登录都 FAIL，
  // 界面零反馈，用户看到的就是「点登录按钮没有任何反应」（真实事故，见
  // docs/未完成-企业provider可见性与登录自愈-spec-v1.md）。
  // 服务层已把该情形降级为「缓存失效 + 自动重建」；万一仍上浮到这里，说明自动重建也失败了，
  // 必须给一句用户能执行的话，而不是技术原文。
  const rawError = error ?? status?.lastError ?? null;
  const visibleError = rawError
    ? isCredentialDecryptError(rawError)
      ? intl.formatMessage({ id: "settings.reactorServer.credentialReset" })
      : rawError
    : null;
  const errorNode = visibleError ? (
    <div data-testid={TID_REACTOR_SERVER_STATUS} data-state="error" role="alert">
      <Alert variant="warning" className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <AlertDescription className="min-w-0 break-words text-left">
          {visibleError}
        </AlertDescription>
      </Alert>
    </div>
  ) : null;

  const submitLabel = entering
    ? intl.formatMessage({ id: "settings.reactorServer.entering" })
    : intl.formatMessage({ id: submitLabelId });
  const submitSpinner =
    busy === "login" || entering ? <Loader2 className="size-4 animate-spin" /> : null;

  if (variant === "login") {
    return (
      <div className="space-y-4">
        <LoginField label={intl.formatMessage({ id: "settings.reactorServer.username" })}>
          <Input
            size="lg"
            data-testid={TID_REACTOR_SERVER_USERNAME_INPUT}
            value={username}
            disabled={isBusy || entering}
            autoComplete="username"
            autoFocus
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={onEnter}
          />
        </LoginField>
        <LoginField label={intl.formatMessage({ id: "settings.reactorServer.password" })}>
          <div className="relative">
            <Input
              size="lg"
              type={passwordVisible ? "text" : "password"}
              data-testid={TID_REACTOR_SERVER_PASSWORD_INPUT}
              value={password}
              disabled={isBusy || entering}
              autoComplete="current-password"
              className="pr-10"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={onEnter}
            />
            {/* 与模型设置的 API Key 输入同款交互：密码默认遮蔽，可临时显示以便核对长口令。 */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={isBusy || entering}
              className="absolute top-1/2 right-1.5 -translate-y-1/2"
              aria-label={intl.formatMessage({
                id: passwordVisible ? "login.password.hide" : "login.password.show",
              })}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible ? (
                <EyeOffIcon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )}
            </Button>
          </div>
        </LoginField>
        {/* 登录页不显示地址说明：首次登录的人还没有"网关端口"的概念，
            这行只会增加噪音；设置页仍保留该说明（见下方 settings 变体）。
            锁定地址时整块隐藏：Web 端的地址由 web 容器下发，用户无从选择，
            展示一个不可编辑的内网服务名只会让人困惑。 */}
        {lockedServerUrl?.trim() ? null : (
          <LoginField label={intl.formatMessage({ id: "settings.reactorServer.serverUrl" })}>
            <Input
              size="lg"
              data-testid={TID_REACTOR_SERVER_URL_INPUT}
              value={serverUrl}
              disabled={isBusy || entering}
              placeholder={intl.formatMessage({
                id: "settings.reactorServer.serverUrlPlaceholder",
              })}
              className="font-mono"
              onChange={(event) => setServerUrl(event.target.value)}
              onKeyDown={onEnter}
            />
          </LoginField>
        )}

        {errorNode}

        <Button
          className="h-10 w-full justify-center text-ui-base"
          size="lg"
          data-testid={TID_REACTOR_SERVER_LOGIN}
          disabled={!canSubmit}
          onClick={() => void handleLogin()}
        >
          {/* 提交中给「转圈 + 登录中…」：只转圈不给字，用户无法确认点击是否生效。 */}
          {submitSpinner ?? <LogIn className="size-4" />}
          {submitSpinner ? (
            <span>{intl.formatMessage({ id: "welcome.loggingIn" })}</span>
          ) : (
            submitLabel
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
              disabled={isBusy || entering}
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
              disabled={isBusy || entering}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={onEnter}
            />
          }
        />
        {/* 锁定地址时设置页同样不显示该行：Web 用户改不了它，暴露只会造成误解 */}
        {lockedServerUrl?.trim() ? null : (
          <SettingsRow
            controlLayout="wide"
            label={intl.formatMessage({ id: "settings.reactorServer.serverUrl" })}
            description={intl.formatMessage({ id: "settings.reactorServer.serverUrlDescription" })}
            control={
              <Input
                size="lg"
                data-testid={TID_REACTOR_SERVER_URL_INPUT}
                value={serverUrl}
                disabled={isBusy || entering}
                placeholder={intl.formatMessage({
                  id: "settings.reactorServer.serverUrlPlaceholder",
                })}
                className="font-mono"
                onChange={(event) => setServerUrl(event.target.value)}
                onKeyDown={onEnter}
              />
            }
          />
        )}
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
