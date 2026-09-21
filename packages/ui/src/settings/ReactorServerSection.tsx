/**
 * 企业服务端设置分区。
 *
 * 只负责「登录 / 看状态 / 刷新模型 / 退出」这条用户可见链路；
 * 令牌、企业 provider、网关鉴权都由 `IReactorServerService` 在 host 侧独占管理，
 * 这里不读凭据、不写 provider 配置，因此也不存在"UI 与服务端两份真相"的问题。
 * 未登录时的表单与首启登录页共用 `ReactorServerLoginForm`。
 */
import { AlertTriangle, CheckCircle2, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useCallback } from "react";
import { REACTOR_SERVER_PROVIDER_NAME } from "@zcode/services";
import {
  TID_REACTOR_SERVER_LOGOUT,
  TID_REACTOR_SERVER_STATUS,
  TID_REACTOR_SERVER_SYNC_MODELS,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useReactorServer } from "@/hooks/useReactorServer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { ReactorServerLoginForm } from "@/login/ReactorServerLoginForm.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 模型清单最多平铺多少个条目，超出的用「+N」概括，避免长列表把设置页撑开。 */
const MODEL_CHIP_LIMIT = 12;

export function ReactorServerSection() {
  const { intl } = useZCodeIntl();
  const { status, loading, busy, error, logout, syncModels } = useReactorServer();

  const loggedIn = Boolean(status?.loggedIn);
  const isBusy = busy !== null;

  const handleLogout = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.reactorServer", action: "logout", trigger: "button" },
      operation: () => logout(),
      completed: { resultSource: "local_commit" },
      failureStage: "reactor_server_logout",
    });
  }, [logout]);

  const handleSyncModels = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.reactorServer", action: "refresh_models", trigger: "button" },
      operation: () => syncModels(),
      completed: { resultSource: "platform_result" },
      failureStage: "reactor_server_sync_models",
    });
  }, [syncModels]);

  if (loading) {
    return (
      <div
        data-testid={TID_REACTOR_SERVER_STATUS}
        data-state="loading"
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-6 text-ui-base text-foreground-subtle"
      >
        <Loader2 className="size-4 animate-spin" />
        {intl.formatMessage({ id: "settings.reactorServer.status.loading" })}
      </div>
    );
  }

  if (!loggedIn) {
    return <ReactorServerLoginForm variant="settings" />;
  }

  const models = status?.models ?? [];
  const visibleModels = models.slice(0, MODEL_CHIP_LIMIT);
  const hiddenModelCount = models.length - visibleModels.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        {intl.formatMessage({ id: "settings.reactorServer.status.loggedIn" })}
      </div>

      {error || status?.lastError ? (
        <div
          data-testid={TID_REACTOR_SERVER_STATUS}
          data-state="error"
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-ui-base text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{error ?? status?.lastError}</span>
        </div>
      ) : null}

      <SettingsGroupCard>
        {status?.user ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.reactorServer.account" })}
            description={intl.formatMessage(
              { id: "settings.reactorServer.accountDescription" },
              {
                uid: status.user.uid,
                role: status.user.role,
                // 部门是可选的：拼在角色后面，缺失时不留孤立分隔符。
                dept: status.user.deptPath ? ` · ${status.user.deptPath}` : "",
              },
            )}
            control={
              <span className="truncate text-ui-base font-medium text-foreground">
                {status.user.name}
              </span>
            }
          />
        ) : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.reactorServer.serverUrl" })}
          description={intl.formatMessage(
            { id: "settings.reactorServer.gatewayDescription" },
            { gatewayUrl: status?.gatewayBaseUrl ?? "" },
          )}
          control={
            <span className="truncate font-mono text-ui-base text-foreground-subtle">
              {status?.serverUrl}
            </span>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.reactorServer.models" })}
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
              onClick={() => void handleSyncModels()}
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

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_REACTOR_SERVER_LOGOUT}
          disabled={isBusy}
          onClick={() => void handleLogout()}
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
