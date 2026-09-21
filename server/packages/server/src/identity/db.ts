/**
 * Identity 数据域（PG；管理后台终态库）。G0 审计/用量仍 SQLite 起步，两域分离。
 * ensureSchema 幂等建表（开发期简单 DDL，不做迁移框架；第 2 批 PG 化时引入正式迁移）。
 */

import pg from "pg";

export interface IdentityDb {
  pool: pg.Pool;
}

export function createIdentityDb(dbUrl: string): IdentityDb {
  return { pool: new pg.Pool({ connectionString: dbUrl, max: 5 }) };
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
      department_id INT REFERENCES departments(id) ON DELETE SET NULL,
      ad_dn TEXT,
      last_sync_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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
