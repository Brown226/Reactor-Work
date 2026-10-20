/**
 * 把 AD 来源用户批量转为平台本地账号（密码兜底，两重保障的第二重）。
 *
 * 背景：811 用户里 807 个是 source='ad'（mock LDAP 种子，密码 123456 存在 LDAP 里）。
 * 平台对 ad 用户只做 bind 校验、不落密码 → 「改密码 / 重置密码 / 强制改密」对他们是空转。
 * 本脚本把他们转成 source='local'，密码设为 `<uid>@123`，并置 must_change_password=true，
 * 使首次登录即被要求改密。
 *
 * 为什么转 local 不会在接真实 AD 后被误停用：
 *   identity/sync.ts 的 computeSyncDiff 对 `existing.source === "local"` 直接 continue
 *   （注释「平台本地号（uid 撞名），跳过」）→ 不会被判为「AD 缺失」而停用，姓名/部门也不再被 AD 覆盖。
 *
 * 安全设计：
 *  - 默认 dry-run，只打印将要改动的内容；必须显式加 --apply 才写库。
 *  - 不动 source 已是 local 的用户（内置测试号等），不动 status='disabled' 的用户。
 *  - 保留 ad_dn 列不清空：将来接真实 AD 仍可按 DN 追溯。
 *  - 幂等：重复执行结果一致（重复跑只会重算同一批哈希）。
 *
 * 用法：
 *   node scripts/convert-ad-users-to-local.mjs            # 预演，不写库
 *   node scripts/convert-ad-users-to-local.mjs --apply    # 实际执行
 */

import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import pg from "pg";

// 显式按脚本位置加载仓库根 .env（不依赖 cwd），使连接配置与真实部署一致
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 无 .env 时靠外部环境变量 */
}

const APPLY = process.argv.includes("--apply");

/** 初始密码规则：用户名 + "@123"（与大王约定的重置规则一致）。 */
function initialPassword(uid) {
  return `${uid}@123`;
}

const dbUrl = process.env.REACTOR_DB_URL;
if (!dbUrl) {
  console.error("!! 未读到 REACTOR_DB_URL（检查 .env 是否就位）");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });

function fail(msg) {
  console.error(`!! ${msg}`);
  process.exitCode = 1;
}

try {
  // 只取待转换的：source=ad 且 active。disabled 的 ad 用户保持原状（已停用，无登录需求）。
  const { rows } = await pool.query(
    `SELECT id, uid, name, source, status, password_hash, must_change_password
       FROM users
      WHERE source = 'ad' AND status = 'active'
      ORDER BY id`,
  );

  console.log(`待转换（source=ad 且 active）：${rows.length} 人`);
  if (rows.length === 0) {
    console.log("没有需要转换的用户，结束。");
  } else {
    // 抽样展示前 3 条，让运维确认「用户名→初始密码」的映射符合预期再 APPLY。
    const preview = rows.slice(0, 3).map((r) => `  ${r.uid} → ${initialPassword(r.uid)}`);
    console.log("映射抽样（前 3 条）：");
    for (const line of preview) console.log(line);
    if (rows.length > 3) console.log(`  … 其余 ${rows.length - 3} 人同规则`);

    if (!APPLY) {
      console.log("");
      console.log("【预演】未写库。确认无误后加 --apply 执行。");
    } else {
      // 逐条更新而非单条批量 UPDATE：哈希需按各自 uid 计算，bcrypt 也无法在 SQL 里做。
      let done = 0;
      for (const r of rows) {
        const hash = bcrypt.hashSync(initialPassword(r.uid), 10);
        await pool.query(
          `UPDATE users
              SET source = 'local', password_hash = $2, must_change_password = true, updated_at = now()
            WHERE id = $1`,
          [r.id, hash],
        );
        done += 1;
        // 每 200 条报一次进度：807 条全量跑要一会儿，静默会让运维以为卡死。
        if (done % 200 === 0 || done === rows.length) console.log(`  已处理 ${done}/${rows.length}`);
      }
      console.log(`完成：${done} 人已转为本地账号，初始密码为 <用户名>@123，首次登录强制改密。`);
    }
  }

  // 汇总核对：转换后不应再有 active 的 ad 用户（除本次 dry-run）。
  const { rows: after } = await pool.query(
    `SELECT source, status, count(*)::int AS n FROM users GROUP BY source, status ORDER BY source, status`,
  );
  console.log("");
  console.log("当前 users 分布（source × status）：");
  for (const r of after) console.log(`  ${r.source}/${r.status}: ${r.n}`);

  // 有密码哈希的人数：转 local 后每个 local 用户都应有哈希，否则登录必然失败（看不到原因的失败）。
  const { rows: hashStat } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE password_hash IS NOT NULL AND password_hash <> '') AS with_hash
       FROM users WHERE source = 'local' AND status = 'active'`,
  );
  console.log(`local 且有密码哈希：${hashStat[0].with_hash}/${hashStat[0].total}`);
  if (hashStat[0].with_hash < hashStat[0].total) {
    fail("存在没有密码哈希的 local 用户，这些账号将无法登录——请检查上面的更新是否全部成功。");
  }
} catch (err) {
  fail(`执行失败：${err.message}`);
} finally {
  await pool.end();
}
