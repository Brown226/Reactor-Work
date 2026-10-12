/**
 * 「可用额度」卡（§11.7 重构）。
 *
 * 为什么拆出独立文件：这块从"一行文字"变成"多行组件"后，排版与状态判断都不少；
 * 塞回 `AccountOrgPanel` 会让那个文件同时讲四张卡的故事。
 *
 * 版式对齐参考图（用量限额）：**每条适用规则一行** —— 标题 + 百分比、分段进度条、
 * 阈值/动作、重置日期。用分段条而不是连续条：20 格让人直接数出"用了多少格"，
 * 低占比时也不会细成一条看不见的线。
 *
 * 口径：`buildAccountQuotaView`（同目录纯函数，有单测）—— 有 `myQuota` 时逐规则
 * **同源**渲染（分子分母都来自服务端按令牌解析的那一条）；没有时回落旧口径单行
 * （老服务端），不假装有数据。
 */
import { Loader2, RefreshCw } from "lucide-react";
import type { ReactorServerStatus, ReactorServerUsageOverview } from "@zcode/services";
import { TID_ACCOUNT_QUOTA, TID_REACTOR_SERVER_REFRESH_USAGE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildAccountQuotaView,
  formatAccountTokens,
  type AccountQuotaRow,
  type AccountQuotaView,
} from "@/settings/account/accountCapabilityProjection.js";
import { AccountCardNote } from "@/settings/account/accountUiParts.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type { ReactorServerAction } from "@/hooks/useReactorServer.js";

/** 分段进度条的格数（参考图同量级；20 格 = 每格 5%）。 */
const SEGMENTS = 20;

