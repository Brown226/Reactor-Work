/**
 * 额度规则与告警（额度分配 P2）：建表 + 迁移。
 *
 * 两条路径都要能走：
 *  ① 全新库：`CREATE TABLE IF NOT EXISTS`；
 *  ② 老库（已有 `quota_alert` 且唯一约束是 `(period, threshold)`）：幂等加列 + 约束迁移。
 *
 * 约束迁移为什么不能只写 `ADD CONSTRAINT IF NOT EXISTS`：PG 不支持该语法（列有，
 * 约束没有）。所以用 `DO $$` 先探测旧约束是否存在，存在才删 —— 重跑时跳过，幂等。
 *
 * 为什么 `quota_rule.scope_id` 用 TEXT 而不是 INT：三个维度共表（org 无 id、
 * dept 是 int、user 是 uid 字符串）。TEXT 是唯一能承载三者的类型；查询时 dept 走
 * `scope_id::int`，需要调用方保证写入形状正确（路由层校验）。
 */

import type { IdentityDb } from "../identity/db.js";

export async function ensureQuotaSchema(db: IdentityDb): Promise<void> {
  /* ---------------- quota_rule（额度规则） ---------------- */
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS quota_rule (
      id SERIAL PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('org','dept','user')),
      scope_id TEXT,
      period TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('month')),
      limit_tokens BIGINT,
      limit_cost NUMERIC(16, 2),
      alert_thresholds INT[] NOT NULL DEFAULT '{80,100}',
      action TEXT NOT NULL DEFAULT 'warn' CHECK (action IN ('warn','block')),
      enabled BOOL NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT,
      -- org 的 scope_id 恒为 NULL：唯一约束里 NULL 不参与去重（PG 语义），
      -- 会对 org 失去约束力。故用部分唯一索引补两条（见下），本约束只管 dept/user。
      CONSTRAINT quota_rule_scope_uniq UNIQUE (scope_type, scope_id, period),
      CONSTRAINT quota_rule_limit_any CHECK (limit_tokens IS NOT NULL OR limit_cost IS NOT NULL)
    );
  `);
  // org 唯一：走部分索引（NULL 的唯一性在 UNIQUE 约束里不成立）
  await db.pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS quota_rule_org_uniq ON quota_rule (period) WHERE scope_type = 'org';`,
  );
  // 老库补列（与全仓「无迁移框架，幂等加列」同一手法；新库上面 CREATE 已含）
  await db.pool.query(`ALTER TABLE quota_rule ADD COLUMN IF NOT EXISTS limit_cost NUMERIC(16, 2)`);
  await db.pool.query(`ALTER TABLE quota_rule ADD COLUMN IF NOT EXISTS alert_thresholds INT[] NOT NULL DEFAULT '{80,100}'`);
  await db.pool.query(`ALTER TABLE quota_rule ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'warn'`);
  await db.pool.query(`ALTER TABLE quota_rule ADD COLUMN IF NOT EXISTS enabled BOOL NOT NULL DEFAULT true`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_quota_rule_enabled ON quota_rule (enabled) WHERE enabled`);

  /* ---------------- quota_alert 扩 scope（多维度告警） ---------------- */
  // 老行一律属于组织维度（改造前只有组织额度这一个概念）
  await db.pool.query(`ALTER TABLE quota_alert ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'org'`);
  await db.pool.query(`ALTER TABLE quota_alert ADD COLUMN IF NOT EXISTS scope_id TEXT`);
  /**
   * 唯一约束迁移：`(period, threshold)` → `(period, scope_type, scope_id, threshold)`。
   *
   * 不迁移的后果：部门级 80% 告警与组织级 80% 告警撞唯一键 —— 后者会被静默吞掉
   * （`ON CONFLICT DO NOTHING`），表现为「部门超了但组织那条永远不告警」。
   *
   * org 行的 `scope_id` 是 NULL，同样不参与 UNIQUE 去重 ⇒ org 额外建部分唯一索引。
   */
  await db.pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'quota_alert_period_threshold_key'
           AND conrelid = 'quota_alert'::regclass
      ) THEN
        ALTER TABLE quota_alert DROP CONSTRAINT quota_alert_period_threshold_key;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'quota_alert_scope_threshold_key'
           AND conrelid = 'quota_alert'::regclass
      ) THEN
        ALTER TABLE quota_alert ADD CONSTRAINT quota_alert_scope_threshold_key
          UNIQUE (period, scope_type, scope_id, threshold);
      END IF;
    END $$;
  `);
  // org 的部分唯一索引（scope_id IS NULL 不参与上面的 UNIQUE）
  await db.pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS quota_alert_org_uniq
       ON quota_alert (period, threshold) WHERE scope_type = 'org' AND scope_id IS NULL;`,
  );
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_quota_alert_scope ON quota_alert (period, scope_type, scope_id)`);
}
