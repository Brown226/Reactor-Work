/**
 * 认证（M0-E1 → B2）：**网关侧请求主体识别**。
 *
 * 演进：
 *   M0  只有静态 dev token（DevTokenVerifier）——网关眼里所有人是同一身份，
 *       于是审计/计量/额度无从归属（记给谁？）。
 *   B2  改为「**身份令牌优先、dev token 兜底**」：网关验签 identity 签发的
 *       aud=`gateway` 令牌，取到 sub/name/role/deptId，为审计与计量提供归属依据。
 *
 * 为什么单独一个 audience（落地 auth/index.ts 里 TokenPayload 的
 * `audience: "desktop" | "gateway" | "docs"` 设计）：
 *   身份服务的 API 令牌（aud=`access`）与网关令牌（aud=`gateway`）互不通用——
 *   任一令牌泄露时不能跨面重放。identity 侧用 `POST /auth/gateway-token` 以 access 换取。
 *
 * dev token 仍默认接受（e2e/sidecar 现网依赖），可用
 * `REACTOR_GATEWAY_ALLOW_DEV_TOKEN=false` 在生产强制身份令牌。
 */

import { timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

export type PrincipalRole = "platform_admin" | "dept_head" | "user";

/** 网关请求主体：user=身份令牌；dev=开发令牌（无主体，兼容期/本地）。 */
export interface Principal {
  kind: "user" | "dev";
  /** kind=user 时：域账号 uid */
  sub?: string;
  name?: string;
  role?: PrincipalRole;
  deptId?: number | null;
}

export interface TokenVerifier {
  verify(token: string | undefined): boolean;
}

/** M0 开发令牌：静态 secret 比对。长度不一致时 timingSafeEqual 抛错 → 捕获返回 false。 */
export class DevTokenVerifier implements TokenVerifier {
  private readonly expected: Buffer;

  constructor(secret: string) {
    this.expected = Buffer.from(secret, "utf8");
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const candidate = Buffer.from(token, "utf8");
    if (candidate.length !== this.expected.length) return false;
    try {
      return timingSafeEqual(candidate, this.expected);
    } catch {
      return false;
    }
  }
}

/** 网关 audience 标识（与 identity 签发端共用）。 */
export const GATEWAY_AUDIENCE = "gateway";

const KEY = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/** 网关令牌载荷（与 identity TokenClaims 结构一致）。 */
export interface GatewayTokenClaims {
  sub: string;
  name: string;
  role: PrincipalRole;
  deptId: number | null;
}

/** 签发网关令牌（aud=gateway）。由 identity 的 /auth/gateway-token 调用。 */
export function signGatewayToken(secret: string, claims: GatewayTokenClaims, ttlSeconds: number): Promise<string> {
  return new SignJWT({ name: claims.name, role: claims.role, deptId: claims.deptId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setAudience(GATEWAY_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds) // jose 数值=绝对 epoch 秒
    .sign(KEY(secret));
}

/**
 * 验签网关令牌。只接受 aud=gateway ——
 * identity 的 access/refresh 令牌在此**一律拒绝**（audience 隔离）。
 */
export async function verifyGatewayToken(secret: string, token: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, KEY(secret), { audience: GATEWAY_AUDIENCE });
    const role = payload.role as PrincipalRole | undefined;
    if (!payload.sub || (role !== "platform_admin" && role !== "dept_head" && role !== "user")) return null;
    return {
      kind: "user",
      sub: payload.sub,
      name: typeof payload.name === "string" ? payload.name : payload.sub,
      role,
      deptId: typeof payload.deptId === "number" ? payload.deptId : null,
    };
  } catch {
    return null;
  }
}

export interface GatewayAuthenticatorOptions {
  /** M0 开发令牌（未配置则只认身份令牌） */
  devToken?: string;
  /** 身份令牌验签密钥（REACTOR_JWT_SECRET，与 identity 同源） */
  jwtSecret?: string;
  /** 是否接受 dev token（默认 true，兼容 e2e/sidecar 现状） */
  allowDevToken: boolean;
}

export interface GatewayAuthenticator {
  authenticate(token: string | undefined): Promise<Principal | null>;
  /** 供日志/健康检查展示启用的鉴权方式 */
  describe(): string;
}

export function createGatewayAuthenticator(opts: GatewayAuthenticatorOptions): GatewayAuthenticator {
  const dev = opts.devToken ? new DevTokenVerifier(opts.devToken) : null;
  return {
    async authenticate(token) {
      if (!token) return null;
      // dev token 优先（常量时间比对），仅在允许时生效
      if (opts.allowDevToken && dev?.verify(token)) return { kind: "dev" };
      if (!opts.jwtSecret) return null;
      return verifyGatewayToken(opts.jwtSecret, token);
    },
    describe: () => `jwt(aud=${GATEWAY_AUDIENCE})${opts.allowDevToken ? " + dev-token" : ""}`,
  };
}
