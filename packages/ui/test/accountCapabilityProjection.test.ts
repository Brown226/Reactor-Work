/**
 * 「账号」分区纯逻辑回归（`npx tsx --test packages/ui/test/accountCapabilityProjection.test.ts`）。
 *
 * 为什么值得钉：这一分区里唯一有判断逻辑的就是「角色 → 数据范围 / 能力清单」和
 * 「额度百分比能不能算」。两者都是**算错了也不会报错、只会显示成事实**的地方——
 * 尤其非管理员档：`getUsageOverview()` 的分子是调用者 scope 内用量、分母是全组织上限，
 * 一旦这里退回 `rawPercent`，普通用户会看到「我只用掉组织额度的 0.3%」这种错数。
 * 同时钉住 i18n key 与两份 locale 的对应关系：key 写错时 `formatMessage` 只会回显 id，
 * 界面上就是一行 `settings.account.quota.usageValue`，没有编译期保护。
 */
import assert from "node:assert/strict";
import test from "node:test";

import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  ACCOUNT_ROLES,
  buildAccountQuotaView,
  formatAccountTokens,
  isAccountRole,
  nextPeriodResetIso,
  resolveAccountRoleProfile,
  type AccountQuotaView,
} from "../src/settings/account/accountCapabilityProjection.js";

const LOCALES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ["zh-CN", zhCN as unknown as Record<string, string>],
  ["en-US", enUS as unknown as Record<string, string>],
];

function quota(overrides: Partial<Parameters<typeof buildAccountQuotaView>[0]> = {}): AccountQuotaView {
  return buildAccountQuotaView({
    role: "user",
    usageTokens: 850,
    quotaLimit: 1000,
    rawPercent: 0.85,
    alertThresholds: [80, 100],
    rawQuotaExceeded: true,
    pendingEvents: 0,
    lastError: null,
    ...overrides,
  });
}

test("isAccountRole：只认服务端固定三角色", () => {
  for (const role of ACCOUNT_ROLES) assert.equal(isAccountRole(role), true);
  assert.equal(isAccountRole("auditor"), false);
  assert.equal(isAccountRole(""), false);
  assert.equal(isAccountRole("Platform_Admin"), false);
});

test("resolveAccountRoleProfile：三角色的范围与能力清单齐全", () => {
  assert.deepEqual(resolveAccountRoleProfile("platform_admin"), {
    role: "platform_admin",
    knownRole: "platform_admin",
    labelId: "settings.account.role.platform_admin",
    scope: "all",
    scopeId: "settings.account.scope.all",
    capabilityIds: [
      "settings.account.capability.admin.users",
      "settings.account.capability.admin.modules",
      "settings.account.capability.admin.sync",
      "settings.account.capability.admin.audit",
    ],
  });
  assert.equal(resolveAccountRoleProfile("dept_head").scope, "dept");
  assert.equal(resolveAccountRoleProfile("user").scope, "self");
});

test("resolveAccountRoleProfile：未知角色不猜语义，只回原始串", () => {
  const unknown = resolveAccountRoleProfile("auditor");
  assert.equal(unknown.role, "auditor");
  assert.equal(unknown.knownRole, null);
  assert.equal(unknown.labelId, null);
  assert.equal(unknown.scope, null);
  assert.equal(unknown.scopeId, null);
  assert.deepEqual(unknown.capabilityIds, []);

  // 服务端将来新增角色时，绝不能被归到最接近的一档。
  assert.equal(resolveAccountRoleProfile("auditor").scope, null);
  assert.notEqual(resolveAccountRoleProfile("auditor").scope, "self");
});

test("resolveAccountRoleProfile：null / undefined / 空白不抛错", () => {
  for (const value of [null, undefined, "", "   "]) {
    const profile = resolveAccountRoleProfile(value);
    assert.equal(profile.role, "");
    assert.equal(profile.knownRole, null);
  }
});

test("buildAccountQuotaView：管理员才折算百分比（分子分母同口径）", () => {
  const admin = quota({ role: "platform_admin" });
  assert.equal(admin.scope, "organization");
  assert.equal(admin.usageLabelId, "settings.account.quota.usageOrganization");
  assert.equal(admin.percent, 0.85);
  assert.equal(admin.percentValue, 85);
  assert.equal(admin.quotaExceeded, true);
});

test("buildAccountQuotaView：非管理员一律不给百分比，即便 rawPercent 有值", () => {
  const head = quota({ role: "dept_head" });
  assert.equal(head.scope, "department");
  assert.equal(head.usageLabelId, "settings.account.quota.usageDepartment");
  assert.equal(head.percent, null);
  assert.equal(head.percentValue, 0);
  assert.equal(head.quotaExceeded, false);

  const member = quota({ role: "user" });
  assert.equal(member.scope, "self");
  assert.equal(member.usageLabelId, "settings.account.quota.usageSelf");
  assert.equal(member.percent, null);
  assert.equal(member.percentValue, 0);
  // 错口径的告警线同样必须压掉：否则「我没用多少」会被说成「组织没超线」。
  assert.equal(member.quotaExceeded, false);
});

