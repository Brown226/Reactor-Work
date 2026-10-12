/**
 * RPC 传输断连 fail-closed：MessagePort close → ChannelClient dispose → 挂起请求 reject
 * （`npx tsx --test test/messageportClose.test.ts`，需在 packages/rpc 目录下执行）。
 *
 * 覆盖两条不变量：
 * 1. MessagePortProtocol 把 port 的 close 事件（含主动 disconnect）传播为 onClose，且幂等；
 * 2. ChannelClient 订阅 onClose 后把挂起的 Promise 请求以 ConnectionClosed reject，
 *    不再永久 pending；传输不提供 onClose 时行为零变化。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Emitter, Event } from "../src/foundation.js";
import { ChannelClient } from "../src/channelClient.js";
import { MessagePortProtocol } from "../src/protocol.js";
import type { MessagePortLike, MessagePortPayload } from "../src/protocol.js";

class MockMessagePort implements MessagePortLike {
  readonly messages: MessagePortPayload[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(e?: never) => void>>();

  addEventListener(type: "message" | "close", listener: (e?: { data: MessagePortPayload }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (e?: never) => void);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: "message" | "close",
    listener: (e?: { data: MessagePortPayload }) => void,
  ): void {
    this.listeners.get(type)?.delete(listener as (e?: never) => void);
  }

  postMessage(message: MessagePortPayload): void {
    this.messages.push(message);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  /** 模拟对端进程死亡：Chromium 会在 entangled port 的 owner 退出时触发 close。 */
  emitClose(): void {
    for (const listener of Array.from(this.listeners.get("close") ?? [])) {
      (listener as () => void)();
    }
  }

  emitMessage(data: MessagePortPayload): void {
    for (const listener of Array.from(this.listeners.get("message") ?? [])) {
      (listener as (e: { data: MessagePortPayload }) => void)({ data });
    }
  }
}

test("MessagePortProtocol：port close 事件传播为 onClose", () => {
  const port = new MockMessagePort();
  const protocol = new MessagePortProtocol(port);
  let closeCount = 0;
  protocol.onClose(() => {
    closeCount += 1;
  });

  port.emitClose();
  assert.equal(closeCount, 1, "port close 必须触发一次 onClose");
});

test("MessagePortProtocol：onClose 幂等，重复 close 不重复触发", () => {
  const port = new MockMessagePort();
  const protocol = new MessagePortProtocol(port);
  let closeCount = 0;
  protocol.onClose(() => {
    closeCount += 1;
  });

  port.emitClose();
  port.emitClose();
  assert.equal(closeCount, 1);
});

test("MessagePortProtocol：主动 disconnect 也触发 onClose", () => {
  const port = new MockMessagePort();
  const protocol = new MessagePortProtocol(port);
  let closeCount = 0;
  protocol.onClose(() => {
    closeCount += 1;
  });

  protocol.disconnect();
  assert.equal(closeCount, 1);
  assert.equal(port.closed, true);
});

test("MessagePortProtocol：正常 message 不影响 onClose", () => {
  const port = new MockMessagePort();
  const protocol = new MessagePortProtocol(port);
  let closeCount = 0;
  protocol.onClose(() => {
    closeCount += 1;
  });

  port.emitMessage(new Uint8Array([1, 2, 3]));
  assert.equal(closeCount, 0);
});

test("ChannelClient：传输 onClose 后挂起的 RPC 以 ConnectionClosed reject", async () => {
  const onClose = new Emitter<void>();
  const client = new ChannelClient({
    send: () => {},
    onMessage: Event.None,
    onClose: onClose.event,
  });

  // 未 Initialize 时 call 会挂起等待，正好模拟 host 死亡前后的 in-flight 请求。
  const pending = client.getChannel("test").call("getView");
  onClose.fire();

  await assert.rejects(pending, (error: Error) => {
    assert.equal(error.name, "ConnectionClosed");
    assert.match(error.message, /连接已断开/);
    return true;
  });
});

test("ChannelClient：传输不提供 onClose 时行为零变化（不提前 reject）", async () => {
  const client = new ChannelClient({
    send: () => {},
    onMessage: Event.None,
  });

  const pending = client.getChannel("test").call("getView");
  const settlement = Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);

  assert.equal(await settlement, "pending", "无 onClose 的旧传输实现不得提前 reject");
  client.dispose();
});
