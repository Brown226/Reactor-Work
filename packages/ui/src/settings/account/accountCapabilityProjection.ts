/**
 * 「账号」分区的纯展示投影：角色 → 数据范围 / 能力清单，以及额度口径裁决。
 *
 * 为什么单独成文件：这三段都是**没有副作用的纯函数**，也是本分区里唯一有判断逻辑的地方
 * （其余都是排版）。放在一起才能被 `npx tsx --test` 直接覆盖——UI 交互需要真实企业登录态，
 * 而口径算错（尤其额度百分比）恰恰是最容易悄悄错、又最容易被用户当成事实的部分。
 *
 * 事实源：
 * - 角色与数据范围：服务端 `server/packages/server/src/identity/permissions.ts` 的
 *   `ROLE_META` / `permissionAllowed`，以及管理台 `server/packages/admin/src/pages/Roles.tsx`
 *   的 `ROLE_POINTS`。客户端只做**同一套三角色的只读镜像**，不新增权限判定路径。
 * - 额度：`IReactorServerService.getUsageOverview()`（见 `reactorServer.ts`）。
 */

/** 服务端固定三角色（不开放自由角色，见 identity/permissions.ts 护栏）。 */
export const ACCOUNT_ROLES = ["platform_admin", "dept_head", "user"] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** 数据范围（与服务端 `GET /me` 的 `scope.kind` 同口径，此处按角色静态推导）。 */
export type AccountScopeKind = "all" | "dept" | "self";

export interface AccountRoleProfile {
  /** 服务端返回的原始角色串（未知值原样保留，不猜语义）。 */
  readonly role: string;
  /** 已知角色时为其 key；未知角色为 null。 */
  readonly knownRole: AccountRole | null;
  /** 角色徽标文案的 i18n id；未知角色为 null（UI 直接显示原始串）。 */
  readonly labelId: string | null;
  readonly scope: AccountScopeKind | null;
  readonly scopeId: string | null;
  /** 能力清单的 i18n id；未知角色为空数组。 */
  readonly capabilityIds: readonly string[];
}

const ROLE_PROFILES: Readonly<Record<AccountRole, Omit<AccountRoleProfile, "role" | "knownRole">>> = {
  platform_admin: {
    labelId: "settings.account.role.platform_admin",
    scope: "all",
    scopeId: "settings.account.scope.all",
    capabilityIds: [
      "settings.account.capability.admin.users",
      "settings.account.capability.admin.modules",
      "settings.account.capability.admin.sync",
      "settings.account.capability.admin.audit",
    ],
  },
  dept_head: {
    labelId: "settings.account.role.dept_head",
    scope: "dept",
    scopeId: "settings.account.scope.dept",
    capabilityIds: [
      "settings.account.capability.dept.members",
      "settings.account.capability.dept.reports",
      "settings.account.capability.dept.limits",
    ],
  },
  user: {
    labelId: "settings.account.role.user",
    scope: "self",
    scopeId: "settings.account.scope.self",
    capabilityIds: [
      "settings.account.capability.user.profile",
      "settings.account.capability.user.desktop",
      "settings.account.capability.user.usage",
      "settings.account.capability.user.noAdmin",
    ],
  },
};

export function isAccountRole(value: string): value is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/**
 * 角色 → 展示档案。
 *
 * 未知角色**不猜**：服务端将来扩角色时，UI 显示原始串而不是把它归到最接近的一档
 * （把 `auditor` 显示成「普通用户」会让人以为自己的数据范围只有本人，这是错误事实）。
 */
export function resolveAccountRoleProfile(role: string | null | undefined): AccountRoleProfile {
  const raw = typeof role === "string" ? role.trim() : "";
  if (!isAccountRole(raw)) {
    return { role: raw, knownRole: null, labelId: null, scope: null, scopeId: null, capabilityIds: [] };
  }
  return { role: raw, knownRole: raw, ...ROLE_PROFILES[raw] };
}

/** 额度区的口径归属：管理员看组织、部门负责人看本部门、普通用户看本人。 */
export type AccountQuotaScope = "organization" | "department" | "self";

/**
 * 单条额度规则的展示状态。
 *
 * `none` = 未设上限（不渲染进度条，也不拿别的维度冒充一个百分比）；
 * `warn` = 已达告警线但未超限；`over` = 已超上限（是否拦截看 action）。
 */
export type AccountQuotaState = "none" | "ok" | "warn" | "over";

