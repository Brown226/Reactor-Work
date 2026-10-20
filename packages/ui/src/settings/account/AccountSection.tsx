/**
 * 「账号」设置分区（原「企业服务端」）。
 *
 * 为什么改名并重排：用户在这个页面里想问的是「我是谁、组织给了我什么」，
 * 而旧版按「服务器 / 模型 / 用量 / 策略」四张卡片平铺，主语是一台机器。
 * 现在页内分两段——**账号**（我是谁 / 连到哪 / 有哪些模型）与
 * **组织**（数据范围 / 可用权限 / 可用能力 / 可用额度 / 策略）。
 *
 * 状态所有者一个都没新增：登录态与令牌走 host 侧 `IReactorServerService`
 * （`useReactorServer`），页内分段选择是组件局部 state（不持久化——
 * 每次进设置页都从「账号」开始，符合"先看自己"的阅读顺序）。
 * 未登录时不渲染任何分段，直接复用首启登录页共用的 `ReactorServerLoginForm`。
 */
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { TID_ACCOUNT_SECTION, TID_ACCOUNT_TAB, TID_REACTOR_SERVER_STATUS } from "@zcode/shared";
import { SegmentedTabs } from "@/components/ui/segmented-tabs.js";
import { useReactorServer } from "@/hooks/useReactorServer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { ReactorServerLoginForm } from "@/login/ReactorServerLoginForm.js";
import { AccountOrgPanel } from "@/settings/account/AccountOrgPanel.js";
import { AccountProfilePanel } from "@/settings/account/AccountProfilePanel.js";

type AccountTab = "profile" | "org";

export function AccountSection() {
  const { intl } = useZCodeIntl();
  const {
    status,
    overview,
    loading,
    busy,
    error,
    logout,
    syncModels,
    refreshUsage,
    changePassword,
  } = useReactorServer();
  const [activeTab, setActiveTab] = useState<AccountTab>("profile");

  const handleLogout = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.account", action: "logout", trigger: "button" },
      operation: () => logout(),
      completed: { resultSource: "local_commit" },
      failureStage: "reactor_server_logout",
    });
  }, [logout]);

  const handleSyncModels = useCallback(() => {
    void runUserActionAsync({
      input: { featureId: "settings.account", action: "refresh_models", trigger: "button" },
      operation: () => syncModels(),
      completed: { resultSource: "platform_result" },
      failureStage: "reactor_server_sync_models",
    });
  }, [syncModels]);

  const handleRefreshUsage = useCallback(() => {
    void runUserActionAsync({
      input: { featureId: "settings.account", action: "refresh_usage", trigger: "button" },
      operation: () => refreshUsage(),
      completed: { resultSource: "platform_result" },
      failureStage: "reactor_server_usage",
    });
  }, [refreshUsage]);

  if (loading) {
    return (
      <div
        data-testid={TID_REACTOR_SERVER_STATUS}
        data-state="loading"
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-6 text-ui-base text-foreground-subtle"
      >
        <Loader2 className="size-4 animate-spin" />
        {intl.formatMessage({ id: "settings.account.status.loading" })}
      </div>
    );
  }

  if (!status?.loggedIn) {
    return <ReactorServerLoginForm variant="settings" />;
  }

  const tabItems = [
    {
      value: "profile" as const,
      label: intl.formatMessage({ id: "settings.account.tab.profile" }),
    },
    { value: "org" as const, label: intl.formatMessage({ id: "settings.account.tab.org" }) },
  ];

  return (
    <div className="space-y-6" data-testid={TID_ACCOUNT_SECTION}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
          {intl.formatMessage({ id: "settings.account.status.loggedIn" })}
        </div>
        <div data-testid={TID_ACCOUNT_TAB}>
          <SegmentedTabs
            items={tabItems}
            value={activeTab}
            onValueChange={setActiveTab}
            ariaLabel={intl.formatMessage({ id: "settings.account.tab.ariaLabel" })}
          />
        </div>
      </div>

      {error || status.lastError ? (
        <div
          data-testid={TID_REACTOR_SERVER_STATUS}
          data-state="error"
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-ui-base text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{error ?? status.lastError}</span>
        </div>
      ) : null}

      {activeTab === "profile" ? (
        <AccountProfilePanel
          status={status}
          busy={busy}
          onSyncModels={handleSyncModels}
          onLogout={() => void handleLogout()}
          onChangePassword={(oldPassword, newPassword) => changePassword(oldPassword, newPassword)}
        />
      ) : (
        <AccountOrgPanel
          status={status}
          overview={overview}
          busy={busy}
          onRefreshUsage={handleRefreshUsage}
        />
      )}
    </div>
  );
}
