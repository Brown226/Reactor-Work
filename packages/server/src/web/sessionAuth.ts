import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { WebSession } from "./sessionStore.js";
import { isValidWebUid } from "./uid.js";

export const WEB_SESSION_COOKIE = "zcode_web_session";
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

const sessionByContext = new WeakMap<object, WebSession>();

export function setWebAuthSession(c: Context, session: WebSession): void {
  sessionByContext.set(c, session);
}

export function getWebAuthSession(c: Context): WebSession | null {
  return sessionByContext.get(c) ?? null;
}

export function clearWebAuthSession(c: Context): void {
  sessionByContext.delete(c);
}

export function isSessionAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REACTOR_WEB_SESSION_AUTH?.trim() === "1";
}

export function isSessionProtectedPath(pathname: string): boolean {
  // 登录页/登录接口/首次能力发现必须匿名可达；分享链接继续走 share token。
  if (pathname === "/api/auth/login" || pathname === "/api/auth/session") return false;
  if (pathname === "/api/server-info" || pathname === "/health") return false;
  if (pathname.startsWith("/api/space/shared/")) return false;
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

export function readWebSessionCookie(c: Context): string | undefined {
  return getCookie(c, WEB_SESSION_COOKIE);
}

export function setWebSessionCookie(c: Context, sid: string, ttlSeconds: number): void {
  setCookie(c, WEB_SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.max(1, ttlSeconds),
    secure: resolveCookieSecure(),
  });
}

export function clearWebSessionCookie(c: Context): void {
  deleteCookie(c, WEB_SESSION_COOKIE, { path: "/" });
}

function resolveCookieSecure(): boolean {
  return process.env.REACTOR_WEB_COOKIE_SECURE?.trim() === "1";
}

export function readClientIp(c: Context): string | undefined {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip")?.trim() || undefined;
}

/**
 * 会话模式下拒绝跨站写请求。
 *
 * Cookie 用 SameSite=Lax 已经挡住绝大多数跨站 POST；这里再加 Origin / Sec-Fetch-Site
 * 检查，覆盖反代改写 SameSite 或旧浏览器不发送 Cookie 策略头的情况。
 */
export function isCrossSiteMutation(c: Context): boolean {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const fetchSite = c.req.header("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") return true;
  if (fetchSite === "same-origin" || fetchSite === "none") return false;

  const origin = c.req.header("origin")?.trim();
  if (!origin) return false;
  const host = c.req.header("x-forwarded-host")?.trim() || c.req.header("host")?.trim();
  if (!host) return true;
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto =
    forwardedProto || (new URL(c.req.url).protocol === "https:" ? "https" : "http");
  return origin !== `${proto}://${host}`;
}

export interface LoginRateLimiter {
  isBlocked(key: string): boolean;
  recordFailure(key: string): void;
  reset(key: string): void;
}

export function createLoginRateLimiter(
  options: { limit?: number; windowMs?: number; now?: () => number } = {},
): LoginRateLimiter {
  const limit = options.limit ?? LOGIN_FAILURE_LIMIT;
  const windowMs = options.windowMs ?? LOGIN_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();

  return {
    isBlocked(key) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (entry.resetAt <= now()) {
        failures.delete(key);
        return false;
      }
      return entry.count >= limit;
    },
    recordFailure(key) {
      const at = now();
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= at) {
        failures.set(key, { count: 1, resetAt: at + windowMs });
        return;
      }
      entry.count += 1;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

export class IdentityLoginError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "IdentityLoginError";
    this.status = status;
  }
}

export interface IdentityLoginResult {
  user: {
    uid: string;
    name: string;
    role: string;
    mustChangePassword: boolean;
  };
}

interface IdentityLoginResponse {
  user?: {
    uid?: unknown;
    name?: unknown;
    role?: unknown;
    mustChangePassword?: unknown;
  };
}

export function resolveIdentityBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.REACTOR_IDENTITY_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * 网关只向 identity 换取 uid；企业 access/refresh token 不在这里保存。
 * worker 会用同一份账号密码再登录一次，令牌只落在该 uid 的 home。
 */
export async function loginWithIdentity(
  identityUrl: string,
  username: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityLoginResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${identityUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new IdentityLoginError(
      502,
      `无法连接身份服务：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = (await response.json().catch(() => null)) as
    | IdentityLoginResponse
    | { error?: { message?: unknown } }
    | null;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      typeof body.error.message === "string"
        ? body.error.message
        : `身份服务返回 ${response.status}`;
    throw new IdentityLoginError(
      response.status === 401 || response.status === 403 ? response.status : 502,
      message,
    );
  }

  const user =
    body && typeof body === "object" && "user" in body ? body.user : undefined;
  if (!user || typeof user.uid !== "string" || !isValidWebUid(user.uid)) {
    throw new IdentityLoginError(502, "身份服务返回的用户标识不合法");
  }

  return {
    user: {
      uid: user.uid,
      name: typeof user.name === "string" ? user.name : user.uid,
      role: typeof user.role === "string" ? user.role : "user",
      mustChangePassword: user.mustChangePassword === true,
    },
  };
}