/**
 * QTM P4c：有「我的额度」（服务端按令牌解析的同源口径）时，**取代**旧口径。
 * 这是本文件里唯一"非管理员也能有百分比"的路径 —— 因为此时分子分母
 * 都是该角色自己的维度（部门负责人=本部门子树，成员=本人）。
 */
test("buildAccountQuotaView：有 myQuota 时同源口径生效，非管理员也有正确百分比", () => {
  // 部门负责人：本部门 300/1000 = 30%（旧口径下会是 null）
  const head = quota({
    role: "dept_head",
    myQuota: {
      blocked: false,
      items: [
        { scopeId: null, scopeType: "dept", limitTokens: 1000, usedTokens: 300, tokenPercent: 30, alertThresholds: [80], action: "warn", exceeded: false },
      ],
    },
  });
  assert.equal(head.scope, "department");
  assert.equal(head.usageTokens, 300, "用量取 myQuota 的 used（同源）");
  assert.equal(head.quotaLimit, 1000, "上限取 myQuota 的 limit（同源）");
  assert.equal(head.percent, 0.3);
  assert.equal(head.percentValue, 30);
  assert.equal(head.quotaExceeded, false);
  assert.deepEqual(head.alertThresholds, [80], "阈值也取该维度的，不混用组织线");

  // 普通成员：本人 95/100 = 95% ⇒ 告警线判定可信（同源）
  const member = quota({
    role: "user",
    myQuota: {
      blocked: true,
      items: [
        { scopeId: null, scopeType: "user", limitTokens: 100, usedTokens: 95, tokenPercent: 95, alertThresholds: [80, 100], action: "block", exceeded: true },
      ],
    },
  });
  assert.equal(member.scope, "self");
  assert.equal(member.percent, 0.95);
  assert.equal(member.quotaExceeded, true, "同源口径下服务端的 exceeded 判定可信");
});

/**
 * §11.7：逐规则行是权威展示。**全部**适用规则都要出行（组织 → 部门 → 本人），
 * 只显示自己那一条会让人以为"组织/部门没设额度"——那是错误结论。
 */
test("buildAccountQuotaView：rows 覆盖全部适用规则，按 org→dept→user 顺序", () => {
  const view = quota({
    role: "user",
    myQuota: {
      blocked: false,
      period: "2026-10",
      items: [
        { scopeId: null, scopeType: "user", limitTokens: 100, usedTokens: 95, tokenPercent: 95, alertThresholds: [80, 100], action: "block", exceeded: true },
        { scopeId: null, scopeType: "org", limitTokens: 1_000_000, usedTokens: 500_000, tokenPercent: 50, alertThresholds: [80], action: "warn", exceeded: false },
      ],
    },
  });
  assert.deepEqual(
    view.rows.map((r) => r.scopeType),
    ["user", "org"],
    "行序沿用服务端下发顺序（不自行重排：服务端已按 org→dept→user 解析）",
  );
  const org = view.rows.find((r) => r.scopeType === "org")!;
  assert.equal(org.titleId, "settings.account.quota.row.org");
  assert.equal(org.usedTokens, 500_000);
  assert.equal(org.limitTokens, 1_000_000);
  assert.equal(org.percent, 50);
  assert.equal(org.state, "ok");
  assert.equal(org.resetIso, "2026-11-01", "重置日由服务端 period 推出");
  const me = view.rows.find((r) => r.scopeType === "user")!;
  assert.equal(me.titleId, "settings.account.quota.row.self");
  assert.equal(me.action, "block");
  assert.equal(me.state, "over", "exceeded 且已达最高阈值 ⇒ over");
  assert.equal(view.blocked, false, "blocked 取自服务端口径，不自行推断");
});

