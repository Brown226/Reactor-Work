/**
 * uiTreeStore：patch 合并与树槽位（`npx tsx --test packages/ui/test/uiTreeStore.test.ts`）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { useUiTreeStore } from "../src/store/uiTreeStore.js";
import type { GenUiTreeV1 } from "@zcode/shared";

function sampleTree(): GenUiTreeV1 {
  return {
    schemaVersion: "1",
    root: {
      nodeId: "root",
      kind: "Stack",
      children: [
        {
          nodeId: "metrics",
          kind: "KpiBoard",
          props: { columns: 2 },
          children: [
            { nodeId: "m1", kind: "MetricCard", props: { label: "温度", value: "34" } },
            { nodeId: "m2", kind: "MetricCard", props: { label: "湿度", value: "42" } },
          ],
        },
      ],
    },
  };
}

test("setTree / getTree / clearTree 按消息槽位隔离", () => {
  const store = useUiTreeStore.getState();
  store.setTree({ sessionId: "s1", messageId: "m1", tree: sampleTree() });
  store.setTree({ sessionId: "s1", messageId: "m2", tree: sampleTree() });
  assert.equal(useUiTreeStore.getState().getTree({ sessionId: "s1", messageId: "m1" })?.root.nodeId, "root");
  assert.equal(useUiTreeStore.getState().getTree({ sessionId: "s1", messageId: "m2" })?.root.nodeId, "root");
  store.clearTree({ sessionId: "s1", messageId: "m1" });
  assert.equal(useUiTreeStore.getState().getTree({ sessionId: "s1", messageId: "m1" }), undefined);
  assert.ok(useUiTreeStore.getState().getTree({ sessionId: "s1", messageId: "m2" }));
});

test("applyPatch props 只改目标节点", () => {
  useUiTreeStore.getState().setTree({
    sessionId: "s2",
    messageId: "m1",
    tree: sampleTree(),
  });
  const result = useUiTreeStore.getState().applyPatch({
    sessionId: "s2",
    messageId: "m1",
    ops: [{ op: "props", path: "root/metrics/m1", props: { value: "35" } }],
  });
  assert.equal(result.ok, true);
  const tree = useUiTreeStore.getState().getTree({ sessionId: "s2", messageId: "m1" });
  const metrics = tree?.root.children?.[0];
  const m1 = metrics?.children?.[0];
  const m2 = metrics?.children?.[1];
  assert.equal(m1?.props?.value, "35");
  assert.equal(m1?.props?.label, "温度");
  assert.equal(m2?.props?.value, "42");
});

test("applyPatch replace 替换子树", () => {
  useUiTreeStore.getState().setTree({
    sessionId: "s3",
    messageId: "m1",
    tree: sampleTree(),
  });
  const result = useUiTreeStore.getState().applyPatch({
    sessionId: "s3",
    messageId: "m1",
    ops: [
      {
        op: "replace",
        path: "root/metrics/m2",
        node: { nodeId: "m2", kind: "MetricCard", props: { label: "风速", value: "3" } },
      },
    ],
  });
  assert.equal(result.ok, true);
  const tree = useUiTreeStore.getState().getTree({ sessionId: "s3", messageId: "m1" });
  const m2 = tree?.root.children?.[0]?.children?.[1];
  assert.equal(m2?.props?.label, "风速");
});

test("applyPatch 路径不存在返回可读错误", () => {
  useUiTreeStore.getState().setTree({
    sessionId: "s4",
    messageId: "m1",
    tree: sampleTree(),
  });
  const result = useUiTreeStore.getState().applyPatch({
    sessionId: "s4",
    messageId: "m1",
    ops: [{ op: "props", path: "root/missing", props: { a: 1 } }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /路径不存在/);
});

test("无树时 applyPatch 不伪造成功", () => {
  const result = useUiTreeStore.getState().applyPatch({
    sessionId: "s-none",
    messageId: "m-none",
    ops: [{ op: "props", path: "root", props: { a: 1 } }],
  });
  assert.equal(result.ok, false);
});
