/**
 * 主密钥轮换工具（REACTOR_SECRET_KEY 换钥）。
 *
 * 背景：`secrets.field_values` 的敏感字段用主密钥 AES-256-GCM 加密落盘（见 common/secrets-crypto.ts）。
 * 因此**换主密钥不是改个环境变量就完事** —— 库里已加密的值必须就地「旧钥解、新钥加密」，
 * 否则换完 .env 网关与身份都解不开密钥（表现为 provider 被护栏跳过、连通性测试报解密失败）。
 *
 * 用法（在仓库根执行；默认 dry-run，不改任何数据）：
 *
 *   # 1) 先看会动到什么（dry-run）
 *   $env:REACTOR_SECRET_KEY_OLD = "<旧 64 位 hex>"
 *   $env:REACTOR_SECRET_KEY     = "<新 64 位 hex>"
 *   node packages/server/scripts/rotate-secret-key.mjs
 *
 *   # 2) 确认无误后落盘
 *   node packages/server/scripts/rotate-secret-key.mjs --apply
 *
 *   # 3) 落盘后重启服务（网关/身份读的是启动时的 env）
 *
 * 也可以直接传参：`--old <hex> --new <hex> [--apply]`（注意 shell 历史会留痕，推荐走 env）。
 *
 * 安全设计：
 *   - 默认 dry-run；不加 --apply 绝不写库；
 *   - 逐条先「旧钥解 → 新钥加 → 新钥解 → 与原文比对」四步自证，任一步失败即中止（不半途而废）；
 *   - 历史明文（无 enc:v1: 前缀）会被顺手加密（机会性迁移）；
 *   - 全程不打印任何密钥明文/密文，只打印条目与字段名。
 */

import pg from "pg";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* 靠外部环境 */
}

const { isSealed, loadSecretKey, openSecret, sealSecret, secretFieldNames } = await import(
  new URL("../dist/common/secrets-crypto.js", import.meta.url).href
);

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");

const oldHex = argOf("--old") ?? process.env.REACTOR_SECRET_KEY_OLD;
const newHex = argOf("--new") ?? process.env.REACTOR_SECRET_KEY;
const DB_URL = process.env.REACTOR_DB_URL ?? "postgres://reactor:reactor@127.0.0.1:55432/reactor";

/** 解析 32 字节密钥（hex 或 base64），复用 secrets-crypto 的规则。 */
function parseKey(raw, label) {
  if (!raw) {
    console.error(`✗ 缺少 ${label}（用 --old/--new 或环境变量 REACTOR_SECRET_KEY_OLD / REACTOR_SECRET_KEY）`);
    process.exit(2);
  }
  // loadSecretKey 只读 REACTOR_SECRET_KEY；这里临时借用同一套校验
  const saved = process.env.REACTOR_SECRET_KEY;
  process.env.REACTOR_SECRET_KEY = raw;
  try {
    const key = loadSecretKey();
    if (!key) throw new Error("空值");
    return key;
  } catch (e) {
    console.error(`✗ ${label} 非法：${e.message}`);
    process.exit(2);
  } finally {
    if (saved === undefined) delete process.env.REACTOR_SECRET_KEY;
    else process.env.REACTOR_SECRET_KEY = saved;
  }
}