/** 分段进度条：按占比填色，颜色跟随状态（正常=主色 / 告警线=warning / 超限=destructive）。 */
function SegmentedQuotaBar({ value, state }: { value: number; state: AccountQuotaRow["state"] }) {
  const filled = Math.min(SEGMENTS, Math.max(0, Math.round((value / 100) * SEGMENTS)));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="flex items-center gap-[3px]"
    >
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn(
            "h-2 flex-1 rounded-[2px]",
            i < filled
              ? state === "over"
                ? "bg-destructive"
                : state === "warn"
                  ? "bg-warning"
                  : "bg-primary"
              : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

/** 重置日期按当前语言格式化（输入是服务端周期推出的 ISO date）。 */
function formatResetDate(iso: string, locale: string): string | null {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", timeZone: "UTC" }).format(date);
  } catch {
    return iso;
  }
}

/** 一条规则一行：标题/百分比 → 分段条 → 阈值·动作/重置日。 */
function QuotaRuleRow({ row, locale }: { row: AccountQuotaRow; locale: string }) {
  const { intl } = useZCodeIntl();
  const resetLabel = row.resetIso === null ? null : formatResetDate(row.resetIso, locale);
  const thresholdText =
    row.alertThresholds.length > 0 ? `${row.alertThresholds.join("% / ")}%` : null;
  return (
    <div className="space-y-1.5" data-testid={`quota-row-${row.scopeType}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: row.titleId })}
          <span className="ml-2 font-normal text-foreground-subtle">
            {intl.formatMessage({ id: row.periodId })}
          </span>
        </span>
        <span className="shrink-0 font-mono text-ui-base text-foreground">
          {formatAccountTokens(row.usedTokens, locale)}
          {" / "}
          {row.limitTokens === null ? "∞" : formatAccountTokens(row.limitTokens, locale)}
          {row.percent !== null ? ` · ${row.percent.toFixed(0)}%` : ""}
        </span>
      </div>
      {row.limitTokens === null ? (
        // 未设上限（旧配置合成项的常见形态）：只报已用，不给假进度
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.account.quota.rowNoLimit" },
            { used: formatAccountTokens(row.usedTokens, locale) },
          )}
        </p>
      ) : (
        <>
          <SegmentedQuotaBar value={row.percentValue} state={row.state} />
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <span className="min-w-0 truncate">
              {thresholdText === null
                ? null
                : intl.formatMessage({ id: "settings.account.quota.rowThreshold" }, { thresholds: thresholdText })}
              {" · "}
              <span className={row.action === "block" ? "text-destructive" : undefined}>
                {intl.formatMessage({
                  id:
                    row.action === "block"
                      ? "settings.account.quota.action.block"
                      : "settings.account.quota.action.warn",
                })}
              </span>
            </span>
            {resetLabel === null ? null : (
              <span className="shrink-0">
                {intl.formatMessage({ id: "settings.account.quota.rowReset" }, { date: resetLabel })}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 旧口径单行（老服务端没有 `/desktop/quota/me` 时）。
 *
 * 保留而不是删掉：服务端未升级时端侧不能显示空白。此时分子是调用者 scope 内用量、
 * 分母是全组织上限，**只有管理员档**给百分比与进度条（见投影里的路径 ②）。
 */
function LegacyQuotaLine({ quota, locale }: { quota: AccountQuotaView; locale: string }) {
  const { intl } = useZCodeIntl();
  if (quota.usageTokens === null) {
    return (
      <p className="text-ui-base text-foreground">
        {intl.formatMessage({ id: "settings.reactorServer.usageUnavailable" })}
      </p>
    );
  }
  const used = formatAccountTokens(quota.usageTokens, locale);
  const usageLabel = intl.formatMessage({ id: quota.usageLabelId });
  if (quota.quotaLimit === null) {
    return (
      <p className="text-ui-base text-foreground">
        {intl.formatMessage(
          { id: "settings.account.quota.usageNoLimit" },
          { usageLabel, used },
        )}
      </p>
    );
  }
  if (quota.percent === null) {
    // 非管理员：分子是本 scope 的用量、分母是全组织上限，两个事实分开列。
    return (
      <p className="text-ui-base text-foreground">
        {intl.formatMessage(
          { id: "settings.account.quota.usageNoPercent" },
          { usageLabel, used, limit: formatAccountTokens(quota.quotaLimit, locale) },
        )}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-ui-base text-foreground">
        {intl.formatMessage(
          { id: "settings.account.quota.usageValue" },
          {
            usageLabel,
            used,
            limit: formatAccountTokens(quota.quotaLimit, locale),
            percent: quota.percentValue,
          },
        )}
      </p>
      <div className="h-1 w-full overflow-hidden rounded-md bg-muted">
        <div
          className={cn("h-full rounded-full", quota.quotaExceeded ? "bg-destructive" : "bg-primary")}
          style={{ width: `${quota.percentValue}%` }}
        />
      </div>
      {quota.quotaExceeded ? (
        <p className="text-ui-base text-destructive">
          {intl.formatMessage({ id: "settings.reactorServer.usageExceeded" }, { percent: Math.max(...quota.alertThresholds) })}
        </p>
      ) : null}
    </div>
  );
}

export function AccountQuotaCard({
  status,
  overview,
  busy,
  onRefreshUsage,
}: {
  status: ReactorServerStatus;
  overview: ReactorServerUsageOverview | null;
  busy: ReactorServerAction | null;
  onRefreshUsage: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const quota = buildAccountQuotaView({
    role: status.user?.role,
    usageTokens: overview?.monthTokens ?? null,
    quotaLimit: overview?.quotaLimit ?? null,
    rawPercent: overview?.percent ?? null,
    alertThresholds: overview?.alertThresholds ?? [],
    rawQuotaExceeded: overview?.quotaExceeded ?? false,
    pendingEvents: overview?.pendingEvents ?? 0,
    lastError: overview?.lastError ?? null,
    // 「我的额度」（QTM P4c）：有值时按同源口径展示（分子分母都是该角色的维度），
    // 修掉「非管理员一律不显示百分比」——现在部门负责人/普通成员也能看到自己的真实进度。
    ...(overview?.myQuota ? { myQuota: overview.myQuota } : {}),
  });
  // 同一周期 ⇒ 所有行的重置日相同，取第一行即可（没有行时不显示）
  const resetLabel = (() => {
    const iso = quota.rows[0]?.resetIso;
    return iso === undefined || iso === null ? null : formatResetDate(iso, locale);
  })();

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.account.quota.title" })}
        description={intl.formatMessage({ id: "settings.account.quota.hint" })}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_REACTOR_SERVER_REFRESH_USAGE}
            disabled={busy !== null}
            onClick={onRefreshUsage}
          >
            {busy === "refreshUsage" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <>
                <RefreshCw className="size-4" />
                {intl.formatMessage({ id: "settings.reactorServer.usageRefresh" })}
              </>
            )}
          </Button>
        }
        detail={
          <div data-testid={TID_ACCOUNT_QUOTA} className="space-y-3">
            {quota.blocked ? (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
                {intl.formatMessage({ id: "settings.account.quota.blocked" })}
                {resetLabel === null
                  ? null
                  : ` ${intl.formatMessage({ id: "settings.account.quota.blockedReset" }, { date: resetLabel })}`}
              </p>
            ) : null}
            {quota.rows.length > 0 ? (
              quota.rows.map((row) => <QuotaRuleRow key={row.key} row={row} locale={locale} />)
            ) : (
              <LegacyQuotaLine quota={quota} locale={locale} />
            )}
            {quota.pendingEvents > 0 ? (
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.reactorServer.usagePending" }, { count: quota.pendingEvents })}
              </p>
            ) : null}
            {quota.lastError ? (
              <p className="min-w-0 break-words text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.reactorServer.usageReportError" }, { error: quota.lastError })}
              </p>
            ) : null}
          </div>
        }
      />
      <AccountCardNote>
        {intl.formatMessage({
          id:
            quota.scope === "organization"
              ? "settings.account.quota.noteOrganization"
              : "settings.account.quota.noteScoped",
        })}
      </AccountCardNote>
    </SettingsGroupCard>
  );
}
