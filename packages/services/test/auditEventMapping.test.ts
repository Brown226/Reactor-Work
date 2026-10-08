import assert from "node:assert/strict";
import test from "node:test";
import { MAX_AUDIT_SUMMARY_CHARS, truncateAuditSummary } from "../src/reactor-server/auditContract.js";
import {
  buildBehaviorAuditEvent,
  buildModelCallAuditEvent,
  hasBillableUsage,
  resolveAuditEventId,
  resolveBehaviorEventId,
  type BehaviorAuditFact,
  type ModelCallUsageDelta,
} from "../src/reactor-server/auditEventMapping.js";
import { shouldReportModelCall } from "../src/reactor-server/auditReporter.js";

const ts = "2026-09-22T10:00:00.000Z";

function buildDelta(overrides: Partial<ModelCallUsageDelta> = {}): ModelCallUsageDelta {
  return {
    eventId: "evt-1",
    providerId: "reactor:new-provider",
    modelId: "deepseek/deepseek-v4.1-flash",
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 40 },
    ...overrides,
  };
}

test("映射出 model_call 事件，字段与红线一致", () => {
  const event = buildModelCallAuditEvent(buildDelta(), { ts });
  assert.ok(event);
  assert.equal(event.action, "model_call");
  assert.equal(event.eventId, "evt-1");
  assert.equal(event.ts, ts);
  assert.equal(event.usage?.inputTokens, 120);
  assert.equal(event.usage?.outputTokens, 30);
  assert.equal(event.usage?.cacheReadTokens, 40);
  assert.equal(event.usage?.cacheWriteTokens, undefined);
  assert.equal(event.usage?.model, "deepseek/deepseek-v4.1-flash");
  assert.equal(event.usage?.provider, "reactor:new-provider");
  // 归属由服务端按令牌写入：事件里不得出现
  assert.equal("uid" in event, false);
  assert.equal("deptId" in event, false);
  // summary 只放短标签，不带正文
  assert.equal(event.summary, "deepseek/deepseek-v4.1-flash");
});

test("reasoningTokens 不进用量分项（四段价不认它）", () => {
  const event = buildModelCallAuditEvent(
    buildDelta({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 9 } }),
    { ts },
  );
  assert.ok(event);
  assert.equal(Object.hasOwn(event.usage ?? {}, "reasoningTokens"), false);
});

test("幂等键：eventId 优先，缺失退 eventKey，两者都无则不上报", () => {
  assert.equal(resolveAuditEventId(buildDelta()), "evt-1");
  assert.equal(
    resolveAuditEventId(buildDelta({ eventId: undefined, eventKey: "key-9" })),
    "key-9",
  );
  assert.equal(resolveAuditEventId(buildDelta({ eventId: undefined, eventKey: undefined })), null);
  assert.equal(
    buildModelCallAuditEvent(buildDelta({ eventId: undefined, eventKey: "  " }), { ts }),
    null,
  );
});

test("全 0 用量不算可计费（服务端会当脏数据拒掉）", () => {
  assert.equal(hasBillableUsage(buildDelta({ usage: {} })), false);
  assert.equal(hasBillableUsage(buildDelta({ usage: { inputTokens: 0, outputTokens: 0 } })), false);
  assert.equal(hasBillableUsage(buildDelta({ usage: { totalTokens: 1 } })), true);
});

test("上报过滤：仅企业 provider + 已登录 + 有有效用量", () => {
  const delta = buildDelta();
  assert.equal(
    shouldReportModelCall(delta, { enterpriseLoggedIn: true, enterpriseProvider: true }),
    true,
  );
  // 未登录：留盘等登录（返回 false 不表示丢弃——调用方不调用它即可）
  assert.equal(
    shouldReportModelCall(delta, { enterpriseLoggedIn: false, enterpriseProvider: true }),
    false,
  );
  // 本地 provider（开发者模式旁路）：有意不报
  assert.equal(
    shouldReportModelCall(delta, { enterpriseLoggedIn: true, enterpriseProvider: false }),
    false,
  );
  assert.equal(
    shouldReportModelCall(buildDelta({ usage: {} }), {
      enterpriseLoggedIn: true,
      enterpriseProvider: true,
    }),
    false,
  );
});

