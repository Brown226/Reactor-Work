/**
 * P4.3 CLI 侧权限强制点回归：命令黑名单（组织硬边界）。
 *
 * 运行（仓库无统一 test 入口，按 packages/core/test 既有约定手动执行）：
 *   cd apps/zcode-cli/packages/core && npx tsx --test test/desktop-policy-gates.test.ts
 *
 * 2026-10-13：原「模式天花板」用例已移除——组织 defaultApprovalMode 不再与用户会话 mode
 * 取交集（见 docs/未完成-服务端接线-P4-用量上报与策略.md 头部 2026-10-13 变更说明）。
 * 改为回归守护相反的行为：**即使用组织策略把档位配成 edit，用户选 yolo 仍按 yolo 生效**。
 *
 * 守的产品边界：
 * ① 黑名单是组织硬边界：命中即拒绝，与模式档位无关；
 * ② 用户档位优先：组织 defaultApprovalMode 不得压低用户在桌面端选择的档位；
 * ③ 未配置（无策略）时行为与接线前一致。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReactorDesktopPolicy,
  ReactorDesktopPolicySource,
  ReactorManagedMcpServer,
} from "@zcode/shared";

import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";

function policySource(policy: ReactorDesktopPolicy | null): ReactorDesktopPolicySource {
  return { current: () => policy };
}

function defaultPolicy(overrides: Partial<ReactorDesktopPolicy> = {}): ReactorDesktopPolicy {
  return {
    defaultApprovalMode: "yolo",
    commandBlacklist: [],
    egressAllowlist: [],
    quota: { monthlyTokenLimit: null, alertThresholds: [80, 100] },
    // 白名单默认关闭（不含编程档）与空托管面：与 shared 的 DEFAULT 同口径（spec §1）。
    allowedInterfaceModes: ["office", "review"],
    managedMcp: { servers: [] },
    ...overrides,
  };
}

function service(policy: ReactorDesktopPolicy | null): PermissionService {
  return new PermissionService({ ...defaultPermissionConfig, desktopPolicy: policySource(policy) });
}

test("命令黑名单：命中即拒绝，理由是可读中文，且与模式档位无关", () => {
  const permission = service(defaultPolicy({ commandBlacklist: ["rm -rf", "shutdown"] }));
  const denied = permission.checkPermission({
    toolName: "Bash",
    input: { command: "sudo RM -RF /tmp/important" },
    riskLevel: "high",
    // 即便会话在 yolo 档，黑名单仍然先拦（组织硬边界）。
    mode: "yolo",
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.allowed, false);
  assert.equal(denied.ruleId, "policy.commandBlacklist");
  assert.match(denied.reason ?? "", /组织策略/);
  assert.match(denied.reason ?? "", /rm -rf/);
});

test("命令黑名单：未命中的命令不受影响（yolo 仍走 mode.yolo）", () => {
  const permission = service(defaultPolicy({ commandBlacklist: ["rm -rf"] }));
  const allowed = permission.checkPermission({
    toolName: "Bash",
    input: { command: "ls -la" },
    riskLevel: "low",
    mode: "yolo",
  });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "mode.yolo");
});

test("命令黑名单：没有桌面策略时不生效（与接线前一致）", () => {
  const permission = service(null);
  const allowed = permission.checkPermission({
    toolName: "Bash",
    input: { command: "rm -rf /tmp/x" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "mode.yolo");
});

// 2026-10-13 新增回归：本用例守护「用户档位不被组织策略压低」。
// 修复前这里断言的是相反行为（decision.mode === "edit"），即组织把档位配成 edit 时
// 用户选 yolo 会被静默压成 edit —— 那正是「设了完全访问但每次仍要确认」的根因。
test("用户档位优先：组织策略配成 edit 时，用户选 yolo 仍按 yolo 生效", () => {
  const permission = service(defaultPolicy({ defaultApprovalMode: "edit" }));
  const decision = permission.checkPermission({
    toolName: "Bash",
    input: { command: "npm run build" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(decision.mode, "yolo", "组织策略不得压低用户选择的档位");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("用户档位优先：低于组织档位的选择同样保持原档（edit 不被抬高）", () => {
  const permission = service(defaultPolicy({ defaultApprovalMode: "edit" }));
  const decision = permission.checkPermission({
    toolName: "Read",
    input: { file_path: "a.md" },
    riskLevel: "low",
    mode: "plan",
  });
  assert.equal(decision.mode, "plan");
});

test("用户档位优先：没有桌面策略时原样放行（不引入额外限制）", () => {
  const permission = service(null);
  const decision = permission.checkPermission({
    toolName: "Bash",
    input: { command: "npm test" },
    riskLevel: "low",
    mode: "yolo",
  });
  assert.equal(decision.mode, "yolo");
  assert.equal(decision.ruleId, "mode.yolo");
});

// ===== 托管 MCP 三档（治理平面 P0，spec 见 docs/未完成-MCP治理平面-spec-v1.md） =====

const MANAGED_SERVER: ReactorManagedMcpServer = {
  id: "srv-1",
  name: "crm",
  type: "http",
  enabled: true,
  toolPolicy: { list_contacts: "allow", delete_contact: "block" },
  defaultToolPolicy: "ask",
};

test("托管 MCP：block 是组织硬边界，yolo 也拦", () => {
  const permission = service(
    defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] } }),
  );
  const denied = permission.checkPermission({
    toolName: "mcp__crm__delete_contact",
    input: { id: "42" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.allowed, false);
  assert.equal(denied.ruleId, "policy.managedMcp");
});

test("托管 MCP：ask 强制确认，yolo 不直通", () => {
  const permission = service(
    defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] } }),
  );
  const asked = permission.checkPermission({
    toolName: "mcp__crm__update_opportunity",
    input: { id: "42" },
    riskLevel: "medium",
    mode: "yolo",
  });
  assert.equal(asked.decision, "ask");
  assert.equal(asked.ruleId, "policy.managedMcp");
});

test("托管 MCP：allow 免确认（build/edit 下同样放行）", () => {
  const permission = service(
    defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] } }),
  );
  const allowed = permission.checkPermission({
    toolName: "mcp__crm__list_contacts",
    input: {},
    riskLevel: "low",
    mode: "build",
  });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "policy.managedMcp");
});

test("托管 MCP：同步新增、管理员未登记的工具默认 ask（防上游升级提权）", () => {
  const permission = service(
    defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] } }),
  );
  const asked = permission.checkPermission({
    toolName: "mcp__crm__export_all_data",
    input: {},
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(asked.decision, "ask");
  assert.equal(asked.ruleId, "policy.managedMcp");
});

test("托管 MCP：停用的服务不参与判定（下发面不携带，双保险）", () => {
  const permission = service(
    defaultPolicy({
      managedMcp: { servers: [{ ...MANAGED_SERVER, enabled: false }] },
    }),
  );
  const allowed = permission.checkPermission({
    toolName: "mcp__crm__delete_contact",
    input: { id: "42" },
    riskLevel: "high",
    mode: "yolo",
  });
  // 停用服务的工具本不该被注入会话；这里即便被直接调用，也走普通链路（yolo 放行），
  // 组织禁用语义由 relay 端独立拒绝（spec §5 双保险）。
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "mode.yolo");
});

test("托管 MCP：插件命名空间（服务名含下划线）不会被误判成托管服务", () => {
  const permission = service(
    defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] } }),
  );
  const decision = permission.checkPermission({
    toolName: "mcp__plugin_zcode-cua_computer-use__screenshot",
    input: {},
    riskLevel: "low",
    mode: "yolo",
  });
  assert.equal(decision.ruleId, "mode.yolo");
});

test("托管 MCP：无策略源（未登录）不生效", () => {
  const permission = new PermissionService(defaultPermissionConfig);
  const allowed = permission.checkPermission({
    toolName: "mcp__crm__delete_contact",
    input: { id: "42" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "mode.yolo");
});

// ===== 会话授权随策略版本失效（治理吸收第二批，spec §1B） =====

const SESSION_GRANT = [
  {
    type: "addRules" as const,
    behavior: "allow" as const,
    rules: [{ toolName: "mcp__crm__update_opportunity" }],
  },
];

test("会话授权：策略版本不变时，「本会话不再询问」持续生效", () => {
  const permission = service(defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] }, policyVersion: "v1" }));
  permission.grantSessionPermission(SESSION_GRANT);
  const allowed = permission.checkPermission({
    toolName: "mcp__crm__update_opportunity",
    input: {},
    riskLevel: "medium",
    mode: "yolo",
  });
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.ruleId, "rule.session.allow");
});

test("会话授权：policyVersion 变化（管理员改了策略）→ 授权失效重新询问", () => {
  // 可切换的策略源：先回 v1（建授权），管理员改策略后回 v2
  let current = defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] }, policyVersion: "v1" });
  const switchingSource: ReactorDesktopPolicySource = { current: () => current };
  const permission = new PermissionService({ ...defaultPermissionConfig, desktopPolicy: switchingSource });
  permission.grantSessionPermission(SESSION_GRANT);

  const before = permission.checkPermission({
    toolName: "mcp__crm__update_opportunity",
    input: {},
    riskLevel: "medium",
    mode: "yolo",
  });
  assert.equal(before.decision, "allow");
  assert.equal(before.ruleId, "rule.session.allow");

  // 管理员改了策略：policyVersion v1 → v2
  current = defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] }, policyVersion: "v2" });
  const after = permission.checkPermission({
    toolName: "mcp__crm__update_opportunity",
    input: {},
    riskLevel: "medium",
    mode: "yolo",
  });
  assert.equal(after.decision, "ask", "版本变化后旧的会话授权必须失效、重新询问");
  assert.equal(after.ruleId, "policy.managedMcp");
});

test("会话授权：老服务端（无 policyVersion）不误清", () => {
  const permission = service(defaultPolicy({ managedMcp: { servers: [MANAGED_SERVER] } }));
  permission.grantSessionPermission(SESSION_GRANT);
  for (let round = 0; round < 3; round += 1) {
    const allowed = permission.checkPermission({
      toolName: "mcp__crm__update_opportunity",
      input: {},
      riskLevel: "medium",
      mode: "yolo",
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(allowed.ruleId, "rule.session.allow");
  }
});
