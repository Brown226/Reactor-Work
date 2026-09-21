/**
 * 本地口令哈希（bcryptjs 纯 JS，无原生依赖）。仅 source=local 用户使用；
 * AD 用户一律走 LDAP bind，不落密码。
 */

import bcrypt from "bcryptjs";

export function hashPassword(raw: string): string {
  return bcrypt.hashSync(raw, 10);
}

export function verifyPassword(raw: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(raw, hash);
  } catch {
    return false;
  }
}
