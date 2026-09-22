/**
 * 术语白名单数据域（TRM）：文件审查板块的知识依据之二（见 docs/审查板块-方案-v1.md §4.4）。
 *
 * 消费方式决定表形态：端侧把整表拉进**内存 Set**，审查结果逐条查 Set、命中即丢弃。
 * 所以既没有向量列、也没有检索索引的意义，只需要「按分类分面 + 术语唯一」。
 *
 * `aliases` 沿用核审通的**逗号分隔单列**（不另开子表）：改动白名单是低频管理动作，
 * 子表带来的联表成本换不到任何东西；消费面在 routes 里一次性拆成数组下发，
 * 让拆分口径只有一处，端侧不必各自实现。
 *
 * `is_builtin` 是**权限**字段而不是展示字段：内置术语是审查的执行前提（见 builtin.ts），
 * 删掉会让校对整段失效，因此删除接口必须拒绝它，而不是只把开关置灰。
 */
import type { IdentityDb } from "../identity/db.js";

import { BUILTIN_TERMS } from "./builtin.js";

export const TERMINOLOGY_DEFAULT_CATEGORY = "自定义";

export async function ensureTerminologySchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS terminology (
      id SERIAL PRIMARY KEY,
      term TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '${TERMINOLOGY_DEFAULT_CATEGORY}',
      -- 同义异形，逗号分隔："containment,安全壳厂房"；空串与 NULL 等价（无别名）
      aliases TEXT,
      -- true = 随建表 seed 的内置词条，不可删除（改分类可以）
      is_builtin BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 唯一性是 (术语, 分类) 而不是只按术语：同一词在不同分类下含义不同（"隔离阀"在设备术语
  // 与工艺术语里是两件事），只按术语去重会让管理员无法按专业维护。
  await db.pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_terminology_term_category ON terminology (term, category);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_terminology_category ON terminology (category, term);
  `);
  // 消费面按 updated_at 判缓存是否失效，这里给 max() 一个可用索引。
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_terminology_updated_at ON terminology (updated_at);
  `);
  await seedBuiltinTerms(db);
}

/**
 * 幂等 seed 内置术语：**每次启动都跑**，靠唯一键吞掉已存在的行。
 *
 * 这样做而不是「只在空库时 seed」：内置词条会在版本升级时增补（专业词随审查经验补），
 * 只在空库 seed 就永远补不进已有环境，得让人工去点导入 —— 而这是产品该保证的基线。
 * 单条 `INSERT ... ON CONFLICT` 多值插入，一次往返，112 行的代价可以忽略。
 */
async function seedBuiltinTerms(db: IdentityDb): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (const item of BUILTIN_TERMS) {
    params.push(item.term, item.category, item.aliases.join(","));
    const base = params.length;
    values.push(`($${base - 2}, $${base - 1}, $${base}, true)`);
  }
  if (values.length === 0) return;
  await db.pool.query(
    `INSERT INTO terminology (term, category, aliases, is_builtin)
     VALUES ${values.join(", ")}
     ON CONFLICT (term, category) DO NOTHING`,
    params,
  );
}
