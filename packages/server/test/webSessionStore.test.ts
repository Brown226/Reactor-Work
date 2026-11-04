import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebSessionStore } from "../src/web/sessionStore.js";

test("会话：创建后可读，固定 TTL 到期失效", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-session-"));
  let now = 1_000;
  const store = createWebSessionStore({
    filePath: join(dir, "sessions.sqlite"),
    ttlSeconds: 120,
    now: () => now,
  });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const session = store.create({ uid: "alice", username: "Alice" });
  assert.equal(store.get(session.sid)?.uid, "alice");
  assert.equal(store.countActiveForUid("alice"), 1);

  // 活跃只更新 last_seen，不延长 expires_at（与 identity refresh TTL 对齐）。
  now = 70_000;
  assert.equal(store.get(session.sid)?.uid, "alice");
  now = 150_000;
  assert.equal(store.get(session.sid), null, "超过固定 TTL 必须失效");
});

test("会话：吊销只影响当前 sid，其他浏览器会话保留", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-session-"));
  const store = createWebSessionStore({
    filePath: join(dir, "sessions.sqlite"),
    ttlSeconds: 3_600,
    now: () => 1_000,
  });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const first = store.create({ uid: "alice", username: "Alice" });
  const second = store.create({ uid: "alice", username: "Alice" });
  store.revoke(first.sid);

  assert.equal(store.get(first.sid), null);
  assert.equal(store.get(second.sid)?.uid, "alice");
  assert.equal(store.countActiveForUid("alice"), 1);
});

test("会话：伪造 sid 不会命中", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "web-session-"));
  const store = createWebSessionStore({
    filePath: join(dir, "sessions.sqlite"),
    ttlSeconds: 3_600,
  });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  store.create({ uid: "alice", username: "Alice" });
  assert.equal(store.get("forged-sid"), null);
  assert.equal(store.get(undefined), null);
});
