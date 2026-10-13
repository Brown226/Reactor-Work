/**
 * 界面模式「可用档」纯逻辑回归（`npx tsx --test packages/ui/test/interfaceModeAvailability.test.ts`）。
 *
 * 为什么值得钉：这两个函数决定「用户能看到哪些档」与「受限用户落到哪一档」。
 * 算错的两个方向都很糟且不会报错：
 *  - 把不可用档留在集合里 → 受限用户仍能看到并使用编程模式，白名单形同虚设；
 *  - 把兜底写反 → 已授权用户被莫名锁进办公档，或受限用户的旧 coding 在重启后复现。
 * 见 docs/未完成-编程模式权限-方案-v1.md。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AVAILABLE_INTERFACE_MODES,
  normalizeAvailableInterfaceModes,
  resolveAvailableInterfaceMode,
} from "../src/lib/interfaceMode.js";

test("normalizeAvailableInterfaceModes：缺省/脏值一律回落白名单默认（不含 coding）", () => {
  // 非数组、空数组、全非法值 —— 都不能放大可见性，必须落到不含 coding 的默认集。
  for (const bad of [undefined, null, "coding", 123, [], ["nope"], ["auto"]]) {
    assert.deepEqual(
      normalizeAvailableInterfaceModes(bad),
      [...DEFAULT_AVAILABLE_INTERFACE_MODES],
      String(bad),
    );
  }
  assert.ok(!DEFAULT_AVAILABLE_INTERFACE_MODES.includes("coding"));
});

test("normalizeAvailableInterfaceModes：去重且保持服务端顺序", () => {
  assert.deepEqual(normalizeAvailableInterfaceModes(["coding", "office", "coding", "review"]), [
    "coding",
    "office",
    "review",
  ]);
  assert.deepEqual(normalizeAvailableInterfaceModes(["review", "office"]), ["review", "office"]);
});

test("normalizeAvailableInterfaceModes：非法项被剔除、合法项保留", () => {
  assert.deepEqual(normalizeAvailableInterfaceModes(["coding", "bogus", 42, "review"]), [
    "coding",
    "review",
  ]);
});

test("resolveAvailableInterfaceMode：当前档可用则原样保留", () => {
  assert.equal(resolveAvailableInterfaceMode("coding", ["office", "coding", "review"]), "coding");
  assert.equal(resolveAvailableInterfaceMode("review", ["office", "review"]), "review");
});

test("resolveAvailableInterfaceMode：当前档不可用时优先落办公档（受限用户逃生口）", () => {
  // 存量用户本地存着 coding、但未被授权 → 必须落 office，而不是集合首项。
  assert.equal(resolveAvailableInterfaceMode("coding", ["review", "office"]), "office");
  assert.equal(resolveAvailableInterfaceMode("coding", ["office", "review"]), "office");
});

test("resolveAvailableInterfaceMode：集合无 office 时退而取首项；空集合落 office", () => {
  assert.equal(resolveAvailableInterfaceMode("coding", ["review"]), "review");
  assert.equal(resolveAvailableInterfaceMode("coding", []), "office");
});
