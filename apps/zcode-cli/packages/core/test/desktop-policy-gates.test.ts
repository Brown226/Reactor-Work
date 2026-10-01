/**
 * P4.2b / P4.3 CLI 侧权限强制点回归：模式天花板 + 命令黑名单。
 *
 * 运行（仓库无统一 test 入口，按 packages/core/test 既有约定手动执行）：
 *   cd apps/zcode-cli/packages/core && npx tsx --test test/desktop-policy-gates.test.ts
 *
 * 守的是两条产品边界（docs/未完成-服务端接线-P4-用量上报与策略.md §4.3）：
 * ① 天花板**只能收紧不能放宽**：组织把档位压到 edit 时，yolo 判定不得再走 mode.yolo；
 * ② 黑名单是组织硬边界：命中即拒绝，与模式档位无关；
 * ③ 未配置（无策略文件）时行为与接线前完全一致 —— 不限制。
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

test("模式天花板：yolo 请求被压到 edit，判定不再走 mode.yolo", () => {
  const permission = service(defaultPolicy({ defaultApprovalMode: "edit" }));
  const decision = permission.checkPermission({
    toolName: "Bash",
    input: { command: "npm run build" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(decision.mode, "edit", "生效档位必须是交集结果");
  assert.notEqual(decision.ruleId, "mode.yolo", "天花板禁止把 yolo 当生效档位");
});

test("模式天花板：请求档位不高于天花板时保持原档（只收紧不放宽）", () => {
  const permission = service(defaultPolicy({ defaultApprovalMode: "edit" }));
  const decision = permission.checkPermission({
    toolName: "Read",
    input: { file_path: "a.md" },
    riskLevel: "low",
    mode: "plan",
  });
  assert.equal(decision.mode, "plan");
});

test("模式天花板：无策略时原样放行（不引入额外限制）", () => {
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