test("buildAccountQuotaView：行状态分级 ok / warn / over / none", () => {
  const row = (over: Partial<Parameters<typeof buildAccountQuotaView>[0]>): string => {
    const v = buildAccountQuotaView({
      role: "user",
      usageTokens: 0,
      quotaLimit: null,
      rawPercent: null,
      alertThresholds: [],
      rawQuotaExceeded: false,
      pendingEvents: 0,
      lastError: null,
      myQuota: {
        blocked: false,
        items: [
          {
            scopeType: "user",
            limitTokens: 100,
            usedTokens: 0,
            tokenPercent: 0,
            alertThresholds: [80, 100],
            action: "warn",
            exceeded: false,
          },
        ],
      },
      ...over,
    });
    return v.rows[0]!.state;
  };
  assert.equal(row({}), "ok", "低于告警线");
  assert.equal(
    row({
      myQuota: {
        blocked: false,
        items: [
          { scopeId: null, scopeType: "user", limitTokens: 100, usedTokens: 85, tokenPercent: 85, alertThresholds: [80, 100], action: "warn", exceeded: false },
        ],
      },
    }),
    "warn",
    "达到告警线但未超限",
  );
  assert.equal(
    row({
      myQuota: {
        blocked: false,
        items: [
          { scopeId: null, scopeType: "user", limitTokens: 100, usedTokens: 120, tokenPercent: 120, alertThresholds: [80, 100], action: "warn", exceeded: true },
        ],
      },
    }),
    "over",
    "超限（哪怕 action=warn 也如实标红）",
  );
  assert.equal(
    row({
      myQuota: {
        blocked: false,
        items: [
          { scopeId: null, scopeType: "user", limitTokens: null, usedTokens: 42, tokenPercent: null, alertThresholds: [], action: "warn", exceeded: false },
        ],
      },
    }),
    "none",
    "未设上限 ⇒ 不给假进度",
  );
});

test("buildAccountQuotaView：myQuota 缺该角色维度 ⇒ 只渲染实际适用的规则，不冒充个人上限", () => {
  // 给的是 org 项，但调用者是普通成员（需要 user 项）⇒ 不能把组织上限当成本人上限
  const member = quota({
    role: "user",
    myQuota: {
      blocked: false,
      period: "2026-10",
      items: [
        { scopeId: null, scopeType: "org", limitTokens: 9_999_999, usedTokens: 1, tokenPercent: 1, alertThresholds: [80], action: "warn", exceeded: false },
      ],
    },
  });
  assert.equal(member.scope, "self");
  assert.equal(member.quotaLimit, null, "没有本人维度的项 ⇒ 不拿组织上限冒充");
  assert.equal(member.percent, null, "旧口径下的非管理员仍不给百分比");
  // 但组织规则确实约束着他：作为一行"组织额度"如实渲染（同源数字）
  assert.equal(member.rows.length, 1);
  assert.equal(member.rows[0]!.scopeType, "org");
  assert.equal(member.rows[0]!.limitTokens, 9_999_999);
  assert.equal(member.rows[0]!.usedTokens, 1);
});

test("buildAccountQuotaView：myQuota 项无上限（tokenPercent=null）⇒ 不给百分比", () => {
  const member = quota({
    role: "user",
    myQuota: {
      blocked: false,
      items: [
        { scopeId: null, scopeType: "user", limitTokens: null, usedTokens: 42, tokenPercent: null, alertThresholds: [], action: "warn", exceeded: false },
      ],
    },
  });
  assert.equal(member.usageTokens, 42, "用量照常显示");
  assert.equal(member.quotaLimit, null);
  assert.equal(member.percent, null, "无上限时不能凭空算百分比");
  assert.equal(member.percentValue, 0);
  assert.equal(member.rows[0]!.percent, null);
  assert.equal(member.rows[0]!.percentValue, 0);
});

test("buildAccountQuotaView：无 myQuota ⇒ rows 为空、blocked 为 false（走旧口径回落）", () => {
  const view = quota({ role: "platform_admin" });
  assert.deepEqual(view.rows, []);
  assert.equal(view.blocked, false);
});

test("nextPeriodResetIso：按服务端 period 推算下一周期首日", () => {
  assert.equal(nextPeriodResetIso("2026-10"), "2026-11-01");
  assert.equal(nextPeriodResetIso("2026-12"), "2027-01-01", "跨年自动进位");
  assert.equal(nextPeriodResetIso("2026-01"), "2026-02-01");
  // 解析不出形状时返回 null：UI 据此不显示重置日期，而不是猜一个"下个月 1 号"
  for (const bad of [null, undefined, "", "2026-10-01", "2026-13", "2026-00", "abc", "26-10"]) {
    assert.equal(nextPeriodResetIso(bad as string | null | undefined), null, `拒绝 ${String(bad)}`);
  }
});

test("buildAccountQuotaView：未知角色按最窄口径处理（self），不冒充管理员", () => {
  const unknown = quota({ role: "auditor" });
  assert.equal(unknown.scope, "self");
  assert.equal(unknown.percent, null);
  assert.equal(unknown.quotaExceeded, false);
});

