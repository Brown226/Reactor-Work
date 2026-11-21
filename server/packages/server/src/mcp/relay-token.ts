/**
 * relay 短期令牌（治理平面 P0）：端侧会话组装时以 access 换取，
 * 用于 `/desktop/mcp-relay/:id` 的鉴权。与网关令牌同一套 jose 纪律：
 * **独立 audience**（aud=`mcp-relay`）——与 access/refresh/gateway 令牌互不通用，
 * 任一令牌泄露不能跨面重放。无服务端存储：短生命周期、过期即失效。
 */

import { SignJWT, jwtVerify } from "jose";

export const MCP_RELAY_AUDIENCE = "mcp-relay";

/** 默认 24 小时：一次会话生命周期内有效，覆盖 access 滑动续签窗口。 */
export const MCP_RELAY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface McpRelayClaims {
  sub: string;
  name: string;
}

const KEY = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signMcpRelayToken(
  jwtSecret: string,
  claims: McpRelayClaims,
  ttlSeconds = MCP_RELAY_TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setAudience(MCP_RELAY_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds) // jose 数值 = 绝对 epoch 秒
    .sign(KEY(jwtSecret));
}

/** 只接受 aud=mcp-relay；其它令牌一律 null。 */
export async function verifyMcpRelayToken(jwtSecret: string, token: string): Promise<McpRelayClaims | null> {
  try {
    const { payload } = await jwtVerify(token, KEY(jwtSecret), { audience: MCP_RELAY_AUDIENCE });
    if (!payload.sub) return null;
    return { sub: payload.sub, name: typeof payload.name === "string" ? payload.name : payload.sub };
  } catch {
    return null;
  }
}
