import assert from "node:assert/strict";
import test from "node:test";
import { MAX_AUDIT_SUMMARY_CHARS, truncateAuditSummary } from "../src/reactor-server/auditContract.js";
import {
  buildModelCallAuditEvent,
  hasBillableUsage,
  resolveAuditEventId,
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
