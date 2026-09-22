/**
 * 标准规范清单数据域（STD）：文件审查板块的知识依据之一（见 docs/审查板块-方案-v1.md §4.4）。
 *
 * 为什么是一张扁平表，而不是「标准 + 条文」两层：
 * 审查消费端只做**确定性命中**（编号/名称字符串比对 + 状态/年份判定），从来不用语义检索；
 * 条文与审点是另一回事，随「以库审文」一起后置，不要在这里预置一张用不上的子表。
 *
 * `status` 存规范串（current/upcoming/abolished/unknown），不存中文：
 * 前端筛选与排序要按枚举比对，而中文「废止/已废止」在源数据里是同义异形，
 * 落成规范串，中文只在展示层映射（management 侧 statusLabel）。
 *
 * 为什么保留 `replace_info`：核审通的自检要回答「你引用的这条已被 XXX 替代」，
 * 替换关系只存在于源清单这一列里，丢掉就没法提示用户改引。
 */
import type { IdentityDb } from "../identity/db.js";

export async function ensureStandardsSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS standard (
      id SERIAL PRIMARY KEY,
      -- 标准编号 "GB/T 50001-2017"；自检时与文档里的引用做主键级比对，因此建索引。
      standard_no TEXT NOT NULL,
      standard_name TEXT NOT NULL,
      -- current / upcoming / abolished / unknown
      status TEXT NOT NULL DEFAULT 'current',
      -- 归类（源清单第 8 列，如 "材料/冶金"）：导入时由批次带入，用于管理台分面浏览。
      category TEXT,
      publish_date DATE,
      implement_date DATE,
      abolish_date DATE,
      -- 源清单原文，形如 "替换:CB/T1033-1999;;"；不解析、不建关系，只原样存并展示。
      replace_info TEXT,
      -- 标识符前缀（GB/T、JJG…）：由 standard_no 解析，前端只读展示，不接受外部写入。
      ident TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 唯一性按 (编号, 名称) 而非只按编号：同一编号在源清单里存在多版本行（GB 150-1998 现行+废止），
  // 把它当重复删掉会静默丢掉状态，自检因此报不出「这条已废止」。
  await db.pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_standard_no_name ON standard (standard_no, standard_name);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_standard_status ON standard (status, standard_no);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_standard_category ON standard (category);
  `);
  // 搜索走 ILIKE '%kw%'，13k 行用普通 btree 也能走索引扫描的位图过滤；
  // 规模涨到十万级再考虑 pg_trgm，现在引入扩展属于过度设计。
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_standard_name_trgm ON standard USING gin (standard_name gin_trgm_ops);
  `).catch(() => undefined); // pg_trgm 未安装时不阻断启动（与 datasets 的 vector 降级同思路）
  // 后续加字段照着 audit/schema.ts 的做法续写幂等补列：
  //   ALTER TABLE standard ADD COLUMN IF NOT EXISTS <col> <type>;
}
