/**
 * 冒烟专用数据库（与真实库**物理隔离**）。
 *
 * ## 为什么必须有这个文件
 *
 * 2026-09-18 事故：`skills-smoke` / `agents-smoke` 开头的「清场」写的是**删全表**——
 *
 * ```js
 * // 清场（幂等重跑）
 * for (const s of (await get("/admin/skills", adminTok)).json?.skills ?? []) await del(`/admin/skills/${s.id}`, adminTok);
 * ```
 *
 * 它们自起的 identity（8801 端口、`authMode=local`）确实隔离了**鉴权**，但它
 * `env: { ...process.env }` 继承了 `.env` 的 `REACTOR_DB_URL` → 连的是**真实 reactor 库**。
 * 于是跑一次 `gate:infra`（`gate:all` 也会跑到这一组）就把
 * **技能市场（28 个技能 / 380 个附件）与数字人市场（agents 历史最大 id 315）整体清空**。
 * 用户、组织、权限、模型、密钥、审计都不受影响 —— 所以这个洞活了很久没人发现，
 * 直到市场里第一次有了真实内容。
 *
 * 修法不是把清场改成"只删自己的 fixture"（那样每加一个 fixture 都要记得登记，
 * 漏一个就又清真实数据），而是**让冒烟根本不碰真实库**。
 *
 * ## 用法
 *
 * 每个会连库的冒烟，在**起 identity / 建 pg.Pool 之前**加一行：
 *
 * ```js
 * import { useSmokeDb } from "./lib/smoke-db.mjs";
 * // ...
 * async function main() {
 *   await useSmokeDb();          // ← 必须在任何连库动作之前
 *   const child = spawn(...);
 * ```
 *
 * 它做四件事：
 *   ① 把 `REACTOR_DB_URL` 的库名换成 `reactor_smoke`（`REACTOR_SMOKE_DB_NAME` 可覆盖）；
 *   ② **fail-closed 守卫**：解析出的库名与真实库同名 → 直接抛错（绝不允许冒烟指向真实库）；
 *   ③ 连维护库 `postgres` 做 `DROP DATABASE IF EXISTS ... WITH (FORCE)` + `CREATE DATABASE`
 *      → 每次跑都是**干净库**，冒烟里原有的「清场」退化成对空表的空操作；
 *   ④ 把结果写回 `process.env.REACTOR_DB_URL` —— 子进程（spread process.env）与
 *      直连（`new pg.Pool({connectionString: process.env.REACTOR_DB_URL})`）都自动继承。
 *
 * schema 与种子**不用管**：identity 启动时 `ensureSchema` / `ensureSkillsSchema` /
 * `ensureAgentsSchema` / `ensurePermissionsSchema` / `ensureAuditSchema` /
 * `ensureBuiltinLocalAccounts` 会在空库上自建全套，含 `admin` / `head` / `user` 三个本地测试号。
 *
 * ## 已知边界
 *
 * - 冒烟**必须串行跑**（门禁 runner 就是串行的）：两个冒烟并行会互相 DROP 对方的库。
 * - `identity-smoke` 断言的是 **LDAP 同步后**的组织树与域账号，干净库上它必须**自己先同步**
 *   （见该脚本的「前置：LDAP 全量同步」一步）—— 原先它依赖真实库"恰好同步过"，在干净克隆上本来就会红。
 */

import pg from "pg";

/** 与各冒烟同一兜底值：.env 的 REACTOR_DB_URL，缺省本地 docker pg。 */
const DEFAULT_DB_URL = "postgres://reactor:reactor@127.0.0.1:55432/reactor";

/** 维护库：`CREATE/DROP DATABASE` 必须连到另一个库上执行（不能在事务里） */
const MAINTENANCE_DB = "postgres";

/** 冒烟库默认名 */
const DEFAULT_SMOKE_DB = "reactor_smoke";

export function resolveRealDbUrl() {
  return process.env.REACTOR_DB_URL ?? DEFAULT_DB_URL;
}

export function resolveSmokeDbName() {
  return process.env.REACTOR_SMOKE_DB_NAME?.trim() || DEFAULT_SMOKE_DB;
}

/** 库名只允许 `[a-z_][a-z0-9_]*`：它要被拼进 DDL（标识符不能参数化），必须先自己挡住 */
function assertSafeDbName(name) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`冒烟库名非法：${JSON.stringify(name)}（只允许小写字母/数字/下划线，且以字母或下划线开头）`);
  }
}

/** 派生冒烟库 URL：只换库名，主机/账号/口令沿用真实库的连接串 */
export function resolveSmokeDbUrl() {
  const u = new URL(resolveRealDbUrl());
  u.pathname = `/${resolveSmokeDbName()}`;
  return u.toString();
}

/**
 * 准备冒烟库并把它设为本次运行的 `REACTOR_DB_URL`。
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.reset] 是否 DROP + CREATE（默认 true：每次跑都从干净库开始）
 * @param {boolean} [opts.quiet] 不打印
 * @returns {Promise<string>} 冒烟库连接串
 */
export async function useSmokeDb({ reset = true, quiet = false } = {}) {
  const realName = new URL(resolveRealDbUrl()).pathname.slice(1);
  const name = resolveSmokeDbName();

  // ★ fail-closed：宁可让冒烟起不来，也不能让它指向真实库（那就是 2026-09-18 的事故）
  if (name === realName) {
    throw new Error(
      `拒绝运行：冒烟库名与真实库同名（${name}）。冒烟会清空该库的市场数据，` +
        `请用 REACTOR_SMOKE_DB_NAME 指定另一个库名。`,
    );
  }
  assertSafeDbName(name);

  const maintenance = new URL(resolveRealDbUrl());
  maintenance.pathname = `/${MAINTENANCE_DB}`;
  const pool = new pg.Pool({ connectionString: maintenance.toString(), max: 1, connectionTimeoutMillis: 5000 });
  try {
    if (reset) {
      // WITH (FORCE) 会掐掉残留连接（上一轮没退干净的 identity），否则 DROP 会因"库正被使用"失败
      await pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    const { rows } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rows.length === 0) await pool.query(`CREATE DATABASE "${name}"`);
  } finally {
    await pool.end().catch(() => undefined);
  }

  const url = resolveSmokeDbUrl();
  process.env.REACTOR_DB_URL = url;
  if (!quiet) {
    console.log(`  ℹ 冒烟库：${name}${reset ? "（每次重建）" : ""} —— 真实库 ${realName} 不受影响`);
  }
  return url;
}