/** 一条适用规则的渲染行（§11.7：每条规则一行，替代原来的"一个数"）。 */
export interface AccountQuotaRow {
  /** React key（同一用户不会同时有两条同 scope 规则，故 scope 即唯一）。 */
  readonly key: string;
  readonly scopeType: "org" | "dept" | "user";
  /** 行标题的 i18n id（组织额度 / 本部门额度 / 我的额度）。 */
  readonly titleId: string;
  /** 周期标签的 i18n id。 */
  readonly periodId: string;
  readonly limitTokens: number | null;
  readonly usedTokens: number;
  /** 使用率 0-100；null = 未设上限（同 `state: "none"`）。 */
  readonly percent: number | null;
  /** 进度条取值（0-100，取整）；`percent` 为 null 时为 0。 */
  readonly percentValue: number;
  readonly state: AccountQuotaState;
  readonly alertThresholds: readonly number[];
  readonly action: "warn" | "block";
  /** 下一周期首日（ISO date，`YYYY-MM-DD`）；周期边界以服务端 period 为权威。 */
  readonly resetIso: string | null;
}

export interface AccountQuotaView {
  readonly scope: AccountQuotaScope;
  /** 用量行标签的 i18n id（与 scope 一一对应，让用户看清这是谁的口径）。 */
  readonly usageLabelId: string;
  /** 服务端聚合用量；null = 未登录 / 服务端不可达（不拿本地队列冒充）。 */
  readonly usageTokens: number | null;
  /** 组织月度上限；null = 未设置上限。 */
  readonly quotaLimit: number | null;
  /**
   * 使用率（0-1）；null = **不应显示百分比与进度条**。
   *
   * 两条路径，`myQuota` 存在时优先（见 `buildAccountQuotaView` 的注释）：
   *
   * ① **同源口径**（`myQuota` 有该项）：服务端按令牌解析出适用规则，
   *    每项自带 used 与 limit，百分比直接来自服务端 —— 任何角色都正确。
   * ② **旧口径回落**（无 myQuota/老服务端）：`getUsageOverview()` 的分子是调用者 scope 内的
   *    用量（普通用户只有自己、部门负责人是本部门子树），分母却是**全组织**上限。两者相除
   *    对非管理员没有意义——部门负责人会把自己部门的消耗当成分母是全组织的比例，
   *    普通用户会以为自己只用掉了组织额度的零头。此时**只对管理员**给出百分比。
   */
  readonly percent: number | null;
  /** 进度条取值（0-100，一位小数）；`percent` 为 null 时为 0。 */
  readonly percentValue: number;
  readonly alertThresholds: readonly number[];
  /** 是否已达最高告警线；仅在口径一致时可判定。 */
  readonly quotaExceeded: boolean;
  readonly pendingEvents: number;
  readonly lastError: string | null;
  /**
   * 逐规则渲染行（§11.7）。有 `myQuota` 时含**全部**适用规则（组织 → 部门 → 本人），
   * 让多规则叠加的约束逐条可见；无 `myQuota` 时为空数组（走旧口径单行回落）。
   */
  readonly rows: readonly AccountQuotaRow[];
  /** 任一阻断规则已超限（端侧据此提示；真正的拦截在网关）。 */
  readonly blocked: boolean;
}

/** `buildAccountQuotaView` 入参里的「我的额度」（QTM P4c，`/desktop/quota/me` 归一化后）。 */
export interface AccountMyQuotaItem {
  readonly scopeType: "org" | "dept" | "user";
  /** org 为 null；dept 是部门 id 字符串；user 是 uid（服务端原样下发） */
  readonly scopeId: string | null;
  readonly limitTokens: number | null;
  readonly usedTokens: number;
  readonly tokenPercent: number | null;
  readonly alertThresholds: readonly number[];
  /** 超限动作：warn 只告警；block 由网关 429（端侧只作展示，不自行判定） */
  readonly action: "warn" | "block";
  readonly exceeded: boolean;
}

