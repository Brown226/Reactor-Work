/**
 * Identity 数据域（PG；管理后台终态库）。G0 审计/用量仍 SQLite 起步，两域分离。
 * ensureSchema 幂等建表（开发期简单 DDL，不做迁移框架；第 2 批 PG 化时引入正式迁移）。
 */

import pg from "pg";

export interface IdentityDb {
  pool: pg.Pool;
}

/** 连接池上限默认值 */
const DEFAULT_POOL_MAX = 10;
/**
 * 连接池上限天花板：PG 服务端 `max_connections=100`，且 reactor 库不只有本池在用，
 * 客户端池超过这个量会直接触发 `FATAL: too many clients`，故封顶留余量。
 */
const POOL_MAX_CEILING = 50;

/**
 * 解析连接池上限（env：`REACTOR_IDENTITY_POOL_MAX`）。
 *
 * 为什么改成可配：原为硬编码 `max: 5`，实测 8 路并发即占到 4 个（80%），
 * 内网多人同时用会在上限处排队；而放大是安全的（PG 服务端尚有余量）。
 * 内网部署不便重建镜像（无外网时 `--build` 必挂），调一行 `.env` 比重新 build + docker save 便宜得多。
 */
function resolvePoolMax(): number {
  const raw = process.env.REACTOR_IDENTITY_POOL_MAX?.trim();
  if (!raw) return DEFAULT_POOL_MAX;
  const n = Number(raw);
  // 反例：env 手写错（非数字、0、负数、小数）时若照建，池会变成 NaN 或 0，
  // 表现为「一查库就永久卡住」且不报错，极难排查；故一律回落默认值并告警。
  if (!Number.isInteger(n) || n < 1) {
    console.warn(`[identity/db] REACTOR_IDENTITY_POOL_MAX="${raw}" 不是正整数，已回落默认值 ${DEFAULT_POOL_MAX}`);
    return DEFAULT_POOL_MAX;
  }
  return Math.min(n, POOL_MAX_CEILING);
}

export function createIdentityDb(dbUrl: string): IdentityDb {
  return { pool: new pg.Pool({ connectionString: dbUrl, max: resolvePoolMax() }) };
}

export async function closeIdentityDb(db: IdentityDb): Promise<void> {
  await db.pool.end();
}

export async function ensureSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      parent_id INT REFERENCES departments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      depth INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (parent_id, name)
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT,
      source TEXT NOT NULL DEFAULT 'ad' CHECK (source IN ('ad','local')),
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('platform_admin','dept_head','user')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      password_hash TEXT,
      must_change_password BOOLEAN NOT NULL DEFAULT false,
      department_id INT REFERENCES departments(id) ON DELETE SET NULL,
      ad_dn TEXT,
      last_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  /**
   * 已存在的库补列：`CREATE TABLE IF NOT EXISTS` 对老表不生效，
   * 而 811 用户的生产库早于本字段存在。ADD COLUMN IF NOT EXISTS 幂等可重跑。
   *
   * 语义：true = 该用户必须修改初始密码后才能继续使用（初始密码 / 管理员重置均置 true）。
   */
  await db.pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS ad_sync_logs (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      mode TEXT NOT NULL,
      total INT NOT NULL DEFAULT 0,
      added INT NOT NULL DEFAULT 0,
      changed INT NOT NULL DEFAULT 0,
      disabled INT NOT NULL DEFAULT 0,
      unchanged INT NOT NULL DEFAULT 0,
      diff_json TEXT
    );
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS user_tokens (
      id SERIAL PRIMARY KEY,
      uid TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_user_tokens_uid ON user_tokens (uid);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_user_tokens_token_hash ON user_tokens (token_hash);`);
}
