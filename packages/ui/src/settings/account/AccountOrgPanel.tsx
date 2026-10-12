/**
 * 「账号」分区的**组织**页：组织给了我什么——数据范围、可用权限、可用能力、可用额度。
 *
 * 边界（本期刻意不做，理由都写在这里，避免下次有人"顺手补上"）：
 * - **不显示组织名**：服务端没有组织实体（只有部门树），`/depts/tree` 对普通用户直接 403，
 *   客户端拿不到也就不能编一个。
 * - **不显示逐条权限点**：`/admin/permissions`、`/admin/roles` 都被 `requireAdmin` 拦死，
 *   普通用户没有「我的权限」接口。这里列的是**按角色的能力说明**（镜像服务端 `ROLE_META`
 *   与管理台 `ROLE_POINTS` 的既有文案），不是权限点的实时投影。
 * - **额度卡单独成文件**：逐规则进度条与旧口径回落都在 `AccountQuotaCard.tsx`
 *   （§11.7 重构），口径判断在同目录 `accountCapabilityProjection.ts`（有单测）。
 */
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactorServerStatus, ReactorServerUsageOverview } from "@zcode/services";
import {
  TID_ACCOUNT_CAPABILITY,
  TID_ACCOUNT_PERMISSIONS,
  TID_REACTOR_SERVER_POLICY,
} from "@zcode/shared";
import { useServerAgentSync } from "@/hooks/useServerAgentSync.js";
import { useServerSkillMarket } from "@/hooks/useServerSkillMarket.js";
import type { ReactorServerAction } from "@/hooks/useReactorServer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveAccountRoleProfile, formatAccountTokens } from "@/settings/account/accountCapabilityProjection.js";
import { AccountQuotaCard } from "@/settings/account/AccountQuotaCard.js";
import { AccountCardHeader, AccountCardNote } from "@/settings/account/accountUiParts.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 技能 / 专家计数：`null` = 该服务的目录投影还没就绪，显示「—」而不是「0 个」。
 * 模型数不在这里——它直接来自登录态（`status.models`），不需要额外订阅。
 */
function useAccountCapabilityCounts(): { skills: number | null; experts: number | null } {
  const { catalog, load } = useServerSkillMarket();
  const { getCatalog } = useServerAgentSync();
  const [expertCount, setExpertCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void getCatalog()
      .then((items) => {
        // 服务端把已停用的专家挡在 `/me/agents` 之外，这里再按定义级启用过滤一次，
        // 保证「可用专家」与聊天里实际能召唤到的集合一致。
        if (active) setExpertCount(items.filter((item) => item.enabled).length);
      })
      .catch(() => {
        if (active) setExpertCount(null);
      });
    return () => {
      active = false;
    };
  }, [getCatalog]);

  /**
   * 技能数不能只读 host 内存投影：web 端没有 host 同步服务，投影恒为空数组，
   * 「企业技能」会永远显示「—」（服务端实际下发了 24 个）—— 用户看到的就是
   * "组织什么都没给我"。故这里显式拉一次目录；失败仍回落「—」，不拿 0 冒充。
   *
   * 桌面端首帧由 host 同步填好，`catalog.length > 0` 时跳过，不会重复请求。
   */
  useEffect(() => {
    if (catalog.length > 0) return;
    void load().catch(() => undefined);
  }, [catalog.length, load]);

  const skills = catalog.length > 0 ? catalog.filter((item) => item.installEnabled).length : null;

  return { skills, experts: expertCount };
}

