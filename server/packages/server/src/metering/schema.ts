/**
 * 计量账本（额度分配 P1）：建表。
 *
 * 设计要点：
 *  - **唯一写入者 = gateway 进程**（每次代理一次模型调用落一行）；identity 只读它做报表/告警，
 *    gateway 自己也读它做执行前计数。建表归 identity 启动批（gateway 遵「不建表不迁移」纪律）——
 *    两进程同时冷启时存在建表窗口，gateway 侧按 fail-open 降级（见
 *    `docs/未完成-额度分配-方案-v1.md` §6「启动竞态」）。
 *  - **幂等键 `request_id`**：网关重试/重放不重复计账。
 *  - 部门为**写入时快照**（dept_id + dept_path 同时落库）：用户之后调岗不影响历史统计，
 *    与 `audit_event` 同一纪律。
 *  - **本表不自算费用**：cost 由调用方按 `common/pricing.ts` 的四段价核算后传入
 *    （网关是唯一有回执 usage 的位置），仓储保持无业务公式——避免两处计价漂移。
 *  - `subject_kind='system'` 用于无主体的系统调用（如 KB 向量化用的 dev token）：
 *    计入组织额度、不进入任何个人/部门额度（方案 §2 Q5）。
 */

import type { IdentityDb } from "../identity/db.js";

export async function ensureMeteringSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id BIGSERIAL PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user','system')),
      uid TEXT NOT NULL,
      dept_id INT,
      dept_path TEXT,
      model TEXT,
      provider TEXT,
      api_shape TEXT,
      input_tokens INT,
      output_tokens INT,
      cache_read_tokens INT,
      cache_write_tokens INT,
      total_tokens INT,
      cost NUMERIC(16, 6),
      cost_source TEXT,
      currency TEXT,
      pricing_snapshot JSONB,
      -- 一次代理的终局：ok=正常回执；error=上游 4xx/5xx；aborted=断流/客户端取消
      outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok','error','aborted')),
      http_status INT
    );
  `);
  // 查询与聚合的主要访问路径（与审计表同风格：时间/人/部门三条）
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_ledger_ts ON usage_ledger (ts DESC);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_ledger_uid_ts ON usage_ledger (uid, ts DESC);`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_ledger_dept_ts ON usage_ledger (dept_id, ts DESC);`);
}
