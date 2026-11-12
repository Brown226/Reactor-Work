/**
 * EmitUiTree handler：树原样进结果，不在 handler 写会话状态。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { countNodes } from "@zcode/contracts";
import { emitUiPatchToolEntry, emitUiTreeToolEntry } from "./emit-ui-tree.js";

const sampleTree = {
  schemaVersion: "1" as const,
  root: {
    nodeId: "root",
    kind: "Stack",
    children: [
      {
        nodeId: "weather",
        kind: "WeatherCard",
        props: { city: "北京", temp: "34", condition: "晴" },
      },
    ],
  },
};

test("EmitUiTree：handler 回显树并计数", async () => {
  const output = await emitUiTreeToolEntry.handler({ tree: sampleTree }, {
    toolCallId: "t1",
    sessionId: "s1",
    toolName: "EmitUiTree",
    signal: AbortSignal.timeout(5000),
  } as never);
  const result = output as { ok: boolean; nodeCount: number; tree: typeof sampleTree };
  assert.equal(result.ok, true);
  assert.equal(result.nodeCount, countNodes(sampleTree.root));
  assert.equal(result.tree.root.kind, "Stack");
});

test("EmitUiTree：schema 拒绝缺 schemaVersion", () => {
  const parsed = emitUiTreeToolEntry.runtimeInputSchema.safeParse({
    tree: { root: { nodeId: "root", kind: "Stack" } },
  });
  assert.equal(parsed.success, false);
});

test("EmitUiPatch：回显 applied 条数", async () => {
  const output = await emitUiPatchToolEntry.handler(
    {
      target_tree_call_id: "t1",
      ops: [{ op: "props", path: "root/weather", props: { temp: "35" } }],
    },
    {
      toolCallId: "t2",
      sessionId: "s1",
      toolName: "EmitUiPatch",
      signal: AbortSignal.timeout(5000),
    } as never,
  );
  const result = output as { ok: boolean; applied: number };
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
});