export function AccountOrgPanel({
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
  const user = status.user;
  const roleProfile = resolveAccountRoleProfile(user?.role);
  const roleLabel =
    roleProfile.labelId !== null
      ? intl.formatMessage({ id: roleProfile.labelId })
      : (user?.role ?? "—");
  const scopeLabel =
    roleProfile.scopeId !== null
      ? intl.formatMessage({ id: roleProfile.scopeId })
      : intl.formatMessage({ id: "settings.account.scope.unknown" });

  const counts = useAccountCapabilityCounts();
  // 企业模型数直接来自登录态里的目录（不额外发网络请求）。
  const modelCount = status.models?.length ?? 0;
  const policyMode = overview?.policyMode ?? null;

  const formatCount = (value: number | null): string =>
    value === null ? "—" : formatAccountTokens(value, locale);

  return (
    <div className="space-y-6">
      {/* 数据范围卡：先回答"我的数据边界在哪"，再谈能力与额度。 */}
      <SettingsGroupCard>
        <AccountCardHeader titleId="settings.account.scope.title" />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.account.scope.role" })}
          control={<span className="truncate text-ui-base text-foreground">{roleLabel}</span>}
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.account.scope.range" })}
          description={intl.formatMessage({ id: "settings.account.scope.hint" })}
          control={<span className="truncate text-ui-base text-foreground">{scopeLabel}</span>}
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

      {/* 可用权限卡：按角色列出的能力说明，不是权限点的实时投影。 */}
      <SettingsGroupCard>
        <AccountCardHeader titleId="settings.account.permissions.title" />
        <div className="px-4 py-3" data-testid={TID_ACCOUNT_PERMISSIONS}>
          {roleProfile.capabilityIds.length === 0 ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.account.permissions.unknown" })}
            </p>
          ) : (
            <ul className="space-y-2">
              {roleProfile.capabilityIds.map((capabilityId) => (
                <li key={capabilityId} className="flex items-start gap-2 text-ui-base text-foreground">
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="min-w-0">{intl.formatMessage({ id: capabilityId })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <AccountCardNote>
          {intl.formatMessage({ id: "settings.account.permissions.note" })}
        </AccountCardNote>
      </SettingsGroupCard>

      {/* 可用能力卡：目录投影的计数（模型 / 技能 / 专家）。 */}
      <SettingsGroupCard>
        <AccountCardHeader titleId="settings.account.capability.title" />
        <div
          className="grid grid-cols-3 gap-3 px-4 py-4"
          data-testid={TID_ACCOUNT_CAPABILITY}
        >
          {(
            [
              ["settings.account.capability.models", modelCount],
              ["settings.account.capability.skills", counts.skills],
              ["settings.account.capability.experts", counts.experts],
            ] as const
          ).map(([labelId, value]) => (
            <div key={labelId} className="min-w-0">
              <div className="text-ui-lg font-semibold text-foreground">{formatCount(value)}</div>
              <div className="truncate text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: labelId })}
              </div>
            </div>
          ))}
        </div>
        <AccountCardNote>
          {intl.formatMessage({ id: "settings.account.capability.note" })}
        </AccountCardNote>
      </SettingsGroupCard>

      {/* 组织策略卡：能力清单说"我可以做什么"，策略说"组织把它卡在哪一档"。 */}
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.account.policy.title" })}
          description={intl.formatMessage({
            id:
              overview?.policySource === "server"
                ? "settings.reactorServer.policySourceServer"
                : "settings.reactorServer.policySourceUnknown",
          })}
          control={
            <span
              data-testid={TID_REACTOR_SERVER_POLICY}
              className="inline-flex items-center gap-1.5 text-ui-base font-medium text-foreground"
            >
              <ShieldCheck className="size-4 text-foreground-subtle" />
              {policyMode === null
                ? intl.formatMessage({ id: "settings.reactorServer.policyUnrestricted" })
                : intl.formatMessage({ id: `settings.reactorServer.policy.mode.${policyMode}` })}
            </span>
          }
          detail={
            <div className="space-y-1 text-ui-base text-foreground-subtle">
              <p>{intl.formatMessage({ id: "settings.reactorServer.policyModeHint" })}</p>
              <p>
                {intl.formatMessage(
                  { id: "settings.reactorServer.policyCommandBlacklist" },
                  { count: overview?.commandBlacklistCount ?? 0 },
                )}
                {" · "}
                {intl.formatMessage(
                  { id: "settings.reactorServer.policyEgressAllowlist" },
                  { count: overview?.egressAllowlistCount ?? 0 },
                )}
              </p>
              {overview?.policyStale ? (
                <p className="text-amber-600 dark:text-amber-400">
                  {intl.formatMessage({ id: "settings.reactorServer.policyStale" })}
                </p>
              ) : null}
            </div>
          }
        />
      </SettingsGroupCard>

      {/* 可用额度卡：逐规则进度（分段条 + 重置日），口径与阻断判定同源 —— 见 AccountQuotaCard。 */}
      <AccountQuotaCard
        status={status}
        overview={overview}
        busy={busy}
        onRefreshUsage={onRefreshUsage}
      />
    </div>
  );
}
