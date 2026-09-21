/**
 * 主密钥自检：用当前 `REACTOR_SECRET_KEY` 能否解开库里全部已加密的敏感字段？
 *
 * 用途：
 *   - 轮换主密钥后复核（rotate-secret-key.mjs 末尾已内置一次，这里是可独立重复跑的版本）；
 *   - 服务起不来 / provider 被护栏跳过时，快速判断「是不是主密钥不对」；
 *   - 部署前自检（CI 或发布脚本可加一步）。
 *
 * 用法：node packages/server/scripts/verify-secret-key.mjs
 * 退出码：0 = 全部可解（或有明文待迁移但无失败）；1 = 存在解不开的字段；2 = 缺少主密钥/连不上库。
 */

import pg from "pg";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 靠外部环境 */
}

const { isSealed, loadSecretKey, openSecret, secretFieldNames } = await import(
  new URL("../dist/common/secrets-crypto.js", import.meta.url).href
);

const DB_URL = process.env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor";
const key = loadSecretKey();
if (!key) {
  console.error("✗ 未配置 REACTOR_SECRET_KEY（无法自检）");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
try {
  await pool.query("SELECT 1");
} catch (e) {
  console.error(`✗ PG 不可达（${DB_URL}）：${e.message}`);
  await pool.end().catch(() => {});
  process.exit(2);
}

const { rows } = await pool.query(
  `SELECT s.id, s.name, s.field_values, t.fields AS template_fields
   FROM secrets s LEFT JOIN secret_templates t ON t.key = s.template_key
   ORDER BY s.id`,
);

let ok = 0;
let failed = 0;
let plaintext = 0;
for (const row of rows) {
  for (const field of secretFieldNames(row.template_fields)) {
    const v = row.field_values?.[field];
    if (typeof v !== "string" || v === "") continue;
    if (!isSealed(v)) {
      plaintext += 1;
      console.warn(`  ! #${row.id} ${row.name}.${field} 是**明文**（未加密落盘）`);
      continue;
    }
    try {
      openSecret(v, key);
      ok += 1;
    } catch {
      failed += 1;
      console.error(`  ✗ #${row.id} ${row.name}.${field} 用当前主密钥解不开`);
    }
  }
}

console.log(`密钥自检：可解密 ${ok} 个字段，解不开 ${failed} 个，明文 ${plaintext} 个（共 ${rows.length} 条密钥）`);
await pool.end().catch(() => undefined);

if (failed > 0) {
  console.error("✗ 自检失败：主密钥与库内密文不匹配（换过钥但没轮换数据？见 rotate-secret-key.mjs）");
  process.exit(1);
}
console.log("✓ 自检通过");
process.exit(0);
