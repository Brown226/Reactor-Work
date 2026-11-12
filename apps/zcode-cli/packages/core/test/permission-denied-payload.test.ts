/**
 * `emitPermissionDenied` payload 回归（洞②：审计补全，
 * `npx tsx --test packages/core/test/permission-denied-payload.test.ts`）。
 *
 * 钉住规则 id 的**端侧出口**：permission-flow 判 deny 后把 `permissionDecision.ruleId`
 * 传进事件 payload —— 审计链路（bootstrap fact → Host 上报桥）靠这个字段区分
 * 「组织策略拦截（policy.* → policy_block）」与「普通规则拒绝（→ approval/forbidden）」。
 * payload 是 strict schema，字段加错/漏传都会让下游整条事实被拒。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventType, type TraceContext } from "@zcode/contracts";

import { emitPermissionDenied } from "../src/tool/executor/events.js";
import type { ExecutableToolCall } from "../src/tool/types.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";

interface CapturedEvent {
  type: unknown;
  payload: Record<string, unknown>;
}

function harness() {
  const captured: CapturedEvent[] = [];
  const deps = {
    sessionId: "sess-1",
    turnId: "turn-1",
    emitEvent: async (event: unknown) => {
      captured.push(event as CapturedEvent);
    },
  } as unknown as ToolExecutorDeps;
  const toolCall = {
    id: "call-1",
    name: "Bash",
    input: { command: "rm -rf /tmp/important" },
  } as unknown as ExecutableToolCall;
  const trace = { turnId: "turn-1", traceId: "trace-1" } as unknown as TraceContext;
  return { captured, deps, toolCall, trace };
}

test("规则拒绝：ruleId 随 PermissionDenied payload 下行（审计链路的 policy.* 识别依据）", async () => {
  const { captured, deps, toolCall, trace } = harness();
  await emitPermissionDenied(
    deps,
    toolCall,
    "该命令被组织策略禁止执行",
    trace,
    "policy.commandBlacklist",
  );

  assert.equal(captured.length, 1);
  const event = captured[0];
  assert.ok(event);
  assert.equal(event.type, SessionEventType.PermissionDenied);
  assert.equal(event.payload["toolCallId"], "call-1");
  assert.equal(event.payload["toolName"], "Bash");
  assert.equal(event.payload["reason"], "该命令被组织策略禁止执行");
  assert.equal(event.payload["ruleId"], "policy.commandBlacklist");
});

test("无规则的拒绝：payload 不带 ruleId 键（strict schema 兼容旧形状）", async () => {
  const { captured, deps, toolCall, trace } = harness();
  await emitPermissionDenied(deps, toolCall, undefined, trace);

  assert.equal(captured.length, 1);
  const payload = captured[0]?.payload;
  assert.ok(payload);
  assert.equal("ruleId" in payload, false, "无规则拒绝不得凭空造 ruleId 字段");
  // reason 缺省时回落可读文案（既有行为，不因本次改动回归）
  assert.equal(payload["reason"], "Permission denied for Bash");
});