test("超长 summary 截断到服务端上限", () => {
  const long = "x".repeat(MAX_AUDIT_SUMMARY_CHARS + 50);
  const truncated = truncateAuditSummary(long);
  assert.ok(truncated);
  assert.equal(truncated.length, MAX_AUDIT_SUMMARY_CHARS);
  assert.equal(truncated.endsWith("…"), true);
  assert.equal(truncateAuditSummary("   "), undefined);
});

/* ── 行为事实映射（洞②，逐行对应 docs/未完成-审计补全-方案-v1.md §2.3） ── */

const factTs = "2026-10-08T08:00:00.000Z";

function behaviorFact(overrides: Record<string, unknown>): BehaviorAuditFact {
  return {
    version: 1,
    eventId: "fe-1",
    eventSeq: 0,
    occurredAt: Date.parse(factTs),
    sessionId: "sess-1",
    ...overrides,
  } as BehaviorAuditFact;
}

function permFact(overrides: Record<string, unknown>): BehaviorAuditFact {
  return behaviorFact({
    kind: "permission.lifecycle",
    toolCallId: "call-1",
    toolName: "Bash",
    ...overrides,
  });
}

function toolFact(overrides: Record<string, unknown>): BehaviorAuditFact {
  return behaviorFact({
    kind: "tool.lifecycle",
    toolCallId: "call-2",
    toolName: "Edit",
    ...overrides,
  });
}

const map = (fact: BehaviorAuditFact) => buildBehaviorAuditEvent(fact, { ts: "2026-10-08T09:00:00.000Z" });

test("审批结论：resolved allow/deny/modify/escalate → approval 四词折算", () => {
  const allow = map(permFact({ phase: "resolved", decision: "allow" }));
  assert.equal(allow?.action, "approval");
  assert.equal(allow?.approvalDecision, "allow");
  assert.equal(allow?.outcome, "ok");
  assert.equal(allow?.target, "call-1");
  assert.equal(allow?.toolName, "Bash");
  assert.equal(allow?.summary, "Bash");
  assert.equal(allow?.ts, factTs);
  assert.equal(allow?.eventId, "sess-1:fe-1");

  assert.equal(map(permFact({ phase: "resolved", decision: "deny" }))?.approvalDecision, "deny");
  assert.equal(map(permFact({ phase: "resolved", decision: "deny" }))?.outcome, "denied");
  assert.equal(map(permFact({ phase: "resolved", decision: "modify" }))?.approvalDecision, "allow");
  assert.equal(map(permFact({ phase: "resolved", decision: "escalate" }))?.approvalDecision, "ask");
  // 缺结论的事实不报（不猜）
  assert.equal(map(permFact({ phase: "resolved" })), null);
  // 问了还没答不是结论
  assert.equal(map(permFact({ phase: "requested" })), null);
});

test("规则拒绝：policy.* → policy_block；其它 ruleId → approval/forbidden", () => {
  const policy = map(permFact({ phase: "denied", ruleId: "policy.commandBlacklist" }));
  assert.equal(policy?.action, "policy_block");
  assert.equal(policy?.outcome, "denied");
  assert.equal(policy?.errorCode, "policy.commandBlacklist");
  assert.equal(policy?.summary, "policy.commandBlacklist");
  assert.equal(policy?.approvalDecision, undefined);

  const other = map(permFact({ phase: "denied", ruleId: "rule.disallowedTools" }));
  assert.equal(other?.action, "approval");
  assert.equal(other?.approvalDecision, "forbidden");
  assert.equal(other?.outcome, "denied");
  assert.equal(other?.errorCode, "rule.disallowedTools");

  const noRule = map(permFact({ phase: "denied" }));
  assert.equal(noRule?.action, "approval");
  assert.equal(noRule?.approvalDecision, "forbidden");
  assert.equal(noRule?.errorCode, undefined);
});