const oldKey = parseKey(oldHex, "旧主密钥");
const newKey = parseKey(newHex, "新主密钥");
if (oldKey.equals(newKey)) {
  console.error("✗ 新旧主密钥相同，无需轮换");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
try {
  await pool.query("SELECT 1");
} catch (e) {
  console.error(`✗ PG 不可达（${DB_URL}）：${e.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}

console.log(`== 主密钥轮换（${APPLY ? "APPLY 落盘" : "DRY-RUN 预览"}）==`);

const { rows } = await pool.query(
  `SELECT s.id, s.name, s.field_values, t.fields AS template_fields
   FROM secrets s LEFT JOIN secret_templates t ON t.key = s.template_key
   ORDER BY s.id`,
);
console.log(`扫描密钥 ${rows.length} 条`);

let changedRows = 0;
let changedFields = 0;
let alreadyCurrent = 0;
let plaintextMigrated = 0;
const updates = [];

for (const row of rows) {
  const values = (row.field_values ?? {});
  const names = secretFieldNames(row.template_fields);
  const sensitive = names.length > 0 ? names : Object.keys(values).filter((k) => /key|token|secret|password|passwd|pwd|credential/i.test(k));
  const next = { ...values };
  let rowChanged = false;
  const touched = [];

  for (const k of sensitive) {
    const v = values[k];
    if (typeof v !== "string" || v === "") continue;
    let plain;
    let wasPlaintext = false;
    if (isSealed(v)) {
      try {
        plain = openSecret(v, oldKey);
      } catch {
        // 旧钥解不开：可能已经是新钥加的（重复执行）→ 用新钥试
        try {
          openSecret(v, newKey);
          alreadyCurrent += 1;
          continue;
        } catch {
          console.error(`✗ #${row.id} 字段 ${k} 用新旧主密钥都解不开 —— 中止（未写入任何数据）`);
          await pool.end().catch(() => {});
          process.exit(1);
        }
      }
    } else {
      // 历史明文：顺手加密（机会性迁移）
      plain = v;
      wasPlaintext = true;
    }

    const resealed = sealSecret(plain, newKey);
    // 自证：新钥必须能解回原文，否则中止
    if (openSecret(resealed, newKey) !== plain) {
      console.error(`✗ #${row.id} 字段 ${k} 加解密自证失败 —— 中止（未写入任何数据）`);
      await pool.end().catch(() => {});
      process.exit(1);
    }
    next[k] = resealed;
    rowChanged = true;
    changedFields += 1;
    touched.push(wasPlaintext ? `${k}(明文→加密)` : k);
    if (wasPlaintext) plaintextMigrated += 1;
  }

  if (rowChanged) {
    changedRows += 1;
    console.log(`  · #${row.id} ${row.name}：${touched.join(", ")}`);
    updates.push({ id: row.id, values: next });
  }
}

console.log(
  `结果：需更新 ${changedRows} 条（${changedFields} 个字段，其中明文迁移 ${plaintextMigrated} 个）；已在新钥下 ${alreadyCurrent} 个字段跳过`,
);

if (!APPLY) {
  console.log("\n（DRY-RUN，未写入。确认后加 --apply 落盘）");
  await pool.end().catch(() => {});
  process.exit(0);
}

if (updates.length === 0) {
  console.log("无需写入。");
  await pool.end().catch(() => {});
  process.exit(0);
}

// 单事务写入：要么全成，要么全不动
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const u of updates) {
    await client.query(`UPDATE secrets SET field_values = $1, updated_at = now() WHERE id = $2`, [
      JSON.stringify(u.values),
      u.id,
    ]);
  }
  await client.query("COMMIT");
  console.log(`✓ 已落盘 ${updates.length} 条`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(`✗ 写入失败已回滚：${e.message}`);
  await client.release();
  await pool.end().catch(() => undefined);
  process.exit(1);
} finally {
  client.release();
}

// 落盘后复核：全部字段必须能用新钥解开
const { rows: after } = await pool.query(
  `SELECT s.id, s.name, s.field_values, t.fields AS template_fields
   FROM secrets s LEFT JOIN secret_templates t ON t.key = s.template_key ORDER BY s.id`,
);
let verifyFail = 0;
for (const row of after) {
  const names = secretFieldNames(row.template_fields);
  for (const k of names) {
    const v = row.field_values?.[k];
    if (typeof v !== "string" || v === "") continue;
    try {
      openSecret(v, newKey);
    } catch {
      console.error(`✗ 复核失败：#${row.id} 字段 ${k}`);
      verifyFail += 1;
    }
  }
}
console.log(verifyFail === 0 ? "✓ 复核通过：全部敏感字段可用新主密钥解密" : `✗ 复核失败 ${verifyFail} 处`);
console.log("\n下一步：重启网关与身份服务（它们读取启动时的 REACTOR_SECRET_KEY）。");
await pool.end().catch(() => undefined);
process.exit(verifyFail === 0 ? 0 : 1);