test("buildAccountQuotaView：缺上限或缺用量时不折算，且不拿 0 冒充", () => {
  const noLimit = quota({ role: "platform_admin", quotaLimit: null });
  assert.equal(noLimit.percent, null);
  assert.equal(noLimit.quotaLimit, null);
  assert.equal(noLimit.quotaExceeded, false);
  // 用量本身仍如实保留，UI 据此走「未设置上限」分支。
  assert.equal(noLimit.usageTokens, 850);

  const noUsage = quota({ role: "platform_admin", usageTokens: null });
  assert.equal(noUsage.usageTokens, null);
  assert.equal(noUsage.percent, null);
  assert.equal(noUsage.quotaExceeded, false);
});

test("buildAccountQuotaView：percentValue 封顶 100 且保留一位小数", () => {
  assert.equal(quota({ role: "platform_admin", rawPercent: 1.4 }).percentValue, 100);
  assert.equal(quota({ role: "platform_admin", rawPercent: 0.1234 }).percentValue, 12.3);
});

test("buildAccountQuotaView：告警线与本地队列状态原样透传", () => {
  const view = quota({
    role: "user",
    alertThresholds: [80, 100],
    pendingEvents: 3,
    lastError: "network down",
  });
  assert.deepEqual(view.alertThresholds, [80, 100]);
  assert.equal(view.pendingEvents, 3);
  assert.equal(view.lastError, "network down");
});

test("formatAccountTokens：按 locale 加千分位，异常输入不抛错", () => {
  assert.equal(formatAccountTokens(268196, "en-US"), "268,196");
  assert.equal(formatAccountTokens(0, "en-US"), "0");
  assert.equal(formatAccountTokens(268196, "not a locale!!"), "268196");
});

test("i18n：投影产出的每个 key 在 zh-CN / en-US 都有非空文案", () => {
  const keyIds = new Set<string>([
    "settings.account.role.platform_admin",
    "settings.account.role.dept_head",
    "settings.account.role.user",
    "settings.account.scope.all",
    "settings.account.scope.dept",
    "settings.account.scope.self",
    "settings.account.scope.unknown",
    "settings.account.quota.usageOrganization",
    "settings.account.quota.usageDepartment",
    "settings.account.quota.usageSelf",
    "settings.account.quota.usageValue",
    "settings.account.quota.usageNoLimit",
    "settings.account.quota.usageNoPercent",
    "settings.account.quota.noteOrganization",
    "settings.account.quota.noteScoped",
    // §11.7 逐规则行：标题 / 周期 / 无上限 / 阈值 / 重置日 / 动作 / 阻断提示
    "settings.account.quota.row.org",
    "settings.account.quota.row.dept",
    "settings.account.quota.row.self",
    "settings.account.quota.row.period",
    "settings.account.quota.rowNoLimit",
    "settings.account.quota.rowThreshold",
    "settings.account.quota.rowReset",
    "settings.account.quota.action.warn",
    "settings.account.quota.action.block",
    "settings.account.quota.blocked",
    "settings.account.quota.blockedReset",
  ]);
  for (const role of ACCOUNT_ROLES) {
    for (const id of resolveAccountRoleProfile(role).capabilityIds) keyIds.add(id);
    const labelId = resolveAccountRoleProfile(role).labelId;
    if (labelId) keyIds.add(labelId);
  }

  for (const [localeName, messages] of LOCALES) {
    for (const id of keyIds) {
      const value = messages[id];
      assert.equal(typeof value, "string", `${localeName} 缺 key: ${id}`);
      assert.notEqual(value.trim(), "", `${localeName} 的 ${id} 是空串`);
    }
  }
});

test("i18n：额度百分比模板必须含 percent 占位符（否则管理员档会丢信息）", () => {
  for (const [localeName, messages] of LOCALES) {
    assert.match(
      messages["settings.account.quota.usageValue"] ?? "",
      /\{percent\}/,
      `${localeName} 的 usageValue 丢了 {percent}`,
    );
    assert.match(messages["settings.account.quota.usageValue"] ?? "", /\{used\}/);
    assert.match(messages["settings.account.quota.usageValue"] ?? "", /\{limit\}/);
    assert.match(messages["settings.account.quota.usageValue"] ?? "", /\{usageLabel\}/);
    // 非管理员档不给百分比，模板里也不能偷偷留 percent。
    assert.doesNotMatch(messages["settings.account.quota.usageNoPercent"] ?? "", /\{percent\}/);
  }
});

test("i18n：逐规则行模板的占位符齐全（缺一个就少一个事实）", () => {
  for (const [, messages] of LOCALES) {
    assert.match(messages["settings.account.quota.rowNoLimit"] ?? "", /\{used\}/);
    assert.match(messages["settings.account.quota.rowThreshold"] ?? "", /\{thresholds\}/);
    assert.match(messages["settings.account.quota.rowReset"] ?? "", /\{date\}/);
    assert.match(messages["settings.account.quota.blockedReset"] ?? "", /\{date\}/);
  }
});
