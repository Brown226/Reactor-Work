/**
 * 令牌（JWT HS256，jose）与登录服务（第 1 批）。
 * 登录：source=local → bcrypt；source=ad / 未入库 → LDAP 搜 DN + bind（镜像公司 ADValid），
 * 通过后按 DN OU 段落部门并自动供给用户。
 */

import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import { signGatewayToken } from "../auth/token.js";
import type { IdentityConfig } from "./config.js";
import type { IdentityDb } from "./db.js";
import { ensureDeptPath } from "./depts.js";
import { findLdapUserByLogin, verifyUserBind, type LdapSettings } from "./ldap.js";
import { verifyPassword } from "./passwords.js";
import { deleteRefreshToken, isRefreshValid, storeRefreshToken } from "./token-service.js";
import {
  findUserByUid,
  toPublicUser,
  upsertAdUser,
  type Role,
  type UserRow,
} from "./users.js";

export interface TokenClaims {
  sub: string;
  name: string;
  role: Role;
  deptId: number | null;
}

export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}

const KEY = (secret: string): Uint8Array => new TextEncoder().encode(secret);

async function signToken(
  secret: string,
  claims: TokenClaims,
  audience: "access" | "refresh",
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ name: claims.name, role: claims.role, deptId: claims.deptId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setAudience(audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds) // jose 数值=绝对 epoch 秒
    .sign(KEY(secret));
}

async function verifyToken(
  secret: string,
  token: string,
  audience: "access" | "refresh",
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, KEY(secret), { audience });
    const role = payload.role as Role | undefined;
    if (!payload.sub || (role !== "platform_admin" && role !== "dept_head" && role !== "user")) return null;
    return {
      sub: payload.sub,
      name: typeof payload.name === "string" ? payload.name : payload.sub,
      role,
      deptId: typeof payload.deptId === "number" ? payload.deptId : null,
    };
  } catch {
    return null;
  }
}

export async function issueTokenPair(cfg: IdentityConfig, user: UserRow) {
  const claims: TokenClaims = {
    sub: user.uid,
    name: user.name,
    role: user.role,
    deptId: user.departmentId,
  };
  const accessToken = await signToken(cfg.jwtSecret, claims, "access", cfg.accessTtlSeconds);
  const refreshToken = await signToken(cfg.jwtSecret, claims, "refresh", cfg.refreshTtlSeconds);
  return { accessToken, refreshToken };
}

/** 用同 claims 签发新 access token（authed 滑动续签复用）。 */
export function signAccessToken(cfg: IdentityConfig, claims: TokenClaims): Promise<string> {
  return signToken(cfg.jwtSecret, claims, "access", cfg.accessTtlSeconds);
}

export function verifyAccess(cfg: IdentityConfig, token: string): Promise<TokenClaims | null> {
  return verifyToken(cfg.jwtSecret, token, "access");
}

/**
 * B2：用 access 令牌换取**网关 audience** 的令牌（网关只认 aud=gateway）。
 * 与 access 同源密钥、同 claims，仅 audience/ttl 不同 → 令牌不能跨面重放。
 */
export function signGatewayTokenFor(cfg: IdentityConfig, claims: TokenClaims): Promise<string> {
  return signGatewayToken(cfg.jwtSecret, claims, cfg.gatewayTokenTtlSeconds);
}

export function verifyRefresh(cfg: IdentityConfig, token: string): Promise<TokenClaims | null> {
  return verifyToken(cfg.jwtSecret, token, "refresh");
}

export async function refreshTokens(
  cfg: IdentityConfig,
  db: IdentityDb,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const claims = await verifyRefresh(cfg, refreshToken);
  if (!claims) throw new AuthError(401, "刷新令牌无效或已过期");
  // 服务端吊销校验：不在库或已过期 → 拒绝（JWT 本身未过期但已被吊销/轮换的情况）。
  if (!(await isRefreshValid(db, claims.sub, refreshToken))) throw new AuthError(401, "刷新令牌已失效");
  const accessToken = await signToken(cfg.jwtSecret, claims, "access", cfg.accessTtlSeconds);
  const rotated = await signToken(cfg.jwtSecret, claims, "refresh", cfg.refreshTtlSeconds);
  // 轮换：删旧写新。
  await deleteRefreshToken(db, claims.sub, refreshToken);
  await storeRefreshToken(db, claims.sub, rotated, refreshExpiry(cfg));
  return { accessToken, refreshToken: rotated };
}

function refreshExpiry(cfg: IdentityConfig): Date {
  return new Date(Date.now() + cfg.refreshTtlSeconds * 1000);
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: ReturnType<typeof toPublicUser>;
}

export async function login(
  cfg: IdentityConfig,
  db: IdentityDb,
  username: string,
  password: string,
): Promise<LoginResult> {
  const uid = username.trim();
  if (!uid || !password) throw new AuthError(400, "请输入账号与密码");

  const existing = await findUserByUid(db, uid);
  if (existing?.status === "disabled") throw new AuthError(403, "账号已停用，请联系管理员");

  if (existing?.source === "local") {
    if (cfg.authMode === "ldap") throw new AuthError(401, "当前认证模式为 LDAP，本地账号不可用");
    if (!existing.passwordHash || !verifyPassword(password, existing.passwordHash)) {
      throw new AuthError(401, "账号或密码错误");
    }
    const tokens = await issueTokenPair(cfg, existing);
    await storeRefreshToken(db, existing.uid, tokens.refreshToken, refreshExpiry(cfg));
    return { ...tokens, user: toPublicUser(existing) };
  }

  // source=ad 或尚未入库 → LDAP
  if (cfg.authMode === "local") throw new AuthError(401, "当前认证模式为本地，域账号不可用");
  const settings: LdapSettings = cfg.ldap;
  /**
   * LDAP 目录查询失败（连不上/超时）与"账号不存在"必须区分：
   * 前者是**服务不可用**（域服务/Docker 里的 ldap 没起），后者才是凭据错。
   * 以前这里不捕获 → 网络错误冒到全局 onError → 用户只看到 500"服务异常"，
   * 排查方向完全错（会以为是自己密码错了或服务端挂了）。
   */
  let ld;
  try {
    ld = await findLdapUserByLogin(settings, uid);
  } catch (err) {
    // 状态码用 500（AuthError 只允许 400/401/403/409/500 —— 这是有意的收窄，
    // 不在本次修复里扩它）。可操作性靠 message：说清"是域服务不可用，不是密码错"。
    throw new AuthError(
      500,
      `域服务(LDAP)当前不可用：${(err as Error).message}。若用域账号登录，请检查域服务（Docker 里的 ldap）；本地账号不受影响。`,
    );
  }
  if (!ld) throw new AuthError(401, "账号或密码错误");
  let ok = false;
  try {
    ok = await verifyUserBind(settings, ld.dn, password);
  } catch (err) {
    throw new AuthError(500, `LDAP 服务异常: ${(err as Error).message}`);
  }
  if (!ok) throw new AuthError(401, "账号或密码错误");

  const deptId = ld.ouPath.length ? await ensureDeptPath(db, ld.ouPath) : null;
  const user = await upsertAdUser(db, {
    uid: ld.uid,
    name: ld.name,
    email: ld.email,
    adDn: ld.dn,
    departmentId: deptId,
  });
  if (user.status === "disabled") throw new AuthError(403, "账号已停用，请联系管理员");
  const tokens = await issueTokenPair(cfg, user);
  await storeRefreshToken(db, user.uid, tokens.refreshToken, refreshExpiry(cfg));
  return { ...tokens, user: toPublicUser(user) };
}
