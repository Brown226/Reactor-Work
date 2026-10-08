/**
 * 行为事实构造回归（洞②：审计补全，`npx tsx --test packages/bootstrap/test/conversation-telemetry-facts.test.ts`）。
 *
 * 钉住两件 Host 上报链路依赖、但单看 Host 侧测试发现不了的事：
 * ① `tool.lifecycle` **终态**事实必须带 `sideEffect`（= `started.readOnly !== true` 的缓存结论）——
 *    Host 只认终态报 `tool_call`，缓存掉了就会漏报副作用工具；非终态不带，终态后必须清缓存。
 * ② `permission.lifecycle` 的 denied 事实必须带 `ruleId`（规则拒绝时）——Host 据此把
 *    `policy.*` 记成 `policy_block`、其余记成 `approval/forbidden`，不匹配中文 reason 文本。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";

type ToolFact = Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>;
type PermFact = Extract<ConversationTelemetryFact, { kind: "permission.lifecycle" }>;

const SESSION = "sess-bf-1";
const TURN = "turn-bf-1";

let seq = 0;
function ev(type: SessionEventType, payload: unknown, id: string): SessionEvent {
  seq += 1;
  return {
    id,
    sessionId: SESSION,
    turnId: TURN,
    type,
    timestamp: new Date(1_791_400_000_000 + seq),
    traceId: "trace-1",
    sequenceNumber: seq,
    payload,
  } as unknown as SessionEvent;
}

function toolFact(normalizer: ConversationTelemetryFactNormalizer, event: SessionEvent): ToolFact | null {
  const fact = normalizer.normalize(SESSION, event);
  if (fact === null) return null;
  assert.equal(fact.kind, "tool.lifecycle", `期望工具事实，实际 ${fact.kind}`);
  return fact as ToolFact;
}

function permFact(normalizer: ConversationTelemetryFactNormalizer, event: SessionEvent): PermFact | null {
  const fact = normalizer.normalize(SESSION, event);
  if (fact === null) return null;
  assert.equal(fact.kind, "permission.lifecycle", `期望审批事实，实际 ${fact.kind}`);
  return fact as PermFact;
}

test("tool 终态事实带 sideEffect（started.readOnly 缓存），非终态不带、终态后清缓存", () => {
  const n = new ConversationTelemetryFactNormalizer();

  // 只读 Bash（`ls`）：started.readOnly=true → 终态 sideEffect=false → Host 不报 tool_call
  n.normalize(SESSION, ev(SessionEventType.ToolCallScheduled, { toolCallId: "t1", toolName: "Bash", input: { command: "ls" } }, "e1"));
  const started = toolFact(n, ev(SessionEventType.ToolCallStarted, { toolCallId: "t1", toolName: "Bash", startedAt: new Date(), readOnly: true }, "e2"));
  assert.ok(started);
  assert.equal(started.phase, "started");
  assert.equal(started.sideEffect, undefined, "非终态事实不附带 sideEffect");

  const done = toolFact(n, ev(SessionEventType.ToolCallResult, { toolCallId: "t1", result: { success: true }, duration: 500 }, "e3"));
  assert.ok(done);
  assert.equal(done.phase, "completed");
  assert.equal(done.toolName, "Bash", "工具名从 scheduled 缓存带出");
  assert.equal(done.sideEffect, false, "readOnly=true 的终态 → sideEffect=false（只读不报）");
  assert.equal(done.durationMs, 500);

  // 终态已清缓存：同一 toolCallId 缺 started 的后续终态不带 sideEffect（宁可不报不误报）
  const again = toolFact(n, ev(SessionEventType.ToolCallResult, { toolCallId: "t1", result: { success: true }, duration: 1 }, "e4"));
  assert.ok(again);
  assert.equal(again.sideEffect, undefined, "终态必须清 sideEffect 缓存");
});

test("副作用工具：readOnly=false → 终态 sideEffect=true；未声明 readOnly 按副作用处理", () => {
  const n = new ConversationTelemetryFactNormalizer();

  // Edit（写文件）：readOnly=false → sideEffect=true → Host 报 tool_call
  n.normalize(SESSION, ev(SessionEventType.ToolCallScheduled, { toolCallId: "t2", toolName: "Edit", input: {} }, "e5"));
  n.normalize(SESSION, ev(SessionEventType.ToolCallStarted, { toolCallId: "t2", startedAt: new Date(), readOnly: false }, "e6"));
  const edit = toolFact(n, ev(SessionEventType.ToolCallResult, { toolCallId: "t2", result: { success: true }, duration: 10 }, "e7"));
  assert.ok(edit);
  assert.equal(edit.sideEffect, true);

  // 早于 readOnly 字段的旧事件：未声明按副作用（保守报，不漏报）
  n.normalize(SESSION, ev(SessionEventType.ToolCallScheduled, { toolCallId: "t3", toolName: "Write", input: {} }, "e8"));
  n.normalize(SESSION, ev(SessionEventType.ToolCallStarted, { toolCallId: "t3", startedAt: new Date() }, "e9"));
  const write = toolFact(n, ev(SessionEventType.ToolCallResult, { toolCallId: "t3", result: { success: true }, duration: 20 }, "e10"));
  assert.ok(write);
  assert.equal(write.sideEffect, true, "未声明 readOnly → 按副作用处理");
});

test("permission denied 事实携带 ruleId；无 ruleId / resolved 不带该字段", () => {
  const n = new ConversationTelemetryFactNormalizer();

  const denied = permFact(
    n,
    ev(SessionEventType.PermissionDenied, {
      toolCallId: "t9",
      toolName: "Bash",
      reason: "该命令被组织策略禁止执行",
      ruleId: "policy.commandBlacklist",
    }, "e11"),
  );
  assert.ok(denied);
  assert.equal(denied.phase, "denied");
  assert.equal(denied.toolName, "Bash");
  assert.equal(denied.ruleId, "policy.commandBlacklist");

  const deniedNoRule = permFact(
    n,
    ev(SessionEventType.PermissionDenied, { toolCallId: "t10", toolName: "Bash", reason: "用户取消" }, "e12"),
  );
  assert.ok(deniedNoRule);
  assert.equal("ruleId" in deniedNoRule, false, "无规则拒绝不带 ruleId 字段");

  const resolved = permFact(
    n,
    ev(SessionEventType.PermissionResolved, { toolCallId: "t11", decision: "allow" }, "e13"),
  );
  assert.ok(resolved);
  assert.equal(resolved.phase, "resolved");
  assert.equal(resolved.decision, "allow");
  assert.equal("ruleId" in resolved, false, "resolved 事实不带 ruleId");
});