test("工具终态：副作用工具 → tool_call；只读/缺 sideEffect → 不报", () => {
  const done = map(toolFact({ phase: "completed", sideEffect: true, durationMs: 1200 }));
  assert.equal(done?.action, "tool_call");
  assert.equal(done?.outcome, "ok");
  assert.equal(done?.durationMs, 1200);
  assert.equal(done?.target, "call-2");
  assert.equal(done?.toolName, "Edit");
  assert.equal(done?.usage, undefined);

  const failed = map(
    toolFact({ phase: "failed", sideEffect: true, durationMs: 10, errorCode: "fs_write_error" }),
  );
  assert.equal(failed?.action, "tool_call");
  assert.equal(failed?.outcome, "error");
  assert.equal(failed?.errorCode, "fs_write_error");

  // 只读（Bash `ls` 之类解析为 readOnly → sideEffect=false）与旧 CLI 缺字段都不报
  assert.equal(map(toolFact({ phase: "completed", sideEffect: false })), null);
  assert.equal(map(toolFact({ phase: "completed" })), null);
  // 非终态即使带 sideEffect 也不报
  for (const phase of ["scheduled", "started", "progress"] as const) {
    assert.equal(map(toolFact({ phase, sideEffect: true })), null);
  }
});

test("拦截识别：egress 族 → policy_block（先于副作用判定）；permission_denied 去重跳过", () => {
  const egress = map(
    toolFact({ phase: "failed", sideEffect: false, errorCode: "webfetch_egress_blocked", durationMs: 5 }),
  );
  assert.equal(egress?.action, "policy_block");
  assert.equal(egress?.outcome, "denied");
  assert.equal(egress?.errorCode, "webfetch_egress_blocked");

  const rawEgress = map(toolFact({ phase: "failed", errorCode: "egress_blocked" }));
  assert.equal(rawEgress?.action, "policy_block");

  // 权限层拒绝的工具终态：同 toolCallId 的 permission 事实已记账，这里必须跳过（防一案两行）
  assert.equal(map(toolFact({ phase: "failed", sideEffect: true, errorCode: "permission_denied" })), null);
});

test("行为 eventId：常规拼接；超 128 退化为确定性哈希", () => {
  const short = resolveBehaviorEventId(permFact({ phase: "resolved", decision: "allow" }));
  assert.equal(short, "sess-1:fe-1");

  const long = behaviorFact({
    kind: "tool.lifecycle",
    phase: "completed",
    sideEffect: true,
    toolCallId: "c".repeat(80),
    sessionId: "s".repeat(60),
    eventId: "e".repeat(70), // 60 + 1 + 70 = 131 > 128，触发哈希退化
  });
  const id = resolveBehaviorEventId(long);
  assert.ok(id.length <= 128, `超长退化后必须 ≤128，实际 ${id.length}`);
  assert.ok(id.startsWith("h:"));
  assert.equal(id, resolveBehaviorEventId(long), "同输入必须同键（幂等）");
});

test("红线：errorMessage/reason 正文不进事件任何字段", () => {
  const event = map(
    toolFact({
      phase: "failed",
      sideEffect: true,
      errorCode: "fs_write_error",
      errorMessage: "EACCES: permission denied, open '/secret/path/key.pem'",
    }),
  );
  assert.ok(event);
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("secret/path"), false, "错误正文不得落审计事件");
  assert.equal(serialized.includes("EACCES"), false, "错误正文不得落审计事件");

  const denied = map(
    permFact({ phase: "denied", ruleId: "policy.commandBlacklist", reason: "该命令被组织策略禁止执行（命中 rm -rf）" }),
  );
  assert.ok(denied);
  assert.equal(JSON.stringify(denied).includes("rm -rf"), false, "拒绝理由不得落审计事件");
});

test("行为 ts：occurredAt 为 epoch 毫秒；非法时回落调用方时钟", () => {
  const event = map(permFact({ phase: "resolved", decision: "allow" }));
  assert.equal(event?.ts, factTs);
  const broken = map(permFact({ phase: "resolved", decision: "allow", occurredAt: Number.NaN }));
  assert.equal(broken?.ts, "2026-10-08T09:00:00.000Z");
});
