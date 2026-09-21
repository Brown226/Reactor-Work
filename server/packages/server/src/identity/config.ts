/**
 * Identity（第 1 批·身份底座）配置——全部来自环境变量。
 * 本地测试用 Docker mock LDAP(dc=cnpe,dc=cc, 端口 1389) + PG(55432)，
 * 真实内网 AD 联调时仅改 URL/BaseDN/服务账号/登录属性即可（见 docs 第 1 批方案 §9）。
 */

export type AuthMode = "mixed" | "ldap" | "local";

export interface IdentityConfig {
  host: string;
  port: number;
  /** mixed=按用户 source 分流(ad 走 LDAP/local 走本地)；ldap=仅 LDAP；local=仅本地测试号 */
  authMode: AuthMode;
  dbUrl: string;
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /**
   * B2：网关令牌（aud=gateway）有效期。缺省与 access 一致——
   * 客户端在登录/续签时顺手换取即可，不必额外处理过期。
   */
  gatewayTokenTtlSeconds: number;
  ldap: {
    url: string;
    baseDn: string;
    adminDn: string;
    adminPwd: string;
    /** 登录搜索属性：mock LDAP 用 uid；真实 AD 切 sAMAccountName */
    loginAttr: string;
  };
  /** 内置本地测试号口令（仅 authMode local/mixed 时 seed，测试专用不入 .env.example 真值） */
  test: { adminPwd: string; headPwd: string; userPwd: string };
  /** head 测试号数据范围演示用部门路径（root→leaf） */
  headDeptPath: string[];
}

export const DEFAULT_IDENTITY_PORT = 8791;

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const authMode = (env.REACTOR_AUTH_MODE ?? "mixed") as AuthMode;
  if (!["mixed", "ldap", "local"].includes(authMode)) {
    throw new Error(`REACTOR_AUTH_MODE 非法: ${authMode}（mixed|ldap|local）`);
  }
  return {
    host: env.REACTOR_IDENTITY_HOST ?? "127.0.0.1",
    port: Number(env.REACTOR_IDENTITY_PORT ?? String(DEFAULT_IDENTITY_PORT)),
    authMode,
    dbUrl: env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor",
    jwtSecret: env.REACTOR_JWT_SECRET ?? "reactor-dev-jwt-secret-change-me",
    accessTtlSeconds: Number(env.REACTOR_ACCESS_TTL_SECONDS ?? 2 * 60 * 60),
    refreshTtlSeconds: Number(env.REACTOR_REFRESH_TTL_SECONDS ?? 7 * 24 * 60 * 60),
    gatewayTokenTtlSeconds: Number(
      env.REACTOR_GATEWAY_TOKEN_TTL_SECONDS ?? env.REACTOR_ACCESS_TTL_SECONDS ?? 2 * 60 * 60,
    ),
    ldap: {
      url: env.REACTOR_LDAP_URL ?? "ldap://127.0.0.1:1389",
      baseDn: env.REACTOR_LDAP_BASE_DN ?? "ou=cnpe,dc=cnpe,dc=cc",
      adminDn: env.REACTOR_LDAP_ADMIN_DN ?? "cn=admin,dc=cnpe,dc=cc",
      adminPwd: env.REACTOR_LDAP_ADMIN_PWD ?? "admin123",
      loginAttr: env.REACTOR_LDAP_LOGIN_ATTR ?? "uid",
    },
    test: {
      adminPwd: env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123",
      headPwd: env.REACTOR_TEST_HEAD_PWD ?? "Head@123",
      userPwd: env.REACTOR_TEST_USER_PWD ?? "User@123",
    },
    headDeptPath: ["河北分公司", "设计管理部"],
  };
}
