/**
 * LDAP 认证接口（M0-E1 占位 → M1 接 AD/LDAP 域账号，FR-M1-01）。
 * 无真实 AD 环境时 disabledLdap 恒失败；M1 用 ldapjs 实现 LDAP BIND（username + password 校验域账号）。
 */

export interface LdapResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export interface LdapAuthenticator {
  authenticate(username: string, password: string): Promise<LdapResult>;
}

export const disabledLdap: LdapAuthenticator = {
  async authenticate() {
    return { ok: false, error: "LDAP 未配置（M1 接入 AD/LDAP 域账号）" };
  },
};