export function buildAccountQuotaView(input: {
  role: string | null | undefined;
  usageTokens: number | null;
  quotaLimit: number | null;
  /** 服务端/缓存算出的原始使用率，只作为管理员档的输入。 */
  rawPercent: number | null;
  alertThresholds: readonly number[];
  rawQuotaExceeded: boolean;
  pendingEvents: number;
  lastError: string | null;
  /**
   * 「我的额度」（QTM P4c）：有值时**取代旧口径**作为展示来源 —— 每项自带 used/limit，
   * 分子分母同源，任何角色都能正确显示进度（这是修掉「非管理员不显示百分比」的关键）。
   */
  myQuota?: { readonly items: readonly AccountMyQuotaItem[]; readonly blocked: boolean; readonly period?: string } | null;
}): AccountQuotaView {
  const profile = resolveAccountRoleProfile(input.role);
  const scope: AccountQuotaScope =
    profile.scope === "all" ? "organization" : profile.scope === "dept" ? "department" : "self";
  const usageLabelId =
    scope === "organization"
      ? "settings.account.quota.usageOrganization"
      : scope === "department"
        ? "settings.account.quota.usageDepartment"
        : "settings.account.quota.usageSelf";

  // ── 路径 ①：服务端给到「我的额度」⇒ 逐规则渲染（同源口径） ──
  const wanted = scope === "organization" ? "org" : scope === "department" ? "dept" : "user";
  const mine = input.myQuota?.items.find((item) => item.scopeType === wanted) ?? null;
  const blocked = input.myQuota?.blocked === true;
  if (input.myQuota) {
    const resetIso = nextPeriodResetIso(input.myQuota.period);
    // 展示**全部**适用规则（组织 → 部门 → 本人）：三类规则叠加生效，只显示自己那一条
    // 会让用户以为"组织/部门没设额度"—— 那是错误的结论。
    const rows: AccountQuotaRow[] = input.myQuota.items.map((item) => {
      const percent = item.tokenPercent;
      /**
       * 告警线取**最低**那条：`[80, 100]` 的语义是"到 80% 开始提醒、到 100% 升级"，
       * 所以 80% 就是警示区间的起点。若取最高线，warn 状态永远不可达
       * （达到 100% 时已经该是 over）—— 分段条会一路主色到底再突然变红。
       */
      const firstThreshold =
        item.alertThresholds.length > 0 ? Math.min(...item.alertThresholds) : null;
      const state: AccountQuotaState =
        percent === null
          ? "none"
          : item.exceeded
            ? "over"
            : firstThreshold !== null && percent >= firstThreshold
              ? "warn"
              : "ok";
      return {
        key: `${item.scopeType}:${item.scopeId ?? "org"}`,
        scopeType: item.scopeType,
        titleId:
          item.scopeType === "org"
            ? "settings.account.quota.row.org"
            : item.scopeType === "dept"
              ? "settings.account.quota.row.dept"
              : "settings.account.quota.row.self",
        periodId: "settings.account.quota.row.period",
        limitTokens: item.limitTokens,
        usedTokens: item.usedTokens,
        percent,
        percentValue: percent === null ? 0 : Math.min(100, Math.round(percent)),
        state,
        alertThresholds: item.alertThresholds,
        action: item.action,
        resetIso,
      };
    });
    /**
     * 单数字字段（旧版式与回执文案用）：有本人维度时取该项（同源）；
     * 没有时**不给上限也不给百分比** —— "组织上限 vs 本人用量"是错口径相除，
     * 正是文件头路径 ② 记下的教训。此时权威展示是上面的 `rows`。
     */
    const minePercent = mine?.tokenPercent ?? null;
    return {
      scope,
      usageLabelId,
      usageTokens: mine ? mine.usedTokens : input.usageTokens,
      quotaLimit: mine ? mine.limitTokens : null,
      percent: minePercent === null ? null : minePercent / 100,
      percentValue: minePercent === null ? 0 : Math.min(100, Math.round(minePercent * 10) / 10),
      alertThresholds: mine?.alertThresholds ?? [],
      // 同源口径下服务端的 exceeded 判定可信（它用的是同一个 limit）
      quotaExceeded: mine?.exceeded === true,
      pendingEvents: input.pendingEvents,
      lastError: input.lastError,
      rows,
      blocked,
    };
  }

  // ── 路径 ②：回落旧口径（老服务端 / 未登录）—— 只对管理员给百分比 ──
  const percentUsable =
    scope === "organization" && input.quotaLimit !== null && input.usageTokens !== null;
  const percent = percentUsable ? input.rawPercent : null;
  const percentValue = percent === null ? 0 : Math.min(100, Math.round(percent * 1000) / 10);

  return {
    scope,
    usageLabelId,
    usageTokens: input.usageTokens,
    quotaLimit: input.quotaLimit,
    percent,
    percentValue,
    alertThresholds: input.alertThresholds,
    // 告警线同理：用错口径的 percent 去比阈值，会把「我没用多少」说成「组织没超线」。
    quotaExceeded: percentUsable && input.rawQuotaExceeded,
    pendingEvents: input.pendingEvents,
    lastError: input.lastError,
    rows: [],
    blocked: false,
  };
}

/**
 * 下一周期首日（ISO date）。
 *
 * 周期边界**不在这里推断**：入参是服务端下发的 `period`（`YYYY-MM`，UTC 自然月），
 * 这里只做"给出 period → 算出重置日"的确定性换算。解析不出形状时返回 null
 * （UI 据此不显示重置日期，而不是猜一个"下个月 1 号"）。
 */
export function nextPeriodResetIso(period: string | null | undefined): string | null {
  if (typeof period !== "string") return null;
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  // month=12 时 Date.UTC 自动进位到次年 1 月，无需手写分支
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/**
 * 可用能力计数。
 *
 * `null` 表示**取不到**（host 未注册该服务 / 尚未同步），与 `0`（确实没有）不是一回事：
 * 把「还没同步」显示成「0 个」会让用户以为组织什么都没给他。
 */
export interface AccountCapabilityCounts {
  readonly models: number | null;
  readonly skills: number | null;
  readonly experts: number | null;
}

/** token 数字按当前语言加千分位（intl 实例只有 formatMessage，不带数字格式化）。 */
export function formatAccountTokens(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}
