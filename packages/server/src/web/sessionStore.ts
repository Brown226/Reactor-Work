import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getWebDataRoot } from "@zcode/services/node";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOUCH_THROTTLE_MS = 60_000;

export interface WebSession {
  readonly sid: string;
  readonly uid: string;
  readonly username: string;
}

export interface CreateWebSessionInput {
  uid: string;
  username: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

interface WebSessionRow {
  sid_hash: string;
  uid: string;
  username: string;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface WebSessionStore {
  create(input: CreateWebSessionInput): WebSession;
  get(sid: string | undefined): WebSession | null;
  revoke(sid: string): void;
  countActiveForUid(uid: string): number;
  close(): void;
}

export interface WebSessionStoreOptions {
  filePath?: string;
  ttlSeconds?: number;
  now?: () => number;
}

export function resolveWebSessionDatabasePath(): string {
  return (
    process.env.REACTOR_WEB_SESSION_DB?.trim() ||
    join(getWebDataRoot(), "web-sessions", "sessions.sqlite")
  );
}

export function resolveWebSessionTtlSeconds(): number {
  const raw = process.env.REACTOR_WEB_SESSION_TTL_SECONDS?.trim();
  if (!raw) return DEFAULT_SESSION_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_SECONDS;
}

function hashSid(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}

export function createWebSessionStore(options: WebSessionStoreOptions = {}): WebSessionStore {
  const now = options.now ?? Date.now;
  const ttlMs = (options.ttlSeconds ?? resolveWebSessionTtlSeconds()) * 1000;
  const filePath = options.filePath ?? resolveWebSessionDatabasePath();
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const db: DatabaseSyncInstance = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      sid_hash TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      user_agent TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_uid
      ON web_sessions(uid, revoked_at, expires_at);
  `);

  const insert = db.prepare(`
    INSERT INTO web_sessions (
      sid_hash, uid, username, created_at, last_seen_at, expires_at, user_agent, ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const select = db.prepare(`
    SELECT sid_hash, uid, username, last_seen_at, expires_at, revoked_at
    FROM web_sessions WHERE sid_hash = ?
  `);
  const touch = db.prepare(`
    UPDATE web_sessions SET last_seen_at = ? WHERE sid_hash = ?
  `);
  const revokeStatement = db.prepare(`
    UPDATE web_sessions SET revoked_at = ? WHERE sid_hash = ? AND revoked_at IS NULL
  `);
  const countActive = db.prepare(`
    SELECT COUNT(*) AS count FROM web_sessions
    WHERE uid = ? AND revoked_at IS NULL AND expires_at > ?
  `);
  const cleanup = db.prepare(`DELETE FROM web_sessions WHERE expires_at <= ?`);

  return {
    create(input) {
      const createdAt = now();
      cleanup.run(createdAt);
      const sid = randomBytes(32).toString("base64url");
      insert.run(
        hashSid(sid),
        input.uid,
        input.username,
        createdAt,
        createdAt,
        createdAt + ttlMs,
        input.userAgent ?? null,
        input.ip ?? null,
      );
      return { sid, uid: input.uid, username: input.username };
    },

    get(sid) {
      if (!sid) return null;
      const sidHash = hashSid(sid);
      const row = select.get(sidHash) as WebSessionRow | undefined;
      const at = now();
      if (!row || row.revoked_at !== null || row.expires_at <= at) {
        return null;
      }
      if (at - row.last_seen_at >= TOUCH_THROTTLE_MS) {
        touch.run(at, sidHash);
      }
      return { sid, uid: row.uid, username: row.username };
    },

    revoke(sid) {
      revokeStatement.run(now(), hashSid(sid));
    },

    countActiveForUid(uid) {
      const row = countActive.get(uid, now()) as { count: number } | undefined;
      return row?.count ?? 0;
    },

    close() {
      db.close();
    },
  };
}
