/**
 * 规范库数据域（RUL）：文件审查板块的知识依据之三（见 docs/审查板块-方案-v1.md §4.4）。
 *
 * 两层结构：`rule_library`（一个规范/一份审查清单 = 一个库）+ `rule_library_item`
 * （库里的**条文**与其**审点**）。消费方式与标准库一样是「全量预加载 + 逐条核对」
 * （核审通把它预加载进 `ctx.checkpoints`），所以不需要检索列。
 *
 * 字段为什么收在 10 个：
 * 核审通的 `rule_library_items` 有 22 列，其中 `execution_type` / `builtin_prefix` / `params` /
 * `message_template` / `check_method` / `target_scope` 全部服务于**机械规则引擎**（按前缀
 * 注入规则参数），而「仅规则审查」已在本期裁掉（方案 §2.1），留着就是没有消费方的死列。
 * 同理 `audit_dimension`（compliance/fact/text）随 DEC 三维度审查一并删除。
 * 真正有消费方的是**条文原文 + 判定 prompt**（以库审文，后置期消费）。
 *
 * `clause_hash` 为什么 NOT NULL 且服务端自己算：
 * 它是导入的**幂等键**。让调用方传，同一份清单换个调用方就会算出不同键、重复灌库；
 * 服务端统一按 `sha256(条文)前 16 位` 推导，同一份清单反复导入始终落在同一行。
 */
import type { IdentityDb } from "../identity/db.js";

export type RuleLibraryStatus = "draft" | "published" | "archived";
export type RuleSeverity = "error" | "warning" | "info";
export type RuleMandatory = "mandatory" | "guidance";

export async function ensureRuleLibrariesSchema(db: IdentityDb): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS rule_library (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      -- 导入来源文件名，便于回溯"这批条文从哪份清单来的"
      source_file_name TEXT,
      -- draft / published / archived：只有 published 的库会被消费面下发
      status TEXT NOT NULL DEFAULT 'draft',
      -- 关联标准编号（如 "GB 50974-2014"）。**故意不建外键**：标准库整批重导会换 id，
      -- 外键会把"重导标准库"变成"必须先删规范库"；自检只按编号做字符串比对。
      standard_no TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_library_name ON rule_library (name);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_library_status ON rule_library (status);
  `);
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS rule_library_item (
      id SERIAL PRIMARY KEY,
      library_id INTEGER NOT NULL REFERENCES rule_library (id) ON DELETE CASCADE,
      rule_code TEXT,
      rule_name TEXT,
      category TEXT,
      -- 条文原文（规范里那句话本身）
      clause_text TEXT,
      -- 判定 prompt：把条文转成"要审什么"的动作化描述（以库审文用）
      check_prompt TEXT,
      severity TEXT NOT NULL DEFAULT 'warning',
      -- mandatory = 强制性条文 / guidance = 推荐性
      mandatory TEXT NOT NULL DEFAULT 'mandatory',
      source_location TEXT,
      -- 幂等键：sha256(条文||名称) 前 16 位，服务端推导，见文件头注
      clause_hash TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_library_item_hash
      ON rule_library_item (library_id, clause_hash);
  `);
  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rule_library_item_library
      ON rule_library_item (library_id, enabled);
  `);
}
