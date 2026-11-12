/**
 * 冒烟运行期的「管理操作审计」清理（所有服务端冒烟共用）。
 *
 * ## 为什么需要
 * T3-4 / G0 落地后，身份服务与网关在**管理接口**上会自记审计
 * （`audit_event.action = 'admin_action'`，`event_id` 由服务端生成 `admin-<ts>-<rand>`，
 * **不带冒烟前缀**）。于是冒烟里的这些用例都会往**真实库**留痕：
 *   · 负向鉴权：user 角色打 `/admin/skills|agents|permissions/scan` → 403 但留痕（`越权尝试…`）
 *   · 敏感资源 CRUD：secrets / providers / agents 的新建-更新-删除
 *   · 连通性测试：`providers:<code>` 的 `secrets.use`
 * 实测：**跑一次全套十个服务端冒烟 = audit_event 净增约 18 行**（2026-09-12 复核）。
 * audit-smoke 早先已按前缀 + 时间窗自清，其余脚本没有 → 残留会累积，污染审计页与用量口径。
 *
 * ## 清理口径（与 audit-smoke 保持一致）
 * `DELETE FROM audit_event WHERE action = 'admin_action' AND ts >= <本次运行起点>`
 *
 * ⚠ **残留风险**：该时间窗内**人工**在管理台上的操作也会被一并删掉。
 *   跑冒烟时不要同时手工点管理台（窗口通常只有几十秒）。
 *   排查问题时可用环境变量 `REACTOR_SMOKE_KEEP_AUDIT=1` 跳过清理、把审计行留住。
 *
 * ## 用法
 * ```js
 * import { cleanupAdminAudit } from "./lib/audit-cleanup.mjs";
 * const STARTED_AT = new Date();            // 脚本顶部，发出第一个请求之前
 * // ...finally 里（且必须在所有「清理用 API 调用」之后，否则那些调用又写新行）：
 * await cleanupAdminAudit({ since: STARTED_AT });          // 自建连接
 * await cleanupAdminAudit({ since: STARTED_AT, pool });     // 复用已有 pool
 * ```
 */

import pg from "pg";

/** 与各冒烟脚本同一兜底值：.env 的 REACTOR_DB_URL，缺省本地 docker pg。 */
export const DEFAULT_DB_URL = "postgres://reactor:reactor@127.0.0.1:55432/reactor";

export function resolveDbUrl() {
  return process.env.REACTOR_DB_URL ?? DEFAULT_DB_URL;
}

/**
 * 删除本次冒烟运行期间产生的管理操作审计行。
 *
 * @param {object}  [opts]
 * @param {Date}     opts.since  本次运行起点（脚本顶部捕获）。缺省=不清理并告警，避免误删全表。
 * @param {object}  [opts.pool]  复用的 pg.Pool；不传则自建并按需关闭。
 * @param {string}  [opts.dbUrl] 库地址；缺省取 REACTOR_DB_URL。
 * @param {boolean} [opts.quiet] 静默（不回显行数）。
 * @returns {Promise<{ skipped?: string, rowCount?: number }>}
 */
export async function cleanupAdminAudit({ since, pool, dbUrl, quiet = false } = {}) {
  if (process.env.REACTOR_SMOKE_KEEP_AUDIT === "1") {
    if (!quiet) console.log("  ℹ 已按 REACTOR_SMOKE_KEEP_AUDIT=1 跳过管理操作审计清理");
    return { skipped: "keep-audit" };
  }
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
    // 没有起点就不能用「时间窗」口径安全删除（会波及全表）→ 宁可不删
    console.warn("  ⚠ 未提供运行起点，跳过管理操作审计清理");
    return { skipped: "no-since" };
  }

  const own = !pool;
  if (own) {
    pool = new pg.Pool({ connectionString: dbUrl ?? resolveDbUrl(), max: 1, connectionTimeoutMillis: 3000 });
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM audit_event WHERE action = 'admin_action' AND ts >= $1`,
      [since],
    );
    if (!quiet) console.log(`  ℹ 已清理管理操作审计 ${rowCount ?? 0} 条（本次运行窗内）`);
    return { rowCount: rowCount ?? 0 };
  } catch (err) {
    // 清理失败不影响冒烟结论，但必须显式告警（否则又会静默累积）
    console.warn(`  ⚠ 管理操作审计清理失败：${err instanceof Error ? err.message : String(err)}`);
    return { skipped: "error" };
  } finally {
    if (own) await pool.end().catch(() => undefined);
  }
}
