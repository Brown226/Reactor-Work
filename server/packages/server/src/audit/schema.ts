/**
 * 审计与用量数据域（G0）：建表。
 *
 * 设计要点：
 *  - **只增不改**：本模块只提供 INSERT/SELECT 路径，不存在 UPDATE/DELETE 审计事件的代码；
 *  - **正文不落服务端**（NFR-P-01）：只存结构化元数据与用量计数，summary 有长度硬约束；
 *  - 部门为**写入时快照**（dept_id + dept_path 同时落库）：用户之后调岗不影响历史统计；
 *  - 幂等：event_id 唯一索引 —— 端侧离线缓冲补传不会重复入库。
 *
 * 存储选型：PG（与身份同库）——可直接 join 部门、网关与身份两进程共享连接池。
 * （原 G0 任务卡写「SQLite 起步」，2026-09-12 经确认改为 PG；理由见交接文档 §11.13。）
 */

import type { IdentityDb } from "../identity/db.js";

export async function ensureAuditSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS audit_event (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      ts TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      uid TEXT NOT NULL,
      dept_id INT REFERENCES departments(id) ON DELETE SET NULL,
      dept_path TEXT,
      session_id TEXT,
      session_type TEXT,
      action TEXT NOT NULL,
      tool_name TEXT,
      target TEXT,
      outcome TEXT,
      approval_decision TEXT,
      policy_mode TEXT,
      duration_ms INT,
      error_code TEXT,
      summary TEXT,
      files_touched INT,
      model TEXT,
      provider TEXT,
      input_tokens INT,
      output_tokens INT,
      cache_read_tokens INT,
      cache_write_tokens INT,
      total_tokens INT,
      -- cost = **服务端按四段价核算的权威值**（见 common/pricing.ts）；
      -- cost_reported = 端侧上报值，仅作对照（口径可能漂移）
      cost NUMERIC(16, 6),
      cost_reported NUMERIC(16, 6),
      cost_source TEXT,
      pricing_snapshot JSONB,
      currency TEXT,
      -- 兜底护栏：摘要只允许短标签，塞正文会被数据库直接拒绝
      CONSTRAINT audit_summary_short CHECK (summary IS NULL OR char_length(summary) <= 500)
    );
  `);
  // 四段价改造（2026-09-12）：老库补列，幂等
  await db.pool.query(`ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS cost_reported NUMERIC(16, 6);`);
  await db.pool.query(`ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS cost_source TEXT;`);
  await db.pool.query(`ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB;`);
  await db.pool.query(`ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS target TEXT;`);
  /**
   * 结构化附件（2026-09-19）：配管操作的**改前快照**放这里。
   *
   * 为什么不能塞 `summary`：① 它被 CHECK 限在 500 字以内（那是给短标签用的）；
   * ② 快照需要能后续查询/对比，甚至拿来做人工恢复，JSON 才是正确形状。
   * 为什么不能复用 `pricing_snapshot`：那是计价专用字段，混用会让两个语义互相污染。
   *
   * ⚠ 纪律：**密钥值/令牌一律不得写进 details**（与 summary 同一红线）。
   * 供应商快照只记 `bindSecretId` 这个引用，不记密钥内容。
   */
  await db.pool.query(`ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS details JSONB;`);
  // 查询与聚合的主要访问路径
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_uid_ts ON audit_event (uid, ts DESC);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_dept_ts ON audit_event (dept_id, ts DESC);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_event (ts DESC);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_event (action);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_model ON audit_event (model);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_cost_source ON audit_event (cost_source);`);

  // 组织级策略下发（M11-04）：单行表
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS desktop_policy (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      policy JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
  `);

  // 额度告警（M9）：同一周期同一阈值**只告警一次**，避免刷屏
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS quota_alert (
      id BIGSERIAL PRIMARY KEY,
      period TEXT NOT NULL,
      threshold INT NOT NULL,
      level TEXT NOT NULL,
      month_tokens BIGINT NOT NULL,
      limit_tokens BIGINT NOT NULL,
      -- percent 可能远超 100（额度设得极低时），故留足宽度并见 repo 的 clamp
      percent NUMERIC(10, 2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notified BOOL NOT NULL DEFAULT false,
      notified_at TIMESTAMPTZ,
      notify_error TEXT,
      UNIQUE (period, threshold)
    );
  `);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_quota_alert_period ON quota_alert (period);`);
  // 老库补宽（NUMERIC(6,2) 装不下 >9999.99% 的情形；幂等）
  await db.pool
    .query(`ALTER TABLE quota_alert ALTER COLUMN percent TYPE NUMERIC(10, 2)`)
    .catch(() => undefined);
}
