/**
 * 平台运营指标数据域（双平台看板）。
 *
 * 为什么单独开一张表：`usage_ledger` 与 `audit_event` 都没有平台维度，登录接口也
 * 不上报客户端类型，导致「Web 与桌面各有多少人在用」当前无任何数据来源。
 * 这里在登录成功时落一条记录，作为平台维度的唯一权威来源。
 *
 * ⚠ 历史数据不可回溯：看板口径只能是「自本表开始写入之日起统计」，
 *   页面必须如实标注起始时间，不能把空历史当成 0。
 */
import type { IdentityDb } from "../identity/db.js";

export async function ensurePlatformMetricsSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS client_login (
      id BIGSERIAL PRIMARY KEY,
      uid TEXT NOT NULL,
      -- 部门在登录时快照，与 audit_event 同口径：组织后来调整不影响历史统计
      dept_id INT,
      dept_path TEXT,
      -- desktop | web：由请求头声明优先，缺失时按 UA 特征推断（见 repo.detectClientPlatform）
      platform TEXT NOT NULL,
      client_version TEXT,
      user_agent TEXT,
      ip TEXT,
      logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- 阶段一没有心跳，last_seen_at 等于登录时间；阶段三接心跳后由客户端更新
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 看板的两个主查询维度：按平台+时间聚合、按用户取最近一次登录
  await db.pool.query(
    `CREATE INDEX IF NOT EXISTS idx_client_login_platform_time ON client_login (platform, logged_in_at DESC);`,
  );
  await db.pool.query(
    `CREATE INDEX IF NOT EXISTS idx_client_login_uid_time ON client_login (uid, last_seen_at DESC);`,
  );
}
