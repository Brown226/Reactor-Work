/**
 * 密码强度规则（客户端与服务端同口径的唯一出处）。
 *
 * 服务端权威实现在 `server/packages/server/src/identity/passwords.ts` 的
 * `validatePasswordStrength`；这里做同一套判据，目的是**在提交前就拦住**，
 * 少一次无效请求。两边规则若需调整必须同步改——这是刻意接受的少量重复，
 * 换来的好处是 UI 不必等服务端响应才知道自己填得行不行。
 *
 * 规则：至少 8 位，且同时含大写字母、小写字母、数字、特殊符号。
 */

/** 五条硬规则（顺序即展示顺序：先长度，后四类字符）。 */
export const PASSWORD_RULES = [
  {
    id: "length",
    test: (v: string) => v.length >= 8,
    key: "settings.account.password.rule.length",
  },
  {
    id: "lower",
    test: (v: string) => /[a-z]/.test(v),
    key: "settings.account.password.rule.lower",
  },
  {
    id: "upper",
    test: (v: string) => /[A-Z]/.test(v),
    key: "settings.account.password.rule.upper",
  },
  {
    id: "digit",
    test: (v: string) => /[0-9]/.test(v),
    key: "settings.account.password.rule.digit",
  },
  {
    id: "special",
    test: (v: string) => /[^a-zA-Z0-9]/.test(v),
    key: "settings.account.password.rule.special",
  },
] as const;

/** 是否满足全部五条。空串一律 false（不要因为"没填"而显示成合格）。 */
export function isStrongPassword(value: string): boolean {
  if (!value) return false;
  return PASSWORD_RULES.every((rule) => rule.test(value));
}

/** 第一条未通过的规则 id；全部通过返回 null（用于把错误指到具体缺什么）。 */
export function firstFailedPasswordRule(value: string): string | null {
  for (const rule of PASSWORD_RULES) {
    if (!rule.test(value)) return rule.id;
  }
  return null;
}
