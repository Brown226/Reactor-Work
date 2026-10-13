/**
 * 组织策略里「可用界面模式」字段的纯逻辑回归
 * （`npx tsx --test packages/shared/test/desktopPolicyInterfaceModes.test.ts`）。
 *
 * 为什么值得钉：`normalizeReactorDesktopPolicy` 是**端侧唯一**把服务端策略归一化的地方，
 * 它与 `isReactorInterfaceModeAllowed` 共同决定编程档对谁可见。缺字段时的默认必须是
 * 「白名单关闭」（不含 coding）——若反向写成放大可见性，未授权用户会直接看到编程模式，
 * 且这是**不会报错的静默越权**。见 docs/未完成-编程模式权限-方案-v1.md。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_REACTOR_DESKTOP_POLICY,
  isReactorInterfaceModeAllowed,
  normalizeReactorDesktopPolicy,
} from "../src/desktopPolicy.js";

test("默认策略：白名单关闭（不含 coding）", () => {
  assert.deepEqual(DEFAULT_REACTOR_DESKTOP_POLICY.allowedInterfaceModes, ["office", "review"]);
  assert.ok(!DEFAULT_REACTOR_DESKTOP_POLICY.allowedInterfaceModes.includes("coding"));
});

test("normalizeReactorDesktopPolicy：缺字段回落白名单关闭默认", () => {
  const p = normalizeReactorDesktopPolicy({ commandBlacklist: [] });
  assert.deepEqual(p.allowedInterfaceModes, ["office", "review"]);
  assert.ok(!p.allowedInterfaceModes.includes("coding"));
});

test("normalizeReactorDesktopPolicy：脏值（非数组/全非法/空）一律回落默认，不放大可见性", () => {
  for (const bad of ["coding", 123, [], ["nope"], [null]]) {
    const p = normalizeReactorDesktopPolicy({ allowedInterfaceModes: bad });
    assert.deepEqual(p.allowedInterfaceModes, ["office", "review"], JSON.stringify(bad));
  }
});

test("normalizeReactorDesktopPolicy：合法值去重并保留", () => {
  const p = normalizeReactorDesktopPolicy({
    allowedInterfaceModes: ["coding", "office", "coding"],
  });
  assert.deepEqual(p.allowedInterfaceModes, ["coding", "office"]);
});

test("normalizeReactorDesktopPolicy：非法项被剔除", () => {
  const p = normalizeReactorDesktopPolicy({ allowedInterfaceModes: ["coding", "x", "review"] });
  assert.deepEqual(p.allowedInterfaceModes, ["coding", "review"]);
});

test("isReactorInterfaceModeAllowed：按集合判定，缺省按白名单关闭处理", () => {
  assert.equal(isReactorInterfaceModeAllowed("coding", ["office", "coding", "review"]), true);
  assert.equal(isReactorInterfaceModeAllowed("coding", ["office", "review"]), false);
  // 空/未给 → 白名单关闭默认：coding 不可用，office/review 可用
  assert.equal(isReactorInterfaceModeAllowed("coding", []), false);
  assert.equal(isReactorInterfaceModeAllowed("coding", null), false);
  assert.equal(isReactorInterfaceModeAllowed("office", []), true);
  assert.equal(isReactorInterfaceModeAllowed(null, ["coding"]), false);
});
