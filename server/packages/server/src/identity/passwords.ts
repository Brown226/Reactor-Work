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

/**
 * 新密码强度规则（客户端弹窗与服务端接口共用同一套判据）：
 * 至少 8 位，且**同时**含大写字母、小写字母、数字、特殊符号。
 *
 * 为什么四条都要：大王明确要求「大小写字母+特殊符号+数字」；
 * 而仅要求"其中几种"的弱规则（如只要求长度）在内网字典攻击下形同虚设。
 *
 * 返回 null = 通过；返回字符串 = 未通过原因（文案可直接展示给用户）。
 */
export function validatePasswordStrength(pwd: string): string | null {
  if (pwd.length < 8) return "密码至少 8 位";
  if (!/[a-z]/.test(pwd)) return "密码需包含小写字母";
  if (!/[A-Z]/.test(pwd)) return "密码需包含大写字母";
  if (!/[0-9]/.test(pwd)) return "密码需包含数字";
  if (!/[^a-zA-Z0-9]/.test(pwd)) return "密码需包含特殊符号（如 ! @ # $ %）";
  return null;
}

/** 规则提示文案（客户端弹窗直接展示，避免两端各写一份措辞）。 */
export const PASSWORD_RULE_HINT = "至少 8 位，且同时包含大写字母、小写字母、数字和特殊符号";
