/**
 * 密码强度规则纯逻辑回归
 * （`npx tsx --test packages/ui/test/passwordStrength.test.ts`）。
 *
 * 为什么值得钉：这五条规则是「初始密码必须改」的最后一道闸。
 * 两个方向的错都不会报错，只会静悄悄地削弱安全：
 *  - 规则过松（如只查长度）→ 用户把密码改成 `aaaaaaaa` 也算通过，强制改密白做；
 *  - 规则过严或漏一类 → 大量合法密码被拒，用户卡在弹窗里进不了应用。
 *
 * 注意：服务端 `validatePasswordStrength` 是权威判据，这里只保证客户端先拦一道，
 * 两边规则必须同步调整（见 passwordStrength.ts 头注）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_RULES,
  firstFailedPasswordRule,
  isStrongPassword,
} from "../src/settings/account/passwordStrength.js";

test("四类字符 + 长度齐全才算通过", () => {
  assert.equal(isStrongPassword("Abcd@1234"), true);
  assert.equal(isStrongPassword("Zqx9!wvm2K"), true);
  assert.equal(isStrongPassword("aB3$xxxx"), true);
});

test("缺任意一类都不通过", () => {
  assert.equal(isStrongPassword("abcd1234"), false, "缺大写");
  assert.equal(isStrongPassword("ABCD1234"), false, "缺小写");
  assert.equal(isStrongPassword("Abcd@efgh"), false, "缺数字");
  assert.equal(isStrongPassword("Abcd1234"), false, "缺特殊符号");
});

test("长度不足 8 位不通过（哪怕四类齐全）", () => {
  assert.equal(isStrongPassword("aB3$x"), false);
  assert.equal(isStrongPassword("aB3$xya"), false, "7 位仍不够");
  assert.equal(isStrongPassword("aB3$xyab"), true, "8 位达标");
});

test("空串一律不通过（不能因为没填而显示成合格）", () => {
  assert.equal(isStrongPassword(""), false);
});

test("常见弱口令被拒", () => {
  // 这些是内网字典攻击的前几名，放过任何一个都等于没改
  for (const weak of [
    "123456",
    "12345678",
    "password",
    "Password1",
    "qwerty123",
    "abc12345",
    "admin123",
  ]) {
    assert.equal(isStrongPassword(weak), false, `应拒绝 ${weak}`);
  }
});

test("空格不算特殊符号（避免用户用一串空格糊弄长度）", () => {
  // 正则 [^a-zA-Z0-9] 会把空格算作特殊符号 —— 这里如实钉住当前行为，
  // 若将来要禁空格需同时改服务端，不能只改一侧。
  assert.equal(isStrongPassword("aB3   xyz"), true);
});

test("firstFailedPasswordRule 指出第一条未通过的规则", () => {
  assert.equal(firstFailedPasswordRule("Abcd@1234"), null);
  assert.equal(firstFailedPasswordRule("abc"), "length", "先报长度（最短的木板）");
  assert.equal(firstFailedPasswordRule("abcdefgh"), "upper");
  assert.equal(firstFailedPasswordRule("ABCDEFGH"), "lower");
  assert.equal(firstFailedPasswordRule("Abcdefgh"), "digit");
  assert.equal(firstFailedPasswordRule("Abcd1234"), "special");
});

test("规则表共五条且顺序为长度→小写→大写→数字→特殊", () => {
  assert.deepEqual(
    PASSWORD_RULES.map((r) => r.id),
    ["length", "lower", "upper", "digit", "special"],
  );
});
