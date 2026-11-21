/**
 * 托管 MCP 注册表（治理平面 P0，spec 见 docs/未完成-MCP治理平面-spec-v1.md）：建表。
 *
 * 与全仓纪律一致：**无迁移框架，幂等 ensureSchema** —— `CREATE TABLE IF NOT EXISTS`，
 * 老库演进一律 `ADD COLUMN IF NOT EXISTS`。建表归 identity 启动批（identity/server.ts）；
 * relay 只在本进程读库，不建表。
 *
 * 红线（spec §1）：`headers_ciphertext` 只存 `sealSecret` 封存值（`enc:v1:` 形态）；
 * `header_names` 只存名字与值的末四位，任何接口/下发/日志都不得回明文。
 *
 * 为什么 `name` 上的正则约束写进 CHECK：服务名即模型可见工具前缀段（`mcp__<name>__*`），
 * **禁下划线**才能保证前缀无歧义、可按 `tool:mcp__<服务名>__*` 通配授权（spec §1 授权键规范）。
 * 约束是最后一道闸，路由层会先以可读文案拦截。
 */

import type { IdentityDb } from "../identity/db.js";

export async function ensureMcpSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_server (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('http','sse')),
      url TEXT NOT NULL,
      auth TEXT NOT NULL DEFAULT 'none' CHECK (auth IN ('none','shared')),
      headers_ciphertext JSONB NOT NULL DEFAULT '{}'::jsonb,
      header_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled BOOL NOT NULL DEFAULT true,
      tools_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      synced_at TIMESTAMPTZ,
      sync_error TEXT,
      created_by TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT mcp_server_name_uniq UNIQUE (name),
      CONSTRAINT mcp_server_name_shape CHECK (name ~ '^[a-z][a-z0-9-]{0,23}$')
    );
  `);
  // 老库补列（与 quota-schema.ts 同一手法；新库上面 CREATE 已含）
  await db.pool.query(`ALTER TABLE mcp_server ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''`);
  await db.pool.query(`ALTER TABLE mcp_server ADD COLUMN IF NOT EXISTS tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.pool.query(`ALTER TABLE mcp_server ADD COLUMN IF NOT EXISTS sync_error TEXT`);
  // 管理台列表按名称排序是主视图；enabled 过滤给下发面用
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_mcp_server_enabled ON mcp_server (enabled) WHERE enabled`);
}
