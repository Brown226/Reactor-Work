/**
 * Identity（第 1 批·身份底座）配置——全部来自环境变量。
 * 本地测试用 Docker mock LDAP(dc=cnpe,dc=cc, 端口 1389) + PG(55432)，
 * 真实内网 AD 联调时改 URL/BaseDN/服务账号/登录属性/userFilter（见 README §真实 AD 接入）。
 */

export type AuthMode = "mixed" | "ldap" | "local";

export interface IdentityConfig {
  host: string;
  /** 用户面端口（桌面客户端登录/业务调用连这里）；不挂管理台，`/admin/*` 一律 404。 */
  port: number;
  /**
   * 管理面端口（管理员浏览器用）；挂管理台 SPA 且 `GET /` 302 到 `/console/`。
   *
   * 分端口的原因：改造前两者同在 8791，任何能访问 `http://<host>:8791/` 的人都会被 302
   * 送到管理台登录页（routes.ts 的 `GET /` 跳转），普通用户有看到服务端地址、摸到管理 API
   * 的风险。拆开后 8792 可由防火墙/内网 ACL 只放行管理员网段。
   *
   * 与 `port` 相等时**不启用分离**（保持单端口旧行为），便于本地调试与既有脚本。
   */
  adminPort: number;
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
    /** 用户搜索 filter；缺省 mock 口径 inetOrgPerson，真实 AD 必须显式配置（见 ldap.ts） */
    userFilter: string;
  };
  /** 内置本地测试号口令（仅 authMode local/mixed 时 seed，测试专用不入 .env.example 真值） */
  test: { adminPwd: string; headPwd: string; userPwd: string };
  /** head 测试号数据范围演示用部门路径（root→leaf） */
  headDeptPath: string[];
}

export const DEFAULT_IDENTITY_PORT = 8791;
/** 管理面默认端口：与用户面 8791 相邻，便于运维记忆。 */
export const DEFAULT_IDENTITY_ADMIN_PORT = 8792;

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const authMode = (env.REACTOR_AUTH_MODE ?? "mixed") as AuthMode;
  if (!["mixed", "ldap", "local"].includes(authMode)) {
    throw new Error(`REACTOR_AUTH_MODE 非法: ${authMode}（mixed|ldap|local）`);
  }
  const port = Number(env.REACTOR_IDENTITY_PORT ?? String(DEFAULT_IDENTITY_PORT));
  const adminPort = Number(env.REACTOR_IDENTITY_ADMIN_PORT ?? String(DEFAULT_IDENTITY_ADMIN_PORT));
  // 写错端口名/填了非数字会让 `serve()` 抛一个难懂的底层错误，这里提前给出可读提示。
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`REACTOR_IDENTITY_PORT 非法: ${env.REACTOR_IDENTITY_PORT}（应为 1-65535 的整数）`);
  }
  if (!Number.isInteger(adminPort) || adminPort <= 0 || adminPort > 65535) {
    throw new Error(`REACTOR_IDENTITY_ADMIN_PORT 非法: ${env.REACTOR_IDENTITY_ADMIN_PORT}（应为 1-65535 的整数）`);
  }
  return {
    host: env.REACTOR_IDENTITY_HOST ?? "127.0.0.1",
    port,
    adminPort,
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
      // 缺省保持 mock OpenLDAP 口径；接真实 AD 时 .env 必须显式覆盖（README §AD 接入）
      userFilter: env.REACTOR_LDAP_USER_FILTER ?? "(objectClass=inetOrgPerson)",
    },
    test: {
      adminPwd: env.REACTOR_TEST_ADMIN_PWD ?? "Admin@123",
      headPwd: env.REACTOR_TEST_HEAD_PWD ?? "Head@123",
      userPwd: env.REACTOR_TEST_USER_PWD ?? "User@123",
    },
    headDeptPath: ["河北分公司", "设计管理部"],
  };
}
