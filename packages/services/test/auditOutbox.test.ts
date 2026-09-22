import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUDIT_OUTBOX_MAX_EVENTS, type AuditEventInput } from "../src/reactor-server/auditContract.js";
import { createAuditOutbox } from "../src/reactor-server/auditOutbox.js";

function buildEvent(eventId: string): AuditEventInput {
  return { eventId, ts: "2026-09-22T10:00:00.000Z", action: "model_call" };
}

async function withTempOutbox(
  run: (outbox: ReturnType<typeof createAuditOutbox>, filePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "audit-outbox-"));
  const filePath = join(dir, "audit-outbox.jsonl");
  try {
    await run(createAuditOutbox({ filePath }), filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("append → peek 不删除，ack 才移除", async () => {
  await withTempOutbox(async (outbox) => {
    await outbox.append([buildEvent("e1"), buildEvent("e2")]);
    assert.equal(await outbox.size(), 2);
    assert.deepEqual(
      (await outbox.peek(10)).map((event) => event.eventId),
      ["e1", "e2"],
    );
    // peek 是只读的
    assert.equal(await outbox.size(), 2);

    await outbox.ack(["e1"]);
    assert.deepEqual(
      (await outbox.peek(10)).map((event) => event.eventId),
      ["e2"],
    );
  });
});

test("重复 append 同一 eventId 只保留一条（重传幂等）", async () => {
  await withTempOutbox(async (outbox, filePath) => {
    await outbox.append([buildEvent("dup")]);
    await outbox.append([buildEvent("dup")]);
    assert.equal(await outbox.size(), 1);

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  });
});

test("超过上限丢最旧，文件保持有界", async () => {
  await withTempOutbox(async (outbox) => {
    const overflow = 3;
    const events = Array.from({ length: AUDIT_OUTBOX_MAX_EVENTS + overflow }, (_, index) =>
      buildEvent(`e${index}`),
    );
    await outbox.append(events);
    assert.equal(await outbox.size(), AUDIT_OUTBOX_MAX_EVENTS);

    const remaining = await outbox.peek(1);
    assert.equal(remaining[0]?.eventId, `e${overflow}`);
  });
});

test("重开 outbox 能读回已落盘事件（崩溃后不丢）", async () => {
  await withTempOutbox(async (_outbox, filePath) => {
    const writer = createAuditOutbox({ filePath });
    await writer.append([buildEvent("survive")]);

    const reader = createAuditOutbox({ filePath });
    assert.deepEqual(
      (await reader.peek(10)).map((event) => event.eventId),
      ["survive"],
    );
  });
});

test("脏行不会让整份队列报废", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-outbox-dirty-"));
  const filePath = join(dir, "audit-outbox.jsonl");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      filePath,
      `${JSON.stringify(buildEvent("good"))}\n{"broken":\nnot json at all\n`,
      "utf8",
    );
    const outbox = createAuditOutbox({ filePath });
    assert.deepEqual(
      (await outbox.peek(10)).map((event) => event.eventId),
      ["good"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
