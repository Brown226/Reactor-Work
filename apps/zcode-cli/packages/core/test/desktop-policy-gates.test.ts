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

import type { ReactorDesktopPolicy, ReactorDesktopPolicySource } from "@zcode/shared";

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
