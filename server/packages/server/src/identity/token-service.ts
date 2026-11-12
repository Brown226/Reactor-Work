/**
 * Refresh Token 服务端存储（T3-2，参照 BuildingAI user_token 设计）。
 * 落库内容仅存 sha256(refreshToken) 十六进制哈希，不存明文；同一 uid 滚动保留最新 10 条。
 */

import { createHash } from "node:crypto";
import type { IdentityDb } from "./db.js";

/** 同一 uid 保留的最大 token 条数（超出删最旧）。 */
const MAX_TOKENS_PER_UID = 10;

/** sha256(refreshToken) 十六进制。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 登录/轮换后落库：插入新 token 并裁剪到最新 10 条。 */
export async function storeRefreshToken(
  db: IdentityDb,
  uid: string,
  refreshToken: string,
  expiresAt: Date,
): Promise<void> {
  await db.pool.query(`INSERT INTO user_tokens (uid, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    uid,
    hashToken(refreshToken),
    expiresAt,
  ]);
  await db.pool.query(
    `DELETE FROM user_tokens
     WHERE uid = $1 AND id NOT IN (
       SELECT id FROM user_tokens WHERE uid = $1 ORDER BY id DESC LIMIT $2
     )`,
    [uid, MAX_TOKENS_PER_UID],
  );
}

/** 校验：该 uid 下存在此 token 哈希且未过期。 */
export async function isRefreshValid(db: IdentityDb, uid: string, refreshToken: string): Promise<boolean> {
  const { rows } = await db.pool.query(
    `SELECT 1 FROM user_tokens WHERE uid = $1 AND token_hash = $2 AND expires_at > now() LIMIT 1`,
    [uid, hashToken(refreshToken)],
  );
  return rows.length > 0;
}

/** 轮换后删除旧 token（按哈希精确匹配）。 */
export async function deleteRefreshToken(db: IdentityDb, uid: string, refreshToken: string): Promise<void> {
  await db.pool.query(`DELETE FROM user_tokens WHERE uid = $1 AND token_hash = $2`, [uid, hashToken(refreshToken)]);
}

/** 吊销该 uid 全部 refresh token（登出 / 停用账号）。 */
export async function revokeAll(db: IdentityDb, uid: string): Promise<void> {
  await db.pool.query(`DELETE FROM user_tokens WHERE uid = $1`, [uid]);
}
